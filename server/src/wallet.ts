import { PoolClient } from 'pg';
import { HttpError } from './errors';

export type EntryType = 'welcome_bonus' | 'bet' | 'payout' | 'deposit' | 'withdrawal' | 'withdrawal_reversal';
export type BalanceType = 'promo' | 'real';

// Fixed map (never built from user input) so the column name in the SQL below is safe.
const COLUMN: Record<BalanceType, string> = { promo: 'promo_balance', real: 'real_balance' };

/**
 * The ONLY function that changes a balance. It locks the wallet row, checks the
 * result is not negative, updates the balance and appends the ledger entry in the
 * caller's transaction. Clients never set balances.
 */
export async function applyEntry(
  c: PoolClient,
  p: {
    userId: string;
    type: EntryType;
    amount: number;
    roundId?: string;
    paymentId?: string;
    balanceType?: BalanceType;
  },
): Promise<number> {
  const balanceType = p.balanceType ?? 'promo';
  const col = COLUMN[balanceType];
  const w = await c.query(`SELECT ${col} AS bal FROM wallets WHERE user_id = $1 FOR UPDATE`, [p.userId]);
  if (!w.rows[0]) throw new HttpError(404, 'Wallet not found');
  const next = Number(w.rows[0].bal) + p.amount;
  if (next < 0) throw new HttpError(409, balanceType === 'real' ? 'Insufficient balance' : 'Insufficient play credits');
  await c.query(`UPDATE wallets SET ${col} = $2, updated_at = now() WHERE user_id = $1`, [p.userId, next]);
  await c.query(
    `INSERT INTO ledger_entries (user_id, entry_type, amount, balance_after, balance_type, round_id, payment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.userId, p.type, p.amount, next, balanceType, p.roundId ?? null, p.paymentId ?? null],
  );
  return next;
}
