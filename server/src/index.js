import http from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { closeRedis } from './config/redis.js';
import { closeQueue } from './services/queue/llmQueue.js';
import { initSockets } from './sockets/index.js';
import { resolveEnabledChatModelIds } from './services/ai/modelRegistry.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

/**
 * API bootstrap: connect MongoDB, start HTTP + Socket.IO, handle graceful
 * shutdown so in-flight SSE relays close cleanly.
 *
 * Inference does not run here — see src/worker.js.
 */
async function start() {
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);

  /**
   * A queued generation can legitimately hold an SSE connection open for
   * minutes on CPU. Node's 5s default headers timeout and 0s request timeout
   * would otherwise sever the stream mid-answer.
   */
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0; // SSE relays manage their own idle timeout

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
    logger.info(
      {
        engine: env.ai.defaultProvider,
        models: resolveEnabledChatModelIds(),
        defaultModel: env.ai.llamacpp.defaultModel,
      },
      `ATOZAS AI API listening on ${env.backendUrl} (${env.nodeEnv})`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down...`);

    server.close(async () => {
      await closeQueue().catch(() => {});
      await disconnectDatabase().catch(() => {});
      await closeRedis().catch(() => {});
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Force-exit if graceful shutdown stalls behind a lingering stream.
    setTimeout(() => process.exit(1), 15_000).unref();
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
