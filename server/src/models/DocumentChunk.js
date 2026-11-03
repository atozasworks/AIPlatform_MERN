import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * An embedded slice of a Document.
 *
 * Vectors live here as a plain array of doubles. That is a deliberate trade:
 * MongoDB Community has no native vector index, so retrieval does a keyword
 * prefilter plus an in-process dot product over a scope-filtered cache (see
 * vectorStore.js). This keeps the deployment to a single database with no extra
 * service, and stays comfortably fast into the tens of thousands of chunks.
 *
 * Access-control fields are denormalized from the parent document so retrieval
 * can filter by scope without a join. `ingest.js` keeps them in sync.
 */
const documentChunkSchema = new Schema(
  {
    document: { type: Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organization: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    visibility: {
      type: String,
      enum: ['private', 'organization', 'public'],
      required: true,
      index: true,
    },

    /** Position within the parent document, used to show ordered citations. */
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },
    /** Markdown heading trail ("Billing › Refunds") for citation context. */
    heading: { type: String, default: '' },
    tokenCount: { type: Number, default: 0 },

    /** L2-normalized embedding, so cosine similarity is a plain dot product. */
    embedding: { type: [Number], default: undefined, select: false },
    embeddingModel: { type: String, default: '' },

    // Denormalized for citation rendering without loading the parent.
    documentTitle: { type: String, default: '' },
    sourceUri: { type: String, default: '' },
    sourceType: { type: String, default: 'user-upload' },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

documentChunkSchema.index({ document: 1, chunkIndex: 1 });
documentChunkSchema.index({ visibility: 1, owner: 1, deletedAt: 1 });
// Backs the keyword half of hybrid retrieval.
documentChunkSchema.index({ text: 'text', heading: 'text', documentTitle: 'text' });

documentChunkSchema.set('toJSON', { virtuals: true, versionKey: false });

export const DocumentChunk = model('DocumentChunk', documentChunkSchema);
export default DocumentChunk;
