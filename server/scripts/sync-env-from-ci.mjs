/**
 * Copies non-empty GitHub Environment secrets into server/.env.
 *
 * Keys that are unset in GitHub are left as they already are on the VPS.
 * NODE_ENV is never changed: both sites stay production.
 * Model and SearXNG URLs are written only when the host is loopback, a
 * private range, or listed in SELF_HOSTED_ALLOWED_HOSTS. A public URL is
 * skipped so the API can still boot. The script prints key names and
 * hostnames, never a secret value.
 *
 * SYNC_ENV_FILE is a local test override. It is not a server setting.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const envPath = process.env.SYNC_ENV_FILE
  ? path.resolve(process.env.SYNC_ENV_FILE)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

const URL_KEYS = new Set([
  'LLAMACPP_BASE_URL',
  'EMBEDDING_BASE_URL',
  'GPU_BASE_URL',
  'SEARXNG_BASE_URL',
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

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

function cleanIncoming(value) {
  let next = String(value)
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\r/g, '');
  if (
    next.length >= 2 &&
    ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'")))
  ) {
    next = unquote(next);
  }
  return next;
}

function formatValue(value) {
  if (/[\s#"'\n\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

function unquote(raw) {
  const value = String(raw).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function allowlistFrom(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/** Same rule as assertSelfHosted in src/config/env.js. Do not import that module. */
function isSelfHostedUrl(rawUrl, allow) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (LOCAL_HOSTS.has(host)) return true;
  if (allow.has(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname || '(invalid url)';
  } catch {
    return '(invalid url)';
  }
}

if (!existsSync(envPath)) {
  console.error('[sync-env] server/.env is missing');
  process.exit(1);
}

const raw = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/);
const existing = new Map();
for (const line of lines) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (match) existing.set(match[1], unquote(match[2]));
}
const allowSource =
  process.env.SELF_HOSTED_ALLOWED_HOSTS != null && process.env.SELF_HOSTED_ALLOWED_HOSTS !== ''
    ? process.env.SELF_HOSTED_ALLOWED_HOSTS
    : existing.get('SELF_HOSTED_ALLOWED_HOSTS') || '';
const allow = allowlistFrom(allowSource);
const pending = new Map();
const skipped = [];
for (const key of KEYS) {
  let value = process.env[key];
  if (value == null || value === '') continue;
  value = cleanIncoming(value);
  if (key === 'GOOGLE_CLIENT_ID' || URL_KEYS.has(key)) value = value.trim();
  if (value === '') continue;
  if (URL_KEYS.has(key) && !isSelfHostedUrl(value, allow)) {
    const host = hostnameOf(value);
    skipped.push(host === '(invalid url)' ? `${key} (not a url)` : `${key} (${host})`);
    continue;
  }
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
for (const item of skipped) {
  console.error(
    `[sync-env] skipped ${item}; host is not loopback, a private range, or SELF_HOSTED_ALLOWED_HOSTS. Left the existing server/.env value in place.`,
  );
}
console.log(`[sync-env] updated ${pending.size} keys in server/.env`);
