import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { aiGateway } from '../services/ai/AIGateway.js';
import {
  getOwnedConversation,
  buildProviderMessages,
  buildActivePath,
  getMessages,
} from '../services/conversation.service.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { logger } from '../config/logger.js';

/** GET /ai/models — model catalog for the selector (§4). */
export const listModels = asyncHandler(async (_req, res) => {
  return sendSuccess(res, { models: aiGateway.listModels() });
});

/**
 * POST /ai/conversations/:id/stream
 * Persists the user message, then streams the assistant reply token-by-token
 * over Server-Sent Events. Handles client disconnects (stop generation) and
 * prevents duplicate user messages via an idempotency key (§5, §22).
 *
 * SSE event protocol:
 *   event: meta   data: { provider, model, userMessageId, assistantMessageId, parentMessageId }
 *   event: token  data: { text }
 *   event: title  data: { title }            (once, after first exchange)
 *   event: done   data: { usage, model }
 *   event: error  data: { message }
 */
export const streamChat = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const {
    content,
    provider: reqProvider,
    model: reqModel,
    clientMessageId,
    parentMessageId: reqParentId,
  } = req.body;

  const conversation = await getOwnedConversation(userId, req.params.id);

  // Resolve where this user message hangs in the tree.
  // undefined → continue latest branch; null → root sibling; id → that parent.
  let parentMessageId = reqParentId;
  if (parentMessageId === undefined) {
    const existing = await getMessages(userId, conversation._id);
    const path = buildActivePath(existing);
    const last = path[path.length - 1];
    parentMessageId = last ? last.id : null;
  }

  // Idempotency: if we already stored this client message, don't duplicate it.
  let userMessage = null;
  if (clientMessageId) {
    userMessage = await Message.findOne({
      conversation: conversation._id,
      user: userId,
      role: 'user',
      'clientMeta.clientMessageId': clientMessageId,
    });
  }
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

  const { provider, model } = aiGateway.resolve({
    provider: reqProvider || conversation.provider,
    model: reqModel || conversation.model,
  });

  // Persist chosen provider/model on the conversation if changed.
  if (conversation.provider !== provider.id || conversation.model !== model) {
    conversation.provider = provider.id;
    conversation.model = model;
  }

  const assistantMessage = await Message.create({
    conversation: conversation._id,
    user: userId,
    role: 'assistant',
    content: '',
    provider: provider.id,
    model,
    status: 'streaming',
    parentMessage: userMessage._id,
  });

  // ── Set up SSE ──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('meta', {
    provider: provider.id,
    model,
    userMessageId: String(userMessage._id),
    assistantMessageId: String(assistantMessage._id),
    parentMessageId: parentMessageId || null,
  });

  // Abort generation when the client disconnects (stop button / navigation).
  const abort = new AbortController();
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
    abort.abort();
  });

  let full = '';
  let finalUsage = { prompt: 0, completion: 0, total: 0 };
  let finalModel = model;

  try {
    const messages = await buildProviderMessages(conversation, {
      leafMessageId: userMessage._id,
    });
    const stream = provider.streamResponse({
      model,
      messages,
      options: { signal: abort.signal },
    });

    for await (const chunk of stream) {
      if (chunk.type === 'token') {
        full += chunk.text;
        send('token', { text: chunk.text });
      } else if (chunk.type === 'done') {
        finalUsage = chunk.usage || finalUsage;
        finalModel = chunk.model || finalModel;
      }
    }

    assistantMessage.content = full;
    assistantMessage.status = clientGone ? 'stopped' : 'complete';
    assistantMessage.model = finalModel;
    assistantMessage.tokenUsage = finalUsage;
    await assistantMessage.save();

    // Update conversation aggregates + auto-title after first exchange.
    const update = {
      lastMessageAt: new Date(),
      model: finalModel,
      provider: provider.id,
      $inc: {
        'tokenUsage.prompt': finalUsage.prompt || 0,
        'tokenUsage.completion': finalUsage.completion || 0,
        'tokenUsage.total': finalUsage.total || 0,
      },
    };

    let newTitle = null;
    if (conversation.title === 'New chat') {
      newTitle = deriveTitle(content);
      update.title = newTitle;
    }
    await Conversation.updateOne({ _id: conversation._id }, update);

    if (!clientGone) {
      if (newTitle) send('title', { title: newTitle });
      send('done', { usage: finalUsage, model: finalModel });
      res.end();
    }
  } catch (err) {
    logger.error({ err, requestId: req.id }, 'AI stream failed');
    assistantMessage.status = 'error';
    assistantMessage.content = full;
    assistantMessage.error = err.message;
    await assistantMessage.save().catch(() => {});
    if (!clientGone) {
      send('error', { message: err.isOperational ? err.message : 'Generation failed' });
      res.end();
    }
  }
});

/** Derives a concise title from the first user message. */
function deriveTitle(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const title = clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
  return title || 'New chat';
}
