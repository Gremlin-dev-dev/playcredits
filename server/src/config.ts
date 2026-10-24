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

  // ---- Real money (all amounts in kobo). OFF until the gaming licence is in place. ----
  REAL_MONEY_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),
  REAL_MIN_BET_KOBO: z.coerce.number().int().positive().default(10_000), // NGN 100
  REAL_MAX_BET_KOBO: z.coerce.number().int().positive().default(500_000), // NGN 5,000
  MIN_DEPOSIT_KOBO: z.coerce.number().int().positive().default(10_000), // NGN 100
  MAX_DEPOSIT_KOBO: z.coerce.number().int().positive().default(50_000_000), // NGN 500,000
  MIN_WITHDRAWAL_KOBO: z.coerce.number().int().positive().default(100_000), // NGN 1,000
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
