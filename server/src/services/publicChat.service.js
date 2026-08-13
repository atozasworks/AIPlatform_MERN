import crypto from 'node:crypto';

import { PublicRoom } from '../models/PublicRoom.js';
import { PublicMessage } from '../models/PublicMessage.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

/** Cap how much session history is returned / fed to the model. */
export const PUBLIC_HISTORY_LIMIT = 80;
const MAX_SESSIONS_PER_GUEST = 50;

export function withPublicId(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  const out = { id: String(_id), ...rest };
  if (out.room) out.room = String(out.room);
  return out;
}

function titleFromContent(content) {
  const text = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'New chat';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Creates a private session for this guest browser. */
export async function createGuestSession(guestId, { profile, provider, model } = {}) {
  if (!guestId) throw AppError.badRequest('Missing guest session');

  const count = await PublicRoom.countDocuments({ guestId, deletedAt: null });
  if (count >= MAX_SESSIONS_PER_GUEST) {
    // Drop the oldest empty-or-idle sessions so the guest can keep chatting.
    const oldest = await PublicRoom.find({ guestId, deletedAt: null })
      .sort({ lastMessageAt: 1 })
      .limit(Math.max(1, count - MAX_SESSIONS_PER_GUEST + 1))
      .select('_id')
      .lean();
    const ids = oldest.map((r) => r._id);
    if (ids.length) {
      await PublicRoom.updateMany({ _id: { $in: ids } }, { deletedAt: new Date() });
    }
  }

  return PublicRoom.create({
    slug: `guest:${crypto.randomUUID()}`,
    guestId,
    title: 'New chat',
    profile: profile || env.ai.defaultProfile || 'balanced',
    provider: provider || null,
    model: model || null,
    lastMessageAt: new Date(),
  });
}

export async function listGuestSessions(guestId, { q, limit = 50, archived = false } = {}) {
  if (!guestId) return [];
  const query = {
    guestId,
    deletedAt: null,
  };
  if (archived === true || archived === 'true') {
    query.archived = true;
  } else {
    // Treat missing field as not archived (legacy rooms created before the flag).
    query.archived = { $ne: true };
  }
  const search = String(q || '').trim();
  if (search) {
    query.title = { $regex: escapeRegex(search), $options: 'i' };
  }

  const rooms = await PublicRoom.find(query)
    .sort({ pinned: -1, lastMessageAt: -1 })
    .limit(Math.min(100, Number(limit) || 50))
    .lean();

  // Hide empty shells that somehow got created without a first message.
  const withMessages = [];
  for (const room of rooms) {
    if (room.title && room.title !== 'New chat') {
      withMessages.push(withPublicId(room));
      continue;
    }
    const hasMsg = await PublicMessage.exists({ room: room._id });
    if (hasMsg) withMessages.push(withPublicId(room));
  }
  return withMessages;
}

/** Patch title / pinned / archived on an owned guest session. */
export async function updateGuestSession(guestId, roomId, patch = {}) {
  const room = await getOwnedGuestSession(guestId, roomId);
  if (typeof patch.title === 'string') {
    const title = patch.title.trim().slice(0, 200);
    if (!title) throw AppError.badRequest('Title cannot be empty');
    room.title = title;
  }
  if (typeof patch.pinned === 'boolean') room.pinned = patch.pinned;
  if (typeof patch.archived === 'boolean') {
    room.archived = patch.archived;
    // Archiving clears the pin so archived lists stay simple.
    if (patch.archived) room.pinned = false;
  }
  await room.save();
  return room;
}

/** Creates (or returns) a read-only share token for this session. */
export async function enableGuestShare(guestId, roomId) {
  const room = await getOwnedGuestSession(guestId, roomId);
  if (!room.shareToken) {
    room.shareToken = crypto.randomBytes(24).toString('hex');
    await room.save();
  }
  return room;
}

export async function disableGuestShare(guestId, roomId) {
  const room = await getOwnedGuestSession(guestId, roomId);
  room.shareToken = null;
  await room.save();
  return room;
}

/** Public read of a shared guest session (no cookie ownership required). */
export async function getSharedGuestSession(token) {
  const shareToken = String(token || '').trim();
  if (!/^[a-f0-9]{32,64}$/i.test(shareToken)) {
    throw AppError.notFound('Shared chat not found');
  }
  const room = await PublicRoom.findOne({
    shareToken,
    deletedAt: null,
  });
  if (!room) throw AppError.notFound('Shared chat not found');
  const messages = await listPublicMessages(room._id);
  return {
    session: {
      id: String(room._id),
      title: room.title,
      createdAt: room.createdAt,
      lastMessageAt: room.lastMessageAt,
    },
    messages,
  };
}

export async function getOwnedGuestSession(guestId, roomId) {
  if (!guestId) throw AppError.unauthorized('Guest session required');
  const room = await PublicRoom.findOne({
    _id: roomId,
    guestId,
    deletedAt: null,
  });
  if (!room) throw AppError.notFound('Chat session not found');
  return room;
}

export async function softDeleteGuestSession(guestId, roomId) {
  const room = await getOwnedGuestSession(guestId, roomId);
  room.deletedAt = new Date();
  await room.save();
  await PublicMessage.updateMany({ room: room._id }, { $set: { deletedAt: new Date() } }).catch(
    () => {},
  );
  return room;
}

export async function listPublicMessages(roomId, { limit = PUBLIC_HISTORY_LIMIT } = {}) {
  const msgs = await PublicMessage.find({ room: roomId, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return msgs.reverse().map(withPublicId);
}

/**
 * Recent complete turns for the model prompt (oldest → newest).
 * Pending/error rows are skipped so a crashed generation does not poison context.
 */
export async function getPublicHistoryForModel(roomId, { excludeIds = [] } = {}) {
  const exclude = excludeIds.map(String).filter(Boolean);
  const msgs = await PublicMessage.find({
    room: roomId,
    deletedAt: null,
    status: { $in: ['complete', 'stopped'] },
    ...(exclude.length ? { _id: { $nin: exclude } } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(PUBLIC_HISTORY_LIMIT)
    .select('role content')
    .lean();

  return msgs
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '') }));
}

/** Auto-title a session from the first user turn when still "New chat". */
export async function maybeTitleGuestSession(room, content) {
  if (!room) return null;
  if (room.title && room.title !== 'New chat') return room.title;
  const title = titleFromContent(content);
  await PublicRoom.updateOne({ _id: room._id }, { title, lastMessageAt: new Date() });
  return title;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
