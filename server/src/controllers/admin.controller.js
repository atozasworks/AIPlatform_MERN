import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { readinessReport } from '../services/health/probes.js';
import { getMetricsSnapshot, getSystemMetrics } from '../services/health/metrics.js';
import { describeModelCompliance } from '../services/ai/modelRegistry.js';
import { getCacheStats } from '../services/rag/vectorStore.js';
import { checkSearchHealth } from '../services/web/searxng.js';
import { pauseQueue, resumeQueue, cleanStaleJobs } from '../services/queue/llmQueue.js';
import { aiGateway } from '../services/ai/AIGateway.js';
import { env, isSelfHostedUrl } from '../config/env.js';

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
     * Live web retrieval — the only outbound path in the system, so its
     * configuration is reported in full for audit rather than summarised.
     *
     * `searxngSelfHosted` should always be true: env.js refuses to boot
     * otherwise. It is asserted again here so the status page proves it instead
     * of assuming it.
     */
    webRetrieval: {
      enabled: env.web.enabled,
      search: await checkSearchHealth(),
      searxngUrl: env.web.searxngUrl || null,
      searxngSelfHosted: env.web.searxngUrl ? isSelfHostedUrl(env.web.searxngUrl) : null,
      allowedDomains: env.web.allowedDomains,
      blockedDomains: env.web.blockedDomains,
      // An empty allowlist means any public host is quotable. Surfaced as an
      // explicit flag because it is the riskier of the two postures.
      unrestrictedDomains: env.web.enabled && env.web.allowedDomains.length === 0,
      maxResults: env.web.maxResults,
      maxFetch: env.web.maxFetch,
      topPassages: env.web.topPassages,
      minScore: env.web.minScore,
      totalBudgetMs: env.web.totalBudgetMs,
      userAgent: env.web.userAgent,
    },

    /**
     * Compliance record. `transmitsDataExternally` is false for every entry and
     * model base URLs are asserted self-hosted at boot, so this remains the
     * auditable statement that no prompt reaches a third-party model. Note that
     * `webRetrieval` above is a separate egress path: it sends search queries
     * out, never prompts or documents.
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
