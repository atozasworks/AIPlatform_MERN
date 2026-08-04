import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { readinessReport } from '../services/health/probes.js';
import { getMetricsSnapshot, getSystemMetrics } from '../services/health/metrics.js';
import { describeModelCompliance } from '../services/ai/modelRegistry.js';
import { getCacheStats } from '../services/rag/vectorStore.js';
import { pauseQueue, resumeQueue, cleanStaleJobs } from '../services/queue/llmQueue.js';
import { aiGateway } from '../services/ai/AIGateway.js';
import { env } from '../config/env.js';

/**
 * Administrative visibility into the inference platform.
 * Every route here is behind requireAuth + requireRole('admin').
 */

/**
 * GET /admin/ai/status
 *
 * One call answering: is the model up, how deep is the queue, how fast is it
 * generating, is the host under pressure, and is every loaded model licensed
 * and checksum-verified.
 */
export const aiStatus = asyncHandler(async (_req, res) => {
  const [report, metrics] = await Promise.all([readinessReport(), getMetricsSnapshot()]);

  const llamacpp = aiGateway.providers.get('llamacpp');
  const [serverProps, chatModels] = await Promise.all([
    llamacpp?.isAvailable() ? llamacpp.getServerProps() : null,
    aiGateway.listModels(),
  ]);

  return sendSuccess(res, {
    ready: report.ready,
    checks: report.checks,
    queue: report.queue,
    breaker: report.breaker,

    inference: {
      defaultProvider: env.ai.defaultProvider,
      defaultModel: env.ai.llamacpp.defaultModel,
      configuredContextWindow: env.ai.llamacpp.contextWindow,
      // Router mode keeps at most this many models resident, evicting by LRU.
      maxLoadedModels: env.ai.llamacpp.routerMaxLoaded,
      // Which of the configured models the router is actually serving, and why
      // any of them are not.
      models: chatModels.map((m) => ({
        id: m.id,
        provider: m.provider,
        available: m.available,
        unavailableReason: m.unavailableReason || null,
        contextWindow: m.contextWindow,
        license: m.license,
      })),
      // What llama-server actually loaded, which can differ from the .env.
      runtime: serverProps,
      thinkingMode: env.ai.llamacpp.thinking ? 'enabled' : 'disabled',
      workerConcurrency: env.limits.workerConcurrency,
    },

    limits: env.limits,

    retrieval: {
      enabled: env.rag.enabled,
      embeddingModel: env.ai.embeddings.model,
      dimensions: env.ai.embeddings.dimensions,
      topK: env.rag.topK,
      minScore: env.rag.minScore,
      vectorCache: getCacheStats(),
    },

    /**
     * Compliance record. `transmitsDataExternally` is false for every entry and
     * base URLs are asserted self-hosted at boot, so this is the auditable
     * statement that no prompt leaves ATOZAS infrastructure.
     */
    models: describeModelCompliance(),

    metrics,
    system: getSystemMetrics(),
  });
});

/** POST /admin/ai/queue/pause — stop admitting work (maintenance, model swap). */
export const pauseGenerationQueue = asyncHandler(async (_req, res) => {
  await pauseQueue();
  return sendSuccess(res, { paused: true });
});

/** POST /admin/ai/queue/resume */
export const resumeGenerationQueue = asyncHandler(async (_req, res) => {
  await resumeQueue();
  return sendSuccess(res, { paused: false });
});

/** POST /admin/ai/queue/clean — drop jobs whose clients are long gone. */
export const cleanQueue = asyncHandler(async (_req, res) => {
  const removed = await cleanStaleJobs();
  return sendSuccess(res, { removed });
});

export default { aiStatus, pauseGenerationQueue, resumeGenerationQueue, cleanQueue };
