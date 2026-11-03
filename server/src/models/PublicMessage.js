import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * Messages in a guest chat session (`PublicRoom` owned by a guest cookie).
 * Visible only to that guest — not a global shared town square.
 */
const publicMessageSchema = new Schema(
  {
    room: { type: Schema.Types.ObjectId, ref: 'PublicRoom', required: true, index: true },

    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, default: '' },

    /** For assistant rows: the user message this reply belongs to. */
    replyTo: { type: Schema.Types.ObjectId, ref: 'PublicMessage', default: null, index: true },

    provider: { type: String, default: null },
    model: { type: String, default: null },

    /** Live-web sources cited by an assistant reply (guests use web-only RAG). */
    citations: {
      type: [
        new Schema(
          {
            label: String,
            title: String,
            heading: { type: String, default: null },
            sourceUri: { type: String, default: null },
            sourceType: String,
            siteName: { type: String, default: null },
            publishedAt: { type: Date, default: null },
            retrievedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    clientMeta: {
      clientMessageId: { type: String, default: null },
    },

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

publicMessageSchema.index({ room: 1, createdAt: 1 });
publicMessageSchema.index(
  { room: 1, 'clientMeta.clientMessageId': 1 },
  { partialFilterExpression: { 'clientMeta.clientMessageId': { $type: 'string' } } },
);

publicMessageSchema.set('toJSON', { virtuals: true, versionKey: false });

export const PublicMessage = model('PublicMessage', publicMessageSchema);
export default PublicMessage;
