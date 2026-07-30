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
import v1Routes from './routes/v1/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Built frontend served by this server in production
// (e.g. htdocs/atozasai.com/server/dist -> ../dist relative to src/).
const distPath = path.resolve(__dirname, '../dist');

/**
 * Builds and configures the Express application (middleware order matters).
 * Kept separate from the HTTP/Socket bootstrap in index.js for testability.
 */
export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // behind Nginx in production

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  app.use(helmetMiddleware());
  app.use(corsMiddleware());
  app.use(compression());
  app.use(express.json({ limit: env.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: env.jsonBodyLimit }));
  app.use(cookieParser());
  app.use(sanitizeMiddleware);
  app.use(hppMiddleware);

  // Health check (used by Nginx / uptime monitors / load balancers).
  app.get('/api/health', (_req, res) =>
    res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } }),
  );

  app.use('/api/v1', globalLimiter, v1Routes);

  // Serve the built frontend (dist) and fall back to index.html for SPA routes.
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get(/^(?!\/api).*/, (_req, res) =>
      res.sendFile(path.join(distPath, 'index.html')),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
