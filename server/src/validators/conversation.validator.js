import { z } from 'zod';
import { PROFILE_IDS } from '../services/ai/prompts.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const createConversationSchema = {
  body: z.object({
    title: z.string().trim().max(200).optional(),
    provider: z.string().trim().max(32).optional(),
    model: z.string().trim().max(128).optional(),
    profile: z.enum(PROFILE_IDS).optional(),
    retrievalEnabled: z.boolean().optional(),
    systemPrompt: z.string().max(8000).optional(),
    temporary: z.boolean().optional(),
  }),
};

export const updateConversationSchema = {
  params: z.object({ id: objectId }),
  body: z
    .object({
      title: z.string().trim().max(200).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      folder: z.string().trim().max(120).nullable().optional(),
      tags: z.array(z.string().trim().max(40)).max(50).optional(),
      systemPrompt: z.string().max(8000).optional(),
      profile: z.enum(PROFILE_IDS).optional(),
      retrievalEnabled: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
};

export const conversationIdSchema = {
  params: z.object({ id: objectId }),
};

export const editMessageSchema = {
  params: z.object({ id: objectId, messageId: objectId }),
  body: z.object({
    content: z.string().trim().min(1).max(32000),
  }),
};

export const listConversationsSchema = {
  query: z.object({
    search: z.string().trim().max(200).optional(),
    archived: z.enum(['true', 'false']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
};
