# Implementation checklist

## Implemented (code written)
- [x] Registration, login, logout, `/api/me`; bcrypt hashing; cookie sessions; Origin check; rate limiting; helmet
- [x] One-time 10,000 virtual welcome bonus (same transaction as signup, unique index)
- [x] Server-managed wallet; append-only ledger; row locking; separate promo/real columns (real locked to 0)
- [x] Aviator-style game: server-side crash point, commit/reveal seed, bet, cash-out, crash settlement, history
- [x] Wallet UI: balance, totals, transaction history, round history; simulation labels everywhere
- [x] Migrations + runner; `.env.example`; Windows README

## Automated tests written
- [x] Unit: crash-point maths and distribution, multiplier curve, payouts, input validation (`server/tests/game.test.ts`)
- [x] Integration (need PostgreSQL via `TEST_DATABASE_URL`): signup/bonus, duplicate email, login, password hashing, 401s on protected routes, forged token, cross-origin rejection, cross-user round access, no balance/deposit/withdraw endpoints, bet/cash-out accounting, crash pays nothing, over-balance bets, concurrent bets, concurrent cash-outs, ledger immutability, DB balance constraints (`server/tests/api.test.ts`)

## NOT verified yet — read this
- [ ] **Nothing has been installed, built or run.** The environment this was generated in had no network access, so `npm install`, `npm run build`, `npm run migrate` and `npm test` have **not** been executed. Expect that you may need to fix small type or dependency errors on first run. Please run them and report any failures.
- [ ] Rate-limit behaviour and the React UI have no automated tests (UI is untested beyond reading the code).

## Intentionally not included
- No withdrawals, deposits, withdrawal fees or payment-provider integration. The spec's "withdrawal charge", "fee calculation" and "payment provider abstraction" items were removed by agreement because play credits have no cash value. If a licensed real-money product is built later, that is a separate design (licence, KYC, fees deducted from payouts, verified provider webhooks).
- No email verification, password reset, 2FA, admin panel, or responsible-gaming limits.
- Only one game (Aviator-style); more games need new modules using `applyEntry()`.
