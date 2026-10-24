import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { crashPointFromSeed } from '../src/game';

const hasDb = !!process.env.TEST_DATABASE_URL;

// Integration tests need a real PostgreSQL test database (see README). Skipped without TEST_DATABASE_URL.
describe.skipIf(!hasDb)('API integration', () => {
  let app: import('express').Express;
  let pool: import('pg').Pool;

  function findSeed(pred: (c: number) => boolean) {
    for (let i = 0; ; i++) if (pred(crashPointFromSeed('find' + i))) return 'find' + i;
  }
  const HIGH_SEED = findSeed((c) => c >= 100); // will not crash during a test
  const LOW_SEED = findSeed((c) => c === 1); // crashes immediately

  beforeAll(async () => {
    const { runMigrations } = await import('../src/migrate');
    await runMigrations();
    pool = (await import('../src/db')).pool;
    app = (await import('../src/app')).createApp();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    delete process.env.TEST_FORCE_SEED;
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function signup(email = 'a@example.com') {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/register').send({ email, password: 'correct-horse-1' });
    expect(r.status).toBe(201);
    return agent;
  }
  const ledgerSum = async () =>
    Number((await pool.query('SELECT COALESCE(SUM(amount),0) s FROM ledger_entries')).rows[0].s);

  describe('authentication and bonus', () => {
    it('registers, grants the 10,000 bonus once, and records it in the ledger', async () => {
      const a = await signup();
      const w = await a.get('/api/wallet');
      expect(w.body.playCredits).toBe(10000);
      expect(w.body.realMoney).toBe(0);
      const l = await a.get('/api/wallet/ledger');
      expect(l.body).toHaveLength(1);
      expect(l.body[0]).toMatchObject({ type: 'welcome_bonus', amount: 10000, balanceAfter: 10000 });
    });
    it('rejects duplicate email (case-insensitive) without a second bonus', async () => {
      await signup('dup@example.com');
      const r = await request(app).post('/api/auth/register').send({ email: 'DUP@example.com', password: 'correct-horse-1' });
      expect(r.status).toBe(409);
      expect(await ledgerSum()).toBe(10000);
    });
    it('rejects weak input', async () => {
      const r = await request(app).post('/api/auth/register').send({ email: 'x', password: 'short' });
      expect(r.status).toBe(400);
    });
    it('logs in with the right password only', async () => {
      await signup('l@example.com');
      expect((await request(app).post('/api/auth/login').send({ email: 'l@example.com', password: 'wrong-password-1' })).status).toBe(401);
      expect((await request(app).post('/api/auth/login').send({ email: 'l@example.com', password: 'correct-horse-1' })).status).toBe(200);
    });
    it('never stores a plaintext password', async () => {
      await signup('h@example.com');
      const h = (await pool.query('SELECT password_hash FROM users')).rows[0].password_hash;
      expect(h).toMatch(/^\$2[aby]\$/);
      expect(h).not.toContain('correct-horse-1');
    });
  });

  describe('authorization', () => {
    it.each([
      ['get', '/api/wallet'], ['get', '/api/wallet/ledger'], ['get', '/api/me'], ['get', '/api/games/history'],
      ['get', '/api/games/aviator/current'], ['post', '/api/games/aviator/bet'],
    ])('%s %s requires login', async (m, p) => {
      expect((await (request(app) as any)[m](p)).status).toBe(401);
    });
    it('rejects a forged token', async () => {
      const r = await request(app).get('/api/wallet').set('Cookie', 'sid=forged.token.value');
      expect(r.status).toBe(401);
    });
    it('rejects cross-origin state-changing requests', async () => {
      const r = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@example.com', password: 'correct-horse-1' });
      expect(r.status).toBe(403);
    });
    it("a user cannot cash out or read another user's round", async () => {
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      const a = await signup('a@example.com');
      const b = await signup('b@example.com');
      const round = (await a.post('/api/games/aviator/bet').send({ amount: 500 })).body;
      expect((await b.post(`/api/games/aviator/${round.id}/cashout`)).status).toBe(404);
      expect((await b.get(`/api/games/aviator/${round.id}`)).status).toBe(404);
    });
    it('exposes no way to set a balance, deposit or withdraw', async () => {
      const a = await signup();
      for (const [m, p] of [['put', '/api/wallet'], ['post', '/api/wallet'], ['post', '/api/wallet/withdraw'], ['post', '/api/wallet/deposit'], ['post', '/api/withdrawals']]) {
        expect([404]).toContain((await (a as any)[m](p).send({ balance: 999999 })).status);
      }
      expect((await a.get('/api/wallet')).body.playCredits).toBe(10000);
    });
  });

  describe('betting and wallet', () => {
    it('debits the bet, hides the seed, and the ledger matches the balance', async () => {
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      const a = await signup();
      const r = await a.post('/api/games/aviator/bet').send({ amount: 2000 });
      expect(r.status).toBe(201);
      expect(r.body.balance).toBe(8000);
      expect(r.body.serverSeed).toBeUndefined();
      expect(r.body.crashPoint).toBeUndefined();
      expect(r.body.seedHash).toMatch(/^[0-9a-f]{64}$/);
      expect((await a.get('/api/wallet')).body.playCredits).toBe(8000);
    });
    it('cashing out pays floor(bet x multiplier), reveals the seed, and keeps ledger == balance', async () => {
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      const a = await signup();
      const round = (await a.post('/api/games/aviator/bet').send({ amount: 2000 })).body;
      const c = await a.post(`/api/games/aviator/${round.id}/cashout`);
      expect(c.status).toBe(200);
      expect(c.body.status).toBe('cashed_out');
      expect(c.body.payout).toBe(Math.floor(2000 * c.body.multiplier));
      expect(c.body.serverSeed).toBe(HIGH_SEED);
      const w = (await a.get('/api/wallet')).body;
      expect(w.playCredits).toBe(8000 + c.body.payout);
      expect(await ledgerSum()).toBe(w.playCredits);
      expect((await a.post(`/api/games/aviator/${round.id}/cashout`)).status).toBe(409); // no double payout
    });
    it('a crashed round pays nothing', async () => {
      process.env.TEST_FORCE_SEED = LOW_SEED;
      const a = await signup();
      const round = (await a.post('/api/games/aviator/bet').send({ amount: 1000 })).body;
      const c = await a.post(`/api/games/aviator/${round.id}/cashout`);
      expect(c.body.status).toBe('crashed');
      expect(c.body.payout).toBe(0);
      expect((await a.get('/api/wallet')).body.playCredits).toBe(9000);
    });
    it('rejects invalid, too-large and over-balance bets', async () => {
      const a = await signup();
      expect((await a.post('/api/games/aviator/bet').send({ amount: 5 })).status).toBe(400);
      expect((await a.post('/api/games/aviator/bet').send({ amount: 1.5 })).status).toBe(400);
      expect((await a.post('/api/games/aviator/bet').send({ amount: 999999 })).status).toBe(400);
      expect((await a.get('/api/wallet')).body.playCredits).toBe(10000);
    });
    it('rejects a bet larger than the balance', async () => {
      process.env.TEST_FORCE_SEED = LOW_SEED; // crash immediately so rounds settle
      const a = await signup();
      for (let i = 0; i < 2; i++) await a.post('/api/games/aviator/bet').send({ amount: 5000 });
      const r = await a.post('/api/games/aviator/bet').send({ amount: 100 });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/Insufficient/);
    });
    it('concurrent bets cannot overspend or open two rounds', async () => {
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      const a = await signup();
      const results = await Promise.all(Array.from({ length: 8 }, () => a.post('/api/games/aviator/bet').send({ amount: 5000 })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const w = (await a.get('/api/wallet')).body.playCredits;
      expect(w).toBe(5000);
      expect(await ledgerSum()).toBe(5000);
    });
    it('concurrent cash-outs pay exactly once', async () => {
      process.env.TEST_FORCE_SEED = HIGH_SEED;
      const a = await signup();
      const round = (await a.post('/api/games/aviator/bet').send({ amount: 1000 })).body;
      const rs = await Promise.all(Array.from({ length: 6 }, () => a.post(`/api/games/aviator/${round.id}/cashout`)));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect((await pool.query("SELECT count(*) FROM ledger_entries WHERE entry_type='payout'")).rows[0].count).toBe('1');
    });
    it('the ledger is append-only', async () => {
      await signup();
      await expect(pool.query('UPDATE ledger_entries SET amount = 1')).rejects.toThrow(/append-only/);
      await expect(pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
    });
    it('the database refuses a negative balance or a real-money balance', async () => {
      await signup();
      await expect(pool.query('UPDATE wallets SET promo_balance = -1')).rejects.toThrow();
      await expect(pool.query('UPDATE wallets SET real_balance = 100')).rejects.toThrow();
    });
  });
});
