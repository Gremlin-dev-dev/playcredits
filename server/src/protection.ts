import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { pool, withTx } from './db';
import { HttpError } from './errors';
import { requireAuth } from './auth';

// Anything with a pg-style query() works: the pool or a transaction client.
type Q = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };

const WINDOW: Record<string, string> = { daily: '1 day', weekly: '7 days', monthly: '30 days' };
const COOLING_OFF = '24 hours';
const EXCLUSION_MS: Record<string, number | null> = {
  '24h': 24 * 3600e3,
  '7d': 7 * 24 * 3600e3,
  '30d': 30 * 24 * 3600e3,
  '90d': 90 * 24 * 3600e3,
  '180d': 180 * 24 * 3600e3,
  permanent: null,
};

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** The limit that applies right now: a scheduled change counts once its time has passed. */
function effectiveAmount(row: any): number | null {
  const matured = row.pending_effective_at && new Date(row.pending_effective_at).getTime() <= Date.now();
  const v = matured ? row.pending_amount : row.amount;
  return v === null || v === undefined ? null : Number(v);
}

// ---------- enforcement (called from deposits and real-money bets) ----------

export async function assertNotExcluded(q: Q, userId: string) {
  const r = await q.query(`SELECT self_excluded_until > now() AS active FROM users WHERE id=$1`, [userId]);
  if (r.rows[0]?.active) throw new HttpError(403, 'You have self-excluded from real-money play');
}

export async function assertDepositAllowed(q: Q, userId: string, amount: number) {
  const limits = await q.query(`SELECT * FROM player_limits WHERE user_id=$1 AND kind='deposit'`, [userId]);
  for (const row of limits.rows) {
    const limit = effectiveAmount(row);
    if (limit === null) continue;
    // Count completed deposits, plus checkouts started in the last hour (not yet confirmed).
    const used = await q.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payments
       WHERE user_id=$1 AND kind='deposit'
         AND created_at > now() - $2::interval
         AND (status='succeeded' OR (status='pending' AND created_at > now() - interval '1 hour'))`,
      [userId, WINDOW[row.period]],
    );
    if (Number(used.rows[0].total) + amount > limit) {
      throw new HttpError(403, `This deposit would exceed your ${row.period} deposit limit`);
    }
  }
}

/** Net real-money losses in the window (bets minus payouts, including any open round) + this bet must fit. */
export async function assertLossAllowed(q: Q, userId: string, bet: number) {
  const limits = await q.query(`SELECT * FROM player_limits WHERE user_id=$1 AND kind='loss'`, [userId]);
  for (const row of limits.rows) {
    const limit = effectiveAmount(row);
    if (limit === null) continue;
    const net = await q.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM ledger_entries
       WHERE user_id=$1 AND balance_type='real' AND entry_type IN ('bet','payout')
         AND created_at > now() - $2::interval`,
      [userId, WINDOW[row.period]],
    );
    const lossSoFar = Math.max(0, -Number(net.rows[0].total));
    if (lossSoFar + bet > limit) throw new HttpError(403, `This bet would exceed your ${row.period} loss limit`);
  }
}

// ---------- changing settings ----------

export async function setLimit(userId: string, kind: string, period: string, amount: number | null) {
  return withTx(async (c) => {
    const cur = (
      await c.query(`SELECT * FROM player_limits WHERE user_id=$1 AND kind=$2 AND period=$3 FOR UPDATE`, [userId, kind, period])
    ).rows[0];
    const current = cur ? effectiveAmount(cur) : null;
    if (amount === current) {
      // Nothing to change (this also folds in a change that has already matured).
      if (cur) {
        await c.query(
          `UPDATE player_limits SET amount=$4, pending_amount=NULL, pending_effective_at=NULL, updated_at=now()
           WHERE user_id=$1 AND kind=$2 AND period=$3`,
          [userId, kind, period, current],
        );
      }
      return { applied: true as const };
    }
    // Setting a first limit, or lowering one, is immediate. Raising or removing waits 24h.
    const immediate = amount !== null && (current === null || amount < current);
    if (immediate) {
      await c.query(
        `INSERT INTO player_limits (user_id, kind, period, amount) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, kind, period)
         DO UPDATE SET amount=EXCLUDED.amount, pending_amount=NULL, pending_effective_at=NULL, updated_at=now()`,
        [userId, kind, period, amount],
      );
      return { applied: true as const };
    }
    await c.query(
      `UPDATE player_limits
       SET amount=$4, pending_amount=$5, pending_effective_at=now() + $6::interval, updated_at=now()
       WHERE user_id=$1 AND kind=$2 AND period=$3`,
      [userId, kind, period, current, amount, COOLING_OFF],
    );
    return { applied: false as const, coolingOff: COOLING_OFF };
  });
}

export async function selfExclude(userId: string, period: string) {
  const ms = EXCLUSION_MS[period];
  if (ms === undefined) throw new HttpError(400, 'Invalid exclusion period');
  const until = ms === null ? 'infinity' : new Date(Date.now() + ms).toISOString();
  // Can only be extended, never shortened or lifted by the player.
  const r = await pool.query(
    `UPDATE users SET self_excluded_until=$2::timestamptz
     WHERE id=$1 AND (self_excluded_until IS NULL OR self_excluded_until < $2::timestamptz)
     RETURNING self_excluded_until = 'infinity' AS permanent, self_excluded_until AS until`,
    [userId, until],
  );
  if (!r.rows[0]) throw new HttpError(409, 'You are already excluded for at least that long');
  return { permanent: r.rows[0].permanent as boolean, until: r.rows[0].permanent ? null : r.rows[0].until };
}

export async function getProtection(userId: string) {
  const lim = await pool.query(`SELECT * FROM player_limits WHERE user_id=$1 ORDER BY kind, period`, [userId]);
  const u = await pool.query(
    `SELECT self_excluded_until > now() AS active, self_excluded_until = 'infinity' AS permanent, self_excluded_until AS until
     FROM users WHERE id=$1`,
    [userId],
  );
  const e = u.rows[0] ?? {};
  return {
    limits: lim.rows
      .map((row) => {
        const amount = effectiveAmount(row);
        const matured = row.pending_effective_at && new Date(row.pending_effective_at).getTime() <= Date.now();
        return {
          kind: row.kind,
          period: row.period,
          amount,
          pending: !matured && row.pending_effective_at
            ? { amount: row.pending_amount === null ? null : Number(row.pending_amount), effectiveAt: row.pending_effective_at }
            : null,
        };
      })
      .filter((l) => l.amount !== null || l.pending),
    selfExclusion: { active: !!e.active, permanent: !!e.active && !!e.permanent, until: e.active && !e.permanent ? e.until : null },
  };
}

// ---------- routes (mounted at /api/protection, behind the real-money switch) ----------

export function protectionRouter() {
  const r = Router();
  r.use(requireAuth);

  r.get('/', wrap(async (req, res) => res.json(await getProtection(req.userId!))));

  r.put(
    '/limits',
    wrap(async (req, res) => {
      const b = z
        .object({
          kind: z.enum(['deposit', 'loss']),
          period: z.enum(['daily', 'weekly', 'monthly']),
          amount: z.number().int('Amount must be in whole kobo').positive().nullable(),
        })
        .parse(req.body);
      const result = await setLimit(req.userId!, b.kind, b.period, b.amount);
      res.json({ ...result, ...(await getProtection(req.userId!)) });
    }),
  );

  r.post(
    '/self-exclusion',
    wrap(async (req, res) => {
      const { period } = z.object({ period: z.enum(['24h', '7d', '30d', '90d', '180d', 'permanent']) }).parse(req.body);
      res.status(201).json(await selfExclude(req.userId!, period));
    }),
  );

  return r;
}
