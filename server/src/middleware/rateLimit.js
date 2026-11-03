import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { getRedis, key } from '../config/redis.js';
import { logger } from '../config/logger.js';

/**
 * IP/user rate limiting backed by Redis.
 *
 * The in-memory store this replaces reset on every restart and counted
 * separately per process, so a PM2 reload handed attackers a fresh quota. The
 * Redis store keeps one shared window across the API processes and the worker.
 */

function createStore(scope) {
  try {
    return new RedisStore({
      prefix: `${key('ratelimit', scope)}:`,
      sendCommand: (...args) => getRedis().call(...args),
    });
  } catch (err) {
    // Fall back to the in-memory store rather than refusing to boot; a degraded
    // limiter is better than an API that will not start.
    logger.error({ err }, 'Redis rate-limit store unavailable, falling back to memory');
    return undefined;
  }
}

/** Authenticated users are limited per account; anonymous traffic per IP. */
function keyGenerator(req) {
  return req.user ? `u:${req.user._id}` : `ip:${req.ip}`;
}

export const globalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  limit: env.rateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  store: createStore('global'),
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' },
  },
});

/** Stricter window for credential endpoints, to slow brute-force attempts. */
export const authLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  limit: env.rateLimit.authMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Always per-IP: an attacker enumerating accounts has no session yet.
  keyGenerator: (req) => `ip:${req.ip}`,
  store: createStore('auth'),
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later.' },
  },
});

/**
 * Ingest is far more expensive than a normal request (chunking plus embedding),
 * so it gets its own, much tighter budget.
 */
export const ingestLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  store: createStore('ingest'),
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many document uploads. Please wait a minute.' },
  },
});

/**
 * Pre-login public/private chat — tighter IP budget than the global limiter
 * because these routes skip authentication.
 */
export const publicChatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${req.ip}`,
  store: createStore('public-chat'),
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many chat requests. Please wait a moment before trying again.',
    },
  },
});

export default globalLimiter;
