import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const tokenUsageSchema = new Schema(
  {
    prompt: { type: Number, default: 0 },
    completion: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false },
);

/**
 * A conversation groups messages for a user against a chosen provider/model.
 * Scoped strictly by `user` (and later `organization`) to prevent cross-user leakage.
 */
const conversationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organization: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },

    title: { type: String, default: 'New chat', trim: true, maxlength: 200 },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    systemPrompt: { type: String, default: '', maxlength: 8000 },

    /** Prompt profile applied to new turns (see services/ai/prompts.js). */
    profile: { type: String, default: 'balanced' },
    /** Lets a user turn document grounding off for a specific conversation. */
    retrievalEnabled: { type: Boolean, default: true },

    folder: { type: String, default: null },
    tags: { type: [String], default: [] },

    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    temporary: { type: Boolean, default: false },

    tokenUsage: { type: tokenUsageSchema, default: () => ({}) },
    costEstimate: { type: Number, default: 0 },

    lastMessageAt: { type: Date, default: Date.now, index: true },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversationSchema.index({ user: 1, lastMessageAt: -1 });
conversationSchema.index({ user: 1, pinned: -1, lastMessageAt: -1 });
conversationSchema.index({ user: 1, archived: 1 });
conversationSchema.index({ title: 'text' });

conversationSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Conversation = model('Conversation', conversationSchema);
export default Conversation;
