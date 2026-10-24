import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { crashPointFromSeed } from '../src/game';

const hasDb = !!process.env.TEST_DATABASE_URL;

// Needs the PostgreSQL test database (TEST_DATABASE_URL). CI provides one.
describe.skipIf(!hasDb)('player protection', () => {
  let app: import('express').Express;
  let pool: import('pg').Pool;
  let config: any;

  function findSeed(pred: (c: number) => boolean) {
    for (let i = 0; ; i++) if (pred(crashPointFromSeed('pp' + i))) return 'pp' + i;
  }
  const HIGH_SEED = findSeed((c) => c >= 100);

  beforeAll(async () => {
    const { runMigrations } = await import('../src/migrate');
    await runMigrations();
    pool = (await import('../src/db')).pool;
    config = (await import('../src/config')).config;
    app = (await import('../src/app')).createApp();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    config.REAL_MONEY_ENABLED = true;
    config.PAYSTACK_SECRET_KEY = 'sk_test_unit_test_key';
    delete process.env.TEST_FORCE_SEED;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.REAL_MONEY_ENABLED = false;
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function signup(email = 'pp@example.com') {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/register').send({ email, password: 'correct-horse-1' });
    expect(r.status).toBe(201);
    return { agent, id: r.body.id as string };
  }
  const mockPaystack = () =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const setReal = (id: string, kobo: number) => pool.query('UPDATE wallets SET real_balance=$2 WHERE user_id=$1', [id, kobo]);
  const addLedger = (id: string, type: 'bet' | 'payout', amount: number) =>
    pool.query(
      `INSERT INTO ledger_entries (user_id, entry_type, amount, balance_after, balance_type) VALUES ($1,$2,$3,1000000,'real')`,
      [id, type, amount],
    );

  it('routes do not exist while real money is off', async () => {
    const { agent } = await signup();
    config.REAL_MONEY_ENABLED = false;
    expect((await agent.get('/api/protection')).status).toBe(404);
  });

  describe('limits', () => {
    it('lowering is immediate; raising and removing wait 24 hours', async () => {
      const { agent, id } = await signup();
      const put = (amount: number | null) => agent.put('/api/protection/limits').send({ kind: 'deposit', period: 'daily', amount });
      let r = await put(100000);
      expect(r.body.applied).toBe(true);
      r = await put(200000); // raise: scheduled
      expect(r.body.applied).toBe(false);
      expect(r.body.limits[0]).toMatchObject({ amount: 100000, pending: { amount: 200000 } });
      r = await put(50000); // lower: immediate, cancels the scheduled raise
      expect(r.body.applied).toBe(true);
      expect(r.body.limits[0]).toMatchObject({ amount: 50000, pending: null });
      r = await put(null); // remove: scheduled
      expect(r.body.applied).toBe(false);
      expect(r.body.limits[0]).toMatchObject({ amount: 50000, pending: { amount: null } });
      // After the cooling-off period the removal takes effect.
      await pool.query(`UPDATE player_limits SET pending_effective_at = now() - interval '1 minute' WHERE user_id=$1`, [id]);
      const g = await agent.get('/api/protection');
      expect(g.body.limits).toEqual([]);
    });
    it('validates input and requires login', async () => {
      const { agent } = await signup();
      expect((await agent.put('/api/protection/limits').send({ kind: 'deposit', period: 'hourly', amount: 5 })).status).toBe(400);
      expect((await agent.put('/api/protection/limits').send({ kind: 'deposit', period: 'daily', amount: -5 })).status).toBe(400);
      expect((await agent.put('/api/protection/limits').send({ kind: 'deposit', period: 'daily', amount: 10.5 })).status).toBe(400);
      expect((await request(app).get('/api/protection')).status).toBe(401);
    });
  });

  describe('deposit limit', () => {
    it('blocks a deposit that would exceed the limit, allows one that fits', async () => {
      const { agent, id } = await signup();
      mockPaystack();
      await agent.put('/api/protection/limits').send({ kind: 'deposit', period: 'daily', amount: 100000 });
      await pool.query(
        `INSERT INTO payments (user_id, kind, amount, status, reference) VALUES ($1,'deposit',60000,'succeeded','dep_old')`,
        [id],
      );
      expect((await agent.post('/api/payments/deposits').send({ amount: 50000 })).status).toBe(403);
      expect((await agent.post('/api/payments/deposits').send({ amount: 40000 })).status).toBe(201);
    });
  });

  describe('loss limit', () => {
    it('counts net real-money losses in the window', async () => {
      const { agent, id } = await signup();
      await setReal(id, 100000);
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      await agent.put('/api/protection/limits').send({ kind: 'loss', period: 'daily', amount: 30000 });
      await addLedger(id, 'bet', -25000);
      const refused = await agent.post('/api/games/aviator/bet').send({ amount: 10000, wallet: 'real' });
      expect(refused.status).toBe(403);
      await addLedger(id, 'payout', 15000); // net loss is now 10,000
      const ok = await agent.post('/api/games/aviator/bet').send({ amount: 10000, wallet: 'real' });
      expect(ok.status).toBe(201);
    });
    it('does not limit play-credit bets', async () => {
      const { agent } = await signup();
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      await agent.put('/api/protection/limits').send({ kind: 'loss', period: 'daily', amount: 1 });
      expect((await agent.post('/api/games/aviator/bet').send({ amount: 100 })).status).toBe(201);
    });
  });

  describe('self-exclusion', () => {
    it('blocks real deposits and bets, still allows withdrawals and play credits', async () => {
      const { agent, id } = await signup();
      mockPaystack();
      await setReal(id, 500000);
      await pool.query(`UPDATE users SET kyc_status='verified' WHERE id=$1`, [id]);
      const r = await agent.post('/api/protection/self-exclusion').send({ period: '24h' });
      expect(r.status).toBe(201);
      expect(r.body.permanent).toBe(false);
      expect((await agent.post('/api/payments/deposits').send({ amount: 50000 })).status).toBe(403);
      expect((await agent.post('/api/games/aviator/bet').send({ amount: 10000, wallet: 'real' })).status).toBe(403);
      const wd = await agent.post('/api/payments/withdrawals').send({ amount: 200000, bankCode: '058', accountNumber: '0123456789' });
      expect(wd.status).toBe(201);
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      expect((await agent.post('/api/games/aviator/bet').send({ amount: 100 })).status).toBe(201);
      expect((await agent.get('/api/protection')).body.selfExclusion.active).toBe(true);
    });
    it('can be extended but never shortened, and permanent is final', async () => {
      const { agent } = await signup();
      expect((await agent.post('/api/protection/self-exclusion').send({ period: '30d' })).status).toBe(201);
      expect((await agent.post('/api/protection/self-exclusion').send({ period: '7d' })).status).toBe(409);
      expect((await agent.post('/api/protection/self-exclusion').send({ period: '90d' })).status).toBe(201);
      const p = await agent.post('/api/protection/self-exclusion').send({ period: 'permanent' });
      expect(p.status).toBe(201);
      expect(p.body).toMatchObject({ permanent: true, until: null });
      expect((await agent.post('/api/protection/self-exclusion').send({ period: '180d' })).status).toBe(409);
      expect((await agent.post('/api/protection/self-exclusion').send({ period: 'permanent' })).status).toBe(409);
      expect((await agent.get('/api/protection')).body.selfExclusion).toMatchObject({ active: true, permanent: true });
    });
    it('ends automatically when the period passes', async () => {
      const { agent, id } = await signup();
      await setReal(id, 100000);
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      await agent.post('/api/protection/self-exclusion').send({ period: '24h' });
      await pool.query(`UPDATE users SET self_excluded_until = now() - interval '1 minute' WHERE id=$1`, [id]);
      expect((await agent.post('/api/games/aviator/bet').send({ amount: 10000, wallet: 'real' })).status).toBe(201);
    });
  });
});
