import crypto from 'node:crypto';
import { Document } from '../../models/Document.js';
import { DocumentChunk } from '../../models/DocumentChunk.js';
import { AppError } from '../../utils/AppError.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { chunkText } from './chunker.js';
import { embedPassages } from './embeddings.js';
import { bumpCorpusVersion } from './vectorStore.js';

/**
 * Document ingestion: hash → chunk → embed → persist → invalidate cache.
 *
 * Ingestion runs inline on the API process rather than through the LLM queue.
 * That queue exists to protect llama-server's chat slots; embedding runs on a
 * separate llama-server instance, so routing imports through the same queue
 * would make document uploads wait behind user conversations for no benefit.
 */

export function hashContent(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Only administrators may publish content every user can retrieve. */
function assertVisibilityAllowed(visibility, user) {
  const isAdmin = user.roles?.includes('admin');
  if ((visibility === 'public' || visibility === 'organization') && !isAdmin) {
    throw AppError.forbidden('Only administrators can publish shared documents');
  }
}

/**
 * Indexes a document and makes it retrievable.
 *
 * @param {object} params
 * @param {object} params.user       Authenticated user document
 * @param {string} params.title
 * @param {string} params.content    Plain text or Markdown
 * @param {string} [params.sourceUri]
 * @param {string} [params.sourceType]
 * @param {string} [params.visibility]
 * @param {boolean} [params.verified]
 */
export async function ingestDocument({
  user,
  title,
  content,
  sourceUri = '',
  sourceType = 'user-upload',
  visibility = 'private',
  verified = false,
}) {
  assertVisibilityAllowed(visibility, user);

  const text = String(content || '').trim();
  if (!text) throw AppError.badRequest('Document content is empty');

  const byteSize = Buffer.byteLength(text, 'utf8');
  if (byteSize > env.rag.maxUploadBytes) {
    throw AppError.badRequest(
      `Document exceeds the ${Math.round(env.rag.maxUploadBytes / 1024)} KB limit`,
      { code: 'DOCUMENT_TOO_LARGE' },
    );
  }

  const owned = await Document.countDocuments({ owner: user._id, deletedAt: null });
  if (owned >= env.rag.maxDocumentsPerUser) {
    throw AppError.badRequest(
      `You have reached the limit of ${env.rag.maxDocumentsPerUser} indexed documents.`,
      { code: 'DOCUMENT_LIMIT_REACHED' },
    );
  }

  const contentHash = hashContent(text);
  const existing = await Document.findOne({
    owner: user._id,
    contentHash,
    deletedAt: null,
  });
  if (existing) {
    return { document: existing, chunks: existing.chunkCount, reused: true };
  }

  const chunks = chunkText(text);
  if (!chunks.length) throw AppError.badRequest('Document produced no indexable content');

  const doc = await Document.create({
    owner: user._id,
    organization: user.organization || null,
    title: String(title || 'Untitled document').slice(0, 300),
    sourceUri,
    sourceType,
    visibility,
    contentHash,
    byteSize,
    status: 'indexing',
    verified: Boolean(verified) && user.roles?.includes('admin'),
    embeddingModel: env.ai.embeddings.model,
  });

  try {
    const vectors = await embedPassages(chunks.map((c) => c.text));

    await DocumentChunk.insertMany(
      chunks.map((chunk, i) => ({
        document: doc._id,
        owner: doc.owner,
        organization: doc.organization,
        visibility: doc.visibility,
        chunkIndex: chunk.index,
        text: chunk.text,
        heading: chunk.heading,
        tokenCount: chunk.tokenCount,
        embedding: vectors[i],
        embeddingModel: env.ai.embeddings.model,
        documentTitle: doc.title,
        sourceUri: doc.sourceUri,
        sourceType: doc.sourceType,
      })),
      { ordered: false },
    );

    doc.chunkCount = chunks.length;
    doc.status = 'ready';
    await doc.save();

    await bumpCorpusVersion();
    logger.info({ documentId: String(doc._id), chunks: chunks.length }, 'Document indexed');

    return { document: doc, chunks: chunks.length, reused: false };
  } catch (err) {
    // Leave no half-indexed document behind: a partial corpus produces
    // citations that point at content the answer never actually saw.
    await DocumentChunk.deleteMany({ document: doc._id }).catch(() => {});
    doc.status = 'failed';
    doc.error = err.message?.slice(0, 500) || 'Indexing failed';
    await doc.save().catch(() => {});
    throw err;
  }
}

/** Soft-deletes a document and its chunks, then refreshes the vector cache. */
export async function removeDocument(user, documentId) {
  const doc = await Document.findOne({ _id: documentId, deletedAt: null });
  if (!doc) throw AppError.notFound('Document not found');

  const isOwner = String(doc.owner) === String(user._id);
  const isAdmin = user.roles?.includes('admin');
  if (!isOwner && !isAdmin) throw AppError.forbidden('You cannot delete this document');

  const now = new Date();
  doc.deletedAt = now;
  await doc.save();
  await DocumentChunk.updateMany({ document: doc._id, deletedAt: null }, { deletedAt: now });
  await bumpCorpusVersion();

  return { id: String(doc._id) };
}

/** Documents the caller may see: their own, plus shared content. */
export async function listDocuments(user, { limit = 50 } = {}) {
  const clauses = [{ owner: user._id }, { visibility: 'public' }];
  if (user.organization) {
    clauses.push({ visibility: 'organization', organization: user.organization });
  }

  const docs = await Document.find({ deletedAt: null, $or: clauses })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();

  return docs.map((d) => ({
    id: String(d._id),
    title: d.title,
    sourceType: d.sourceType,
    sourceUri: d.sourceUri,
    visibility: d.visibility,
    verified: d.verified,
    status: d.status,
    chunkCount: d.chunkCount,
    byteSize: d.byteSize,
    owned: String(d.owner) === String(user._id),
    createdAt: d.createdAt,
  }));
}

export default { ingestDocument, removeDocument, listDocuments, hashContent };
