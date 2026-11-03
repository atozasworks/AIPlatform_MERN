import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * A retrievable source document.
 *
 * `visibility` is the access-control axis for retrieval:
 *   - private      → only `owner` may retrieve it
 *   - organization → members of `organization` may retrieve it
 *   - public       → every authenticated user (ATOZAS docs, help articles,
 *                    product information, approved policies)
 *
 * Only an administrator may create `public` documents; see rag.controller.js.
 */
const documentSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organization: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    title: { type: String, required: true, trim: true, maxlength: 300 },
    /** Where the content came from, shown in citations. */
    sourceUri: { type: String, default: '', maxlength: 2000 },
    sourceType: {
      type: String,
      enum: ['documentation', 'product', 'help', 'policy', 'user-upload', 'admin-import'],
      default: 'user-upload',
      index: true,
    },

    visibility: {
      type: String,
      enum: ['private', 'organization', 'public'],
      default: 'private',
      index: true,
    },

    language: { type: String, default: 'auto', maxlength: 16 },
    /** SHA-256 of the raw content; blocks re-ingesting an unchanged document. */
    contentHash: { type: String, required: true, index: true },
    byteSize: { type: Number, default: 0 },

    chunkCount: { type: Number, default: 0 },
    embeddingModel: { type: String, default: '' },

    status: {
      type: String,
      enum: ['pending', 'indexing', 'ready', 'failed'],
      default: 'pending',
      index: true,
    },
    error: { type: String, default: null },

    /** Set by an administrator once the content has been reviewed. */
    verified: { type: Boolean, default: false },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

documentSchema.index({ owner: 1, deletedAt: 1, createdAt: -1 });
documentSchema.index({ visibility: 1, deletedAt: 1 });
documentSchema.index({ owner: 1, contentHash: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

documentSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Document = model('Document', documentSchema);
export default Document;
