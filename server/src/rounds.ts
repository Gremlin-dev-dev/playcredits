import { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { HttpError } from './errors';
import { applyEntry, BalanceType } from './wallet';
import { assertLossAllowed, assertNotExcluded } from './protection';
import { createSeed, crashPointFromSeed, crashTimeMs, multiplierAt, payoutFor, seedHash } from './game';

const ELAPSED = `EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000 AS elapsed_ms`;

export interface RoundView {
  id: string;
  status: 'open' | 'cashed_out' | 'crashed';
  bet: number;
  seedHash: string;
  elapsedMs?: number; // only while open
  multiplier?: number; // cashout multiplier, or crash point once crashed
  crashPoint?: number; // revealed only after settlement
  serverSeed?: string; // revealed only after settlement
  payout: number;
  wallet?: BalanceType; // which wallet the bet came from
  balance?: number;
}

function view(r: any, balance?: number): RoundView {
  const settled = r.status !== 'open';
  return {
    id: r.id,
    status: r.status,
    bet: Number(r.bet),
    seedHash: r.seed_hash,
    elapsedMs: settled ? undefined : Number(r.elapsed_ms),
    multiplier: r.cashout_multiplier != null ? Number(r.cashout_multiplier) : undefined,
    crashPoint: settled ? Number(r.crash_point) : undefined,
    serverSeed: settled ? r.server_seed : undefined,
    payout: Number(r.payout),
    wallet: r.balance_type,
    balance,
  };
}

async function markCrashed(c: PoolClient, r: any) {
  const u = await c.query(
    `UPDATE game_rounds SET status='crashed', settled_at=now() WHERE id=$1 RETURNING *`,
    [r.id],
  );
  return u.rows[0];
}

/** Locks the user's open round (if any); settles it as crashed if its time is up. */
async function lockOpenRound(c: PoolClient, userId: string) {
  const q = await c.query(
    `SELECT *, ${ELAPSED} FROM game_rounds WHERE user_id=$1 AND status='open' FOR UPDATE`,
    [userId],
  );
  const r = q.rows[0];
  if (!r) return null;
  if (Number(r.elapsed_ms) >= crashTimeMs(Number(r.crash_point))) {
    await markCrashed(c, r);
    return null;
  }
  return r;
}

export async function placeBet(
  c: PoolClient,
  userId: string,
  amount: number,
  balanceType: BalanceType = 'promo',
): Promise<RoundView> {
  // Lock order is always: round row, then wallet row (same as cashOut) to avoid deadlocks.
  if (await lockOpenRound(c, userId)) throw new HttpError(409, 'A round is already in progress');
  if (balanceType === 'real') {
    await assertNotExcluded(c, userId);
    await assertLossAllowed(c, userId, amount);
  }
  const seed = createSeed();
  const id = randomUUID();
  await c.query(
    `INSERT INTO game_rounds (id, user_id, bet, status, server_seed, seed_hash, crash_point, balance_type)
     VALUES ($1,$2,$3,'open',$4,$5,$6,$7)`,
    [id, userId, amount, seed, seedHash(seed), crashPointFromSeed(seed), balanceType],
  );
  const balance = await applyEntry(c, { userId, type: 'bet', amount: -amount, roundId: id, balanceType });
  const r = (await c.query(`SELECT *, ${ELAPSED} FROM game_rounds WHERE id=$1`, [id])).rows[0];
  return view(r, balance);
}

export async function currentRound(c: PoolClient, userId: string): Promise<RoundView | null> {
  const r = await lockOpenRound(c, userId);
  return r ? view(r) : null;
}

export async function cashOut(c: PoolClient, userId: string, roundId: string): Promise<RoundView> {
  const q = await c.query(
    `SELECT *, ${ELAPSED} FROM game_rounds WHERE id=$1 AND user_id=$2 FOR UPDATE`,
    [roundId, userId],
  );
  const r = q.rows[0];
  if (!r) throw new HttpError(404, 'Round not found');
  if (r.status !== 'open') throw new HttpError(409, 'Round already settled');

  const elapsed = Number(r.elapsed_ms);
  if (elapsed >= crashTimeMs(Number(r.crash_point))) {
    const done = await markCrashed(c, r);
    return view(done);
  }
  const mult = multiplierAt(elapsed);
  const payout = payoutFor(Number(r.bet), mult);
  const u = await c.query(
    `UPDATE game_rounds SET status='cashed_out', cashout_multiplier=$2, payout=$3, settled_at=now()
     WHERE id=$1 RETURNING *`,
    [r.id, mult, payout],
  );
  const balance = await applyEntry(c, { userId, type: 'payout', amount: payout, roundId: r.id, balanceType: r.balance_type });
  return view(u.rows[0], balance);
}
