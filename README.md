# PlayCredits — virtual-credit gaming simulation

Full-stack app: React + TypeScript + Vite frontend, Node + Express + TypeScript API, PostgreSQL.

**This is a simulation.** Users get 10,000 *virtual play credits* and can play an Aviator-style game.
Credits have **no cash value**. There are **no deposits, real-money bets, cash-outs to money, or withdrawals**
anywhere in this codebase, and the UI says so. Do not repurpose it into a real-money or "pay a fee to withdraw" product.

## What is in the box
- `server/` – Express API, SQL migrations (`server/migrations`), tests (`server/tests`)
- `web/` – Vite React app (dev server proxies `/api` to the API)
- `CHECKLIST.md` – what is implemented/tested vs. what is not

## Required software (Windows 10/11)
1. **Node.js 20 LTS or newer** – https://nodejs.org (check: `node -v`)
2. **PostgreSQL 15 or newer** – https://www.postgresql.org/download/windows/ (remember the `postgres` password you set; keep `psql` on PATH or use SQL Shell)
3. Git is optional.

## First-time setup (PowerShell, from the extracted folder)
```powershell
# 1. Install dependencies for both packages
npm install

# 2. Create the databases (enter your postgres password when asked)
psql -U postgres -c "CREATE DATABASE playcredits;"
psql -U postgres -c "CREATE DATABASE playcredits_test;"

# 3. Create your env file
copy server\.env.example server\.env

# 4. Generate a secret and paste it as JWT_SECRET in server\.env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Edit `server\.env`: set `DATABASE_URL` (replace `CHANGE_ME` with your postgres password), `JWT_SECRET`, and
`TEST_DATABASE_URL`. If your password contains special characters, URL-encode them (`@` → `%40`).

```powershell
# 5. Create tables
npm run migrate

# 6. Run API (http://localhost:4000) and web app (http://localhost:5173) together
npm run dev
```
Open http://localhost:5173, register, and you will receive 10,000 play credits.

## Commands
| Command | What it does |
|---|---|
| `npm run dev` | API + web in watch mode |
| `npm run migrate` | Applies pending SQL migrations (idempotent; safe to re-run) |
| `npm run build` | Type-checks/builds server (`server/dist`) and web (`web/dist`) |
| `npm test` | Unit tests always; integration tests when `TEST_DATABASE_URL` is set |

### Running the integration tests (PowerShell)
The tests truncate all tables, so **use the separate test database**:
```powershell
$env:TEST_DATABASE_URL="postgres://postgres:YOUR_PASSWORD@localhost:5432/playcredits_test"
npm test
```
Without `TEST_DATABASE_URL`, the integration suite is skipped (not failed).

## Environment variables (`server/.env`)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | ≥32 chars; signs session cookies. Rotating it logs everyone out |
| `CLIENT_ORIGIN` | Exact frontend origin; used for CORS and Origin checks |
| `WELCOME_BONUS_CREDITS`, `MIN_BET_CREDITS`, `MAX_BET_CREDITS` | Game settings |
| `TRUST_PROXY` | Set `1` behind a reverse proxy |
| `TEST_DATABASE_URL` | Test-only database |

## How it works
- **Wallet:** balances live only in PostgreSQL. Every change goes through `applyEntry()` in `server/src/wallet.ts`, which locks the wallet row (`SELECT … FOR UPDATE`), rejects negative balances, updates the balance and appends an immutable row to `ledger_entries` in one transaction. A DB trigger blocks UPDATE/DELETE on the ledger. No endpoint accepts a balance from the client.
- **Promo vs. real money:** separate columns; `real_balance` is constrained to 0 in this edition.
- **Welcome bonus:** granted inside the registration transaction; a unique index allows one per user.
- **Aviator:** on bet, the server picks a secret seed, derives the crash point (HMAC-SHA256, 1% house edge), stores it and returns only the seed's SHA-256 hash. Multiplier = e^(0.1·seconds) measured on the server clock. Cash-out pays `floor(bet × multiplier)` if the plane hasn't crashed; the seed is revealed after settlement so you can verify. One open round per user (partial unique index).
- **Security:** bcrypt (cost 12), httpOnly SameSite=Lax cookie JWT, Origin check, Helmet, rate limits (auth: 20 per 15 min per IP), zod validation on every route, auth required on all non-public routes, errors never leak internals.

## Real money (Paystack) - disabled by default
Set `REAL_MONEY_ENABLED=true` only when you are licensed to operate. Until then every `/api/payments/*` route returns 404.
- Amounts are whole **kobo** (NGN x 100). Wallets keep a separate `real_balance`; each game round remembers which wallet it was bet from.
- **Deposits:** `POST /api/payments/deposits {amount}` creates a pending payment and returns a Paystack checkout URL. Money is credited **only** when Paystack calls `POST /api/payments/paystack/webhook` with a valid HMAC-SHA512 signature, the amount and currency match what we stored, and the payment is still pending (so retries never double-credit). In the Paystack dashboard set the webhook URL to `https://YOUR-API-DOMAIN/api/payments/paystack/webhook`.
- **Withdrawals:** `POST /api/payments/withdrawals {amount, bankCode, accountNumber}` needs `users.kyc_status = 'verified'`, takes the money off the balance immediately and queues the request as `pending_review`. Paying out (Paystack Transfers) and the admin approval screen are not built yet.
- Not built yet: identity verification flow, deposit/loss limits, self-exclusion, admin panel, payouts.

## Deployment guidance
1. Provision PostgreSQL; set env vars on the host (never commit `.env`).
2. `npm ci && npm run build && npm run migrate:prod -w server`, then `npm start -w server`.
3. Serve `web/dist` from a static host or reverse proxy (nginx/Caddy), proxying `/api` to the API on the same domain so cookies stay first-party. Set `NODE_ENV=production`, `CLIENT_ORIGIN` to the public https origin, `TRUST_PROXY=1`, and use HTTPS.
4. Back up the database; the ledger is your audit trail.
