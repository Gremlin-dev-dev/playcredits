import { Pool, PoolClient } from 'pg';
import { config } from './config';

// TODO before launch: pin Supabase's CA certificate instead of rejectUnauthorized:false.
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
