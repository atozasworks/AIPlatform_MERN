import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { AppError } from '../utils/AppError.js';
import { ingestDocument, removeDocument, listDocuments } from '../services/rag/ingest.js';
import { extractTextFromUpload } from '../services/rag/extractText.js';
import { retrieve } from '../services/rag/retriever.js';

/**
 * Knowledge-base management.
 *
 * Access control lives in the service layer (`ingest.js` for writes,
 * `vectorStore.scopeFilter` for reads), so these handlers stay thin and there
 * is exactly one place to audit for cross-user document leakage.
 */

/** GET /rag/documents — documents this user may retrieve from. */
export const list = asyncHandler(async (req, res) =>
  sendSuccess(res, { documents: await listDocuments(req.user, { limit: req.query.limit }) }),
);

/** POST /rag/documents — index new content. */
export const create = asyncHandler(async (req, res) => {
  const { document, chunks, reused } = await ingestDocument({
    user: req.user,
    title: req.body.title,
    content: req.body.content,
    sourceUri: req.body.sourceUri,
    sourceType: req.body.sourceType,
    visibility: req.body.visibility,
    verified: req.body.verified,
  });

  return sendSuccess(
    res,
    {
      document: {
        id: String(document._id),
        title: document.title,
        visibility: document.visibility,
        status: document.status,
        chunkCount: chunks,
      },
      reused,
    },
    { status: reused ? 200 : 201 },
  );
});

/**
 * POST /rag/documents/upload — multipart file → extract text → index.
 * Returns extracted text so the client can ground the current turn immediately.
 */
export const upload = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw AppError.badRequest('Choose a file to upload', { code: 'FILE_REQUIRED' });
  }

  const title = String(req.body?.title || req.file.originalname || 'Uploaded file').slice(0, 300);
  const { text, kind } = await extractTextFromUpload({
    buffer: req.file.buffer,
    filename: req.file.originalname || title,
    mimeType: req.file.mimetype,
  });

  const { document, chunks, reused } = await ingestDocument({
    user: req.user,
    title,
    content: text,
    sourceType: 'user-upload',
    visibility: 'private',
  });

  return sendSuccess(
    res,
    {
      document: {
        id: String(document._id),
        title: document.title,
        visibility: document.visibility,
        status: document.status,
        chunkCount: chunks,
      },
      reused,
      kind,
      // Cap what we echo back so a huge PDF does not inflate the HTTP reply.
      content: text.length > 200_000 ? text.slice(0, 200_000) : text,
    },
    { status: reused ? 200 : 201 },
  );
});

/** DELETE /rag/documents/:id */
export const remove = asyncHandler(async (req, res) =>
  sendSuccess(res, await removeDocument(req.user, req.params.id)),
);

/**
 * POST /rag/search — retrieval preview.
 *
 * Returns the same scope-filtered results the model would receive, which is how
 * an operator verifies that a citation is genuine and that private documents
 * are not visible across accounts.
 */
export const search = asyncHandler(async (req, res) => {
  const result = await retrieve({
    query: req.body.query,
    scope: {
      userId: String(req.user._id),
      organizationId: req.user.organization ? String(req.user.organization) : null,
    },
    topK: req.body.topK,
  });

  return sendSuccess(res, {
    degraded: result.degraded,
    reason: result.reason || null,
    sources: result.sources.map((s) => ({
      label: s.label,
      documentId: s.documentId,
      title: s.documentTitle,
      heading: s.heading || null,
      sourceUri: s.sourceUri || null,
      sourceType: s.sourceType,
      chunkIndex: s.chunkIndex,
      score: s.score,
      denseScore: s.denseScore,
      keywordScore: s.keywordScore,
      preview: s.chunkText.slice(0, 300),
    })),
  });
});

export default { list, create, upload, remove, search };
