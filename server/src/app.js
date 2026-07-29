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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
