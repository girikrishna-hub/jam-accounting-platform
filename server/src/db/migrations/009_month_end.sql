-- Slice 5: month-end close and GCT returns.

-- A month's close: requested by the accountant with the checklist and acknowledged warnings, approved by a
-- reviewer (which closes the Bookkeeping period), and possibly reopened by a reviewer with a reason.
CREATE TABLE IF NOT EXISTS app.period_closes (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  period_id        text NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  status           text NOT NULL CHECK (status IN ('requested', 'closing', 'closed', 'reopened')),
  checklist        jsonb NOT NULL,
  acknowledgements jsonb NOT NULL DEFAULT '[]',
  requested_by     uuid,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  approved_by      uuid,
  approved_at      timestamptz,
  reopened_by      uuid,
  reopened_at      timestamptz,
  reopen_reason    text NOT NULL DEFAULT ''
);
-- One live close per month (a reopened one is history).
CREATE UNIQUE INDEX IF NOT EXISTS period_closes_live ON app.period_closes(org_id, period_id) WHERE status <> 'reopened';

-- A month's GCT return as filed: the working's figures and the journal that moved input GCT into GCT payable.
CREATE TABLE IF NOT EXISTS app.gct_returns (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  output_minor  bigint NOT NULL,
  input_minor   bigint NOT NULL,
  net_minor     bigint NOT NULL,
  filed_on      date NOT NULL,
  reference     text NOT NULL DEFAULT '',
  status        text NOT NULL CHECK (status IN ('filing', 'filed')),
  entry_id      text,
  filed_by      uuid,
  filed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_start)
);
