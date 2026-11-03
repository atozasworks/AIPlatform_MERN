import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { chunkText } from '../rag/chunker.js';
import { embedQuery, embedPassages, isEmbeddingEnabled } from '../rag/embeddings.js';
import { observe, increment, SAMPLE, METRIC } from '../health/metrics.js';
import { assessFreshness, buildSearchQuery } from './freshness.js';
import { fetchAndExtract } from './fetchPage.js';
import { scoreByLexicalOverlap } from './rerank.js';
import { search } from './searxng.js';

/**
 * Live web retrieval: question in, ranked and dated source passages out.
 *
 *   question
 *     -> freshness router      does this need current information at all?
 *     -> SearXNG               self-hosted metasearch, no vendor API
 *     -> fetch + extract       public pages only, Readability, egress-guarded
 *     -> chunk                 same chunker as uploaded documents
 *     -> rerank                lexical by default; see rerank.js for why
 *     -> top passages          with url, publishedAt and retrievedAt attached
 *
 * Two properties this deliberately preserves:
 *
 *  1. **Nothing is stored.** Web passages are per-request and live only in Redis
 *     as a short-TTL fetch cache. They are never written into the Document /
 *     DocumentChunk corpus, because that corpus is user-owned, access-scoped and
 *     assumed curated — mixing transient scraped text into it would corrupt the
 *     meaning of every existing similarity threshold and require an eviction
 *     job to stop it growing without bound.
 *
 *  2. **The output shape matches the local retriever's.** Both produce the same
 *     `source` objects, so prompt assembly, citation verification and the client
 *     renderer needed no web-specific branches.
 *
 * Reranking is what makes this affordable in an 8k context. A fetched article is
 * far too long to quote wholesale; scoring its chunks against the question and
 * keeping the best few spends the retrieval budget on the paragraphs that
 * actually answer it.
 */

/** @typedef {import('./fetchPage.js').ExtractedPage} ExtractedPage */

/**
 * Runs the live tier.
 *
 * Never throws. Every failure path returns an empty source list with a reason,
 * because degrading to a model-knowledge answer (with the prompt's staleness
 * caveat) always beats failing the user's request.
 *
 * @param {object} params
 * @param {string} params.question
 * @param {AbortSignal} [params.signal]
 * @param {boolean} [params.force] Skip the freshness router and always search.
 * @returns {Promise<{ sources: Array, attempted: boolean, reason: string, verdict: object }>}
 */
export async function retrieveFromWeb({ question, signal, force = false } = {}) {
  const verdict = assessFreshness(question);

  if (!env.web.enabled) {
    return { sources: [], attempted: false, reason: 'disabled', verdict };
  }
  if (!force && !verdict.needsWeb) {
    return { sources: [], attempted: false, reason: verdict.reason, verdict };
  }

  const startedAt = Date.now();
  // One wall-clock budget covers search plus every fetch. Without it a handful
  // of slow origins could hold a generation slot for a minute before the model
  // has produced a single token.
  const budget = AbortSignal.timeout(env.web.totalBudgetMs);
  const combined = signal ? AbortSignal.any([signal, budget]) : budget;

  try {
    const query = buildSearchQuery(question, verdict);
    const categories = verdict.newsBiased
      ? [...new Set([...env.web.searxngCategories, 'news'])]
      : env.web.searxngCategories;

    const hits = await search(query, { categories, limit: env.web.maxResults, signal: combined });
    if (!hits.length) {
      return { sources: [], attempted: true, reason: 'no_results', verdict };
    }

    const pages = await fetchPages(hits.slice(0, env.web.maxFetch), combined);
    if (!pages.length) {
      return { sources: [], attempted: true, reason: 'no_readable_pages', verdict };
    }

    // Whatever is left of the budget after search and fetching is what reranking
    // gets. Without this the embedding call runs on its own much longer timeout
    // and the total budget becomes advisory.
    const remainingMs = env.web.totalBudgetMs - (Date.now() - startedAt);
    const sources = await rankPassages(question, pages, remainingMs);

    await observe(SAMPLE.WEB_RETRIEVAL_MS, Date.now() - startedAt);
    await increment(METRIC.WEB_RETRIEVALS);

    logger.info(
      {
        query,
        reason: verdict.reason,
        hits: hits.length,
        pages: pages.length,
        passages: sources.length,
        ms: Date.now() - startedAt,
      },
      'Live web retrieval complete',
    );

    return {
      sources,
      attempted: true,
      reason: sources.length ? 'ok' : 'below_threshold',
      verdict,
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'Live web retrieval failed; answering without web sources');
    return { sources: [], attempted: true, reason: 'error', verdict };
  }
}

/**
 * Fetches candidate pages concurrently.
 *
 * Concurrency is bounded by `WEB_MAX_FETCH` rather than a semaphore because the
 * list is already that short. These are network-bound waits, so running them in
 * parallel is the difference between a 3-second and a 12-second retrieval phase.
 * `allSettled` means one dead origin cannot sink the batch.
 */
async function fetchPages(hits, signal) {
  const settled = await Promise.allSettled(
    hits.map(async (hit) => {
      const page = await fetchAndExtract(hit.url, { signal });
      if (!page) return null;
      return {
        ...page,
        // The search engine's own date is kept when the page declares none;
        // engines often know a publication date the HTML omits.
        publishedAt: page.publishedAt || hit.publishedAt || null,
        searchTitle: hit.title,
        engine: hit.engine,
      };
    }),
  );

  return settled
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
}

/**
 * Chunks the fetched pages and keeps the passages closest to the question.
 *
 * Scoring is lexical by default because embedding reranking costs ~5.5 s per
 * passage on this hardware — see the measurement in `rerank.js`. The embedding
 * path remains available for deployments where that does not hold.
 *
 * @param {string} question
 * @param {object[]} pages
 * @param {number} budgetMs Time left for reranking before the caller gives up.
 */
async function rankPassages(question, pages, budgetMs) {
  const candidates = selectCandidates(pages);
  if (!candidates.length) return [];

  const scores = await computeScores(question, candidates, budgetMs);

  const kept = candidates
    .map((candidate, i) => ({ ...candidate, score: scores[i] }))
    .filter((candidate) => candidate.score >= env.web.minScore)
    // Stable sort, so the search engine's own ranking breaks ties without having
    // to be blended into the score.
    .sort((a, b) => b.score - a.score)
    // One passage per URL: three chunks of the same article crowd out the
    // second opinion that makes a claim corroborated rather than merely sourced.
    .filter(dedupeByUrl())
    .slice(0, env.web.topPassages);

  // Nothing clearing the threshold means the pages were fetched but none of them
  // answer the question. Quoting the lead paragraphs anyway would put irrelevant
  // text in front of the model and invite a wrong answer that looks sourced, so
  // this returns nothing and the prompt falls back to its staleness caveat.
  return kept.map((candidate, i) => toSource(candidate, i, candidate.score));
}

/**
 * Produces one score per candidate, falling back to lexical scoring whenever the
 * embedding path is unavailable, disabled, or out of time.
 */
async function computeScores(question, candidates, budgetMs) {
  if (env.web.rerankMode !== 'embedding') {
    return scoreByLexicalOverlap(question, candidates);
  }

  // Below a couple of seconds there is no point starting: the request would be
  // abandoned mid-flight having already cost the embedding server the work.
  if (!isEmbeddingEnabled() || budgetMs < 2000) {
    logger.warn({ budgetMs }, 'No budget for embedding rerank; scoring lexically');
    return scoreByLexicalOverlap(question, candidates);
  }

  try {
    return await withDeadline(scoreByEmbedding(question, candidates), budgetMs);
  } catch (err) {
    logger.warn({ err: err.message }, 'Embedding rerank failed; scoring lexically');
    return scoreByLexicalOverlap(question, candidates);
  }
}

/**
 * Chooses which passages are worth scoring.
 *
 * Allocation is per page and head-first. Per page, because letting one long
 * article consume the whole allowance would silence the corroborating source that
 * makes an answer trustworthy. Head-first, because articles and documentation
 * both put the substance early and bury boilerplate — related links, comment
 * threads, footer navigation — at the end.
 *
 * The cap is generous under lexical scoring, which is effectively free, and is
 * what keeps the embedding mode from being unusably slow when enabled.
 */
function selectCandidates(pages) {
  const perPage = Math.max(1, Math.ceil(env.web.maxRerankPassages / Math.max(1, pages.length)));

  const candidates = [];
  for (const page of pages) {
    const chunks = chunkText(page.text).slice(0, perPage);
    for (const chunk of chunks) {
      candidates.push({
        page,
        text: chunk.text,
        index: chunk.index,
        heading: chunk.heading || '',
      });
    }
  }

  return candidates.slice(0, env.web.maxRerankPassages);
}

/** Cosine similarity against the query, using the local embedding server. */
async function scoreByEmbedding(question, candidates) {
  const [queryVector, passageVectors] = await Promise.all([
    embedQuery(question),
    embedPassages(candidates.map((c) => c.text)),
  ]);

  return candidates.map((_, i) => dot(queryVector, passageVectors[i]));
}

/**
 * Rejects if `promise` has not settled within `ms`.
 *
 * The underlying embedding request keeps running — `embedPassages` takes no
 * signal — but the user is no longer waiting on it, which is the property that
 * matters. Its own request timeout ends it.
 */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`rerank exceeded ${ms}ms budget`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Stateful predicate for `filter`, keeping the highest-scoring chunk per URL. */
function dedupeByUrl() {
  const seen = new Set();
  return (candidate) => {
    if (seen.has(candidate.page.url)) return false;
    seen.add(candidate.page.url);
    return true;
  };
}

/**
 * Shapes a passage into the same `source` object the local retriever emits.
 *
 * `sourceType: 'web'` is what downstream code keys on to render a retrieval date
 * and to tell the model that this source is live rather than curated.
 *
 * Labels use the same `S#` scheme as the local tier even though `retriever.js`
 * renumbers the merged list. A distinct scheme (`W#`) was tried and is a trap:
 * `citations.js` matches `/\[(S\d{1,2})\]/`, so any caller that used this tier
 * directly without relabelling would have every citation silently discarded as
 * unknown. Numbering here is provisional; correctness does not depend on it.
 */
function toSource(candidate, position, score) {
  const { page } = candidate;
  const host = safeHost(page.url);

  return {
    label: `S${position + 1}`,
    chunkId: null,
    documentId: null,
    title: page.title || page.searchTitle || host,
    documentTitle: page.title || page.searchTitle || host,
    heading: candidate.heading,
    sourceUri: page.url,
    sourceType: 'web',
    chunkIndex: candidate.index,
    chunkText: candidate.text,
    // Provenance the user needs in order to judge the answer: who published it,
    // when they say they did, and when ATOZAS actually read it.
    siteName: page.siteName || host,
    publishedAt: page.publishedAt ? page.publishedAt.toISOString() : null,
    retrievedAt: page.retrievedAt.toISOString(),
    score: score == null ? 0 : Math.round(score * 1000) / 1000,
    denseScore: score == null ? 0 : Math.round(score * 1000) / 1000,
    keywordScore: 0,
  };
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'source';
  }
}

/** Both vectors are L2-normalized by embeddings.js, so cosine is a dot product. */
function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export default retrieveFromWeb;
