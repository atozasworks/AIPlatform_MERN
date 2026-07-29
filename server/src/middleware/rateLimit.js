import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * In-memory rate limiting for Phase 1. In later phases this is backed by Redis
 * (rate-limit-redis) so limits are shared across horizontally-scaled instances.
 */
export const globalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } },
});

/** Stricter limiter for auth endpoints to slow brute-force attempts (§16). */
export const authLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later.' } },
});
