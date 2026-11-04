/**
 * Copies non-empty GitHub Environment secrets into server/.env.
 *
 * Keys that are unset in GitHub are left as they already are on the VPS.
 * NODE_ENV is never changed: both sites stay production.
 * The script prints how many keys changed and never prints a value.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

const KEYS = [
  'PORT',
  'BACKEND_URL',
  'FRONTEND_URL',
  'CORS_ORIGINS',
  'MONGO_URI',
  'REDIS_URL',
  'REDIS_PREFIX',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
  'COOKIE_DOMAIN',
  'COOKIE_SECURE',
  'COOKIE_SAMESITE',
  'EMAIL_ENABLED',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'OTP_LENGTH',
  'OTP_TTL_MINUTES',
  'OTP_MAX_ATTEMPTS',
  'OTP_RESEND_COOLDOWN_SECONDS',
  'GOOGLE_CLIENT_ID',
  'DEFAULT_AI_PROVIDER',
  'DEFAULT_PROMPT_PROFILE',
  'LLAMACPP_ENABLED',
  'LLAMACPP_BASE_URL',
  'LLAMACPP_API_KEY',
  'LLAMACPP_MODELS',
  'LLAMACPP_MODEL',
  'LLAMACPP_MODELS_MAX',
  'LLAMACPP_CATALOG_TTL_MS',
  'LLAMACPP_CONTEXT_WINDOW',
  'LLAMACPP_REQUEST_TIMEOUT_MS',
  'LLAMACPP_THINKING',
  'EMBEDDING_ENABLED',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSIONS',
  'EMBEDDING_BATCH_SIZE',
  'EMBEDDING_REQUEST_TIMEOUT_MS',
  'EMBEDDING_QUERY_PREFIX',
  'EMBEDDING_PASSAGE_PREFIX',
  'GPU_ENABLED',
  'GPU_BASE_URL',
  'GPU_API_KEY',
  'GPU_MODEL',
  'SELF_HOSTED_ALLOWED_HOSTS',
  'MAX_ACTIVE_REQUESTS_PER_USER',
  'MAX_REQUESTS_PER_MINUTE',
  'MAX_REQUESTS_PER_HOUR',
  'MAX_QUEUE_SIZE',
  'MAX_PROMPT_TOKENS',
  'MAX_OUTPUT_TOKENS_NORMAL',
  'MAX_OUTPUT_TOKENS_DETAILED',
  'MAX_CONVERSATION_CONTEXT_TOKENS',
  'MAX_RETRIEVAL_CONTEXT_TOKENS',
  'LLM_WORKER_CONCURRENCY',
  'QUEUE_STALE_MS',
  'STREAM_IDLE_TIMEOUT_MS',
  'SSE_HEARTBEAT_MS',
  'JOB_ATTEMPTS',
  'BREAKER_FAILURE_THRESHOLD',
  'BREAKER_WINDOW_MS',
  'BREAKER_COOLDOWN_MS',
  'RAG_ENABLED',
  'RAG_TOP_K',
  'RAG_CANDIDATE_LIMIT',
  'RAG_MIN_SCORE',
  'RAG_CHUNK_TOKENS',
  'RAG_CHUNK_OVERLAP_TOKENS',
  'RAG_VECTOR_WEIGHT',
  'RAG_MAX_UPLOAD_BYTES',
  'RAG_MAX_DOCUMENTS_PER_USER',
  'RAG_VECTOR_CACHE_MAX_CHUNKS',
  'WEB_RETRIEVAL_ENABLED',
  'SEARXNG_BASE_URL',
  'WEB_ALLOWED_DOMAINS',
  'WEB_MAX_FETCH',
  'WEB_TOP_PASSAGES',
  'WEB_TOTAL_BUDGET_MS',
  'WEB_RERANK_MODE',
  'WEB_MAX_RERANK_PASSAGES',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'AUTH_RATE_LIMIT_MAX',
  'JSON_BODY_LIMIT',
  'MODEL_SHA256_QWEN3_14B',
  'MODEL_SHA256_EMBEDDING',
  'ATOZAS_SSO_ENABLED',
  'ATOZAS_ISSUER',
  'ATOZAS_CLIENT_ID',
  'ATOZAS_CLIENT_SECRET',
  'ATOZAS_REDIRECT_URI',
  'ATOZAS_SCOPE',
  'ATOZAS_AUTHORIZE_URL',
  'ATOZAS_TOKEN_URL',
  'ATOZAS_USERINFO_URL',
  'ATOZAS_REVOKE_URL',
  'ATOZAS_TOKEN_AUTH_STYLE',
  'ATOZAS_HOMEPAGE_KEY',
  'ATOZAS_SESSION_COOKIE_NAME',
  'ATOZAS_SESSION_SECRET',
  'ATOZAS_SESSION_MAX_AGE_DAYS',
  'ATOZAS_SESSION_COLLECTION',
  'ATOZAS_COOKIE_SECURE',
  'ATOZAS_COOKIE_SAMESITE',
  'ATOZAS_AUTO_REDIRECT',
];

function formatValue(value) {
  if (/[\s#"'\n\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

if (!existsSync(envPath)) {
  console.error('[sync-env] server/.env is missing');
  process.exit(1);
}

const raw = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/);
const pending = new Map();
for (const key of KEYS) {
  const value = process.env[key];
  if (value == null || value === '') continue;
  pending.set(key, `${key}=${formatValue(value)}`);
}
const seen = new Set();
const next = lines.map((line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
  if (!match || !pending.has(match[1])) return line;
  seen.add(match[1]);
  return pending.get(match[1]);
});
for (const [key, line] of pending) {
  if (!seen.has(key)) next.push(line);
}
const text = `${next.filter((line, index) => line !== '' || index !== next.length - 1).join('\n')}\n`;
writeFileSync(envPath, text);
const count = pending.size;
console.log(`[sync-env] updated ${count} keys in server/.env`);
