-- Slice 1 foundation. Every client-owned table carries org_id (design pack, constitution: isolation).
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.users (
  id             uuid PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  is_firm_admin  boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.sessions (
  token_hash     text PRIMARY KEY,
  public_ref     uuid NOT NULL UNIQUE,
  user_id        uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON app.sessions(user_id);

CREATE TABLE IF NOT EXISTS app.organisations (
  id                    uuid PRIMARY KEY,
  name                  text NOT NULL,
  legal_name            text NOT NULL DEFAULT '',
  trn                   text NOT NULL DEFAULT '',
  country               text NOT NULL DEFAULT 'JM',
  currency              text NOT NULL DEFAULT 'JMD',
  financial_year_start  smallint NOT NULL DEFAULT 1 CHECK (financial_year_start BETWEEN 1 AND 12),
  opening_date          date NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  ledger_request_id     text NOT NULL UNIQUE,
  ledger_id             text UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.assignments (
  user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('accountant', 'reviewer', 'client_viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS assignments_org_idx ON app.assignments(org_id);

CREATE TABLE IF NOT EXISTS app.audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  org_id      uuid,
  action      text NOT NULL,
  target      text NOT NULL DEFAULT '',
  outcome     text NOT NULL DEFAULT 'succeeded',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_org_idx ON app.audit(org_id, id DESC);

CREATE TABLE IF NOT EXISTS app.schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
