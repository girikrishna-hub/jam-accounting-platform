-- Failed sign-in tracking for the Authentication Runtime's lockout policy.
-- Kept in the database so lockout holds across restarts and multiple server instances.
CREATE TABLE IF NOT EXISTS app.sign_in_lockout (
  identity_key   text PRIMARY KEY,
  failures       timestamptz[] NOT NULL DEFAULT '{}',
  locked_until   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
