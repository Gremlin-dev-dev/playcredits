CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- Promo (virtual) and real-money balances are separate columns.
-- This edition has no real-money features, so real_balance is locked to 0.
CREATE TABLE wallets (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  promo_balance bigint NOT NULL DEFAULT 0 CHECK (promo_balance >= 0),
  real_balance  bigint NOT NULL DEFAULT 0 CHECK (real_balance = 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_rounds (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game               text NOT NULL DEFAULT 'aviator',
  bet                bigint NOT NULL CHECK (bet > 0),
  status             text NOT NULL CHECK (status IN ('open','cashed_out','crashed')),
  server_seed        text NOT NULL,
  seed_hash          text NOT NULL,
  crash_point        numeric(10,2) NOT NULL CHECK (crash_point >= 1),
  started_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  cashout_multiplier numeric(10,2),
  payout             bigint NOT NULL DEFAULT 0 CHECK (payout >= 0),
  settled_at         timestamptz
);
CREATE UNIQUE INDEX one_open_round_per_user ON game_rounds (user_id) WHERE status = 'open';
CREATE INDEX game_rounds_user_idx ON game_rounds (user_id, started_at DESC);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_type    text NOT NULL CHECK (entry_type IN ('welcome_bonus','bet','payout')),
  amount        bigint NOT NULL,
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  balance_type  text NOT NULL DEFAULT 'promo' CHECK (balance_type = 'promo'),
  round_id      uuid REFERENCES game_rounds(id),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ledger_user_idx ON ledger_entries (user_id, id DESC);
-- A user can receive the welcome bonus only once.
CREATE UNIQUE INDEX one_welcome_bonus_per_user ON ledger_entries (user_id) WHERE entry_type = 'welcome_bonus';

-- Ledger is append-only (UPDATE and DELETE are rejected).
CREATE FUNCTION ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
