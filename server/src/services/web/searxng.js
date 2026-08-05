import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getRedis, key } from '../../config/redis.js';
import { isDomainAllowed } from './egressGuard.js';

/**
 * Search client for a self-hosted SearXNG instance.
 *
 * SearXNG is an open-source metasearch aggregator: it forwards a query to
 * upstream engines and merges the results, without an account, an API key or a
 * per-query bill. That is what makes genuinely current answers possible here
 * without adopting a proprietary search API — and, more importantly, without
 * putting every user's question into a vendor's query log under an ATOZAS key.
 *
 * `env.js` refuses to boot if SEARXNG_BASE_URL is not loopback or private, so
 * this always talks to an instance ATOZAS runs. What leaves the box afterwards
 * is whatever the operator configured SearXNG's upstream engines to be.
 *
 * Results are cached in Redis by normalized query, which matters more than it
 * looks: several users asking the same current-events question in a short
 * window is the common case, and each cache hit removes a full search plus up
 * to `WEB_MAX_FETCH` page downloads.
 */

/** @typedef {{ url: string, title: string, snippet: string, engine: string, publishedAt: Date|null }} SearchHit */

const SEARCH_CACHE_PREFIX = 'web:search';

function cacheKey(query, categories) {
  // Case and whitespace are not meaningful to the upstream engines, so folding
  // them raises the hit rate without changing results.
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return key(`${SEARCH_CACHE_PREFIX}:${categories.join(',')}:${normalized}`);
}

/**
 * SearXNG returns `publishedDate` only for engines that expose one (news
 * engines mostly). It is advisory: origin servers lie about dates, and a
 * missing date is far more common than a wrong one. Rendered to the user as
 * "published" alongside the retrieval timestamp so both are visible.
 */
function parsePublishedDate(raw) {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // A future date is a broken feed, not a scoop.
  if (parsed.getTime() > Date.now() + 86400000) return null;
  return parsed;
}

/**
 * Runs one metasearch query.
 *
 * Returns `[]` rather than throwing on any failure: the caller must be able to
 * fall back to model knowledge (with an honest caveat in the prompt) instead of
 * failing the user's whole request because a search backend blipped.
 *
 * @param {string} query
 * @param {{ categories?: string[], limit?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<SearchHit[]>}
 */
export async function search(query, options = {}) {
  if (!env.web.enabled || !env.web.searxngUrl) return [];

  const text = String(query || '').trim();
  if (text.length < 3) return [];

  const categories = options.categories?.length ? options.categories : env.web.searxngCategories;
  const limit = options.limit ?? env.web.maxResults;
  const redisKey = cacheKey(text, categories);

  const cached = await readCache(redisKey);
  if (cached) return cached.slice(0, limit);

  const url = new URL(`${env.web.searxngUrl}/search`);
  url.searchParams.set('q', text);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', env.web.searxngLanguage);
  url.searchParams.set('categories', categories.join(','));
  if (env.web.searxngEngines.length) {
    url.searchParams.set('engines', env.web.searxngEngines.join(','));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.web.searxngTimeoutMs);
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': env.web.userAgent },
      signal: controller.signal,
    });

    if (!res.ok) {
      // 403 here almost always means the instance's settings.yml has not enabled
      // the JSON format, which is off by default and is the usual first-run trap.
      logger.warn(
        { status: res.status },
        'SearXNG search failed. If 403, add "json" to search.formats in settings.yml',
      );
      return [];
    }

    const body = await res.json();
    const hits = normalizeResults(body?.results).slice(0, Math.max(limit, env.web.maxResults));

    await writeCache(redisKey, hits);
    return hits.slice(0, limit);
  } catch (err) {
    logger.warn({ err: err.message }, 'SearXNG search unavailable; answering without live sources');
    return [];
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Shapes and filters raw SearXNG hits.
 *
 * Domain policy is applied here as well as in the egress guard. It is cheap and
 * it keeps blocked hosts out of the cache, so a later policy change is not
 * fighting stale entries that were allowed when they were written.
 */
function normalizeResults(results) {
  if (!Array.isArray(results)) return [];

  const seen = new Set();
  const hits = [];

  for (const r of results) {
    const rawUrl = typeof r?.url === 'string' ? r.url : '';
    if (!rawUrl) continue;

    let hostname;
    try {
      hostname = new URL(rawUrl).hostname;
    } catch {
      continue;
    }
    if (!isDomainAllowed(hostname)) continue;

    // Engines overlap heavily; the same URL from three engines is one source.
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);

    hits.push({
      url: rawUrl,
      title: String(r.title || hostname).slice(0, 300),
      snippet: String(r.content || '').slice(0, 1000),
      engine: String(r.engine || 'searxng').slice(0, 60),
      publishedAt: parsePublishedDate(r.publishedDate),
    });
  }

  return hits;
}

async function readCache(redisKey) {
  try {
    const raw = await getRedis().get(redisKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Dates do not survive JSON; rehydrate so callers get a uniform shape.
    return parsed.map((hit) => ({
      ...hit,
      publishedAt: hit.publishedAt ? new Date(hit.publishedAt) : null,
    }));
  } catch {
    return null;
  }
}

async function writeCache(redisKey, hits) {
  if (!hits.length) return;
  try {
    await getRedis().set(
      redisKey,
      JSON.stringify(hits),
      'EX',
      env.web.searchCacheTtlSeconds,
    );
  } catch {
    // A cold cache costs latency, not correctness.
  }
}

/**
 * Reports whether the search backend is reachable, for the admin status page.
 * Distinguishes "not configured" from "configured but down", which are very
 * different operator problems.
 */
export async function checkSearchHealth({ timeoutMs = 3000 } = {}) {
  if (!env.web.enabled) return { ok: false, enabled: false, reason: 'disabled' };
  if (!env.web.searxngUrl) return { ok: false, enabled: true, reason: 'not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.web.searxngUrl}/healthz`, { signal: controller.signal });
    return { ok: res.ok, enabled: true, url: env.web.searxngUrl };
  } catch (err) {
    return { ok: false, enabled: true, reason: err.message, url: env.web.searxngUrl };
  } finally {
    clearTimeout(timer);
  }
}

export default { search, checkSearchHealth };
