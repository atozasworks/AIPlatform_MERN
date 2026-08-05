import crypto from 'node:crypto';

import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { AppError } from '../utils/AppError.js';
import { aiGateway } from '../services/ai/AIGateway.js';
import { listProfiles, resolveProfile, isValidProfile } from '../services/ai/prompts.js';
import { getOwnedConversation, getMessages, buildActivePath } from '../services/conversation.service.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { createSseChannel } from '../middleware/sse.js';
import {
  enqueueGeneration,
  getQueuePosition,
  requestCancellation,
  isQueuePaused,
  getQueueDepth,
} from '../services/queue/llmQueue.js';
import { attachToStream, clearStreamBuffer } from '../services/queue/streamBus.js';
import { acquireSlot, releaseSlot, getUserUsage } from '../services/queue/userLimits.js';
import { getBreakerState } from '../services/queue/circuitBreaker.js';
import { isInferenceAvailable } from '../services/health/probes.js';
import { increment, METRIC } from '../services/health/metrics.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Chat request handling.
 *
 * The controller no longer performs inference. It validates, admits, enqueues,
 * then relays frames the worker publishes to Redis. That separation is what
 * allows hundreds of open SSE connections against two concurrent generations:
 * an idle relay costs a socket, not a CPU core.
 */

/**
 * GET /ai/models — the served model, plus whether live retrieval is available.
 *
 * Still a list: the provider layer is list-shaped and the client picks the
 * default. ATOZAS serves one chat model, so there is nothing to choose between.
 *
 * `webRetrieval` is reported here rather than on a separate endpoint because the
 * client needs it at the same moment, and because it changes how much a user
 * should trust a time-sensitive answer — with retrieval unavailable, answers come
 * from training data alone.
 */
export const listModels = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    models: await aiGateway.listModels(),
    default: env.ai.llamacpp.defaultModel,
    webRetrieval: {
      available: env.web.enabled && Boolean(env.web.searxngUrl),
      // Absent an allowlist retrieval may quote any public host; with one it is
      // pinned to sources the operator vetted.
      restrictedToAllowlist: env.web.allowedDomains.length > 0,
    },
  }),
);

/** GET /ai/profiles — prompt profiles the client may choose from. */
export const listPromptProfiles = asyncHandler(async (_req, res) =>
  sendSuccess(res, { profiles: listProfiles(), default: env.ai.defaultProfile }),
);

/** GET /ai/usage — the caller's current quota consumption. */
export const getUsage = asyncHandler(async (req, res) =>
  sendSuccess(res, await getUserUsage(req.user._id)),
);

/**
 * POST /conversations/:id/stream
 *
 * SSE protocol:
 *   queued     { jobId, position, queueDepth }
 *   started    { provider, model, profile, queueWaitMs }
 *   token      { text }
 *   citation   { stage, sources[] }
 *   completed  { model, usage, citations[], stats{} }
 *   cancelled  { reason }
 *   error      { code, message }
 *   heartbeat  { at }
 *
 * `meta` is emitted first (outside the worker protocol) so the client can bind
 * its optimistic message rows to real database ids before anything streams.
 */
export const streamChat = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const {
    content,
    profile: requestedProfile,
    provider: requestedProvider,
    model: requestedModel,
    clientMessageId,
    parentMessageId: requestedParentId,
    resumeFromSeq,
  } = req.body;

  const conversation = await getOwnedConversation(userId, req.params.id);

  // Reject early, before any database writes, when the platform cannot serve.
  // The live probe matters on a cold outage: the breaker is still closed after
  // a llama-server crash, so without it the first requests would be admitted
  // and only fail mid-stream once the worker had tripped the threshold.
  const [paused, breaker, inference] = await Promise.all([
    isQueuePaused(),
    getBreakerState(),
    isInferenceAvailable(),
  ]);

  if (paused || breaker.state === 'open' || !inference.ok) {
    await increment(METRIC.REQUESTS_QUEUE_FULL);
    throw new AppError(
      503,
      'ATOZAS AI is temporarily unavailable while the inference service recovers. Please try again shortly.',
      {
        code: 'INFERENCE_UNAVAILABLE',
        details: { retryAfterSeconds: Math.ceil((breaker.openForMs || 30000) / 1000) },
      },
    );
  }

  const profileId = isValidProfile(requestedProfile)
    ? requestedProfile
    : conversation.profile || env.ai.defaultProfile;
  const profile = resolveProfile(profileId);

  // Fail fast if the engine is down: no orphan message rows, no queued work.
  const { provider, model } = aiGateway.resolve({
    provider: requestedProvider || conversation.provider,
    model: requestedModel || conversation.model,
  });

  // ── Resolve the parent in the message tree ──
  let parentMessageId = requestedParentId;
  if (parentMessageId === undefined) {
    const existing = await getMessages(userId, conversation._id);
    const path = buildActivePath(existing);
    const last = path[path.length - 1];
    parentMessageId = last ? last.id : null;
  }

  // ── Idempotency: a retried POST must not create a second user message ──
  let userMessage = null;
  if (clientMessageId) {
    userMessage = await Message.findOne({
      conversation: conversation._id,
      user: userId,
      role: 'user',
      'clientMeta.clientMessageId': clientMessageId,
    });
  }

  // If this exchange already finished, replay the stored answer instead of
  // generating again. Without this, a retry re-attaches to a job whose replay
  // buffer is gone and the client waits out the full idle timeout. Replaying
  // also costs the user no quota, which is the correct semantics for a retry.
  if (userMessage) {
    const finished = await Message.findOne({
      conversation: conversation._id,
      user: userId,
      role: 'assistant',
      parentMessage: userMessage._id,
      status: { $in: ['complete', 'stopped', 'error'] },
    });

    if (finished) {
      return replayStoredAnswer(req, res, {
        conversation,
        userMessage,
        assistantMessage: finished,
        parentMessageId,
      });
    }
  }

  // A deterministic job id derived from the client message id means a reconnect
  // re-attaches to the running generation instead of starting a new one.
  const jobId = clientMessageId
    ? `gen-${conversation._id}-${crypto.createHash('sha1').update(clientMessageId).digest('hex').slice(0, 24)}`
    : `gen-${conversation._id}-${crypto.randomUUID()}`;

  // ── Admission control ──
  let slot;
  try {
    slot = await acquireSlot({
      userId: String(userId),
      jobId,
      conversationId: String(conversation._id),
      content,
    });
  } catch (err) {
    if (err.statusCode === 429) await increment(METRIC.REQUESTS_RATE_LIMITED);
    throw err;
  }

  // A duplicate submission attaches to the original job rather than queueing
  // a second identical generation.
  if (slot.duplicate && slot.existingJobId && slot.existingJobId !== jobId) {
    logger.debug({ userId: String(userId), jobId: slot.existingJobId }, 'Attaching to duplicate job');
    return relayExistingJob(req, res, {
      jobId: slot.existingJobId,
      resumeFromSeq: Number(resumeFromSeq) || 0,
    });
  }

  let assistantMessage = null;

  try {
    if (!userMessage) {
      userMessage = await Message.create({
        conversation: conversation._id,
        user: userId,
        role: 'user',
        content,
        status: 'complete',
        parentMessage: parentMessageId || null,
        ...(clientMessageId ? { clientMeta: { clientMessageId } } : {}),
      });
    }

    // Reuse the assistant row on a retry so the transcript keeps one reply.
    assistantMessage = await Message.findOne({
      conversation: conversation._id,
      user: userId,
      role: 'assistant',
      parentMessage: userMessage._id,
      status: { $in: ['pending', 'streaming'] },
    });

    if (!assistantMessage) {
      assistantMessage = await Message.create({
        conversation: conversation._id,
        user: userId,
        role: 'assistant',
        content: '',
        provider: provider.id,
        model,
        status: 'pending',
        parentMessage: userMessage._id,
      });
    }

    if (conversation.provider !== provider.id || conversation.model !== model || conversation.profile !== profileId) {
      await Conversation.updateOne(
        { _id: conversation._id },
        { provider: provider.id, model, profile: profileId },
      );
    }

    const { position } = await enqueueGeneration({
      jobId,
      userId: String(userId),
      conversationId: String(conversation._id),
      userMessageId: String(userMessage._id),
      assistantMessageId: String(assistantMessage._id),
      profile: profileId,
      providerId: provider.id,
      model,
      maxTokens: profile.maxTokens,
      language: req.user.settings?.language,
      fingerprint: slot.fingerprint,
    });

    // ── Relay ──
    const channel = createSseChannel(req, res);
    const depth = await getQueueDepth();

    channel.send('meta', {
      jobId,
      provider: provider.id,
      model,
      profile: profileId,
      userMessageId: String(userMessage._id),
      assistantMessageId: String(assistantMessage._id),
      parentMessageId: parentMessageId || null,
    });

    channel.send('queued', {
      jobId,
      position,
      queueDepth: depth.waiting,
      activeGenerations: depth.active,
    });

    // Title the conversation from the first prompt while the model works.
    if (conversation.title === 'New chat') {
      const title = deriveTitle(content);
      await Conversation.updateOne({ _id: conversation._id }, { title });
      channel.send('title', { title });
    }

    await pumpJobToChannel(channel, { jobId, resumeFromSeq: Number(resumeFromSeq) || 0 });
  } catch (err) {
    // The job never made it onto the queue, so nothing will release the slot.
    await releaseSlot({ userId: String(userId), jobId, fingerprint: slot.fingerprint });
    if (assistantMessage && assistantMessage.status === 'pending') {
      await Message.deleteOne({ _id: assistantMessage._id }).catch(() => {});
    }
    throw err;
  }
});

/**
 * GET /conversations/:id/stream/:jobId
 * Re-attaches to a generation after a refresh or network drop. `lastSeq` makes
 * the replay exactly-once from the client's perspective.
 */
export const resumeStream = asyncHandler(async (req, res) => {
  await getOwnedConversation(req.user._id, req.params.id);

  const { jobId } = req.params;
  // Job ids embed the conversation id, so this also proves ownership of the job.
  if (!jobId.startsWith(`gen-${req.params.id}-`)) {
    throw AppError.forbidden('This generation does not belong to the conversation');
  }

  return relayExistingJob(req, res, {
    jobId,
    resumeFromSeq: Number(req.query.lastSeq) || 0,
  });
});

/** POST /conversations/:id/stream/:jobId/cancel — the Stop Generation button. */
export const cancelGeneration = asyncHandler(async (req, res) => {
  await getOwnedConversation(req.user._id, req.params.id);

  const { jobId } = req.params;
  if (!jobId.startsWith(`gen-${req.params.id}-`)) {
    throw AppError.forbidden('This generation does not belong to the conversation');
  }

  const result = await requestCancellation(jobId);
  return sendSuccess(res, result);
});

/**
 * Streams back an exchange that already completed, in the same event shape a
 * live generation produces, so the client needs no special-case handling.
 */
function replayStoredAnswer(req, res, { conversation, userMessage, assistantMessage, parentMessageId }) {
  const channel = createSseChannel(req, res);

  channel.send('meta', {
    jobId: null,
    replayed: true,
    provider: assistantMessage.provider,
    model: assistantMessage.model,
    profile: conversation.profile,
    userMessageId: String(userMessage._id),
    assistantMessageId: String(assistantMessage._id),
    parentMessageId: parentMessageId || null,
  });

  if (assistantMessage.content) {
    channel.send('token', { text: assistantMessage.content });
  }

  if (assistantMessage.status === 'error') {
    channel.send('error', {
      code: 'PREVIOUS_ATTEMPT_FAILED',
      message: assistantMessage.error || 'The previous attempt failed.',
    });
  } else if (assistantMessage.status === 'stopped') {
    channel.send('cancelled', { reason: 'previously_stopped' });
  } else {
    channel.send('completed', {
      model: assistantMessage.model,
      finishReason: 'stop',
      usage: assistantMessage.tokenUsage || { prompt: 0, completion: 0, total: 0 },
      citations: assistantMessage.citations || [],
      stats: null,
      replayed: true,
    });
  }

  channel.close();
}

/** Opens an SSE channel for a job that is already queued or running. */
async function relayExistingJob(req, res, { jobId, resumeFromSeq }) {
  const channel = createSseChannel(req, res);
  channel.send('meta', { jobId, resumed: true });
  await pumpJobToChannel(channel, { jobId, resumeFromSeq });
}

/**
 * Forwards worker frames to the browser until a terminal event or timeout.
 *
 * Resolves rather than rejects on timeout: the SSE response is already
 * committed, so the only useful action is to emit an error frame and close.
 */
function pumpJobToChannel(channel, { jobId, resumeFromSeq = 0 }) {
  return new Promise((resolve) => {
    let settled = false;
    let detach = null;
    let idleTimer = null;

    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      await detach?.().catch(() => {});
      channel.close();
      resolve();
    };

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        channel.send('error', {
          code: 'STREAM_TIMEOUT',
          message: 'The response took too long and the connection was closed. Your message was saved.',
        });
        finish();
      }, env.limits.streamIdleTimeoutMs);
      idleTimer.unref?.();
    };

    const onFrame = (frame) => {
      resetIdleTimer();
      // `seq` lets the client resume precisely after a reconnect.
      channel.send(frame.event, { ...frame.data, seq: frame.seq });

      if (frame.event === 'completed' || frame.event === 'cancelled' || frame.event === 'error') {
        clearStreamBuffer(jobId).catch(() => {});
        finish();
      }
    };

    channel.onClose(() => {
      // The user navigated away or hit Stop; detach but let the worker finish
      // and persist, so the answer is waiting when they come back.
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      detach?.().catch(() => {});
      resolve();
    });

    resetIdleTimer();

    attachToStream(jobId, onFrame, { afterSeq: resumeFromSeq })
      .then((fn) => {
        detach = fn;
        if (channel.closed) fn().catch(() => {});
      })
      .catch((err) => {
        logger.error({ err, jobId }, 'Failed to attach SSE relay');
        channel.send('error', {
          code: 'RELAY_FAILED',
          message: 'Could not connect to the generation stream.',
        });
        finish();
      });

    // Keep the queue position fresh while the job waits its turn.
    const positionTimer = setInterval(async () => {
      if (settled) {
        clearInterval(positionTimer);
        return;
      }
      const position = await getQueuePosition(jobId).catch(() => 0);
      if (position > 0) channel.send('queued', { jobId, position });
    }, 4000);
    positionTimer.unref?.();
    channel.onClose(() => clearInterval(positionTimer));
  });
}

/** Derives a concise title from the first user message. */
function deriveTitle(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const title = clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
  return title || 'New chat';
}
