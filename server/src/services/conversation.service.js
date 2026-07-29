import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { AppError } from '../utils/AppError.js';
import { aiGateway } from './ai/AIGateway.js';

/**
 * Conversation + message data access. Every query is scoped by `user` so users
 * can never read or mutate another user's data (§21 cross-user isolation).
 */
export async function createConversation(userId, input = {}) {
  const { provider, model } = aiGateway.resolve({ provider: input.provider, model: input.model });
  return Conversation.create({
    user: userId,
    title: input.title || 'New chat',
    provider: provider.id,
    model,
    systemPrompt: input.systemPrompt || '',
    temporary: Boolean(input.temporary),
  });
}

export async function getOwnedConversation(userId, conversationId) {
  const convo = await Conversation.findOne({
    _id: conversationId,
    user: userId,
    deletedAt: null,
  });
  if (!convo) throw AppError.notFound('Conversation not found');
  return convo;
}

export async function listConversations(userId, { search, archived, cursor, limit = 25 } = {}) {
  const query = { user: userId, deletedAt: null };
  if (archived === 'true') query.archived = true;
  else if (archived === 'false') query.archived = false;
  if (search) query.$text = { $search: search };
  // Cursor = lastMessageAt ISO string of the last item from the previous page.
  if (cursor) query.lastMessageAt = { $lt: new Date(cursor) };

  const items = await Conversation.find(query)
    .sort({ lastMessageAt: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? page[page.length - 1].lastMessageAt : null;
  return { items: page, nextCursor, hasMore };
}

export async function getMessages(userId, conversationId) {
  await getOwnedConversation(userId, conversationId);
  return Message.find({ conversation: conversationId, deletedAt: null })
    .sort({ createdAt: 1 })
    .lean();
}

export async function updateConversation(userId, conversationId, patch) {
  const convo = await getOwnedConversation(userId, conversationId);
  Object.assign(convo, patch);
  await convo.save();
  return convo;
}

export async function softDeleteConversation(userId, conversationId) {
  const convo = await getOwnedConversation(userId, conversationId);
  convo.deletedAt = new Date();
  await convo.save();
  await Message.updateMany(
    { conversation: conversationId, deletedAt: null },
    { deletedAt: new Date() },
  );
  return convo;
}

/** Builds the message array sent to the provider, including the system prompt. */
export async function buildProviderMessages(conversation) {
  const history = await Message.find({
    conversation: conversation._id,
    deletedAt: null,
    status: { $ne: 'error' },
  })
    .sort({ createdAt: 1 })
    .lean();

  const messages = [];
  if (conversation.systemPrompt) {
    messages.push({ role: 'system', content: conversation.systemPrompt });
  }
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}
