import { z } from 'zod';
import { PROFILE_IDS } from '../services/ai/prompts.js';

const guestJobId = z
  .string()
  .trim()
  .max(160)
  .regex(/^gen-(public|ephemeral)-[a-zA-Z0-9:_-]{8,120}$/, 'Invalid job id');

const historyMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(24000),
});

const objectId = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid session id');

export const publicSessionListSchema = {
  query: z.object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    archived: z.enum(['true', 'false']).optional(),
  }),
};

export const publicSessionCreateSchema = {
  body: z
    .object({
      profile: z.enum(PROFILE_IDS).optional(),
      provider: z.string().trim().max(32).optional(),
      model: z.string().trim().max(128).optional(),
    })
    .default({}),
};

export const publicSessionIdSchema = {
  params: z.object({ id: objectId }),
};

export const publicSessionUpdateSchema = {
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    })
    .refine((b) => b.title !== undefined || b.pinned !== undefined || b.archived !== undefined, {
      message: 'Provide title, pinned, and/or archived',
    }),
};

export const publicShareTokenSchema = {
  params: z.object({
    token: z
      .string()
      .trim()
      .regex(/^[a-fA-F0-9]{32,64}$/, 'Invalid share token'),
  }),
};

export const publicRoomStreamSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    content: z.string().trim().min(1, 'Message cannot be empty').max(8000),
    profile: z.enum(PROFILE_IDS).optional(),
    provider: z.string().trim().max(32).optional(),
    model: z.string().trim().max(128).optional(),
    clientMessageId: z.string().trim().max(64).optional(),
    resumeFromSeq: z.coerce.number().int().min(0).max(1_000_000).optional(),
  }),
};

export const ephemeralStreamSchema = {
  body: z.object({
    content: z.string().trim().min(1, 'Message cannot be empty').max(8000),
    profile: z.enum(PROFILE_IDS).optional(),
    provider: z.string().trim().max(32).optional(),
    model: z.string().trim().max(128).optional(),
    clientMessageId: z.string().trim().max(64).optional(),
    history: z.array(historyMessage).max(40).optional().default([]),
    resumeFromSeq: z.coerce.number().int().min(0).max(1_000_000).optional(),
  }),
};

export const publicJobSchema = {
  params: z.object({ jobId: guestJobId }),
  query: z.object({
    lastSeq: z.coerce.number().int().min(0).max(1_000_000).optional(),
  }),
};

export const publicCancelSchema = {
  params: z.object({ jobId: guestJobId }),
};
