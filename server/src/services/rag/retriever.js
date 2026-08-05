import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { embedQuery } from './embeddings.js';
import { searchDense, searchKeyword, loadChunks } from './vectorStore.js';
import { observe, increment, SAMPLE, METRIC } from '../health/metrics.js';
import { retrieveFromWeb } from '../web/webRetriever.js';

/**
 * Retrieval: curated ATOZAS documents, optionally plus live web sources.
 *
 * ── Local tier: hybrid dense + keyword ──
 *
 * Neither half is sufficient alone. Dense search handles paraphrase and
 * cross-language matching (the point of a multilingual embedding model);
 * keyword search reliably nails exact identifiers — error codes, product SKUs,
 * API names — that embeddings tend to blur together.
 *
 * Fusion is weighted-score rather than reciprocal-rank because the dense score
 * is a calibrated cosine value, which `RAG_MIN_SCORE` can threshold against to
 * suppress weak matches. Returning a bad source is worse than returning none:
 * it invites a confidently wrong, apparently-cited answer.
 *
 * ── Live tier: web ──
 *
 * The local corpus is only as current as its last import, and the model's
 * weights only as current as its training cutoff. For questions that turn on
 * present-day facts, `services/web/` searches a self-hosted SearXNG and extracts
 * the pages it finds. That tier runs only when the freshness router says the
 * question needs it, so ordinary questions pay none of its latency.
 *
 * The two tiers are merged here, behind one entry point, so that prompt
 * assembly, citation verification and the client renderer stay unaware of which
 * tier a source came from. Local sources are ordered first: ATOZAS's own
 * documentation should outrank a search result about ATOZAS.
 */

/**
 * @param {object} params
 * @param {string} params.query
 * @param {{ userId: string, organizationId?: string|null }} params.scope
 * @param {number} [params.topK]
 * @param {boolean} [params.allowWeb] Whether the live tier may run at all.
 * @param {boolean} [params.forceWeb] Bypass the freshness router.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ sources: Array, degraded: boolean, reason?: string, web?: object }>}
 */
export async function retrieve({
  query,
  scope,
  topK = env.rag.topK,
  allowWeb = false,
  forceWeb = false,
  signal,
}) {
  const text = String(query || '').trim();

  // The local corpus can be switched off while live retrieval stays on, which is
  // the useful configuration for a deployment with no uploaded documents.
  if (!env.rag.enabled) {
    const web = await maybeRetrieveWeb({ text, allowWeb, forceWeb, signal });
    return {
      sources: relabel(web.sources),
      degraded: false,
      reason: web.sources.length ? 'web_only' : 'disabled',
      web: web.meta,
    };
  }

  if (text.length < 3) return { sources: [], degraded: false, reason: 'query_too_short' };

  const startedAt = Date.now();

  // Keyword search still works when the embedding server is down, so a partial
  // outage degrades retrieval quality instead of failing the whole request.
  let dense = [];
  let degraded = false;
  let reason;

  try {
    const vector = await embedQuery(text);
    dense = await searchDense(vector, scope, env.rag.candidateLimit);
  } catch (err) {
    degraded = true;
    reason = 'embedding_unavailable';
    logger.warn({ err: err.message }, 'Dense retrieval unavailable; falling back to keyword only');
  }

  const keyword = await searchKeyword(text, scope, env.rag.candidateLimit);

  // Kicked off before the fusion below so the network round trips overlap the
  // local search instead of running after it.
  const webPromise = maybeRetrieveWeb({ text, allowWeb, forceWeb, signal });

  // Weighted fusion over the union of both candidate sets.
  const vw = env.rag.vectorWeight;
  const kw = 1 - vw;
  const fused = new Map();

  for (const hit of dense) {
    fused.set(hit.id, { id: hit.id, dense: hit.score, keyword: 0 });
  }
  for (const hit of keyword) {
    const existing = fused.get(hit.id);
    if (existing) existing.keyword = hit.score;
    else fused.set(hit.id, { id: hit.id, dense: 0, keyword: hit.score });
  }

  const ranked = [...fused.values()]
    .map((entry) => ({
      ...entry,
      // When dense search is unavailable, keyword score carries the full weight
      // so the threshold below stays meaningful instead of rejecting everything.
      score: degraded ? entry.keyword : entry.dense * vw + entry.keyword * kw,
    }))
    .filter((entry) => (degraded ? entry.keyword > 0 : entry.dense >= env.rag.minScore || entry.keyword > 0.5))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const web = await webPromise;

  if (!ranked.length) {
    await observe(SAMPLE.RETRIEVAL_MS, Date.now() - startedAt);
    return {
      sources: relabel(web.sources),
      degraded,
      reason: web.sources.length ? 'web_only' : reason || 'no_match',
      web: web.meta,
    };
  }

  const chunks = await loadChunks(ranked.map((r) => r.id));

  const local = [];
  ranked.forEach((entry) => {
    const chunk = chunks.get(entry.id);
    if (!chunk) return; // deleted between search and hydrate
    local.push({
      chunkId: String(chunk._id),
      documentId: String(chunk.document),
      title: chunk.heading ? `${chunk.documentTitle} — ${chunk.heading}` : chunk.documentTitle,
      documentTitle: chunk.documentTitle,
      heading: chunk.heading,
      sourceUri: chunk.sourceUri,
      sourceType: chunk.sourceType,
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.text,
      // Curated uploads carry no dates: they are versioned by re-import, so a
      // retrieval timestamp would imply a currency guarantee they do not have.
      publishedAt: null,
      retrievedAt: null,
      score: Math.round(entry.score * 1000) / 1000,
      denseScore: Math.round(entry.dense * 1000) / 1000,
      keywordScore: Math.round(entry.keyword * 1000) / 1000,
    });
  });

  await observe(SAMPLE.RETRIEVAL_MS, Date.now() - startedAt);
  await increment(METRIC.RETRIEVALS);

  return {
    sources: relabel([...local, ...web.sources]),
    degraded,
    reason,
    web: web.meta,
  };
}

/**
 * Runs the live tier when the caller permits it, absorbing every failure.
 *
 * Web retrieval is strictly additive: it may improve an answer but must never be
 * able to prevent one. Anything that goes wrong out there resolves to an empty
 * list with a recorded reason.
 */
async function maybeRetrieveWeb({ text, allowWeb, forceWeb, signal }) {
  if (!allowWeb || !env.web.enabled || text.length < 3) {
    return { sources: [], meta: { attempted: false, reason: 'not_requested' } };
  }

  try {
    const result = await retrieveFromWeb({ question: text, signal, force: forceWeb });
    if (result.attempted && !result.sources.length) {
      await increment(METRIC.WEB_RETRIEVALS_EMPTY);
    }
    return {
      sources: result.sources,
      meta: {
        attempted: result.attempted,
        reason: result.reason,
        routerReason: result.verdict?.reason,
        confidence: result.verdict?.confidence,
      },
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'Web tier threw; continuing with local sources only');
    return { sources: [], meta: { attempted: true, reason: 'error' } };
  }
}

/**
 * Renumbers the merged list to a contiguous [S1]..[Sn].
 *
 * The tiers label independently (`S#` local, `W#` web) because neither knows
 * about the other. The model must see one unbroken sequence: a gap or a duplicate
 * would make it cite a label that `citations.js` then discards as unknown,
 * silently stripping a reference the answer depended on.
 */
function relabel(sources) {
  return sources.map((source, i) => ({ ...source, label: `S${i + 1}` }));
}

export default retrieve;
