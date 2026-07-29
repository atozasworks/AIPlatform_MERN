import dotenv from 'dotenv';

dotenv.config();

/**
 * Centralized, validated environment configuration.
 * Avoids `process.env` access scattered across the codebase (coding rule §31).
 */
function required(name, value, { allowEmpty = false } = {}) {
  if (value === undefined || (!allowEmpty && value === '')) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
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

export const env = {
  nodeEnv: NODE_ENV,
  isProd,
  isTest: NODE_ENV === 'test',
  port: Number(process.env.PORT || 5000),
  backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  corsOrigins: [
    ...new Set([
      process.env.FRONTEND_URL || 'http://localhost:5173',
      ...list(process.env.CORS_ORIGINS),
    ]),
  ],

  mongoUri: required('MONGO_URI', process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aichat'),
  redisUrl: process.env.REDIS_URL || '',

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

  ai: {
    defaultProvider: process.env.DEFAULT_AI_PROVIDER || 'mock',
    defaultModel: process.env.DEFAULT_AI_MODEL || 'mock-basic',
    groq: {
      apiKey: process.env.GROQ_API_KEY || '',
      baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      defaultModel: process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      defaultModel: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o-mini',
    },
    // Self-hosted open model via Ollama (your own LLM; no third-party API).
    ollama: {
      enabled: bool(process.env.OLLAMA_ENABLED, false),
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
      models: list(process.env.OLLAMA_MODELS),
      contextWindow: Number(process.env.OLLAMA_CONTEXT_WINDOW || 8192),
    },
    // Self-hosted open model via llama.cpp's `llama-server` (OpenAI-compatible
    // endpoint at {baseUrl}/v1). Your own LLM; no third-party API, no per-token cost.
    llamacpp: {
      enabled: bool(process.env.LLAMACPP_ENABLED, false),
      baseUrl: process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080',
      // llama-server needs no key by default; only set if started with --api-key.
      apiKey: process.env.LLAMACPP_API_KEY || 'llama.cpp',
      // llama-server serves a single loaded model; this id is mainly a display label.
      model: process.env.LLAMACPP_MODEL || 'local-gguf',
      models: list(process.env.LLAMACPP_MODELS),
      contextWindow: Number(process.env.LLAMACPP_CONTEXT_WINDOW || 8192),
      // Cap generation length so slow local CPU inference can't run away and
      // stall/reset the SSE stream. Applied when the caller doesn't specify.
      maxTokens: Number(process.env.LLAMACPP_MAX_TOKENS || 512),
    },
  },

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    max: Number(process.env.RATE_LIMIT_MAX || 120),
    authMax: Number(process.env.AUTH_RATE_LIMIT_MAX || 10),
  },

  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '1mb',
};

export default env;
