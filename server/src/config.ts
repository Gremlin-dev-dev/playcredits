import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  // Set to "true" for hosted databases such as Supabase (they require TLS).
  DATABASE_SSL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  WELCOME_BONUS_CREDITS: z.coerce.number().int().positive().default(10000),
  MIN_BET_CREDITS: z.coerce.number().int().positive().default(100),
  MAX_BET_CREDITS: z.coerce.number().int().positive().default(5000),
  TRUST_PROXY: z.coerce.number().int().default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
