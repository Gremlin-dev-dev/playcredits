-- Supabase exposes every table in the public schema through its auto-generated REST API.
-- Our API talks to Postgres directly (as a role that bypasses RLS), so we turn on Row Level
-- Security with NO policies: the public REST API (anon / authenticated keys) can read nothing.
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_rounds       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
