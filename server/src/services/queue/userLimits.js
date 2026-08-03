import { getRedis, key } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';

/**
 * Per-user admission control, enforced in Redis so limits hold across every
 * API process and survive restarts.
 *
 * Four independent gates, checked in this order:
 *   1. sliding minute window   → MAX_REQUESTS_PER_MINUTE
 *   2. sliding hour window     → MAX_REQUESTS_PER_HOUR
 *   3. active generations      → MAX_ACTIVE_REQUESTS_PER_USER
 *   4. duplicate submission    → same prompt already in flight
 *
 * Windows are sliding rather than fixed-bucket: a fixed bucket lets a user fire
 * 2× the limit across a boundary, which on CPU inference is the difference
 * between a responsive queue and a stalled one.
 */

const activeKey = (userId) => key('active', String(userId));
const windowKey = (userId, span) => key('rate', span, String(userId));
const dupKey = (userId, hash) => key('dup', String(userId), hash);

/** Sliding-window counter using a sorted set of request timestamps. */
async function consumeWindow(userId, span, windowMs, limit) {
  const redis = getRedis();
  const k = windowKey(userId, span);
  const now = Date.now();
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  const [, , countRes] = await redis
    .multi()
    .zremrangebyscore(k, 0, now - windowMs)
    .zadd(k, now, member)
    .zcard(k)
    .pexpire(k, windowMs)
    .exec();

  const count = countRes?.[1] ?? 0;

  if (count > limit) {
    // Roll back this attempt so a rejected request doesn't consume quota.
    await redis.zrem(k, member);
    const oldest = await redis.zrange(k, 0, 0, 'WITHSCORES');
    const retryAfterMs = oldest.length
      ? Math.max(1000, Number(oldest[1]) + windowMs - now)
      : windowMs;
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000), limit, count };
  }

  return { allowed: true, count, limit };
}

/** Stable fingerprint of a submission, used for duplicate suppression. */
export function fingerprint(conversationId, content) {
  const text = String(content).trim().replace(/\s+/g, ' ').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return `${conversationId}-${hash.toString(36)}-${text.length}`;
}

/**
 * Runs every admission gate and reserves a slot.
 *
 * On success the caller MUST eventually call `releaseSlot()` — the worker does
 * this in a finally block, and the reservation carries a TTL so a hard process
 * kill cannot leak a slot permanently.
 *
 * @throws {AppError} 429 with a Retry-After hint when a gate rejects.
 */
export async function acquireSlot({ userId, jobId, conversationId, content }) {
  const redis = getRedis();

  const minute = await consumeWindow(userId, 'min', 60_000, env.limits.maxRequestsPerMinute);
  if (!minute.allowed) {
    throw AppError.tooMany(
      `You've reached the limit of ${minute.limit} messages per minute. Please wait a moment.`,
      { details: { scope: 'minute', retryAfterSeconds: minute.retryAfterSeconds } },
    );
  }

  const hour = await consumeWindow(userId, 'hour', 3_600_000, env.limits.maxRequestsPerHour);
  if (!hour.allowed) {
    throw AppError.tooMany(
      `You've reached the limit of ${hour.limit} messages per hour.`,
      { details: { scope: 'hour', retryAfterSeconds: hour.retryAfterSeconds } },
    );
  }

  // Duplicate suppression: the same prompt in the same conversation while the
  // first is still generating returns the original job instead of a second one.
  const fp = fingerprint(conversationId, content);
  const claimed = await redis.set(dupKey(userId, fp), jobId, 'EX', 120, 'NX');
  if (!claimed) {
    const existingJobId = await redis.get(dupKey(userId, fp));
    return { duplicate: true, existingJobId, fingerprint: fp };
  }

  // Active-generation cap.
  const active = activeKey(userId);
  const count = await redis.scard(active);
  if (count >= env.limits.maxActiveRequestsPerUser) {
    await redis.del(dupKey(userId, fp));
    throw AppError.tooMany(
      env.limits.maxActiveRequestsPerUser === 1
        ? 'You already have a response generating. Wait for it to finish or stop it first.'
        : `You can run at most ${env.limits.maxActiveRequestsPerUser} generations at once.`,
      { details: { scope: 'concurrency', active: count } },
    );
  }

  await redis.multi().sadd(active, jobId).expire(active, 900).exec();

  return { duplicate: false, fingerprint: fp };
}

/** Releases the active slot and the duplicate claim. Safe to call twice. */
export async function releaseSlot({ userId, jobId, fingerprint: fp }) {
  const redis = getRedis();
  const ops = redis.multi().srem(activeKey(userId), jobId);
  if (fp) ops.del(dupKey(userId, fp));
  await ops.exec().catch(() => {});
}

/** Current usage snapshot, returned to the client alongside 429 responses. */
export async function getUserUsage(userId) {
  const redis = getRedis();
  const now = Date.now();

  const [activeCount, minuteCount, hourCount] = await Promise.all([
    redis.scard(activeKey(userId)),
    redis.zcount(windowKey(userId, 'min'), now - 60_000, now),
    redis.zcount(windowKey(userId, 'hour'), now - 3_600_000, now),
  ]);

  return {
    active: activeCount,
    activeLimit: env.limits.maxActiveRequestsPerUser,
    perMinute: minuteCount,
    perMinuteLimit: env.limits.maxRequestsPerMinute,
    perHour: hourCount,
    perHourLimit: env.limits.maxRequestsPerHour,
  };
}

export default { acquireSlot, releaseSlot, getUserUsage, fingerprint };
