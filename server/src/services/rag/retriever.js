import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { embedQuery } from './embeddings.js';
import { searchDense, searchKeyword, loadChunks } from './vectorStore.js';
import { observe, increment, SAMPLE, METRIC } from '../health/metrics.js';

/**
 * Hybrid retrieval: dense vectors fused with MongoDB keyword search.
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
 */

/**
 * @param {object} params
 * @param {string} params.query
 * @param {{ userId: string, organizationId?: string|null }} params.scope
 * @param {number} [params.topK]
 * @returns {Promise<{ sources: Array, degraded: boolean, reason?: string }>}
 */
export async function retrieve({ query, scope, topK = env.rag.topK }) {
  if (!env.rag.enabled) return { sources: [], degraded: false, reason: 'disabled' };

  const text = String(query || '').trim();
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

  if (!ranked.length) {
    await observe(SAMPLE.RETRIEVAL_MS, Date.now() - startedAt);
    return { sources: [], degraded, reason: reason || 'no_match' };
  }

  const chunks = await loadChunks(ranked.map((r) => r.id));

  const sources = [];
  ranked.forEach((entry) => {
    const chunk = chunks.get(entry.id);
    if (!chunk) return; // deleted between search and hydrate
    sources.push({
      label: `S${sources.length + 1}`,
      chunkId: String(chunk._id),
      documentId: String(chunk.document),
      title: chunk.heading ? `${chunk.documentTitle} — ${chunk.heading}` : chunk.documentTitle,
      documentTitle: chunk.documentTitle,
      heading: chunk.heading,
      sourceUri: chunk.sourceUri,
      sourceType: chunk.sourceType,
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.text,
      score: Math.round(entry.score * 1000) / 1000,
      denseScore: Math.round(entry.dense * 1000) / 1000,
      keywordScore: Math.round(entry.keyword * 1000) / 1000,
    });
  });

  await observe(SAMPLE.RETRIEVAL_MS, Date.now() - startedAt);
  await increment(METRIC.RETRIEVALS);

  return { sources, degraded, reason };
}

export default retrieve;
