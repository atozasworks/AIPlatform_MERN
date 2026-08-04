import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { isCancelled, clearCancellation } from './llmQueue.js';
import { createStreamPublisher } from './streamBus.js';
import { releaseSlot } from './userLimits.js';
import { requestPermission, recordSuccess, recordFailure } from './circuitBreaker.js';
import { aiGateway } from '../ai/AIGateway.js';
import { resolveProfile } from '../ai/prompts.js';
import { buildSystemPrompt } from '../ai/systemPrompt.js';
import { buildBudgetedMessages } from '../ai/tokenBudget.js';
import { PublicRoom } from '../../models/PublicRoom.js';
import { PublicMessage } from '../../models/PublicMessage.js';
import { getPublicHistoryForModel } from '../publicChat.service.js';
import { increment, observe, METRIC, SAMPLE } from '../health/metrics.js';

/**
 * Guest (pre-login) generation jobs.
 *
 * Kept separate from the authenticated worker path so logged-in Conversation /
 * Message ownership logic is never touched. Jobs are still admitted through the
 * same BullMQ queue so guests share the inference concurrency ceiling.
 */

const CANCEL_POLL_TOKENS = 8;
const CANCEL_POLL_MS = 750;

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

/**
 * @param {import('bullmq').Job} job
 */
export async function processGuestJob(job) {
  const data = job.data;
  const jobId = String(job.id);
  const publisher = createStreamPublisher(jobId);
  const publish = (event, payload) => publisher.publish(event, payload);

  const queuedAt = job.timestamp || Date.now();
  const startedAt = Date.now();
  const queueWaitMs = startedAt - queuedAt;

  let outcome = 'failed';
  let assistantMessage = null;
  let text = '';

  try {
    if (queueWaitMs > env.limits.queueStaleMs) {
      outcome = 'timed_out';
      await publish('error', {
        code: 'QUEUE_TIMEOUT',
        message: 'This request waited too long in the queue and was dropped. Please send it again.',
      });
      await increment(METRIC.GENERATIONS_TIMED_OUT);
      return { status: 'timed_out' };
    }

    if (await isCancelled(jobId)) throw new Cancelled();

    const permission = await requestPermission();
    if (!permission.allowed) {
      throw Object.assign(new Error('Inference temporarily unavailable'), {
        code: 'INFERENCE_UNAVAILABLE',
        retryable: true,
      });
    }

    const profile = resolveProfile(data.profile, { maxTokens: data.maxTokens });
    const { provider, model } = aiGateway.resolve({
      provider: data.providerId,
      model: data.model,
    });

    await publish('started', {
      provider: provider.id,
      model,
      profile: profile.id,
      queueWaitMs,
    });
    await increment(METRIC.GENERATIONS_STARTED);
    await observe(SAMPLE.QUEUE_WAIT_MS, queueWaitMs);

    let history = [];
    let currentTurn = { role: 'user', content: data.content };

    if (data.kind === 'public') {
      const room = await PublicRoom.findById(data.roomId);
      if (!room) throw new Error('Public room is missing');

      assistantMessage = await PublicMessage.findById(data.assistantMessageId);
      if (!assistantMessage) throw new Error('Assistant message row is missing');

      const userMessage = await PublicMessage.findById(data.userMessageId);
      if (!userMessage) throw new Error('User message is missing');

      currentTurn = { role: 'user', content: userMessage.content };
      history = await getPublicHistoryForModel(room._id, {
        excludeIds: [userMessage._id, assistantMessage._id],
      });
    } else {
      // Ephemeral: history lives only in the job payload; nothing is persisted.
      history = Array.isArray(data.history)
        ? data.history
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
            .map((m) => ({ role: m.role, content: String(m.content).slice(0, 24000) }))
            .slice(-40)
        : [];
      currentTurn = { role: 'user', content: String(data.content || '') };
    }

    // Guests never use RAG — keeps retrieval scoped to authenticated users.
    const systemPrompt = buildSystemPrompt({
      profile: { ...profile, retrieval: false, requireRetrieval: false },
      conversationPrompt: '',
      sources: [],
      language: data.language,
    });

    const budgeted = buildBudgetedMessages({
      systemPrompt,
      history,
      currentTurn,
      maxOutputTokens: profile.maxTokens,
      contextWindow: provider.getContextWindow?.(model) ?? provider.contextWindow,
    });

    const abort = new AbortController();
    let firstTokenAt = null;
    let tokenCount = 0;
    let lastCancelCheck = Date.now();
    let usage = { prompt: 0, completion: 0, total: 0 };
    let finalModel = model;
    let finishReason = 'stop';

    const stream = provider.streamResponse({
      model,
      messages: budgeted.messages,
      options: {
        sampling: profile.sampling,
        maxTokens: profile.maxTokens,
        signal: abort.signal,
      },
    });

    try {
      for await (const chunk of stream) {
        if (chunk.type === 'token') {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
            await observe(SAMPLE.TIME_TO_FIRST_TOKEN_MS, firstTokenAt - startedAt);
          }

          text += chunk.text;
          tokenCount += 1;
          await publish('token', { text: chunk.text });

          const due =
            tokenCount % CANCEL_POLL_TOKENS === 0 || Date.now() - lastCancelCheck > CANCEL_POLL_MS;
          if (due) {
            lastCancelCheck = Date.now();
            if (await isCancelled(jobId)) {
              abort.abort();
              throw new Cancelled();
            }
          }
        } else if (chunk.type === 'done') {
          usage = chunk.usage || usage;
          finalModel = chunk.model || finalModel;
          finishReason = chunk.finishReason || finishReason;
        }
      }
    } finally {
      abort.abort();
    }

    const completedAt = Date.now();
    const generationMs = completedAt - (firstTokenAt || startedAt);
    const tokensPerSecond = generationMs > 0 ? (tokenCount / generationMs) * 1000 : 0;

    if (data.kind === 'public' && assistantMessage) {
      assistantMessage.content = text;
      assistantMessage.status = 'complete';
      assistantMessage.model = finalModel;
      assistantMessage.provider = provider.id;
      await assistantMessage.save();

      await PublicRoom.updateOne(
        { _id: data.roomId },
        {
          lastMessageAt: new Date(),
          model: finalModel,
          provider: provider.id,
          profile: profile.id,
        },
      );
    }

    await publish('completed', {
      model: finalModel,
      finishReason,
      usage,
      citations: [],
      stats: {
        queueWaitMs,
        timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
        totalMs: completedAt - startedAt,
        tokensPerSecond: Math.round(tokensPerSecond * 100) / 100,
      },
      truncatedInput: budgeted.truncatedInput,
      droppedTurns: budgeted.droppedCount,
    });

    await Promise.all([
      increment(METRIC.GENERATIONS_COMPLETED),
      observe(SAMPLE.TOKENS_PER_SECOND, tokensPerSecond),
      observe(SAMPLE.TOTAL_COMPLETION_MS, completedAt - startedAt),
      recordSuccess(),
    ]);

    outcome = 'completed';
    return { status: 'completed', tokens: tokenCount };
  } catch (err) {
    if (err instanceof Cancelled) {
      outcome = 'cancelled';
      if (assistantMessage) {
        assistantMessage.content = text;
        assistantMessage.status = 'stopped';
        await assistantMessage.save().catch(() => {});
      }
      await publish('cancelled', { reason: 'user_requested', partialLength: text.length });
      await increment(METRIC.GENERATIONS_CANCELLED);
      return { status: 'cancelled' };
    }

    const isTimeout = err.code === 'INFERENCE_TIMEOUT' || err.statusCode === 504;
    const isInfrastructure =
      isTimeout || err.code === 'INFERENCE_UNAVAILABLE' || err.statusCode === 503 || !err.statusCode;

    if (isInfrastructure) await recordFailure(err.code || err.message);

    outcome = isTimeout ? 'timed_out' : 'failed';
    logger.error({ err, jobId, kind: data.kind, attempt: job.attemptsMade + 1 }, 'Guest generation failed');

    const willRetry = job.attemptsMade + 1 < (job.opts.attempts || 1) && isInfrastructure;
    if (willRetry) throw err;

    if (assistantMessage) {
      assistantMessage.content = text;
      assistantMessage.status = 'error';
      assistantMessage.error = err.message?.slice(0, 500) || 'Generation failed';
      await assistantMessage.save().catch(() => {});
    }

    await publish('error', {
      code: err.code || 'GENERATION_FAILED',
      message: err.isOperational
        ? err.message
        : 'Generation failed. ATOZAS AI could not complete this response.',
      partialLength: text.length,
    });

    await increment(isTimeout ? METRIC.GENERATIONS_TIMED_OUT : METRIC.GENERATIONS_FAILED);
    return { status: outcome };
  } finally {
    await releaseSlot({
      userId: data.userId,
      jobId,
      fingerprint: data.fingerprint,
    }).catch(() => {});
    await clearCancellation(jobId).catch(() => {});
    logger.info({ jobId, outcome, kind: data.kind, queueWaitMs }, 'Guest generation finished');
  }
}

export default processGuestJob;
