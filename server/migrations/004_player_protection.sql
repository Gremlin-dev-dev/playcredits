-- Player protection: deposit limits, loss limits and self-exclusion (real-money play only).

-- One row per (player, kind, period). `amount` is in kobo; NULL means "no limit".
-- Lowering a limit takes effect immediately. Raising or removing one is scheduled
-- (pending_*) and only takes effect after a 24h cooling-off period.
CREATE TABLE player_limits (
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('deposit','loss')),
  period               text NOT NULL CHECK (period IN ('daily','weekly','monthly')),
  amount               bigint CHECK (amount > 0),
  pending_amount       bigint CHECK (pending_amount > 0),
  pending_effective_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, period)
);
ALTER TABLE player_limits ENABLE ROW LEVEL SECURITY;

-- Self-exclusion: no real-money deposits or bets until this moment.
-- 'infinity' = permanent. The player can extend it but never shorten it.
ALTER TABLE users ADD COLUMN self_excluded_until timestamptz;
