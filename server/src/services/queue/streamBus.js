import { getSubscriber, getQueueConnection, key } from '../../config/redis.js';
import { logger } from '../../config/logger.js';

/**
 * Bridges the worker process to the API process's SSE responses.
 *
 * The worker and the HTTP server are separate PM2 processes, so tokens travel
 * over Redis pub/sub. Pub/sub alone would lose any frame published between the
 * job starting and the browser's SSE request arriving, so every frame is also
 * appended to a short-lived replay buffer.
 *
 * A relay therefore: subscribes first, then drains the buffer, then dedupes by
 * sequence number. Nothing is lost on a slow connect and nothing is duplicated
 * on a reconnect — which is what keeps the chat transcript clean when a user
 * refreshes mid-generation.
 */

const BUFFER_TTL_SECONDS = 600;
const BUFFER_MAX_FRAMES = 4000;

const channelFor = (jobId) => key('stream', jobId);
const bufferFor = (jobId) => key('streambuf', jobId);

/** jobId → Set<handler>, so one Redis subscriber serves many SSE responses. */
const handlers = new Map();
let subscriberWired = false;

function wireSubscriber() {
  if (subscriberWired) return;
  subscriberWired = true;

  const sub = getSubscriber();
  sub.on('message', (channel, payload) => {
    const set = handlers.get(channel);
    if (!set?.size) return;

    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      return;
    }

    for (const handler of set) {
      try {
        handler(frame);
      } catch (err) {
        logger.error({ err, channel }, 'SSE relay handler failed');
      }
    }
  });
}

/**
 * Publisher bound to a single job. The worker owns the sequence counter, so
 * ordering is guaranteed without a Redis round trip per token.
 */
export function createStreamPublisher(jobId) {
  const redis = getQueueConnection();
  const channel = channelFor(jobId);
  const buffer = bufferFor(jobId);
  let seq = 0;

  return {
    /**
     * @param {string} event  queued|started|token|citation|completed|cancelled|error
     * @param {object} data
     */
    async publish(event, data = {}) {
      seq += 1;
      const payload = JSON.stringify({ seq, event, data, at: Date.now() });

      await redis
        .multi()
        .rpush(buffer, payload)
        .ltrim(buffer, -BUFFER_MAX_FRAMES, -1)
        .expire(buffer, BUFFER_TTL_SECONDS)
        .publish(channel, payload)
        .exec()
        .catch((err) => logger.error({ err, jobId }, 'Failed to publish stream frame'));
    },

    get sequence() {
      return seq;
    },
  };
}

/**
 * Attaches an SSE response to a job's frame stream.
 *
 * @param {string} jobId
 * @param {(frame: {seq:number, event:string, data:object}) => void} onFrame
 * @param {{ afterSeq?: number }} [options] Resume point for reconnecting clients.
 * @returns {Promise<() => Promise<void>>} detach function
 */
export async function attachToStream(jobId, onFrame, { afterSeq = 0 } = {}) {
  wireSubscriber();

  const channel = channelFor(jobId);
  const sub = getSubscriber();
  const redis = getQueueConnection();

  let lastSeq = afterSeq;
  let draining = true;
  /** Frames that arrive live while the replay buffer is still being drained. */
  const pending = [];

  const deliver = (frame) => {
    if (!frame || frame.seq <= lastSeq) return; // already sent to this client
    lastSeq = frame.seq;
    onFrame(frame);
  };

  const handler = (frame) => {
    if (draining) pending.push(frame);
    else deliver(frame);
  };

  if (!handlers.has(channel)) {
    handlers.set(channel, new Set());
    await sub.subscribe(channel);
  }
  handlers.get(channel).add(handler);

  // Subscription is live, so nothing published from here on can be missed.
  // Now replay whatever the worker emitted before this client arrived.
  try {
    const buffered = await redis.lrange(bufferFor(jobId), 0, -1);
    for (const raw of buffered) {
      try {
        deliver(JSON.parse(raw));
      } catch {
        // Skip a corrupt frame rather than dropping the whole replay.
      }
    }
  } finally {
    draining = false;
    for (const frame of pending.sort((a, b) => a.seq - b.seq)) deliver(frame);
    pending.length = 0;
  }

  return async function detach() {
    const set = handlers.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      handlers.delete(channel);
      await sub.unsubscribe(channel).catch(() => {});
    }
  };
}

/** Drops a job's replay buffer once its result is safely persisted in MongoDB. */
export async function clearStreamBuffer(jobId) {
  await getQueueConnection().del(bufferFor(jobId)).catch(() => {});
}

export default { createStreamPublisher, attachToStream, clearStreamBuffer };
