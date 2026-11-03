import mongoose from 'mongoose';
import { pingRedis } from '../../config/redis.js';
import { aiGateway } from '../ai/AIGateway.js';
import { checkEmbeddingHealth } from '../rag/embeddings.js';
import { getQueueDepth, isQueuePaused } from '../queue/llmQueue.js';
import { getBreakerState } from '../queue/circuitBreaker.js';
import { env } from '../../config/env.js';

/**
 * Dependency probes behind the health endpoints.
 *
 * Liveness and readiness answer different questions and must not share logic:
 * liveness asks "is this process wedged?" (restart me), readiness asks "can I
 * serve traffic?" (stop routing to me). Conflating them makes a brief Redis
 * blip restart a healthy API process.
 */

export async function checkMongo() {
  const startedAt = Date.now();
  // 1 = connected. Anything else means queries would buffer or fail.
  if (mongoose.connection.readyState !== 1) {
    return { ok: false, state: mongoose.connection.readyState, latencyMs: 0 };
  }
  try {
    await mongoose.connection.db.admin().ping();
    return { ok: true, state: 1, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, state: mongoose.connection.readyState, error: err.message };
  }
}

export async function checkRedis() {
  return pingRedis();
}

export async function checkInference() {
  const report = await aiGateway.healthReport();
  const active = report[env.ai.defaultProvider] || { ok: false, reason: 'not registered' };
  return { ...active, provider: env.ai.defaultProvider, engines: report };
}

export async function checkEmbeddings() {
  return checkEmbeddingHealth();
}

/**
 * Admission-time inference gate.
 *
 * `aiGateway.resolve()` only proves an engine is configured and enabled; it
 * cannot tell that llama-server has died. Without a live check the first
 * requests after an outage are accepted, written to the database and queued,
 * and only fail once the worker has burned through the breaker threshold —
 * the user sees a broken stream instead of the 503 the contract promises.
 *
 * Probing on every message would add a round-trip to the hot path, so the
 * verdict is cached briefly and concurrent callers share one in-flight probe.
 * The cache is deliberately asymmetric: a healthy result is trusted longer,
 * while an unhealthy one is rechecked quickly so recovery is picked up fast.
 */
const AVAILABILITY_TTL_MS = { ok: 5000, down: 1000 };
let availability = { checkedAt: 0, ok: false, detail: null };
let availabilityProbe = null;

export async function isInferenceAvailable() {
  const now = Date.now();
  const ttl = availability.ok ? AVAILABILITY_TTL_MS.ok : AVAILABILITY_TTL_MS.down;
  if (availability.checkedAt && now - availability.checkedAt < ttl) return availability;

  // Bounded for the same reason as the readiness probes: this runs on the
  // admission path, so a wedged engine must fail the request fast rather than
  // hold the HTTP handler open.
  availabilityProbe ??= withTimeout(
    checkInference().catch((err) => ({ ok: false, error: err.message })),
    PROBE_TIMEOUT_MS,
    { ok: false, error: 'probe timed out' },
  )
    .then((detail) => {
      availability = { checkedAt: Date.now(), ok: Boolean(detail.ok), detail };
      availabilityProbe = null;
      return availability;
    });

  return availabilityProbe;
}

/** Drops the cached verdict so the next caller re-probes. Used after a restart. */
export function resetInferenceAvailability() {
  availability = { checkedAt: 0, ok: false, detail: null };
}

/**
 * Caps a probe so a wedged dependency cannot stall the health endpoint.
 *
 * This is not defensive padding. The BullMQ connection is built with
 * `maxRetriesPerRequest: null` (BullMQ requires it), which means that when
 * Redis is unreachable its commands queue indefinitely instead of rejecting:
 * `getQueueDepth()` never settles, `Promise.all` below never resolves, and
 * `/api/health/ready` hangs open rather than answering 503. A load balancer or
 * the cron watchdog in deploy/README.md would then see a timeout instead of a
 * clear "not ready", which is the opposite of what a readiness probe is for.
 */
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const PROBE_TIMEOUT_MS = 2500;

/**
 * Full readiness assessment.
 *
 * Embeddings are intentionally not required: retrieval degrades to keyword-only
 * when the embedding server is down, and refusing all chat traffic for that
 * would be a worse outcome than slightly weaker citations.
 *
 * Every probe is bounded, so this function always resolves.
 */
export async function readinessReport() {
  const probe = (p, fallback) => withTimeout(Promise.resolve(p).catch(() => fallback), PROBE_TIMEOUT_MS, fallback);

  const [mongo, redis, inference, embeddings, queue, paused, breaker] = await Promise.all([
    probe(checkMongo(), { ok: false, error: 'probe timed out' }),
    probe(checkRedis(), { ok: false, error: 'probe timed out' }),
    probe(checkInference(), { ok: false, error: 'probe timed out' }),
    probe(checkEmbeddings(), { ok: false, enabled: env.ai.embeddings.enabled, error: 'probe timed out' }),
    probe(getQueueDepth(), null),
    probe(isQueuePaused(), false),
    probe(getBreakerState(), { state: 'unknown' }),
  ]);

  const required = { mongo: mongo.ok, redis: redis.ok, inference: inference.ok };
  const ready = Object.values(required).every(Boolean) && !paused && breaker.state !== 'open';

  return {
    ready,
    checks: {
      mongo,
      redis,
      inference,
      embeddings: { ...embeddings, required: false },
    },
    queue: queue ? { ...queue, paused } : { paused },
    breaker,
  };
}

export default {
  readinessReport,
  checkMongo,
  checkRedis,
  checkInference,
  checkEmbeddings,
  isInferenceAvailable,
  resetInferenceAvailability,
};
