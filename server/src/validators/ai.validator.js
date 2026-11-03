import { z } from 'zod';
import { PROFILE_IDS } from '../services/ai/prompts.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

/**
 * Job ids are generated server-side as `gen-<conversationId>-<hex>`; the route
 * handlers additionally verify the embedded conversation id matches the URL,
 * which is what stops one user resuming or cancelling another user's job.
 */
const jobId = z
  .string()
  .trim()
  .max(128)
  .regex(/^gen-[a-f\d]{24}-[a-f\d-]{8,64}$/i, 'Invalid job id');

export const chatStreamSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    // Hard character ceiling; the token budget is enforced separately against
    // MAX_PROMPT_TOKENS once the text is tokenized.
    content: z.string().trim().min(1, 'Message cannot be empty').max(24000),
    profile: z.enum(PROFILE_IDS).optional(),
    provider: z.string().trim().max(32).optional(),
    model: z.string().trim().max(128).optional(),
    // Idempotency key: prevents duplicate messages on retry or refresh.
    clientMessageId: z.string().trim().max(64).optional(),
    // Parent in the message tree (null = root). Drives continue + edit branches.
    parentMessageId: objectId.nullable().optional(),
    // Last frame the client already rendered, for exactly-once reconnects.
    resumeFromSeq: z.coerce.number().int().min(0).max(1_000_000).optional(),
  }),
};

export const streamJobSchema = {
  params: z.object({ id: objectId, jobId }),
  query: z.object({
    lastSeq: z.coerce.number().int().min(0).max(1_000_000).optional(),
  }),
};

export const cancelJobSchema = {
  params: z.object({ id: objectId, jobId }),
};
