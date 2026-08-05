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
 *
 * The CSP is written for a self-hosted deployment: no analytics CDNs, no
 * external fonts. The only third-party origins allowed are Google Identity
 * Services, which the login page loads when a Google client id is configured
 * on the client. Those origins are always listed here (not gated on the
 * server's GOOGLE_CLIENT_ID) so a client build that includes Google Sign-In
 * cannot be blocked by a server env that temporarily lacks the same value.
 */
export function helmetMiddleware() {
  // Google Identity Services (the "Continue with Google" button) loads a script
  // and an iframe from accounts.google.com and serves avatars from
  // googleusercontent.com.
  const gsiScript = ['https://accounts.google.com/gsi/client'];
  const gsiConnect = ['https://accounts.google.com/gsi/', 'https://accounts.google.com'];
  const gsiFrame = ['https://accounts.google.com/gsi/', 'https://accounts.google.com'];
  const gsiStyle = ['https://accounts.google.com/gsi/style'];
  const gsiImg = ['https://*.googleusercontent.com'];

  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // The SPA calls only its own origin; the AI engine is never reachable
        // from the browser, it sits behind the API on loopback.
        connectSrc: ["'self'", ...env.corsOrigins, ...gsiConnect],
        imgSrc: ["'self'", 'data:', 'blob:', ...gsiImg],
        scriptSrc: ["'self'", ...gsiScript],
        scriptSrcAttr: ["'none'"],
        // Tailwind injects styles at build time, but the runtime still needs
        // inline style attributes for dynamic values. GSI injects a tiny
        // stylesheet for the button; fonts are self-hosted / system only.
        styleSrc: ["'self'", "'unsafe-inline'", ...gsiStyle],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameSrc: ["'self'", ...gsiFrame],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Forbids the page from opening a WebSocket or worker anywhere else.
        workerSrc: ["'self'", 'blob:'],
        ...(env.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // same-origin blocks the Google Sign-In popup / FedCM handshake.
    // same-origin-allow-popups keeps isolation while letting GSI complete.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS only makes sense once TLS terminates at Nginx in production.
    hsts: env.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
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
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-CSRF-Token',
      'Idempotency-Key',
      'Last-Event-ID',
    ],
    // Lets the client read the standard rate-limit headers on a 429.
    exposedHeaders: ['RateLimit', 'RateLimit-Policy', 'Retry-After', 'X-Request-Id'],
  });
}

export const sanitizeMiddleware = mongoSanitize();
export const hppMiddleware = hpp();
