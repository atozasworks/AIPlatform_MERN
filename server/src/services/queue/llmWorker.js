import { Worker } from 'bullmq';
import { getQueueConnection, key } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { LLM_QUEUE_NAME, isCancelled, clearCancellation } from './llmQueue.js';
import { createStreamPublisher } from './streamBus.js';
import { releaseSlot } from './userLimits.js';
import { requestPermission, recordSuccess, recordFailure } from './circuitBreaker.js';
import { aiGateway } from '../ai/AIGateway.js';
import { resolveProfile } from '../ai/prompts.js';
import { buildSystemPrompt } from '../ai/systemPrompt.js';
import { buildBudgetedMessages } from '../ai/tokenBudget.js';
import { retrieve } from '../rag/retriever.js';
import { extractCitations, stripInvalidCitations, toClientCitation } from '../rag/citations.js';
import { Conversation } from '../../models/Conversation.js';
import { Message } from '../../models/Message.js';
import { UsageEvent } from '../../models/UsageEvent.js';
import { getOwnedConversation, getBranchHistory } from '../conversation.service.js';
import { increment, observe, METRIC, SAMPLE } from '../health/metrics.js';
import { processGuestJob } from './guestLlmWorker.js';

/**
 * The controlled LLM worker.
 *
 * This is the only place in the system that calls llama-server for chat. Its
 * concurrency is the hard ceiling on simultaneous CPU inference, which is what
 * lets hundreds of connected users share an 8-thread box without collapsing it.
 *
 * The worker never writes to an HTTP response. It publishes frames to Redis and
 * persists the result to MongoDB, so a browser that disconnects mid-generation
 * can reconnect and replay, and the answer is saved either way.
 *
 * Guest (pre-login) jobs are dispatched to `processGuestJob` and never enter
 * the authenticated Conversation/Message ownership path below.
 */

/** Cancellation is polled rather than pushed, since it crosses processes. */
const CANCEL_POLL_TOKENS = 8;
const CANCEL_POLL_MS = 750;

let worker = null;

/** Wraps a terminal state so the job's `finally` block knows what happened. */
class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

async function loadJobContext(data) {
  const conversation = await getOwnedConversation(data.userId, data.conversationId);
  const assistantMessage = await Message.findOne({
    _id: data.assistantMessageId,
    conversation: conversation._id,
    user: data.userId,
  });
  if (!assistantMessage) throw new Error('Assistant message row is missing');

  const { history, currentTurn } = await getBranchHistory(conversation, {
    leafMessageId: data.userMessageId,
  });
  if (!currentTurn) throw new Error('User message is missing from the conversation branch');

  return { conversation, assistantMessage, history, currentTurn };
}

/**
 * Runs retrieval when the profile calls for it. A retrieval failure degrades to
 * an ungrounded answer rather than failing the request — except for the
 * rag-grounded profile, where an ungrounded answer would defeat the point.
 */
async function gatherSources({ profile, conversation, question, userId, publish }) {
  if (!profile.retrieval || !env.rag.enabled || !shouldRetrieve(profile, conversation)) {
    return { sources: [], degraded: false };
  }

  try {
    const result = await retrieve({
      query: question,
      scope: {
        userId: String(userId),
        organizationId: conversation.organization ? String(conversation.organization) : null,
      },
    });

    if (result.sources.length) {
      await publish('citation', {
        stage: 'retrieved',
        sources: result.sources.map((s) => ({
          label: s.label,
          title: s.documentTitle,
          heading: s.heading || null,
          sourceUri: s.sourceUri || null,
          sourceType: s.sourceType,
          score: s.score,
        })),
      });
    }

    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'Retrieval failed; continuing without sources');
    return { sources: [], degraded: true };
  }
}

/** Retrieval is opt-out per conversation as well as per profile. */
function shouldRetrieve(profile, conversation) {
  if (profile.requireRetrieval) return true;
  return conversation.retrievalEnabled !== false;
}

/**
 * Processes one generation job.
 * @param {import('bullmq').Job} job
 */
async function processJob(job) {
  // Pre-login public/ephemeral jobs use a separate handler so the authenticated
  // path below stays byte-for-byte the same for logged-in users.
  if (job.data?.kind === 'public' || job.data?.kind === 'ephemeral') {
    return processGuestJob(job);
  }

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
    // A job that sat too long has almost certainly lost its client.
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
      // Re-throwing lets BullMQ retry with backoff once the breaker closes.
      throw Object.assign(new Error('Inference temporarily unavailable'), {
        code: 'INFERENCE_UNAVAILABLE',
        retryable: true,
      });
    }

    const context = await loadJobContext(data);
    assistantMessage = context.assistantMessage;

    const profile = resolveProfile(data.profile, { maxTokens: data.maxTokens });
    const { provider, model } = aiGateway.resolve({ provider: data.providerId, model: data.model });

    await publish('started', {
      provider: provider.id,
      model,
      profile: profile.id,
      queueWaitMs,
    });
    await increment(METRIC.GENERATIONS_STARTED);
    await observe(SAMPLE.QUEUE_WAIT_MS, queueWaitMs);

    const retrieval = await gatherSources({
      profile,
      conversation: context.conversation,
      question: context.currentTurn.content,
      userId: data.userId,
      publish,
    });

    const systemPrompt = buildSystemPrompt({
      profile,
      conversationPrompt: context.conversation.systemPrompt,
      sources: retrieval.sources,
      language: data.language,
    });

    const budgeted = buildBudgetedMessages({
      systemPrompt,
      history: context.history,
      currentTurn: context.currentTurn,
      maxOutputTokens: profile.maxTokens,
      contextWindow: provider.getContextWindow?.(model) ?? provider.contextWindow,
    });

    if (budgeted.droppedCount) {
      logger.debug(
        { jobId, dropped: budgeted.droppedCount },
        'Trimmed older turns to fit the context window',
      );
    }

    // ── Generation ──
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

          // Poll for a cross-process stop request every few tokens.
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

    // ── Citations: keep only labels that map to a real retrieved chunk ──
    const { citations, invalidLabels } = extractCitations(text, retrieval.sources);
    if (invalidLabels.length) {
      logger.warn({ jobId, invalidLabels }, 'Model produced citations with unknown labels');
      text = stripInvalidCitations(text, invalidLabels);
    }

    const completedAt = Date.now();
    const generationMs = completedAt - (firstTokenAt || startedAt);
    const tokensPerSecond = generationMs > 0 ? (tokenCount / generationMs) * 1000 : 0;

    assistantMessage.content = text;
    assistantMessage.status = 'complete';
    assistantMessage.model = finalModel;
    assistantMessage.provider = provider.id;
    assistantMessage.tokenUsage = usage;
    assistantMessage.citations = citations.map(toClientCitation);
    await assistantMessage.save();

    await Conversation.updateOne(
      { _id: context.conversation._id },
      {
        lastMessageAt: new Date(),
        model: finalModel,
        provider: provider.id,
        $inc: {
          'tokenUsage.prompt': usage.prompt || 0,
          'tokenUsage.completion': usage.completion || 0,
          'tokenUsage.total': usage.total || 0,
        },
      },
    );

    await publish('completed', {
      model: finalModel,
      finishReason,
      usage,
      citations: citations.map(toClientCitation),
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
      UsageEvent.create({
        user: data.userId,
        conversation: data.conversationId,
        jobId,
        provider: provider.id,
        model: finalModel,
        profile: profile.id,
        promptTokens: usage.prompt || budgeted.promptTokens,
        completionTokens: usage.completion || tokenCount,
        queueWaitMs,
        timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
        totalMs: completedAt - startedAt,
        retrievedChunkCount: retrieval.sources.length,
        status: 'completed',
      }).catch(() => {}),
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
    logger.error({ err, jobId, attempt: job.attemptsMade + 1 }, 'Generation job failed');

    const willRetry = job.attemptsMade + 1 < (job.opts.attempts || 1) && isInfrastructure;
    if (willRetry) {
      // Keep the partial text out of the DB; the retry regenerates from scratch.
      throw err;
    }

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
    logger.info({ jobId, outcome, queueWaitMs }, 'Generation job finished');
  }
}

/** Starts the worker. Called only from `src/worker.js`. */
export function startLlmWorker() {
  if (worker) return worker;

  worker = new Worker(LLM_QUEUE_NAME, processJob, {
    connection: getQueueConnection(),
    prefix: key('bull'),
    concurrency: env.limits.workerConcurrency,
    // A job may legitimately run for minutes on CPU; renew the lock often
    // enough that BullMQ does not consider it stalled mid-generation.
    lockDuration: 60000,
    lockRenewTime: 20000,
    stalledInterval: 60000,
    maxStalledCount: 1,
  });

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'Worker job failed'),
  );
  worker.on('error', (err) => logger.error({ err }, 'Worker error'));

  logger.info(
    { concurrency: env.limits.workerConcurrency },
    'LLM worker started',
  );

  return worker;
}

export async function stopLlmWorker() {
  // `close()` waits for in-flight generations, so a deploy does not cut a user
  // off mid-answer.
  await worker?.close();
  worker = null;
}

export default startLlmWorker;
