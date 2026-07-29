import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { AppError } from '../utils/AppError.js';
import { aiGateway } from './ai/AIGateway.js';

/** Lean docs only have `_id`; map to `id` so the client matches mongoose toJSON. */
export function withId(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  const out = { id: String(_id), ...rest };
  if (out.parentMessage) out.parentMessage = String(out.parentMessage);
  if (out.user) out.user = String(out.user);
  if (out.conversation) out.conversation = String(out.conversation);
  return out;
}

function parentKey(parentMessage) {
  return parentMessage ? String(parentMessage) : 'root';
}

/** Walk the latest (or choice-selected) branch from root → leaf. */
export function buildActivePath(messages, branchChoices = {}) {
  const path = [];
  let parentId = null;

  while (true) {
    const key = parentKey(parentId);
    const siblings = messages
      .filter(
        (m) =>
          m.role === 'user' &&
          parentKey(m.parentMessage) === key &&
          m.status !== 'error',
      )
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (!siblings.length) break;

    const preferred = branchChoices[key];
    const user =
      (preferred && siblings.find((s) => String(s.id || s._id) === String(preferred))) ||
      siblings[siblings.length - 1];

    path.push(user);

    const userId = String(user.id || user._id);
    const assistants = messages
      .filter(
        (m) =>
          m.role === 'assistant' &&
          String(m.parentMessage) === userId &&
          m.status !== 'error',
      )
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (!assistants.length) break;
    const assistant = assistants[assistants.length - 1];
    path.push(assistant);
    parentId = String(assistant.id || assistant._id);
  }

  return path;
}

/**
 * Older linear chats stored every user message with parentMessage=null.
 * Repair them into a proper chain so edit-branches don't collide.
 */
async function repairLinearParents(conversationId, msgs) {
  const rootUsers = msgs.filter((m) => m.role === 'user' && !m.parentMessage);
  const branched = msgs.filter((m) => m.role === 'user' && m.parentMessage);
  if (rootUsers.length <= 1 || branched.length > 0) return msgs;

  const sorted = [...msgs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let lastAssistantId = null;
  const ops = [];

  for (const m of sorted) {
    if (m.role === 'user' && !m.parentMessage && lastAssistantId) {
      ops.push({
        updateOne: {
          filter: { _id: m._id },
          update: { $set: { parentMessage: lastAssistantId } },
        },
      });
      m.parentMessage = lastAssistantId;
    }
    if (m.role === 'assistant') {
      lastAssistantId = m._id;
      if (!m.parentMessage) {
        // Find preceding user in sorted list
        const idx = sorted.indexOf(m);
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (sorted[i].role === 'user') {
            if (!m.parentMessage) {
              ops.push({
                updateOne: {
                  filter: { _id: m._id },
                  update: { $set: { parentMessage: sorted[i]._id } },
                },
              });
              m.parentMessage = sorted[i]._id;
            }
            break;
          }
        }
      }
    }
  }

  if (ops.length) await Message.bulkWrite(ops);
  return msgs;
}

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
  return { items: page.map(withId), nextCursor, hasMore };
}

export async function getMessages(userId, conversationId) {
  await getOwnedConversation(userId, conversationId);
  let msgs = await Message.find({ conversation: conversationId, deletedAt: null })
    .sort({ createdAt: 1 })
    .lean();
  msgs = await repairLinearParents(conversationId, msgs);
  return msgs.map(withId);
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

/**
 * Validates a user message for edit and returns its parent so the client can
 * create a sibling branch (ChatGPT-style versions) instead of deleting history.
 */
export async function prepareMessageEdit(userId, conversationId, messageId) {
  await getOwnedConversation(userId, conversationId);
  const target = await Message.findOne({
    _id: messageId,
    conversation: conversationId,
    user: userId,
    deletedAt: null,
  }).lean();
  if (!target) throw AppError.notFound('Message not found');
  if (target.role !== 'user') {
    throw AppError.badRequest('Only user messages can be edited');
  }
  return {
    messageId: String(target._id),
    parentMessageId: target.parentMessage ? String(target.parentMessage) : null,
  };
}

/** Builds provider history along the branch ending at `leafMessageId` (inclusive). */
export async function buildProviderMessages(conversation, { leafMessageId } = {}) {
  let history = await Message.find({
    conversation: conversation._id,
    deletedAt: null,
    status: { $ne: 'error' },
  })
    .sort({ createdAt: 1 })
    .lean();

  history = await repairLinearParents(conversation._id, history);
  const normalized = history.map(withId);

  const path = leafMessageId
    ? pathToMessage(normalized, String(leafMessageId))
    : buildActivePath(normalized);

  const messages = [];
  if (conversation.systemPrompt) {
    messages.push({ role: 'system', content: conversation.systemPrompt });
  }
  for (const m of path) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}

/** Path from root through the branch that contains `messageId` (inclusive). */
function pathToMessage(messages, messageId) {
  const byId = new Map(messages.map((m) => [String(m.id), m]));
  const target = byId.get(String(messageId));
  if (!target) return buildActivePath(messages);

  const chain = [];
  let cur = target;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentMessage ? byId.get(String(cur.parentMessage)) : null;
  }
  return chain;
}
