import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

/**
 * Source URIs are recorded for citation display only — the server never fetches
 * them. This validator still rejects non-http(s) schemes so a stored `javascript:`
 * or `file:` URI cannot become an SSRF or XSS vector if a future feature does
 * dereference it.
 */
const safeUri = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => {
      if (!value) return true;
      try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'sourceUri must be an absolute http(s) URL' },
  )
  .optional();

export const createDocumentSchema = {
  body: z.object({
    title: z.string().trim().min(1).max(300),
    content: z.string().min(1, 'Document content is required').max(2_000_000),
    sourceUri: safeUri,
    sourceType: z
      .enum(['documentation', 'product', 'help', 'policy', 'user-upload', 'admin-import'])
      .optional(),
    // Elevated visibilities are additionally gated on the admin role in ingest.js.
    visibility: z.enum(['private', 'organization', 'public']).optional(),
    verified: z.boolean().optional(),
  }),
};

export const documentIdSchema = {
  params: z.object({ id: objectId }),
};

export const listDocumentsSchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
};

export const searchSchema = {
  body: z.object({
    query: z.string().trim().min(2).max(2000),
    topK: z.coerce.number().int().min(1).max(20).optional(),
  }),
};
