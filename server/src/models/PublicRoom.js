import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * Guest chat session. New rooms are owned by a browser `guestId` cookie so
 * visitors do not share one global thread. The legacy `slug: 'global'` room may
 * still exist in the DB but is no longer written by the public API.
 */
const publicRoomSchema = new Schema(
  {
    // Unique room key. Legacy shared room used `global`; guest sessions use `guest:<uuid>`.
    slug: { type: String, required: true, unique: true },
    guestId: { type: String, index: true, default: null },
    title: { type: String, default: 'New chat', trim: true, maxlength: 200 },
    provider: { type: String, default: null },
    model: { type: String, default: null },
    profile: { type: String, default: 'balanced' },
    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    /** Opaque token for read-only shared links; null until the guest shares. */
    shareToken: { type: String, default: null, index: true, sparse: true },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

publicRoomSchema.index({ guestId: 1, lastMessageAt: -1 });
publicRoomSchema.index({ guestId: 1, deletedAt: 1, lastMessageAt: -1 });
publicRoomSchema.index({ guestId: 1, archived: 1, pinned: -1, lastMessageAt: -1 });

publicRoomSchema.set('toJSON', { virtuals: true, versionKey: false });

export const PublicRoom = model('PublicRoom', publicRoomSchema);
export default PublicRoom;
