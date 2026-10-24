import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'crypto';
import { crashPointFromSeed } from '../src/game';

const hasDb = !!process.env.TEST_DATABASE_URL;
const KEY = 'sk_test_unit_test_key';

// Needs the PostgreSQL test database (TEST_DATABASE_URL). CI provides one.
describe.skipIf(!hasDb)('real money (Paystack)', () => {
  let app: import('express').Express;
  let pool: import('pg').Pool;
  let config: any;

  function findSeed(pred: (c: number) => boolean) {
    for (let i = 0; ; i++) if (pred(crashPointFromSeed('rm' + i))) return 'rm' + i;
  }
  const HIGH_SEED = findSeed((c) => c >= 100); // will not crash during a test

  beforeAll(async () => {
    const { runMigrations } = await import('../src/migrate');
    await runMigrations();
    pool = (await import('../src/db')).pool;
    config = (await import('../src/config')).config;
    app = (await import('../src/app')).createApp();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    config.REAL_MONEY_ENABLED = false;
    config.PAYSTACK_SECRET_KEY = KEY;
    delete process.env.TEST_FORCE_SEED;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.REAL_MONEY_ENABLED = false;
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function signup(email = 'p@example.com') {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/register').send({ email, password: 'correct-horse-1' });
    expect(r.status).toBe(201);
    return { agent, id: r.body.id as string };
  }
  const sign = (raw: string) => createHmac('sha512', KEY).update(raw).digest('hex');
  function webhook(payload: object, signature?: string) {
    const raw = JSON.stringify(payload);
    const req = request(app).post('/api/payments/paystack/webhook').set('Content-Type', 'application/json');
    if (signature !== '') req.set('x-paystack-signature', signature ?? sign(raw));
    return req.send(raw);
  }
  async function pendingDeposit(userId: string, amount = 500_000, reference = 'dep_test_1') {
    await pool.query(
      `INSERT INTO payments (user_id, kind, amount, status, reference) VALUES ($1,'deposit',$2,'pending',$3)`,
      [userId, amount, reference],
    );
    return reference;
  }
  const realBalance = async (userId: string) =>
    Number((await pool.query('SELECT real_balance FROM wallets WHERE user_id=$1', [userId])).rows[0].real_balance);
  const chargeSuccess = (reference: string, amount = 500_000, currency = 'NGN') => ({
    event: 'charge.success',
    data: { reference, amount, currency, status: 'success' },
  });

  describe('switched off (default)', () => {
    it('payment routes do not exist and real bets are refused', async () => {
      const { agent } = await signup();
      expect((await agent.post('/api/payments/deposits').send({ amount: 500000 })).status).toBe(404);
      expect((await agent.post('/api/payments/withdrawals').send({ amount: 500000 })).status).toBe(404);
      expect((await webhook(chargeSuccess('x'))).status).toBe(404);
      expect((await agent.post('/api/games/aviator/bet').send({ amount: 10000, wallet: 'real' })).status).toBe(403);
    });
  });

  describe('website config', () => {
    it('tells the website whether real money is on, and the limits only when it is', async () => {
      const off = await request(app).get('/api/config');
      expect(off.body.realMoneyEnabled).toBe(false);
      expect(off.body.real).toBeUndefined();
      config.REAL_MONEY_ENABLED = true;
      const on = await request(app).get('/api/config');
      expect(on.body.realMoneyEnabled).toBe(true);
      expect(on.body.real).toMatchObject({ currency: 'NGN', minDepositKobo: 10000, minWithdrawalKobo: 100000 });
    });
    it('marks each finished round with the wallet it was played on', async () => {
      const { agent, id } = await signup();
      config.REAL_MONEY_ENABLED = true;
      await pool.query('UPDATE wallets SET real_balance = 100000 WHERE user_id=$1', [id]);
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      const b = await agent.post('/api/games/aviator/bet').send({ amount: 20000, wallet: 'real' });
      await agent.post(`/api/games/aviator/${b.body.id}/cashout`);
      const h = await agent.get('/api/games/history');
      expect(h.body[0]).toMatchObject({ bet: 20000, balanceType: 'real' });
    });
  });

  describe('deposits', () => {
    beforeEach(() => {
      config.REAL_MONEY_ENABLED = true;
    });
    it('starts a pending deposit with Paystack and credits nothing yet', async () => {
      const { agent, id } = await signup();
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const r = await agent.post('/api/payments/deposits').send({ amount: 500000 });
      expect(r.status).toBe(201);
      expect(r.body.authorizationUrl).toBe('https://checkout.paystack.com/abc');
      const sent = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
      expect(sent).toMatchObject({ amount: 500000, currency: 'NGN', email: 'p@example.com' });
      const p = await pool.query('SELECT status, amount FROM payments WHERE user_id=$1', [id]);
      expect(p.rows[0]).toMatchObject({ status: 'pending', amount: '500000' });
      expect(await realBalance(id)).toBe(0);
    });
    it('marks the deposit failed if Paystack cannot be reached', async () => {
      const { agent, id } = await signup();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
      expect((await agent.post('/api/payments/deposits').send({ amount: 500000 })).status).toBe(502);
      expect((await pool.query('SELECT status FROM payments WHERE user_id=$1', [id])).rows[0].status).toBe('failed');
    });
    it('rejects amounts outside the limits and non-integers', async () => {
      const { agent } = await signup();
      expect((await agent.post('/api/payments/deposits').send({ amount: 50 })).status).toBe(400);
      expect((await agent.post('/api/payments/deposits').send({ amount: 999999999999 })).status).toBe(400);
      expect((await agent.post('/api/payments/deposits').send({ amount: 10000.5 })).status).toBe(400);
    });
    it('requires login', async () => {
      expect((await request(app).post('/api/payments/deposits').send({ amount: 500000 })).status).toBe(401);
    });
  });

  describe('webhook', () => {
    beforeEach(() => {
      config.REAL_MONEY_ENABLED = true;
    });
    it('rejects a missing or wrong signature and credits nothing', async () => {
      const { id } = await signup();
      const ref = await pendingDeposit(id);
      expect((await webhook(chargeSuccess(ref), '')).status).toBe(401);
      expect((await webhook(chargeSuccess(ref), 'deadbeef')).status).toBe(401);
      expect(await realBalance(id)).toBe(0);
    });
    it('credits a verified deposit exactly once, even if Paystack retries', async () => {
      const { agent, id } = await signup();
      const ref = await pendingDeposit(id);
      expect((await webhook(chargeSuccess(ref))).status).toBe(200);
      expect((await webhook(chargeSuccess(ref))).status).toBe(200); // replay
      expect(await realBalance(id)).toBe(500_000);
      const dep = await pool.query(`SELECT * FROM ledger_entries WHERE entry_type='deposit'`);
      expect(dep.rows).toHaveLength(1);
      expect(dep.rows[0]).toMatchObject({ balance_type: 'real', amount: '500000', balance_after: '500000' });
      expect(dep.rows[0].payment_id).toBeTruthy();
      expect((await pool.query('SELECT status FROM payments WHERE reference=$1', [ref])).rows[0].status).toBe('succeeded');
      const w = await agent.get('/api/wallet');
      expect(w.body.realMoney).toBe(500_000);
      expect(w.body.playCredits).toBe(10000);
    });
    it('does not credit when the amount or currency differs from what we stored', async () => {
      const { id } = await signup();
      const ref = await pendingDeposit(id);
      expect((await webhook(chargeSuccess(ref, 100))).status).toBe(200);
      expect(await realBalance(id)).toBe(0);
      expect((await pool.query('SELECT status FROM payments WHERE reference=$1', [ref])).rows[0].status).toBe('failed');
      const ref2 = await pendingDeposit(id, 500_000, 'dep_test_2');
      await webhook(chargeSuccess(ref2, 500_000, 'USD'));
      expect(await realBalance(id)).toBe(0);
    });
    it('ignores unknown references and other events', async () => {
      const { id } = await signup();
      expect((await webhook(chargeSuccess('nope'))).status).toBe(200);
      expect((await webhook({ event: 'transfer.success', data: {} })).status).toBe(200);
      expect(await realBalance(id)).toBe(0);
    });
  });

  describe('betting with the real wallet', () => {
    beforeEach(() => {
      config.REAL_MONEY_ENABLED = true;
    });
    it('debits and pays the real balance, leaving play credits untouched', async () => {
      const { agent, id } = await signup();
      await pool.query('UPDATE wallets SET real_balance = 100000 WHERE user_id=$1', [id]);
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      const b = await agent.post('/api/games/aviator/bet').send({ amount: 20000, wallet: 'real' });
      expect(b.status).toBe(201);
      expect(b.body.wallet).toBe('real');
      expect(await realBalance(id)).toBe(80_000);
      const c = await agent.post(`/api/games/aviator/${b.body.id}/cashout`);
      expect(c.status).toBe(200);
      expect(await realBalance(id)).toBe(80_000 + c.body.payout);
      expect((await agent.get('/api/wallet')).body.playCredits).toBe(10000);
      const types = await pool.query(`SELECT entry_type, balance_type FROM ledger_entries WHERE entry_type IN ('bet','payout') ORDER BY id`);
      expect(types.rows).toEqual([
        { entry_type: 'bet', balance_type: 'real' },
        { entry_type: 'payout', balance_type: 'real' },
      ]);
    });
    it('enforces real-money bet limits and the real balance', async () => {
      const { agent, id } = await signup();
      expect((await agent.post('/api/games/aviator/bet').send({ amount: 100, wallet: 'real' })).status).toBe(400);
      expect((await agent.post('/api/games/aviator/bet').send({ amount: 20000, wallet: 'real' })).status).toBe(409);
      expect(await realBalance(id)).toBe(0);
    });
  });

  describe('withdrawals', () => {
    beforeEach(() => {
      config.REAL_MONEY_ENABLED = true;
    });
    const dest = { bankCode: '058', accountNumber: '0123456789' };
    it('requires identity verification', async () => {
      const { agent, id } = await signup();
      await pool.query('UPDATE wallets SET real_balance = 500000 WHERE user_id=$1', [id]);
      expect((await agent.post('/api/payments/withdrawals').send({ amount: 200000, ...dest })).status).toBe(403);
      expect(await realBalance(id)).toBe(500_000);
    });
    it('holds the money and queues the request for review', async () => {
      const { agent, id } = await signup();
      await pool.query(`UPDATE users SET kyc_status='verified' WHERE id=$1`, [id]);
      await pool.query('UPDATE wallets SET real_balance = 500000 WHERE user_id=$1', [id]);
      const r = await agent.post('/api/payments/withdrawals').send({ amount: 200000, ...dest });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'pending_review', amount: 200000, balance: 300000 });
      expect(await realBalance(id)).toBe(300_000);
      const l = await pool.query(`SELECT amount, balance_type FROM ledger_entries WHERE entry_type='withdrawal'`);
      expect(l.rows).toEqual([{ amount: '-200000', balance_type: 'real' }]);
    });
    it('refuses more than the balance and leaves no trace', async () => {
      const { agent, id } = await signup();
      await pool.query(`UPDATE users SET kyc_status='verified' WHERE id=$1`, [id]);
      await pool.query('UPDATE wallets SET real_balance = 150000 WHERE user_id=$1', [id]);
      expect((await agent.post('/api/payments/withdrawals').send({ amount: 200000, ...dest })).status).toBe(409);
      expect(await realBalance(id)).toBe(150_000);
      expect((await pool.query(`SELECT 1 FROM payments WHERE kind='withdrawal'`)).rows).toHaveLength(0);
    });
    it('validates the bank details and minimum', async () => {
      const { agent, id } = await signup();
      await pool.query(`UPDATE users SET kyc_status='verified' WHERE id=$1`, [id]);
      await pool.query('UPDATE wallets SET real_balance = 500000 WHERE user_id=$1', [id]);
      expect((await agent.post('/api/payments/withdrawals').send({ amount: 200000, bankCode: '058', accountNumber: '123' })).status).toBe(400);
      expect((await agent.post('/api/payments/withdrawals').send({ amount: 500, ...dest })).status).toBe(400);
    });
  });
});
