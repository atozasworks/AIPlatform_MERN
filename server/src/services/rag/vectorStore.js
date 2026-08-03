import { DocumentChunk } from '../../models/DocumentChunk.js';
import { getRedis, key } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * MongoDB-backed vector store with an in-process similarity cache.
 *
 * MongoDB Community has no vector index, so dense search runs in Node over a
 * cached, scope-tagged copy of the corpus. Vectors are stored L2-normalized, so
 * cosine similarity reduces to a dot product over Float32Array — roughly 5M
 * dimension-ops per 10k chunks, which is a few milliseconds.
 *
 * Cross-process invalidation uses a Redis version counter: ingest bumps it, and
 * readers re-check at most once every CACHE_CHECK_MS. Without that, the worker
 * process would keep serving a stale corpus after an admin import.
 */

const CACHE_CHECK_MS = 5000;
const versionKey = key('rag', 'corpus_version');

/** @type {{ loadedVersion: number|null, checkedAt: number, entries: Array }} */
const cache = {
  loadedVersion: null,
  checkedAt: 0,
  entries: [],
  loading: null,
};

async function currentVersion() {
  const raw = await getRedis().get(versionKey).catch(() => null);
  return Number(raw || 0);
}

/** Signals every process that the corpus changed. */
export async function bumpCorpusVersion() {
  await getRedis().incr(versionKey).catch(() => {});
}

async function loadCache(version) {
  const started = Date.now();

  const rows = await DocumentChunk.find({ deletedAt: null }, null, { lean: true })
    .select('+embedding')
    .select('_id document owner organization visibility embedding')
    .limit(env.rag.vectorCacheMaxChunks ?? 100000)
    .lean();

  const entries = [];
  for (const row of rows) {
    if (!Array.isArray(row.embedding) || !row.embedding.length) continue;
    entries.push({
      id: String(row._id),
      documentId: String(row.document),
      owner: String(row.owner),
      organization: row.organization ? String(row.organization) : null,
      visibility: row.visibility,
      vector: Float32Array.from(row.embedding),
    });
  }

  cache.entries = entries;
  cache.loadedVersion = version;
  cache.checkedAt = Date.now();

  logger.info(
    { chunks: entries.length, ms: Date.now() - started },
    'Vector cache loaded',
  );
}

/** Loads or refreshes the cache, coalescing concurrent callers onto one load. */
async function ensureCache() {
  const now = Date.now();

  if (cache.loadedVersion !== null && now - cache.checkedAt < CACHE_CHECK_MS) {
    return;
  }

  const version = await currentVersion();
  cache.checkedAt = now;
  if (cache.loadedVersion === version) return;

  if (!cache.loading) {
    cache.loading = loadCache(version).finally(() => {
      cache.loading = null;
    });
  }
  await cache.loading;
}

/**
 * Access-control predicate. A user may retrieve a chunk when it is public, or
 * they own it, or it belongs to their organization. This is the single place
 * where cross-user document isolation is enforced for retrieval.
 */
function isVisibleTo(entry, scope) {
  if (entry.visibility === 'public') return true;
  if (entry.visibility === 'private') return entry.owner === scope.userId;
  if (entry.visibility === 'organization') {
    return Boolean(scope.organizationId) && entry.organization === scope.organizationId;
  }
  return false;
}

/** Mongo filter mirroring `isVisibleTo`, for the keyword half of the search. */
export function scopeFilter(scope) {
  const clauses = [{ visibility: 'public' }, { visibility: 'private', owner: scope.userId }];
  if (scope.organizationId) {
    clauses.push({ visibility: 'organization', organization: scope.organizationId });
  }
  return { deletedAt: null, $or: clauses };
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Dense nearest-neighbour search restricted to what `scope` may see.
 *
 * @param {Float32Array|number[]} queryVector L2-normalized
 * @param {{ userId: string, organizationId?: string|null }} scope
 * @param {number} limit
 * @returns {Promise<Array<{ id: string, score: number }>>}
 */
export async function searchDense(queryVector, scope, limit) {
  await ensureCache();

  const query = queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector);

  // Bounded max-heap behaviour via a small sorted insert; limit is single digits.
  const top = [];
  for (const entry of cache.entries) {
    if (!isVisibleTo(entry, scope)) continue;

    const score = dot(query, entry.vector);
    if (top.length < limit) {
      top.push({ id: entry.id, score });
      top.sort((a, b) => a.score - b.score);
    } else if (score > top[0].score) {
      top[0] = { id: entry.id, score };
      top.sort((a, b) => a.score - b.score);
    }
  }

  return top.reverse();
}

/**
 * Keyword search over the MongoDB text index, restricted to `scope`.
 * Scores are normalized to 0..1 so they can be fused with cosine similarity.
 */
export async function searchKeyword(queryText, scope, limit) {
  const text = String(queryText || '').trim();
  if (!text) return [];

  const rows = await DocumentChunk.find(
    { ...scopeFilter(scope), $text: { $search: text } },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .select('_id')
    .lean();

  if (!rows.length) return [];

  const max = rows[0].score || 1;
  return rows.map((r) => ({ id: String(r._id), score: max ? r.score / max : 0 }));
}

/** Hydrates chunk ids into full records for prompt assembly and citations. */
export async function loadChunks(ids) {
  if (!ids.length) return new Map();

  const rows = await DocumentChunk.find({ _id: { $in: ids }, deletedAt: null })
    .select('_id document chunkIndex text heading tokenCount documentTitle sourceUri sourceType visibility owner')
    .lean();

  return new Map(rows.map((r) => [String(r._id), r]));
}

/** Test/ops hook: forces the next search to reload from MongoDB. */
export function invalidateLocalCache() {
  cache.loadedVersion = null;
  cache.checkedAt = 0;
  cache.entries = [];
}

export function getCacheStats() {
  return {
    chunksCached: cache.entries.length,
    loadedVersion: cache.loadedVersion,
    approxBytes: cache.entries.length * (env.ai.embeddings.dimensions * 4 + 200),
  };
}

export default { searchDense, searchKeyword, loadChunks, bumpCorpusVersion, scopeFilter };
