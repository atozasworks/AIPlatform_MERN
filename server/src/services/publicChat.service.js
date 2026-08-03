import { PublicRoom } from '../models/PublicRoom.js';
import { PublicMessage } from '../models/PublicMessage.js';
import { env } from '../config/env.js';

export const PUBLIC_ROOM_SLUG = 'global';
/** Cap how much shared history is returned / fed to the model. */
export const PUBLIC_HISTORY_LIMIT = 80;

export function withPublicId(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  const out = { id: String(_id), ...rest };
  if (out.room) out.room = String(out.room);
  return out;
}

/** Ensures the singleton shared room exists. */
export async function getOrCreatePublicRoom() {
  let room = await PublicRoom.findOne({ slug: PUBLIC_ROOM_SLUG });
  if (!room) {
    room = await PublicRoom.create({
      slug: PUBLIC_ROOM_SLUG,
      title: 'Public chat',
      profile: env.ai.defaultProfile || 'balanced',
    });
  }
  return room;
}

export async function listPublicMessages(roomId, { limit = PUBLIC_HISTORY_LIMIT } = {}) {
  const msgs = await PublicMessage.find({ room: roomId })
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
