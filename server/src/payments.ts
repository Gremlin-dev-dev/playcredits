import { NextFunction, Request, Response, Router } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from './config';
import { pool, withTx } from './db';
import { HttpError } from './errors';
import { log } from './logger';
import { requireAuth } from './auth';
import { applyEntry } from './wallet';

/** Real-money routes do not exist (404) unless REAL_MONEY_ENABLED=true. Read at request time. */
export function realMoneyGate(_req: Request, _res: Response, next: NextFunction) {
  if (!config.REAL_MONEY_ENABLED) return next(new HttpError(404, 'Not found'));
  next();
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** Paystack signs the RAW request body with HMAC-SHA512 using your secret key. */
export function verifyPaystackSignature(raw: Buffer, signature: string | undefined): boolean {
  if (!config.PAYSTACK_SECRET_KEY || !signature) return false;
  const expected = createHmac('sha512', config.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Creates a pending deposit and asks Paystack for a checkout link. Nothing is credited here. */
export async function startDeposit(userId: string, email: string, amount: number) {
  const key = config.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503, 'Payments are not configured');
  const reference = `dep_${randomUUID()}`;
  await pool.query(
    `INSERT INTO payments (user_id, kind, amount, status, reference) VALUES ($1,'deposit',$2,'pending',$3)`,
    [userId, amount, reference],
  );
  try {
    const res = await fetch(`${config.PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount, // kobo
        currency: 'NGN',
        reference,
        ...(config.PAYSTACK_CALLBACK_URL ? { callback_url: config.PAYSTACK_CALLBACK_URL } : {}),
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body?.status || !body?.data?.authorization_url) throw new Error(`paystack ${res.status}`);
    return { reference, authorizationUrl: String(body.data.authorization_url) };
  } catch (e) {
    log('error', 'paystack initialize failed', { reference, message: (e as Error).message });
    await pool.query(`UPDATE payments SET status='failed', updated_at=now() WHERE reference=$1 AND status='pending'`, [
      reference,
    ]);
    throw new HttpError(502, 'Could not start the payment. Please try again.');
  }
}

export type CreditResult = 'credited' | 'duplicate' | 'ignored' | 'mismatch';

/**
 * Applies a verified `charge.success` event. Safe to call many times for the same reference:
 * the payment row is locked, and only a 'pending' deposit can be credited (exactly once).
 * We credit OUR stored amount, and only if Paystack's amount and currency match it.
 */
export async function creditDeposit(
  c: PoolClient,
  data: { reference?: string; amount?: number; currency?: string; status?: string },
): Promise<CreditResult> {
  if (!data.reference) return 'ignored';
  const q = await c.query(`SELECT * FROM payments WHERE reference=$1 AND kind='deposit' FOR UPDATE`, [data.reference]);
  const p = q.rows[0];
  if (!p) return 'ignored';
  if (p.status === 'succeeded') return 'duplicate';
  if (p.status !== 'pending') return 'ignored';
  if (data.status !== 'success' || data.currency !== 'NGN' || Number(data.amount) !== Number(p.amount)) {
    await c.query(`UPDATE payments SET status='failed', provider_data=$2, updated_at=now() WHERE id=$1`, [
      p.id,
      JSON.stringify(data),
    ]);
    return 'mismatch';
  }
  await applyEntry(c, { userId: p.user_id, type: 'deposit', amount: Number(p.amount), balanceType: 'real', paymentId: p.id });
  await c.query(`UPDATE payments SET status='succeeded', provider_data=$2, updated_at=now() WHERE id=$1`, [
    p.id,
    JSON.stringify(data),
  ]);
  return 'credited';
}

/**
 * Withdrawal request: verified users only. The money is taken off the balance immediately
 * (so it cannot be bet meanwhile) and the request waits for manual review. Paying it out
 * through Paystack Transfers comes later, behind an admin approval step.
 */
export async function requestWithdrawal(
  c: PoolClient,
  userId: string,
  amount: number,
  destination: { bankCode: string; accountNumber: string },
) {
  const u = await c.query('SELECT kyc_status FROM users WHERE id=$1', [userId]);
  if (!u.rows[0]) throw new HttpError(401, 'Account not found');
  if (u.rows[0].kyc_status !== 'verified') throw new HttpError(403, 'Identity verification is required before withdrawing');
  const id = randomUUID();
  await c.query(
    `INSERT INTO payments (id, user_id, kind, amount, status, reference, destination)
     VALUES ($1,$2,'withdrawal',$3,'pending_review',$4,$5)`,
    [id, userId, amount, `wd_${id}`, JSON.stringify(destination)],
  );
  const balance = await applyEntry(c, {
    userId,
    type: 'withdrawal',
    amount: -amount,
    balanceType: 'real',
    paymentId: id,
  });
  return { id, status: 'pending_review' as const, amount, balance };
}

export function paymentsRouter() {
  const r = Router();

  // Called by Paystack, not by a logged-in user: authenticated by the signature instead.
  r.post(
    '/paystack/webhook',
    wrap(async (req, res) => {
      const raw = (req as any).rawBody as Buffer | undefined;
      if (!raw || !verifyPaystackSignature(raw, req.header('x-paystack-signature'))) {
        throw new HttpError(401, 'Invalid signature');
      }
      const event = req.body as { event?: string; data?: any };
      if (event?.event === 'charge.success') {
        const result = await withTx((c) => creditDeposit(c, event.data ?? {}));
        if (result === 'mismatch') log('error', 'deposit amount/currency mismatch', { reference: event.data?.reference });
      }
      res.json({ ok: true });
    }),
  );

  r.post(
    '/deposits',
    requireAuth,
    wrap(async (req, res) => {
      const { amount } = z
        .object({ amount: z.number().int('Amount must be in whole kobo').min(config.MIN_DEPOSIT_KOBO).max(config.MAX_DEPOSIT_KOBO) })
        .parse(req.body);
      const u = await pool.query('SELECT email FROM users WHERE id=$1', [req.userId]);
      if (!u.rows[0]) throw new HttpError(401, 'Account not found');
      res.status(201).json(await startDeposit(req.userId!, u.rows[0].email, amount));
    }),
  );

  r.post(
    '/withdrawals',
    requireAuth,
    wrap(async (req, res) => {
      const body = z
        .object({
          amount: z.number().int('Amount must be in whole kobo').min(config.MIN_WITHDRAWAL_KOBO),
          bankCode: z.string().regex(/^\d{3,6}$/, 'Invalid bank code'),
          accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
        })
        .parse(req.body);
      const result = await withTx((c) =>
        requestWithdrawal(c, req.userId!, body.amount, { bankCode: body.bankCode, accountNumber: body.accountNumber }),
      );
      res.status(201).json(result);
    }),
  );

  r.get(
    '/',
    requireAuth,
    wrap(async (req, res) => {
      const q = await pool.query(
        `SELECT id, kind, amount, status, created_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [req.userId],
      );
      res.json(
        q.rows.map((p) => ({ id: p.id, kind: p.kind, amount: Number(p.amount), status: p.status, createdAt: p.created_at })),
      );
    }),
  );

  return r;
}
