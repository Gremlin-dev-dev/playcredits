-- Real-money groundwork. All amounts are in kobo (1 NGN = 100 kobo), whole numbers only.
-- The features that use this are OFF unless REAL_MONEY_ENABLED=true (see server/.env.example).

-- 1. Wallets may now hold a real balance (never negative).
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_real_balance_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_real_balance_nonneg CHECK (real_balance >= 0);

-- 2. Payments (deposits and withdrawal requests). `reference` is unique, so a repeated
--    provider webhook can never be applied twice.
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('deposit','withdrawal')),
  amount        bigint NOT NULL CHECK (amount > 0),
  status        text NOT NULL CHECK (status IN ('pending','succeeded','failed','pending_review','approved','paid','rejected')),
  provider      text NOT NULL DEFAULT 'paystack',
  reference     text NOT NULL UNIQUE,
  destination   jsonb,
  provider_data jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- 3. Ledger: new entry types, real balance type, link to the payment that caused the entry.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
  CHECK (entry_type IN ('welcome_bonus','bet','payout','deposit','withdrawal','withdrawal_reversal'));
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_balance_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_balance_type_check
  CHECK (balance_type IN ('promo','real'));
ALTER TABLE ledger_entries ADD COLUMN payment_id uuid REFERENCES payments(id);

-- 4. A round remembers which wallet its bet came from, so the payout goes back to the same one.
ALTER TABLE game_rounds ADD COLUMN balance_type text NOT NULL DEFAULT 'promo' CHECK (balance_type IN ('promo','real'));

-- 5. Identity verification. Withdrawals require 'verified'. Set by an admin / KYC provider, never by the user.
ALTER TABLE users ADD COLUMN kyc_status text NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified'));
