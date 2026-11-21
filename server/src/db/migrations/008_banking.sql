-- Slice 4: bank statements, matching and reconciliation.
-- Statement lines are what the bank says; ledger entries are what the books say. A match links a
-- bank line to one or more ledger entries that touch the bank account, by amount.

CREATE TABLE IF NOT EXISTS app.bank_statements (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  account_code   text NOT NULL,             -- the bank account in the chart, e.g. 1000
  file_name      text NOT NULL DEFAULT '',
  file_hash      text NOT NULL,
  first_date     date NOT NULL,
  last_date      date NOT NULL,
  opening_minor  bigint NOT NULL,
  closing_minor  bigint NOT NULL,
  line_count     integer NOT NULL,
  imported_by    uuid,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_code, file_hash)
);

-- amount_minor is signed: money in positive, money out negative.
CREATE TABLE IF NOT EXISTS app.bank_lines (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  statement_id   uuid NOT NULL REFERENCES app.bank_statements(id),
  account_code   text NOT NULL,
  line_no        integer NOT NULL,
  txn_date       date NOT NULL,
  value_date     date,
  reference      text NOT NULL DEFAULT '',
  description    text NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor <> 0),
  balance_minor  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_lines_org_idx ON app.bank_lines(org_id, account_code, txn_date);
-- The same bank line cannot come in twice, even from a different file.
CREATE UNIQUE INDEX IF NOT EXISTS bank_lines_once ON app.bank_lines(org_id, account_code, txn_date, amount_minor, balance_minor, description);

CREATE TABLE IF NOT EXISTS app.bank_matches (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  line_id       uuid NOT NULL REFERENCES app.bank_lines(id),
  entry_id      text NOT NULL,
  amount_minor  bigint NOT NULL,             -- signed, as on the bank account
  matched_by    uuid,
  matched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_matches_line_idx ON app.bank_matches(org_id, line_id);
-- A ledger entry is matched to at most one bank line.
CREATE UNIQUE INDEX IF NOT EXISTS bank_matches_entry_once ON app.bank_matches(org_id, entry_id);

-- A posting made straight from a bank line (charges, interest, tax payments, drawings, payroll).
CREATE TABLE IF NOT EXISTS app.bank_entries (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  line_id        uuid NOT NULL REFERENCES app.bank_lines(id),
  account_code   text NOT NULL,              -- the bank account
  target_account text NOT NULL,              -- the other side
  description    text NOT NULL,
  amount_minor   bigint NOT NULL,            -- signed, as on the bank account
  flag           text NOT NULL DEFAULT '',   -- e.g. 'Payroll register needed'
  status         text NOT NULL CHECK (status IN ('recording', 'recorded')),
  entry_id       text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Remembered suggestions: a bank description containing the text suggests the account.
CREATE TABLE IF NOT EXISTS app.bank_rules (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  contains_text  text NOT NULL,
  target_account text NOT NULL,
  description    text NOT NULL DEFAULT '',
  flag           text NOT NULL DEFAULT '',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_rules_once ON app.bank_rules(org_id, lower(contains_text));

-- A month's reconciliation: completed by the accountant, signed off by the reviewer. Snapshot holds the
-- figures and reconciling items as they were when completed.
CREATE TABLE IF NOT EXISTS app.bank_reconciliations (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  account_code   text NOT NULL,
  period_end     date NOT NULL,
  status         text NOT NULL CHECK (status IN ('complete', 'signed_off')),
  snapshot       jsonb NOT NULL,
  fingerprint    text NOT NULL,
  completed_by   uuid,
  completed_at   timestamptz NOT NULL DEFAULT now(),
  signed_by      uuid,
  signed_at      timestamptz,
  UNIQUE (org_id, account_code, period_end)
);
