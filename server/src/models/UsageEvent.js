import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * One record per completed generation, for capacity planning and abuse review.
 *
 * Deliberately stores no prompt or response text — only timings, token counts
 * and identifiers. Documents expire automatically so operational telemetry does
 * not become an indefinite record of user behaviour.
 */
const usageEventSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
    jobId: { type: String, required: true, index: true },

    provider: { type: String, required: true },
    model: { type: String, required: true },
    profile: { type: String, default: 'balanced' },

    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },

    queueWaitMs: { type: Number, default: 0 },
    timeToFirstTokenMs: { type: Number, default: null },
    totalMs: { type: Number, default: 0 },
    retrievedChunkCount: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['completed', 'cancelled', 'failed', 'timed_out'],
      required: true,
      index: true,
    },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

// Retain 90 days of telemetry, then let MongoDB expire it.
usageEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
usageEventSchema.index({ user: 1, createdAt: -1 });

usageEventSchema.set('toJSON', { virtuals: true, versionKey: false });

export const UsageEvent = model('UsageEvent', usageEventSchema);
export default UsageEvent;
