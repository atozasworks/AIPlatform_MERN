import { z } from 'zod';

const email = z.string().trim().toLowerCase().email('A valid email is required');

export const otpRequestSchema = {
  body: z.object({
    email,
  }),
};

export const otpVerifySchema = {
  body: z.object({
    email,
    code: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, 'Enter the numeric code from your email'),
  }),
};

export const googleSchema = {
  body: z.object({
    credential: z.string().min(1, 'Missing Google credential'),
  }),
};
