import IORedis from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Redis connection management.
 *
 * Three separate clients are required because of protocol constraints:
 *  - `shared`   — ordinary commands (rate limiting, counters, locks)
 *  - `blocking` — BullMQ's blocking reads; must not be shared, and BullMQ
 *                 requires maxRetriesPerRequest: null on this connection
 *  - `subscriber` — a connection in subscribe mode cannot issue other commands
 *
 * Redis must be bound to loopback on the VPS. A non-private REDIS_URL in
 * production is treated as a deployment error rather than a warning, since it
 * would expose queued prompt text to the network.
 */

const PRIVATE_HOST = /^(127\.0\.0\.1|localhost|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function assertPrivateRedis(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: ${url}`);
  }
  if (env.isProd && !PRIVATE_HOST.test(host)) {
    throw new Error(
      `REDIS_URL must point at a private address in production (got "${host}"). ` +
        'Bind Redis to 127.0.0.1 and keep it off the public interface.',
    );
  }
  return url;
}

const baseOptions = {
  lazyConnect: false,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  reconnectOnError: (err) => (err.message.includes('READONLY') ? 2 : false),
};

/** @type {Map<string, import('ioredis').Redis>} */
const clients = new Map();

function build(name, overrides = {}) {
  const url = assertPrivateRedis(env.redis.url);
  const client = new IORedis(url, { ...baseOptions, ...overrides });

  client.on('error', (err) => logger.error({ err, client: name }, 'Redis connection error'));
  client.on('reconnecting', () => logger.warn({ client: name }, 'Redis reconnecting'));
  client.on('ready', () => logger.info({ client: name }, 'Redis ready'));

  clients.set(name, client);
  return client;
}

/** General-purpose client for counters, locks and rate limiting. */
export function getRedis() {
  return clients.get('shared') || build('shared');
}

/** Dedicated connection for BullMQ queues and workers. */
export function getQueueConnection() {
  return (
    clients.get('blocking') ||
    build('blocking', { maxRetriesPerRequest: null, enableReadyCheck: false })
  );
}

/** Dedicated subscriber, used by the SSE stream bus. */
export function getSubscriber() {
  return clients.get('subscriber') || build('subscriber', { maxRetriesPerRequest: null });
}

/** Namespaced key helper so multiple environments can share one Redis. */
export function key(...parts) {
  return [env.redis.prefix, ...parts].join(':');
}

export async function pingRedis() {
  const startedAt = Date.now();
  try {
    const pong = await getRedis().ping();
    return { ok: pong === 'PONG', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: err.message };
  }
}

export async function closeRedis() {
  await Promise.all(
    [...clients.values()].map((c) => c.quit().catch(() => c.disconnect())),
  );
  clients.clear();
}

export default { getRedis, getQueueConnection, getSubscriber, key, pingRedis, closeRedis };
