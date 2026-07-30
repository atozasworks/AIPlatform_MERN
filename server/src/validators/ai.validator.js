import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const chatStreamSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    content: z.string().trim().min(1, 'Message cannot be empty').max(50000),
    provider: z.string().trim().optional(),
    model: z.string().trim().optional(),
    // Idempotency key prevents duplicate assistant responses on retry/refresh (§22).
    clientMessageId: z.string().trim().max(64).optional(),
    // Parent in the message tree (null = root). Used for continue + edit siblings.
    parentMessageId: objectId.nullable().optional(),
  }),
};
