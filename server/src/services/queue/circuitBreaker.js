import { getRedis, key } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Circuit breaker around llama-server, shared across processes via Redis.
 *
 * When CPU inference starts failing — the model crashed, the box is swapping,
 * requests are timing out — retrying immediately makes it worse. After
 * BREAKER_FAILURE_THRESHOLD failures inside BREAKER_WINDOW_MS the circuit
 * opens: new work is refused with a 503 and the queue is paused so jobs stop
 * being pulled. After the cooldown one probe request is allowed through
 * (half-open); success closes the circuit, failure re-opens it.
 */

const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

const failuresKey = key('breaker', 'failures');
const openUntilKey = key('breaker', 'open_until');
const probeKey = key('breaker', 'probe');

/** @returns {Promise<{state: string, openForMs: number, failures: number}>} */
export async function getBreakerState() {
  const redis = getRedis();
  const [openUntilRaw, failures] = await Promise.all([
    redis.get(openUntilKey),
    redis.zcount(failuresKey, Date.now() - env.breaker.windowMs, Date.now()),
  ]);

  const openUntil = Number(openUntilRaw || 0);
  const now = Date.now();

  if (openUntil > now) {
    return { state: STATE.OPEN, openForMs: openUntil - now, failures };
  }
  if (openUntil > 0) {
    return { state: STATE.HALF_OPEN, openForMs: 0, failures };
  }
  return { state: STATE.CLOSED, openForMs: 0, failures };
}

/**
 * Gate checked by the worker before each generation.
 *
 * @returns {Promise<{allowed: boolean, state: string, retryAfterMs?: number, probe?: boolean}>}
 */
export async function requestPermission() {
  const redis = getRedis();
  const { state, openForMs } = await getBreakerState();

  if (state === STATE.CLOSED) return { allowed: true, state };

  if (state === STATE.OPEN) {
    return { allowed: false, state, retryAfterMs: openForMs };
  }

  // Half-open: let exactly one probe through per cooldown period.
  const gotProbe = await redis.set(probeKey, '1', 'PX', env.breaker.cooldownMs, 'NX');
  if (!gotProbe) {
    return { allowed: false, state, retryAfterMs: env.breaker.cooldownMs };
  }
  return { allowed: true, state, probe: true };
}

/** Clears the failure window and closes the circuit. */
export async function recordSuccess() {
  const redis = getRedis();
  const { state } = await getBreakerState();
  if (state === STATE.CLOSED) return { state, changed: false };

  await redis.multi().del(failuresKey).del(openUntilKey).del(probeKey).exec();
  logger.info('Inference circuit breaker closed after successful probe');
  return { state: STATE.CLOSED, changed: true };
}

/**
 * Records a failure and opens the circuit once the threshold is crossed.
 * Only infrastructure failures should be reported here — a user-caused 400
 * must not count towards tripping the breaker.
 *
 * @returns {Promise<{state: string, opened: boolean, failures: number}>}
 */
export async function recordFailure(reason) {
  const redis = getRedis();
  const now = Date.now();
  const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;

  const [, , countRes] = await redis
    .multi()
    .zremrangebyscore(failuresKey, 0, now - env.breaker.windowMs)
    .zadd(failuresKey, now, member)
    .zcard(failuresKey)
    .pexpire(failuresKey, env.breaker.windowMs * 2)
    .exec();

  const failures = countRes?.[1] ?? 0;

  if (failures >= env.breaker.failureThreshold) {
    const openUntil = now + env.breaker.cooldownMs;
    await redis.set(openUntilKey, String(openUntil), 'PX', env.breaker.cooldownMs * 4);
    logger.error(
      { failures, reason, cooldownMs: env.breaker.cooldownMs },
      'Inference circuit breaker opened',
    );
    return { state: STATE.OPEN, opened: true, failures };
  }

  return { state: STATE.CLOSED, opened: false, failures };
}

export { STATE as BREAKER_STATE };
export default { requestPermission, recordSuccess, recordFailure, getBreakerState };
