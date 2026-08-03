import { Queue, QueueEvents } from 'bullmq';
import { getQueueConnection, key } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../config/logger.js';

/**
 * The single generation queue.
 *
 * Everything CPU-bound funnels through here. Hundreds of users may be connected
 * and hundreds of requests may be admitted, but only LLM_WORKER_CONCURRENCY
 * generations ever run against llama-server at once — the rest wait in Redis
 * with a visible queue position.
 *
 * Jobs carry no conversation history: the worker reloads it from MongoDB by id.
 * That keeps prompt text and personal data out of Redis, which only holds
 * routing metadata and short-lived token frames.
 */

export const LLM_QUEUE_NAME = 'atozas-llm';

/** Terminal and non-terminal states reported to the client. */
export const JOB_STATE = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  FAILED: 'failed',
};

let queue = null;
let queueEvents = null;

export function getLlmQueue() {
  if (queue) return queue;

  queue = new Queue(LLM_QUEUE_NAME, {
    connection: getQueueConnection(),
    prefix: key('bull'),
    defaultJobOptions: {
      attempts: env.limits.jobAttempts,
      backoff: { type: 'exponential', delay: 2000 },
      // Keep a short tail for metrics; drop the rest so Redis stays small and
      // no prompt-adjacent metadata lingers longer than needed.
      removeOnComplete: { age: 300, count: 200 },
      removeOnFail: { age: 3600, count: 200 },
    },
  });

  return queue;
}

export function getQueueEvents() {
  if (queueEvents) return queueEvents;
  queueEvents = new QueueEvents(LLM_QUEUE_NAME, {
    connection: getQueueConnection(),
    prefix: key('bull'),
  });
  return queueEvents;
}

/** Redis key holding the cancellation flag for a job. */
export function cancelKey(jobId) {
  return key('cancel', jobId);
}

/**
 * Admits a generation request.
 *
 * @param {object} job
 * @param {string} job.jobId          Idempotent id (also the SSE channel name)
 * @param {string} job.userId
 * @param {string} job.conversationId
 * @param {string} job.userMessageId
 * @param {string} job.assistantMessageId
 * @param {string} job.profile
 * @param {string} job.providerId
 * @param {string} job.model
 * @param {boolean} job.useRetrieval
 * @returns {Promise<{ jobId: string, position: number }>}
 */
export async function enqueueGeneration(job) {
  const q = getLlmQueue();

  const depth = await getQueueDepth();
  if (depth.waiting >= env.limits.maxQueueSize) {
    throw new AppError(
      503,
      'ATOZAS AI is at capacity right now. Please try again in a moment.',
      { code: 'QUEUE_FULL', details: { waiting: depth.waiting, limit: env.limits.maxQueueSize } },
    );
  }

  // jobId doubles as the idempotency key: re-submitting the same id is a no-op
  // in BullMQ, so a retried POST attaches to the existing job instead of
  // starting a second generation.
  const added = await q.add('generate', job, {
    jobId: job.jobId,
    // Drop jobs that waited longer than the model could plausibly serve them.
    // The worker double-checks this before touching llama-server.
    timestamp: Date.now(),
  });

  const position = await getQueuePosition(added.id);
  logger.debug({ jobId: added.id, position }, 'Generation enqueued');

  return { jobId: added.id, position };
}

/**
 * 1-based position among waiting jobs, or 0 when the job is already running.
 * Bounded scan: past the window we report the window size rather than pulling
 * the entire waiting list into memory on every SSE connect.
 */
export async function getQueuePosition(jobId, window = 150) {
  const q = getLlmQueue();
  const waiting = await q.getWaiting(0, window - 1);
  const index = waiting.findIndex((j) => String(j.id) === String(jobId));
  if (index === -1) return 0;
  return index + 1;
}

export async function getQueueDepth() {
  const q = getLlmQueue();
  const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return {
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    delayed: counts.delayed || 0,
    failed: counts.failed || 0,
    completed: counts.completed || 0,
  };
}

/**
 * Requests cancellation.
 *
 * A waiting job is removed outright. A running job cannot be killed mid-`fetch`
 * from another process, so a flag is set in Redis; the worker polls it between
 * tokens and aborts the inference request within a few tokens.
 */
export async function requestCancellation(jobId) {
  const q = getLlmQueue();
  const job = await q.getJob(jobId);
  if (!job) return { cancelled: false, reason: 'not_found' };

  const state = await job.getState();

  if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
    await job.remove().catch(() => {});
    return { cancelled: true, state };
  }

  if (state === 'active') {
    const redis = getQueueConnection();
    await redis.set(cancelKey(jobId), '1', 'EX', 300);
    return { cancelled: true, state };
  }

  return { cancelled: false, reason: state };
}

export async function isCancelled(jobId) {
  const redis = getQueueConnection();
  return (await redis.exists(cancelKey(jobId))) === 1;
}

export async function clearCancellation(jobId) {
  const redis = getQueueConnection();
  await redis.del(cancelKey(jobId)).catch(() => {});
}

/**
 * Drops jobs that have been waiting past QUEUE_STALE_MS. Their SSE clients are
 * long gone, so generating for them would burn CPU that live users need.
 */
export async function cleanStaleJobs() {
  const q = getLlmQueue();
  const cutoff = Date.now() - env.limits.queueStaleMs;
  const waiting = await q.getWaiting(0, 500);

  let removed = 0;
  for (const job of waiting) {
    if (job.timestamp && job.timestamp < cutoff) {
      await job.remove().catch(() => {});
      removed += 1;
    }
  }

  if (removed) logger.warn({ removed }, 'Removed stale queued generations');
  return removed;
}

/** Pauses admission when llama-server is unhealthy (circuit breaker open). */
export async function pauseQueue() {
  await getLlmQueue().pause();
  logger.warn('LLM queue paused');
}

export async function resumeQueue() {
  await getLlmQueue().resume();
  logger.info('LLM queue resumed');
}

export async function isQueuePaused() {
  return getLlmQueue().isPaused();
}

export async function closeQueue() {
  await queueEvents?.close().catch(() => {});
  await queue?.close().catch(() => {});
  queue = null;
  queueEvents = null;
}

export default getLlmQueue;
