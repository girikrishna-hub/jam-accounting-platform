-- Durable idempotency for workspace actions: the executor enforces each key once per org and action.
CREATE TABLE IF NOT EXISTS app.action_executions (
  execution_id     uuid PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  action_id        text NOT NULL,
  object_type_id   text NOT NULL,
  object_id        text NOT NULL,
  idempotency_key  text NOT NULL,
  actor_id         uuid NOT NULL,
  state            text NOT NULL CHECK (state IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  result           jsonb,
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, action_id, idempotency_key)
);
