import http from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { initSockets } from './sockets/index.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

/**
 * Application bootstrap: connect DB, start HTTP + Socket.IO, and handle
 * graceful shutdown so in-flight requests and streams can finish cleanly (§22).
 */
async function start() {
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  initSockets(server);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        `Port ${env.port} is already in use. Stop the other process or set a different PORT in server/.env.`,
      );
      process.exit(1);
    }
    logger.fatal({ err }, 'HTTP server error');
    process.exit(1);
  });

  server.listen(env.port, () => {
    logger.info(`AiChat API listening on ${env.backendUrl} (${env.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down...`);
    server.close(async () => {
      await disconnectDatabase();
      logger.info('Shutdown complete');
      process.exit(0);
    });
    // Force-exit if graceful shutdown stalls.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
