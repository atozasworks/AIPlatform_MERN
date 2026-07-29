import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/**
 * Aggregated security middleware (§21):
 *  - Helmet security headers + CSP
 *  - CORS allowlist with credentials
 *  - NoSQL injection sanitization
 *  - HTTP parameter pollution protection
 */
export function helmetMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // API server serves JSON only; SPA is served by Nginx/Vite separately.
        connectSrc: ["'self'", ...env.corsOrigins],
        imgSrc: ["'self'", 'data:', 'blob:'],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
}

export function corsMiddleware() {
  const allowlist = new Set(env.corsOrigins);
  return cors({
    origin(origin, callback) {
      // Allow same-origin / server-to-server (no Origin header) and allowlisted origins.
      if (!origin || allowlist.has(origin)) return callback(null, true);
      return callback(AppError.forbidden(`Origin not allowed: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CSRF-Token', 'Idempotency-Key'],
  });
}

export const sanitizeMiddleware = mongoSanitize();
export const hppMiddleware = hpp();
