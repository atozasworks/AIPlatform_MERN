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
 * A single message in a conversation. Supports branching via `parentMessage`,
 * streaming lifecycle via `status`, and later-phase fields (attachments,
 * citations, toolCalls) that default empty in Phase 1.
 */
const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    role: { type: String, enum: ['user', 'assistant', 'system', 'tool'], required: true },
    content: { type: String, default: '' },

    provider: { type: String, default: null },
    model: { type: String, default: null },

    attachments: { type: [Schema.Types.Mixed], default: [] },
    citations: { type: [Schema.Types.Mixed], default: [] },
    toolCalls: { type: [Schema.Types.Mixed], default: [] },

    tokenUsage: { type: tokenUsageSchema, default: () => ({}) },

    parentMessage: { type: Schema.Types.ObjectId, ref: 'Message', default: null },

    // Client-supplied idempotency metadata to dedupe retried/refreshed sends (§22).
    clientMeta: {
      clientMessageId: { type: String, default: null },
    },

    // Privacy: a user can mark an individual message private. When they do, a
    // randomly generated unique code is stored here and emailed to them as a
    // reference/receipt (it is not an access gate — the message stays readable).
    isPrivate: { type: Boolean, default: false },
    privateCode: { type: String, default: null, index: true, sparse: true },
    privateCodeSentAt: { type: Date, default: null },

    feedback: { type: String, enum: ['like', 'dislike', null], default: null },
    status: {
      type: String,
      enum: ['pending', 'streaming', 'complete', 'stopped', 'error'],
      default: 'complete',
    },
    error: { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index(
  { conversation: 1, 'clientMeta.clientMessageId': 1 },
  { partialFilterExpression: { 'clientMeta.clientMessageId': { $type: 'string' } } },
);

messageSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Message = model('Message', messageSchema);
export default Message;
