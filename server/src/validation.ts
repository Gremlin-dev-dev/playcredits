import { z } from 'zod';

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // bcrypt only uses the first 72 bytes, so cap there.
  password: z.string().min(10, 'Password must be at least 10 characters').max(72),
});

export const betSchema = (min: number, max: number) =>
  z.object({ amount: z.number().int('Bet must be a whole number').min(min).max(max) });

export const roundIdSchema = z.object({ id: z.string().uuid() });

export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.coerce.number().int().positive().optional(),
});
