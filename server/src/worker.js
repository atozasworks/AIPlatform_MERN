import { connectDatabase, disconnectDatabase } from './config/db.js';
import { closeRedis } from './config/redis.js';
import { startLlmWorker, stopLlmWorker } from './services/queue/llmWorker.js';
import { cleanStaleJobs, closeQueue } from './services/queue/llmQueue.js';
import { aiGateway } from './services/ai/AIGateway.js';
import { resolveEnabledChatModelIds } from './services/ai/modelRegistry.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

/**
 * BullMQ worker entrypoint — a separate process from the API.
 *
 * This process must run in PM2 **fork** mode with exactly one instance. Cluster
 * mode would fork N copies, each with its own concurrency, silently multiplying
 * simultaneous llama.cpp generations by N and defeating the entire point of the
 * queue. See deploy/ecosystem.config.cjs.
 */

const STALE_SWEEP_MS = 60_000;

async function start() {
  await connectDatabase();

  // Warn loudly rather than fail: the worker should be running and waiting when
  // llama-server finishes loading the model, which can take a minute on CPU.
  const health = await aiGateway.healthReport();
  const engine = health[env.ai.defaultProvider];
  if (!engine?.ok) {
    logger.warn(
      { engine: env.ai.defaultProvider, health: engine },
      'Inference engine is not responding yet; the worker will retry as jobs arrive',
    );
  }

  startLlmWorker();

  const sweeper = setInterval(() => {
    cleanStaleJobs().catch((err) => logger.error({ err }, 'Stale job sweep failed'));
  }, STALE_SWEEP_MS);
  sweeper.unref();

  logger.info(
    {
      concurrency: env.limits.workerConcurrency,
      engine: env.ai.defaultProvider,
      models: resolveEnabledChatModelIds(),
      defaultModel: env.ai.llamacpp.defaultModel,
    },
    'ATOZAS LLM worker ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, draining worker...`);

    clearInterval(sweeper);
    // Waits for in-flight generations so a deploy never truncates an answer.
    await stopLlmWorker().catch((err) => logger.error({ err }, 'Worker shutdown error'));
    await closeQueue().catch(() => {});
    await disconnectDatabase().catch(() => {});
    await closeRedis().catch(() => {});

    logger.info('Worker shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    logger.error({ reason }, 'Unhandled rejection in worker'),
  );
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in worker');
    process.exit(1);
  });

  // Force exit if a generation refuses to finish within the grace period.
  process.on('SIGTERM', () => setTimeout(() => process.exit(1), 45_000).unref());
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start LLM worker');
  process.exit(1);
});
