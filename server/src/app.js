import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import pinoHttp from 'pino-http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { requestId } from './middleware/requestId.js';
import {
  helmetMiddleware,
  corsMiddleware,
  sanitizeMiddleware,
  hppMiddleware,
} from './middleware/security.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { live, ready } from './controllers/health.controller.js';
import v1Routes from './routes/v1/index.js';
import atozasRoutes from './routes/atozas.routes.js';
import { COOKIE_NAMES } from './utils/tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Built frontend served by this server in production
// (e.g. htdocs/atozasai.com/server/dist -> ../dist relative to src/).
const distPath = path.resolve(__dirname, '../dist');

/**
 * Builds and configures the Express application (middleware order matters).
 * Kept separate from the HTTP bootstrap in index.js for testability.
 */
export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // behind Nginx in production
  // Long CPU generations must not be cut off by Node's own header timeout.
  app.set('query parser', 'simple');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      // Health probes fire every few seconds; logging them buries real traffic.
      autoLogging: { ignore: (req) => req.url.startsWith('/api/health') },
    }),
  );

  app.use(helmetMiddleware());
  app.use(corsMiddleware());

  app.use(
    compression({
      /**
       * Compression buffers output, which is fatal for SSE: tokens would sit in
       * the gzip buffer instead of reaching the browser. Streams opt out via
       * the `X-No-Compression` header set below, and by content type.
       */
      filter(req, res) {
        if (req.headers['x-no-compression']) return false;
        const type = res.getHeader('Content-Type');
        if (typeof type === 'string' && type.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.use(express.json({ limit: env.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: env.jsonBodyLimit }));
  app.use(cookieParser());
  app.use(sanitizeMiddleware);
  app.use(hppMiddleware);

  // ── Health endpoints (unauthenticated, unrate-limited, never cached) ──
  app.get('/api/health/live', live);
  app.get('/api/health/ready', ready);
  // Retained for existing uptime monitors pointed at the old path.
  app.get('/api/health', live);

  app.use('/api/v1', globalLimiter, v1Routes);

  // ATOZAS Cross-Domain SSO (OIDC relying party). Mounted at root `/auth` so it
  // owns the provider redirect URI and — critically — is registered BEFORE the
  // SPA catch-all below, which now also excludes `/auth` so these routes are
  // never shadowed by index.html. Inert unless ATOZAS_SSO_ENABLED=true.
  app.use('/auth', atozasRoutes);

  /**
   * Production no-blink SSO entrypoint.
   *
   * Without this, opening `/` first loads the SPA, which calls `/api/v1/auth/me`
   * (401 for anonymous users) and only then starts the ATOZAS redirect on the
   * client, causing a visible flash. When SSO is enabled and there is no app
   * access-token cookie yet, bounce `/` straight to the OIDC start endpoint so
   * the browser leaves immediately. `/?guest=1` remains the opt-out.
   *
   * Skipped in non-production so local/dev never leaves this origin for the
   * ATOZAS IdP just by opening `/` (Vite still proxies `/auth` for manual SSO).
   */
  app.get('/', (req, res, next) => {
    if (!env.isProd) return next();
    if (!env.atozas.enabled) return next();
    if (req.query?.guest === '1') return next();
    if (req.cookies?.[COOKIE_NAMES.access]) return next();
    return res.redirect('/auth/atozas?returnTo=/');
  });

  // Serve the built frontend (dist) and fall back to index.html for SPA routes.
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get(/^(?!\/api|\/auth).*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
