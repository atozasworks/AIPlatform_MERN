import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { AppError } from '../utils/AppError.js';
import { readinessReport } from '../services/health/probes.js';
import { getMetricsSnapshot, getSystemMetrics } from '../services/health/metrics.js';
import { describeModelCompliance } from '../services/ai/modelRegistry.js';
import { getCacheStats } from '../services/rag/vectorStore.js';
import { checkSearchHealth } from '../services/web/searxng.js';
import { pauseQueue, resumeQueue, cleanStaleJobs } from '../services/queue/llmQueue.js';
import { aiGateway } from '../services/ai/AIGateway.js';
import { env, isSelfHostedUrl } from '../config/env.js';
import { User } from '../models/User.js';
import {
  signAccessToken,
  signRefreshToken,
  cookieOptions,
  clearLegacyHostOnlyAuthCookies,
  COOKIE_NAMES,
} from '../utils/tokens.js';
import {
  listCollections,
  getDocuments,
  getDocument,
  getOverview,
} from '../services/admin/dataBrowser.js';

// Mirror auth.controller's session cookies so the admin panel shares the exact
// same httpOnly JWT session the rest of the platform already trusts. Because
// the access cookie is scoped to path '/', requireAuth on every /admin route
// authenticates the panel with no extra plumbing, and the refresh cookie stays
// on '/api/v1/auth' so the panel reuses the app's existing /auth/refresh.
function issueSession(res, user) {
  clearLegacyHostOnlyAuthCookies(res);
  res.cookie(COOKIE_NAMES.access, signAccessToken(user), cookieOptions('access'));
  res.cookie(COOKIE_NAMES.refresh, signRefreshToken(user), cookieOptions('refresh'));
}

function clearSession(res) {
  clearLegacyHostOnlyAuthCookies(res);
  res.clearCookie(COOKIE_NAMES.access, { ...cookieOptions('access'), maxAge: undefined });
  res.clearCookie(COOKIE_NAMES.refresh, { ...cookieOptions('refresh'), maxAge: undefined });
}

// Locking policy for the admin login endpoint: after this many consecutive
// failures the account is frozen for the cooldown window, blunting brute force
// against the one password-bearing surface in an otherwise passwordless app.
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/**
 * POST /admin/login
 *
 * Email + password sign-in for administrators. Unlike the passwordless user
 * flow (OTP / Google / SSO), the admin panel authenticates with a stored
 * bcrypt password and requires the 'admin' role. On success it issues the
 * standard session cookies via issueSession().
 *
 * Registered BEFORE requireAuth/requireRole in admin.routes.js — it is the one
 * unauthenticated route on the admin router.
 */
export const adminLogin = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    throw AppError.badRequest('Email and password are required');
  }

  // Generic message for every credential failure so the endpoint never reveals
  // whether an email exists, lacks a password, or lacks the admin role.
  const invalid = () => AppError.unauthorized('Invalid email or password');

  const user = await User.findOne({ email, deletedAt: null }).select('+passwordHash');
  if (!user) throw invalid();

  if (user.isLocked()) {
    throw AppError.tooMany('Account temporarily locked after too many attempts. Try again later.');
  }

  const hasAdmin = user.roles?.includes('admin');
  const ok = user.passwordHash ? await user.verifyPassword(password) : false;

  if (!ok || !hasAdmin) {
    // Only count password mismatches toward the lockout; a valid password on a
    // non-admin account is a misconfiguration, not a brute-force signal.
    if (!ok) {
      user.failedLoginCount = (user.failedLoginCount || 0) + 1;
      if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
        user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        user.failedLoginCount = 0;
      }
      await user.save();
    }
    throw invalid();
  }

  user.failedLoginCount = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();

  issueSession(res, user);
  return sendSuccess(res, { user: user.toJSON() });
});

/** GET /admin/me — current administrator (behind requireAuth + requireRole). */
export const adminMe = asyncHandler(async (req, res) => {
  return sendSuccess(res, { user: req.user.toJSON() });
});

/** POST /admin/logout — clears the session cookies. */
export const adminLogout = asyncHandler(async (_req, res) => {
  clearSession(res);
  return sendSuccess(res, { ok: true });
});

/** GET /admin/overview — collection counts for the dashboard. */
export const dbOverview = asyncHandler(async (_req, res) => {
  return sendSuccess(res, await getOverview());
});

/** GET /admin/db/collections — every registered model with a live count. */
export const dbCollections = asyncHandler(async (_req, res) => {
  return sendSuccess(res, { collections: await listCollections() });
});

/** GET /admin/db/collections/:model — paginated, searchable documents. */
export const dbDocuments = asyncHandler(async (req, res) => {
  const { page, limit, search, sort } = req.query;
  const result = await getDocuments(req.params.model, { page, limit, search, sort });
  return sendSuccess(res, result);
});

/** GET /admin/db/collections/:model/:id — a single document. */
export const dbDocument = asyncHandler(async (req, res) => {
  const doc = await getDocument(req.params.model, req.params.id);
  return sendSuccess(res, { document: doc });
});

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

export default {
  adminLogin,
  adminMe,
  adminLogout,
  aiStatus,
  pauseGenerationQueue,
  resumeGenerationQueue,
  cleanQueue,
  dbOverview,
  dbCollections,
  dbDocuments,
  dbDocument,
};
