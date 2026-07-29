import { z } from 'zod';

const email = z.string().trim().toLowerCase().email('A valid email is required');
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password is too long');

export const registerSchema = {
  body: z.object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    email,
    password,
  }),
};

export const loginSchema = {
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),
};
