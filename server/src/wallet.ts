import { PoolClient } from 'pg';
import { HttpError } from './errors';

export type EntryType = 'welcome_bonus' | 'bet' | 'payout';

/**
 * The ONLY function that changes a balance. It locks the wallet row, checks the
 * result is not negative, updates the balance and appends the ledger entry in the
 * caller's transaction. Clients never set balances.
 */
export async function applyEntry(
  c: PoolClient,
  p: { userId: string; type: EntryType; amount: number; roundId?: string },
): Promise<number> {
  const w = await c.query('SELECT promo_balance FROM wallets WHERE user_id = $1 FOR UPDATE', [p.userId]);
  if (!w.rows[0]) throw new HttpError(404, 'Wallet not found');
  const next = Number(w.rows[0].promo_balance) + p.amount;
  if (next < 0) throw new HttpError(409, 'Insufficient play credits');
  await c.query('UPDATE wallets SET promo_balance = $2, updated_at = now() WHERE user_id = $1', [p.userId, next]);
  await c.query(
    `INSERT INTO ledger_entries (user_id, entry_type, amount, balance_after, round_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [p.userId, p.type, p.amount, next, p.roundId ?? null],
  );
  return next;
}
