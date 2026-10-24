import fs from 'fs';
import path from 'path';
import { pool } from './db';

export async function runMigrations(): Promise<string[]> {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
    await c.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    c.release();
  }
  return applied;
}

if (require.main === module) {
  runMigrations()
    .then((a) => {
      console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date.');
      return pool.end();
    })
    .catch((e) => {
      console.error('Migration failed:', e.message);
      process.exit(1);
    });
}
