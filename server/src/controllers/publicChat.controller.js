import crypto from 'node:crypto';

import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { AppError } from '../utils/AppError.js';
import { aiGateway } from '../services/ai/AIGateway.js';
import { listProfiles, resolveProfile, isValidProfile } from '../services/ai/prompts.js';
import { PublicMessage } from '../models/PublicMessage.js';
import { createSseChannel } from '../middleware/sse.js';
import {
  enqueueGeneration,
  getQueuePosition,
  requestCancellation,
  isQueuePaused,
  getQueueDepth,
} from '../services/queue/llmQueue.js';
import { attachToStream, clearStreamBuffer } from '../services/queue/streamBus.js';
import { acquireSlot, releaseSlot } from '../services/queue/userLimits.js';
import { getBreakerState } from '../services/queue/circuitBreaker.js';
import { isInferenceAvailable } from '../services/health/probes.js';
import { increment, METRIC } from '../services/health/metrics.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  createGuestSession,
  listGuestSessions,
  getOwnedGuestSession,
  softDeleteGuestSession,
  listPublicMessages,
  maybeTitleGuestSession,
  withPublicId,
} from '../services/publicChat.service.js';

/** Guest admission key — IP-scoped so anonymous traffic cannot share a user quota. */
function guestKey(req) {
  return `guest:${req.ip || 'unknown'}`;
}

function resolveGuestProfile(requestedProfile) {
  const id = isValidProfile(requestedProfile) ? requestedProfile : env.ai.defaultProfile;
  const profile = resolveProfile(id);
  // Pre-login chat never uses RAG (documents are user-scoped).
  if (profile.requireRetrieval) {
    return resolveProfile(env.ai.defaultProfile || 'balanced');
  }
  return { ...profile, retrieval: false, requireRetrieval: false };
}

async function assertInferenceReady() {
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
}

/** GET /public/models */
export const listModels = asyncHandler(async (_req, res) =>
  sendSuccess(res, { models: await aiGateway.listModels() }),
);

/** GET /public/profiles */
export const listPromptProfiles = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    profiles: listProfiles().map((p) => ({ ...p, usesRetrieval: false })),
    default: env.ai.defaultProfile,
  }),
);

/** GET /public/sessions — this guest's chat history (optional ?q= title search). */
export const listSessions = asyncHandler(async (req, res) => {
  const sessions = await listGuestSessions(req.guestId, {
    q: req.query.q,
    limit: req.query.limit,
  });
  return sendSuccess(res, { sessions });
});

/** POST /public/sessions — open a new empty session for this guest. */
export const createSession = asyncHandler(async (req, res) => {
  const room = await createGuestSession(req.guestId, {
    profile: req.body?.profile,
    provider: req.body?.provider,
    model: req.body?.model,
  });
  return sendSuccess(
    res,
    { session: withPublicId(room.toObject ? room.toObject() : room) },
    { status: 201 },
  );
});

/** GET /public/sessions/:id — owned session + messages. */
export const getSession = asyncHandler(async (req, res) => {
  const room = await getOwnedGuestSession(req.guestId, req.params.id);
  const messages = await listPublicMessages(room._id);
  return sendSuccess(res, {
    session: withPublicId(room.toObject ? room.toObject() : room),
    messages,
  });
});

/** DELETE /public/sessions/:id */
export const deleteSession = asyncHandler(async (req, res) => {
  await softDeleteGuestSession(req.guestId, req.params.id);
  return sendSuccess(res, { ok: true });
});

/**
 * POST /public/sessions/:id/stream
 * Persists turns into the guest's own session — never into a shared global room.
 */
export const streamPublic = asyncHandler(async (req, res) => {
  const {
    content,
    profile: requestedProfile,
    provider: requestedProvider,
    model: requestedModel,
    clientMessageId,
    resumeFromSeq,
  } = req.body;

  await assertInferenceReady();

  const room = await getOwnedGuestSession(req.guestId, req.params.id);
  const profile = resolveGuestProfile(requestedProfile);
  const { provider, model } = aiGateway.resolve({
    provider: requestedProvider || room.provider || undefined,
    model: requestedModel || room.model || undefined,
  });

  let userMessage = null;
  if (clientMessageId) {
    userMessage = await PublicMessage.findOne({
      room: room._id,
      role: 'user',
      'clientMeta.clientMessageId': clientMessageId,
    });
  }

  if (userMessage) {
    const finished = await PublicMessage.findOne({
      room: room._id,
      role: 'assistant',
      replyTo: userMessage._id,
      status: { $in: ['complete', 'stopped', 'error'] },
    });

    if (finished) {
      return replayStoredAnswer(req, res, {
        profileId: profile.id,
        userMessage,
        assistantMessage: finished,
      });
    }
  }

  const jobId = clientMessageId
    ? `gen-public-${String(room._id)}-${crypto.createHash('sha1').update(clientMessageId).digest('hex').slice(0, 24)}`
    : `gen-public-${String(room._id)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

  const slotOwner = guestKey(req);
  let slot;
  try {
    slot = await acquireSlot({
      userId: slotOwner,
      jobId,
      conversationId: `public:${room._id}`,
      content,
    });
  } catch (err) {
    if (err.statusCode === 429) await increment(METRIC.REQUESTS_RATE_LIMITED);
    throw err;
  }

  if (slot.duplicate && slot.existingJobId && slot.existingJobId !== jobId) {
    return relayExistingJob(req, res, {
      jobId: slot.existingJobId,
      resumeFromSeq: Number(resumeFromSeq) || 0,
    });
  }

  let assistantMessage = null;

  try {
    if (!userMessage) {
      userMessage = await PublicMessage.create({
        room: room._id,
        role: 'user',
        content,
        status: 'complete',
        ...(clientMessageId ? { clientMeta: { clientMessageId } } : {}),
      });
    }

    const sessionTitle = await maybeTitleGuestSession(room, content);

    assistantMessage = await PublicMessage.findOne({
      room: room._id,
      role: 'assistant',
      replyTo: userMessage._id,
      status: { $in: ['pending', 'streaming'] },
    });

    if (!assistantMessage) {
      assistantMessage = await PublicMessage.create({
        room: room._id,
        role: 'assistant',
        content: '',
        provider: provider.id,
        model,
        status: 'pending',
        replyTo: userMessage._id,
      });
    }

    const { position } = await enqueueGeneration({
      jobId,
      kind: 'public',
      userId: slotOwner,
      roomId: String(room._id),
      userMessageId: String(userMessage._id),
      assistantMessageId: String(assistantMessage._id),
      content,
      profile: profile.id,
      providerId: provider.id,
      model,
      maxTokens: profile.maxTokens,
      fingerprint: slot.fingerprint,
    });

    const channel = createSseChannel(req, res);
    const depth = await getQueueDepth();

    channel.send('meta', {
      jobId,
      mode: 'public',
      provider: provider.id,
      model,
      profile: profile.id,
      userMessageId: String(userMessage._id),
      assistantMessageId: String(assistantMessage._id),
      sessionId: String(room._id),
      title: sessionTitle || room.title,
    });

    channel.send('queued', {
      jobId,
      position,
      queueDepth: depth.waiting,
      activeGenerations: depth.active,
    });

    await pumpJobToChannel(channel, { jobId, resumeFromSeq: Number(resumeFromSeq) || 0 });
  } catch (err) {
    await releaseSlot({ userId: slotOwner, jobId, fingerprint: slot.fingerprint });
    if (assistantMessage && assistantMessage.status === 'pending') {
      await PublicMessage.deleteOne({ _id: assistantMessage._id }).catch(() => {});
    }
    throw err;
  }
});

/**
 * POST /public/ephemeral/stream
 * Private Mode: no Mongo writes. History is supplied by the client for this
 * request only and discarded when the job completes.
 */
export const streamEphemeral = asyncHandler(async (req, res) => {
  const {
    content,
    profile: requestedProfile,
    provider: requestedProvider,
    model: requestedModel,
    clientMessageId,
    history = [],
    resumeFromSeq,
  } = req.body;

  await assertInferenceReady();

  const profile = resolveGuestProfile(requestedProfile);
  const { provider, model } = aiGateway.resolve({
    provider: requestedProvider,
    model: requestedModel,
  });

  const jobId = clientMessageId
    ? `gen-ephemeral-${crypto.createHash('sha1').update(clientMessageId).digest('hex').slice(0, 32)}`
    : `gen-ephemeral-${crypto.randomUUID().replace(/-/g, '')}`;

  const slotOwner = guestKey(req);
  let slot;
  try {
    slot = await acquireSlot({
      userId: slotOwner,
      jobId,
      conversationId: `ephemeral:${slotOwner}`,
      content,
    });
  } catch (err) {
    if (err.statusCode === 429) await increment(METRIC.REQUESTS_RATE_LIMITED);
    throw err;
  }

  if (slot.duplicate && slot.existingJobId && slot.existingJobId !== jobId) {
    return relayExistingJob(req, res, {
      jobId: slot.existingJobId,
      resumeFromSeq: Number(resumeFromSeq) || 0,
    });
  }

  try {
    const { position } = await enqueueGeneration({
      jobId,
      kind: 'ephemeral',
      userId: slotOwner,
      content,
      history,
      profile: profile.id,
      providerId: provider.id,
      model,
      maxTokens: profile.maxTokens,
      fingerprint: slot.fingerprint,
    });

    const channel = createSseChannel(req, res);
    const depth = await getQueueDepth();
    const userMessageId = `ephemeral-user-${clientMessageId || crypto.randomUUID()}`;
    const assistantMessageId = `ephemeral-assistant-${clientMessageId || crypto.randomUUID()}`;

    channel.send('meta', {
      jobId,
      mode: 'private',
      provider: provider.id,
      model,
      profile: profile.id,
      userMessageId,
      assistantMessageId,
    });

    channel.send('queued', {
      jobId,
      position,
      queueDepth: depth.waiting,
      activeGenerations: depth.active,
    });

    await pumpJobToChannel(channel, { jobId, resumeFromSeq: Number(resumeFromSeq) || 0 });
  } catch (err) {
    await releaseSlot({ userId: slotOwner, jobId, fingerprint: slot.fingerprint });
    throw err;
  }
});

/** GET /public/stream/:jobId — resume a guest generation. */
export const resumeGuestStream = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  return relayExistingJob(req, res, {
    jobId,
    resumeFromSeq: Number(req.query.lastSeq) || 0,
  });
});

/** POST /public/stream/:jobId/cancel */
export const cancelGuestGeneration = asyncHandler(async (req, res) => {
  const result = await requestCancellation(req.params.jobId);
  if (result.reason === 'not_found') {
    await releaseSlot({ userId: guestKey(req), jobId: req.params.jobId });
  }
  return sendSuccess(res, result);
});

function replayStoredAnswer(req, res, { profileId, userMessage, assistantMessage }) {
  const channel = createSseChannel(req, res);

  channel.send('meta', {
    jobId: null,
    replayed: true,
    mode: 'public',
    provider: assistantMessage.provider,
    model: assistantMessage.model,
    profile: profileId,
    userMessageId: String(userMessage._id),
    assistantMessageId: String(assistantMessage._id),
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
      usage: { prompt: 0, completion: 0, total: 0 },
      citations: [],
      stats: null,
      replayed: true,
    });
  }

  channel.close();
}

async function relayExistingJob(req, res, { jobId, resumeFromSeq }) {
  const channel = createSseChannel(req, res);
  channel.send('meta', { jobId, resumed: true });
  await pumpJobToChannel(channel, { jobId, resumeFromSeq });
}

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
          message: 'The response took too long and the connection was closed.',
        });
        finish();
      }, env.limits.streamIdleTimeoutMs);
      idleTimer.unref?.();
    };

    const onFrame = (frame) => {
      resetIdleTimer();
      channel.send(frame.event, { ...frame.data, seq: frame.seq });

      if (frame.event === 'completed' || frame.event === 'cancelled' || frame.event === 'error') {
        clearStreamBuffer(jobId).catch(() => {});
        finish();
      }
    };

    channel.onClose(() => {
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
        logger.error({ err, jobId }, 'Failed to attach guest SSE relay');
        channel.send('error', {
          code: 'RELAY_FAILED',
          message: 'Could not connect to the generation stream.',
        });
        finish();
      });

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
