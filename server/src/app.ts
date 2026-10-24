import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { ZodError } from 'zod';
import { config } from './config';
import { pool, withTx } from './db';
import { HttpError } from './errors';
import { log } from './logger';
import { clearSession, originCheck, requireAuth, setSession } from './auth';
import { applyEntry } from './wallet';
import { betSchema, credentialsSchema, pageSchema, roundIdSchema } from './validation';
import { cashOut, currentRound, placeBet } from './rounds';

const BCRYPT_COST = config.NODE_ENV === 'test' ? 4 : 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function createApp() {
  const app = express();
  if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  app.use(originCheck);

  const general = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.NODE_ENV === 'test' ? 10_000 : 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later' },
  });
  app.use('/api', general);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) =>
    res.json({
      currencyLabel: 'play credits',
      minBet: config.MIN_BET_CREDITS,
      maxBet: config.MAX_BET_CREDITS,
      welcomeBonus: config.WELCOME_BONUS_CREDITS,
      notice: 'Simulation only. Play credits are virtual, have no cash value and cannot be withdrawn.',
    }),
  );

  // ---- Auth ----
  app.post(
    '/api/auth/register',
    authLimiter,
    wrap(async (req, res) => {
      const { email, password } = credentialsSchema.parse(req.body);
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      try {
        const user = await withTx(async (c) => {
          const u = await c.query('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email', [email, hash]);
          await c.query('INSERT INTO wallets (user_id) VALUES ($1)', [u.rows[0].id]);
          // Welcome bonus: once per user (unique index) and inside the same transaction.
          await applyEntry(c, { userId: u.rows[0].id, type: 'welcome_bonus', amount: config.WELCOME_BONUS_CREDITS });
          return u.rows[0];
        });
        setSession(res, user.id);
        res.status(201).json({ id: user.id, email: user.email });
      } catch (e: any) {
        if (e?.code === '23505') throw new HttpError(409, 'Email already registered');
        throw e;
      }
    }),
  );

  app.post(
    '/api/auth/login',
    authLimiter,
    wrap(async (req, res) => {
      const { email, password } = credentialsSchema.parse(req.body);
      const q = await pool.query('SELECT id, email, password_hash FROM users WHERE lower(email)=lower($1)', [email]);
      const u = q.rows[0];
      const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH); // constant-ish time
      if (!u || !ok) throw new HttpError(401, 'Invalid email or password');
      setSession(res, u.id);
      res.json({ id: u.id, email: u.email });
    }),
  );

  app.post('/api/auth/logout', (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  app.get(
    '/api/me',
    requireAuth,
    wrap(async (req, res) => {
      const q = await pool.query('SELECT id, email FROM users WHERE id=$1', [req.userId]);
      if (!q.rows[0]) throw new HttpError(401, 'Account not found');
      res.json(q.rows[0]);
    }),
  );

  // ---- Wallet (read-only for clients) ----
  app.get(
    '/api/wallet',
    requireAuth,
    wrap(async (req, res) => {
      const w = await pool.query('SELECT promo_balance FROM wallets WHERE user_id=$1', [req.userId]);
      if (!w.rows[0]) throw new HttpError(404, 'Wallet not found');
      const s = await pool.query(
        `SELECT COALESCE(SUM(-amount) FILTER (WHERE entry_type='bet'),0) AS wagered,
                COALESCE(SUM(amount) FILTER (WHERE entry_type='payout'),0) AS winnings
         FROM ledger_entries WHERE user_id=$1`,
        [req.userId],
      );
      res.json({
        playCredits: Number(w.rows[0].promo_balance),
        realMoney: 0,
        totalWagered: Number(s.rows[0].wagered),
        totalWinnings: Number(s.rows[0].winnings),
        notice: 'Play credits are virtual and have no cash value. They cannot be withdrawn.',
      });
    }),
  );

  app.get(
    '/api/wallet/ledger',
    requireAuth,
    wrap(async (req, res) => {
      const { limit, before } = pageSchema.parse(req.query);
      const q = await pool.query(
        `SELECT id, entry_type, amount, balance_after, round_id, created_at FROM ledger_entries
         WHERE user_id=$1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
        [req.userId, before ?? null, limit],
      );
      res.json(
        q.rows.map((r) => ({
          id: Number(r.id),
          type: r.entry_type,
          amount: Number(r.amount),
          balanceAfter: Number(r.balance_after),
          roundId: r.round_id,
          createdAt: r.created_at,
        })),
      );
    }),
  );

  // ---- Aviator-style game ----
  const bet = betSchema(config.MIN_BET_CREDITS, config.MAX_BET_CREDITS);

  app.post(
    '/api/games/aviator/bet',
    requireAuth,
    wrap(async (req, res) => {
      const { amount } = bet.parse(req.body);
      try {
        const round = await withTx((c) => placeBet(c, req.userId!, amount));
        res.status(201).json(round);
      } catch (e: any) {
        // Unique index allows only one open round per user (covers concurrent requests).
        if (e?.code === '23505') throw new HttpError(409, 'A round is already in progress');
        throw e;
      }
    }),
  );

  app.get(
    '/api/games/aviator/current',
    requireAuth,
    wrap(async (req, res) => {
      res.json((await withTx((c) => currentRound(c, req.userId!))) ?? null);
    }),
  );

  app.post(
    '/api/games/aviator/:id/cashout',
    requireAuth,
    wrap(async (req, res) => {
      const { id } = roundIdSchema.parse(req.params);
      res.json(await withTx((c) => cashOut(c, req.userId!, id)));
    }),
  );

  app.get(
    '/api/games/aviator/:id',
    requireAuth,
    wrap(async (req, res) => {
      const { id } = roundIdSchema.parse(req.params);
      // Settle (as crashed) if its time is up, then return it. Seed stays hidden while open.
      const round = await withTx(async (c) => {
        const open = await currentRound(c, req.userId!);
        if (open && open.id === id) return open;
        const q = await c.query(
          `SELECT * FROM game_rounds WHERE id=$1 AND user_id=$2 AND status<>'open'`,
          [id, req.userId],
        );
        if (!q.rows[0]) throw new HttpError(404, 'Round not found');
        const r = q.rows[0];
        return {
          id: r.id, status: r.status, bet: Number(r.bet), seedHash: r.seed_hash,
          multiplier: r.cashout_multiplier != null ? Number(r.cashout_multiplier) : undefined,
          crashPoint: Number(r.crash_point), serverSeed: r.server_seed, payout: Number(r.payout),
        };
      });
      res.json(round);
    }),
  );

  app.get(
    '/api/games/history',
    requireAuth,
    wrap(async (req, res) => {
      const q = await pool.query(
        `SELECT id, bet, status, payout, cashout_multiplier, crash_point, started_at FROM game_rounds
         WHERE user_id=$1 AND status<>'open' ORDER BY started_at DESC LIMIT 50`,
        [req.userId],
      );
      res.json(
        q.rows.map((r) => ({
          id: r.id, bet: Number(r.bet), status: r.status, payout: Number(r.payout),
          cashoutMultiplier: r.cashout_multiplier != null ? Number(r.cashout_multiplier) : null,
          crashPoint: Number(r.crash_point), startedAt: r.started_at,
        })),
      );
    }),
  );

  // ---- Errors ----
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if ((err as any)?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    log('error', 'unhandled', { path: req.path, message: (err as Error)?.message });
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
