import dotenv from 'dotenv';

dotenv.config();

/**
 * Centralized, validated environment configuration.
 * Avoids `process.env` access scattered across the codebase (coding rule §31).
 *
 * ATOZAS policy: every inference, embedding and retrieval component addressed
 * here must be self-hosted on ATOZAS-controlled infrastructure. Provider base
 * URLs are asserted against `assertSelfHosted()` at boot so a misconfigured
 * deployment fails loudly instead of silently shipping prompts to a vendor.
 */
function required(name, value, { allowEmpty = false } = {}) {
  if (value === undefined || (!allowEmpty && value === '')) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

/**
 * Hostnames that count as ATOZAS-controlled. Anything else is rejected for
 * inference/embedding traffic. Extend via SELF_HOSTED_ALLOWED_HOSTS when the
 * dedicated GPU box lands on a private address or VPN hostname.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
const extraSelfHosted = new Set(list(process.env.SELF_HOSTED_ALLOWED_HOSTS));

/** True for loopback, RFC1918 private ranges, and explicitly allowlisted hosts. */
export function isSelfHostedUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (LOCAL_HOSTS.has(host)) return true;
  if (extraSelfHosted.has(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * Fails startup when an inference endpoint points outside ATOZAS infrastructure.
 * This is the hard guarantee behind "no third-party LLM API".
 *
 * Scope note: this guards *model* traffic — prompts, documents and embeddings.
 * Live web retrieval (`services/web/`) deliberately makes outbound requests and
 * is governed by the separate `env.web` block below. The two are kept apart on
 * purpose: retrieval fetching a public news page is a different risk from a
 * prompt leaving the box, and collapsing them into one switch would make it
 * impossible to audit either.
 */
export function assertSelfHosted(label, rawUrl) {
  if (!isSelfHostedUrl(rawUrl)) {
    throw new Error(
      `${label} must point at ATOZAS-controlled infrastructure (loopback, private range, ` +
        `or SELF_HOSTED_ALLOWED_HOSTS). Refusing to start with: ${rawUrl}`,
    );
  }
  return rawUrl;
}

const llamacppBaseUrl = (process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8081').replace(
  /\/+$/,
  '',
);
const embeddingBaseUrl = (process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:8082').replace(
  /\/+$/,
  '',
);
const gpuBaseUrl = (process.env.GPU_BASE_URL || '').replace(/\/+$/, '');
const searxngBaseUrl = (process.env.SEARXNG_BASE_URL || '').replace(/\/+$/, '');

export const env = {
  nodeEnv: NODE_ENV,
  isProd,
  isTest: NODE_ENV === 'test',
  port: num(process.env.PORT, 5000),
  backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  corsOrigins: [
    ...new Set([
      process.env.FRONTEND_URL || 'http://localhost:5173',
      ...list(process.env.CORS_ORIGINS),
    ]),
  ],

  mongoUri: required('MONGO_URI', process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aichat'),

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    prefix: process.env.REDIS_PREFIX || 'atozas',
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET),
    refreshSecret: required('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET),
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },

  cookie: {
    domain: process.env.COOKIE_DOMAIN || undefined,
    secure: bool(process.env.COOKIE_SECURE, isProd),
    sameSite: isProd ? 'strict' : 'lax',
  },

  /**
   * Passwordless email OTP + Google Sign-In.
   *
   * OTP delivery uses SMTP (Gmail by default). When SMTP credentials are absent
   * the email service falls back to logging the code (development only) so the
   * flow stays testable without wiring a mailbox.
   */
  auth: {
    otp: {
      length: num(process.env.OTP_LENGTH, 6),
      ttlMinutes: num(process.env.OTP_TTL_MINUTES, 10),
      maxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 5),
      // Minimum seconds between two code requests for the same email.
      resendCooldownSeconds: num(process.env.OTP_RESEND_COOLDOWN_SECONDS, 60),
    },
    google: {
      // Same value is exposed to the client as VITE_GOOGLE_CLIENT_ID at build time.
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      get enabled() {
        return Boolean(this.clientId);
      },
    },
  },

  email: {
    // When false (or SMTP creds missing) OTP codes are logged instead of sent.
    enabled: bool(process.env.EMAIL_ENABLED, false),
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: num(process.env.SMTP_PORT, 465),
    secure: bool(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || 'ATOZAS AI <no-reply@atozasai.com>',
  },

  ai: {
    // Only self-hosted engines are selectable. There is no external fallback.
    defaultProvider: process.env.DEFAULT_AI_PROVIDER || 'llamacpp',
    defaultProfile: process.env.DEFAULT_PROMPT_PROFILE || 'balanced',

    /**
     * Chat models served by `llama-server` in router mode (OpenAI-format
     * endpoint at {baseUrl}/v1).
     *
     * One router process fronts every chat model and spawns a child server per
     * model on demand, evicting least-recently-used ones once `routerMaxLoaded`
     * are resident. That is what makes a four-model picker affordable on a
     * CPU box: only the selected model holds weights and KV cache in RAM.
     */
    llamacpp: {
      enabled: bool(process.env.LLAMACPP_ENABLED, true),
      baseUrl: llamacppBaseUrl,
      // llama-server only checks this when started with --api-key.
      apiKey: process.env.LLAMACPP_API_KEY || '',
      // Empty = every chat model in modelRegistry.js. Narrow it per deployment
      // when a host does not have all the weights on disk.
      models: list(process.env.LLAMACPP_MODELS),
      defaultModel: process.env.LLAMACPP_MODEL || 'qwen3-4b-instruct-2507',
      // Fallback prompt budget for models with no registry runtime entry.
      contextWindow: num(process.env.LLAMACPP_CONTEXT_WINDOW, 8192),
      // Mirrors --models-max. 1 keeps a single model resident, which is the
      // only safe setting on a 16 GB box; raise it when RAM allows.
      routerMaxLoaded: num(process.env.LLAMACPP_MODELS_MAX, 1),
      // How long the cached /v1/models availability snapshot stays fresh.
      catalogTtlMs: num(process.env.LLAMACPP_CATALOG_TTL_MS, 30000),
      // Wall-clock ceiling for one generation on CPU before the worker aborts.
      requestTimeoutMs: num(process.env.LLAMACPP_REQUEST_TIMEOUT_MS, 300000),
      // Qwen3 supports a reasoning mode; CPU-only deployments keep it off.
      thinking: bool(process.env.LLAMACPP_THINKING, false),
    },

    /** Second llama-server instance dedicated to embeddings (never the chat model). */
    embeddings: {
      enabled: bool(process.env.EMBEDDING_ENABLED, true),
      baseUrl: embeddingBaseUrl,
      apiKey: process.env.EMBEDDING_API_KEY || '',
      model: process.env.EMBEDDING_MODEL || 'qwen3-embedding-0.6b',
      dimensions: num(process.env.EMBEDDING_DIMENSIONS, 1024),
      batchSize: num(process.env.EMBEDDING_BATCH_SIZE, 16),
      requestTimeoutMs: num(process.env.EMBEDDING_REQUEST_TIMEOUT_MS, 60000),
      /**
       * Retrieval embedding models are asymmetric: the query and the stored
       * passage must be wrapped differently or similarity collapses. Qwen3
       * wants an instruction block on the query and raw text on the passage.
       * Both are configurable so swapping the model stays a config change.
       */
      queryPrefix:
        process.env.EMBEDDING_QUERY_PREFIX ??
        'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
      passagePrefix: process.env.EMBEDDING_PASSAGE_PREFIX ?? '',
    },

    /**
     * Future ATOZAS-owned GPU node. "OpenAI-compatible" describes the wire
     * format only; the URL is still forced through assertSelfHosted().
     */
    gpu: {
      enabled: bool(process.env.GPU_ENABLED, false),
      baseUrl: gpuBaseUrl,
      apiKey: process.env.GPU_API_KEY || '',
      model: process.env.GPU_MODEL || '',
      contextWindow: num(process.env.GPU_CONTEXT_WINDOW, 32768),
      requestTimeoutMs: num(process.env.GPU_REQUEST_TIMEOUT_MS, 120000),
    },
  },

  /** Server-side usage ceilings. Every value is operator-tunable. */
  limits: {
    maxActiveRequestsPerUser: num(process.env.MAX_ACTIVE_REQUESTS_PER_USER, 1),
    maxRequestsPerMinute: num(process.env.MAX_REQUESTS_PER_MINUTE, 5),
    maxRequestsPerHour: num(process.env.MAX_REQUESTS_PER_HOUR, 40),
    maxQueueSize: num(process.env.MAX_QUEUE_SIZE, 100),
    maxPromptTokens: num(process.env.MAX_PROMPT_TOKENS, 4000),
    maxOutputTokensNormal: num(process.env.MAX_OUTPUT_TOKENS_NORMAL, 800),
    maxOutputTokensDetailed: num(process.env.MAX_OUTPUT_TOKENS_DETAILED, 1500),
    maxConversationContextTokens: num(process.env.MAX_CONVERSATION_CONTEXT_TOKENS, 6000),
    maxRetrievalContextTokens: num(process.env.MAX_RETRIEVAL_CONTEXT_TOKENS, 3000),
    workerConcurrency: num(process.env.LLM_WORKER_CONCURRENCY, 2),
    // How long a job may sit queued before it is dropped as stale.
    queueStaleMs: num(process.env.QUEUE_STALE_MS, 120000),
    // How long the SSE relay waits for the worker before giving up.
    streamIdleTimeoutMs: num(process.env.STREAM_IDLE_TIMEOUT_MS, 120000),
    sseHeartbeatMs: num(process.env.SSE_HEARTBEAT_MS, 15000),
    jobAttempts: num(process.env.JOB_ATTEMPTS, 2),
  },

  /** Circuit breaker around llama-server. */
  breaker: {
    failureThreshold: num(process.env.BREAKER_FAILURE_THRESHOLD, 5),
    windowMs: num(process.env.BREAKER_WINDOW_MS, 60000),
    cooldownMs: num(process.env.BREAKER_COOLDOWN_MS, 30000),
  },

  rag: {
    enabled: bool(process.env.RAG_ENABLED, true),
    topK: num(process.env.RAG_TOP_K, 6),
    // Candidates pulled from keyword search before vector rescoring.
    candidateLimit: num(process.env.RAG_CANDIDATE_LIMIT, 200),
    minScore: Number(process.env.RAG_MIN_SCORE ?? 0.72),
    chunkTokens: num(process.env.RAG_CHUNK_TOKENS, 380),
    chunkOverlapTokens: num(process.env.RAG_CHUNK_OVERLAP_TOKENS, 60),
    // Weight of dense similarity in the hybrid score (rest goes to keyword).
    vectorWeight: Number(process.env.RAG_VECTOR_WEIGHT ?? 0.75),
    maxUploadBytes: num(process.env.RAG_MAX_UPLOAD_BYTES, 2 * 1024 * 1024),
    // Upper bound on the in-process similarity cache. 100k chunks of 384 dims
    // is roughly 150 MB resident — safe on a 32 GB box, tune down if not.
    vectorCacheMaxChunks: num(process.env.RAG_VECTOR_CACHE_MAX_CHUNKS, 100000),
    maxDocumentsPerUser: num(process.env.RAG_MAX_DOCUMENTS_PER_USER, 200),
  },

  /**
   * Live web retrieval — the only component in ATOZAS that talks to the public
   * internet.
   *
   * Why it exists: a 4B model's weights are frozen at its training cutoff, so
   * "what is the current version of X" or "what happened today" cannot be
   * answered honestly from the model alone. Retrieval supplies dated, cited
   * source text and the model summarises it.
   *
   * What it does NOT do: no prompt, conversation or uploaded document is ever
   * sent outward. Only a short search query derived from the user's question
   * reaches SearXNG (self-hosted), and only public URLs are fetched. The model
   * itself stays on loopback under `assertSelfHosted()`.
   *
   * Disabled by default. A deployment that must keep zero egress simply leaves
   * WEB_RETRIEVAL_ENABLED unset and behaves exactly as it did before.
   */
  web: {
    enabled: bool(process.env.WEB_RETRIEVAL_ENABLED, false),

    /**
     * Self-hosted SearXNG instance (open-source metasearch). Required: there is
     * deliberately no fallback to a commercial search API, because that would
     * put the user's question in a third party's logs.
     */
    searxngUrl: searxngBaseUrl,
    searxngEngines: list(process.env.SEARXNG_ENGINES),
    // SearXNG's own categories; 'general' plus 'news' covers current events.
    searxngCategories: list(process.env.SEARXNG_CATEGORIES).length
      ? list(process.env.SEARXNG_CATEGORIES)
      : ['general'],
    searxngLanguage: process.env.SEARXNG_LANGUAGE || 'en',
    searxngTimeoutMs: num(process.env.SEARXNG_TIMEOUT_MS, 8000),

    /** How many search hits to consider, and how many of those to actually fetch. */
    maxResults: num(process.env.WEB_MAX_RESULTS, 8),
    maxFetch: num(process.env.WEB_MAX_FETCH, 4),
    /** Passages handed to the model after reranking. */
    topPassages: num(process.env.WEB_TOP_PASSAGES, 4),

    /**
     * How passages are scored against the question.
     *
     * 'lexical' (default) is BM25-style term overlap: microseconds, no inference.
     * 'embedding' uses the local embedding server, which measured ~5.5 seconds
     * per passage on the ATOZAS CPU box — more than the entire retrieval budget
     * for even four passages. See services/web/rerank.js for the measurement.
     * Only worth enabling on a GPU or dedicated embedding host.
     */
    rerankMode: process.env.WEB_RERANK_MODE === 'embedding' ? 'embedding' : 'lexical',

    /**
     * Ceiling on how many passages are scored. Effectively free under lexical
     * scoring; under 'embedding' this is the knob that decides whether reranking
     * fits in the budget at all.
     */
    maxRerankPassages: num(process.env.WEB_MAX_RERANK_PASSAGES, 40),

    /**
     * Per-page fetch limits. A CPU box cannot afford to stream a 40 MB page
     * through an HTML parser, and a slow origin must not hold a generation slot.
     */
    fetchTimeoutMs: num(process.env.WEB_FETCH_TIMEOUT_MS, 6000),
    maxPageBytes: num(process.env.WEB_MAX_PAGE_BYTES, 2 * 1024 * 1024),
    /** Wall-clock ceiling for the whole retrieval phase, fetches included. */
    totalBudgetMs: num(process.env.WEB_TOTAL_BUDGET_MS, 20000),

    /**
     * Empty allowlist means "any public host". Set it to pin retrieval to
     * sources ATOZAS is willing to quote — official docs, gov sites, a chosen
     * news set — which is the recommended production posture.
     */
    allowedDomains: list(process.env.WEB_ALLOWED_DOMAINS),
    blockedDomains: list(process.env.WEB_BLOCKED_DOMAINS),

    /** Identifies ATOZAS to origin servers; some sites block blank agents. */
    userAgent:
      process.env.WEB_USER_AGENT ||
      'ATOZAS-AI/1.0 (+https://atozasai.com; self-hosted retrieval bot)',

    /** Redis TTLs. Repeated questions must not re-hit the same origins. */
    searchCacheTtlSeconds: num(process.env.WEB_SEARCH_CACHE_TTL_SECONDS, 900),
    pageCacheTtlSeconds: num(process.env.WEB_PAGE_CACHE_TTL_SECONDS, 3600),

    /**
     * Minimum rerank score for a web passage to be quoted.
     *
     * The default has to depend on the rerank mode, because the two modes emit
     * scores on unrelated scales and a single number cannot serve both. Embedding
     * mode yields cosine similarity, where 0.45 is a weak-but-real match. Lexical
     * mode yields IDF-weighted query coverage, which tops out well below 1 once
     * term-frequency saturation and length normalization are applied.
     *
     * The lexical default was measured, not guessed. Scoring 49 passages from two
     * real fetched pages:
     *
     *   | question the pages answer     | best passages 0.20 - 0.67 |
     *   | question they do not          | best passages 0.06 - 0.07 |
     *
     * 0.15 sits in the gap with roughly a 2x margin either side. Reusing 0.45
     * here rejected every passage, including correct ones, which is the failure
     * this split prevents.
     *
     * Independent of RAG_MIN_SCORE in either mode: web text is noisier than
     * curated uploads, and search already applied its own relevance filter.
     */
    minScore: Number(
      process.env.WEB_MIN_SCORE ??
        (process.env.WEB_RERANK_MODE === 'embedding' ? 0.45 : 0.15),
    ),
  },

  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    max: num(process.env.RATE_LIMIT_MAX, 120),
    authMax: num(process.env.AUTH_RATE_LIMIT_MAX, 10),
  },

  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '1mb',
};

// Boot-time egress guarantee for model traffic. Runs on the API process and the
// worker process. Web retrieval is intentionally not covered here; see env.web.
if (env.ai.llamacpp.enabled) assertSelfHosted('LLAMACPP_BASE_URL', env.ai.llamacpp.baseUrl);
if (env.ai.embeddings.enabled) assertSelfHosted('EMBEDDING_BASE_URL', env.ai.embeddings.baseUrl);
if (env.ai.gpu.enabled) assertSelfHosted('GPU_BASE_URL', env.ai.gpu.baseUrl);

/**
 * SearXNG is a search *aggregator*, not a model endpoint, but it still sees the
 * user's query, so it is held to the same self-hosting rule. Pointing this at a
 * public SearXNG instance would hand every question to a third party — the
 * exact leak the rest of this file exists to prevent.
 */
if (env.web.enabled) {
  if (!env.web.searxngUrl) {
    throw new Error(
      'WEB_RETRIEVAL_ENABLED=true requires SEARXNG_BASE_URL. Run the bundled ' +
        'self-hosted SearXNG (deploy/searxng/) — a public instance would leak user queries.',
    );
  }
  assertSelfHosted('SEARXNG_BASE_URL', env.web.searxngUrl);
}

export default env;
