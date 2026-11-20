-- Slice 3a: receivables (customers, fee notes with GCT, receipts, allocations, retainers,
-- credit notes). The Bookkeeping runtime holds every posting; these tables hold the
-- sub-ledger documents and the entry_id each one posted (never balances of GL accounts).

-- Which journals were posted by a source document (fee note, receipt, credit note,
-- retainer application). Such journals are corrected through their document, not reversed.
ALTER TABLE app.journals ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE app.journals ADD COLUMN IF NOT EXISTS source_id uuid;

-- Per client: the accounts receivables post to, by account code (validated when used).
CREATE TABLE IF NOT EXISTS app.receivable_settings (
  org_id              uuid PRIMARY KEY REFERENCES app.organisations(id) ON DELETE CASCADE,
  receivable_account  text NOT NULL,   -- control account, e.g. 1100
  gct_account         text NOT NULL,   -- output GCT, e.g. 2100
  disbursement_account text NOT NULL,  -- disbursements recoverable, e.g. 1120
  retainer_account    text NOT NULL,   -- fees received in advance, e.g. 2200
  set_up_at           timestamptz,     -- when brought-forward and unidentified customers were created
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Per client: practice area → fee income account code.
CREATE TABLE IF NOT EXISTS app.practice_areas (
  org_id          uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  income_account  text NOT NULL,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE IF NOT EXISTS app.customers (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer', 'brought_forward', 'unidentified')),
  name        text NOT NULL,
  trn         text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  address     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_org_idx ON app.customers(org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS customers_one_special_kind ON app.customers(org_id, kind) WHERE kind <> 'customer';

-- Gap-free document numbers per client, series and year.
CREATE TABLE IF NOT EXISTS app.document_sequences (
  org_id  uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  series  text NOT NULL,
  year    integer NOT NULL,
  last    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, series, year)
);

CREATE TABLE IF NOT EXISTS app.fee_notes (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES app.customers(id),
  number          text,
  status          text NOT NULL CHECK (status IN ('draft', 'issuing', 'issued', 'discarded')),
  brought_forward boolean NOT NULL DEFAULT false,
  issue_date      date NOT NULL,
  matter_ref      text NOT NULL DEFAULT '',
  practice_area   text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  lines           jsonb NOT NULL DEFAULT '[]',
  fees_minor      bigint NOT NULL DEFAULT 0,
  gct_minor       bigint NOT NULL DEFAULT 0,
  disbursements_minor bigint NOT NULL DEFAULT 0,
  total_minor     bigint NOT NULL DEFAULT 0,
  entry_id        text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  issued_by       uuid,
  issued_at       timestamptz,
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS fee_notes_org_idx ON app.fee_notes(org_id, status, issue_date);
CREATE INDEX IF NOT EXISTS fee_notes_customer_idx ON app.fee_notes(org_id, customer_id);

CREATE TABLE IF NOT EXISTS app.receipts (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES app.customers(id),
  number          text,
  kind            text NOT NULL CHECK (kind IN ('payment', 'retainer')),
  status          text NOT NULL CHECK (status IN ('recording', 'recorded')),
  receipt_date    date NOT NULL,
  method          text NOT NULL DEFAULT '',
  deposit_account text NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  reference       text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  entry_id        text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS receipts_customer_idx ON app.receipts(org_id, customer_id);

CREATE TABLE IF NOT EXISTS app.credit_notes (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  fee_note_id     uuid NOT NULL REFERENCES app.fee_notes(id),
  customer_id     uuid NOT NULL REFERENCES app.customers(id),
  number          text,
  status          text NOT NULL CHECK (status IN ('issuing', 'issued')),
  credit_date     date NOT NULL,
  reason          text NOT NULL,
  fees_minor      bigint NOT NULL DEFAULT 0,
  gct_minor       bigint NOT NULL DEFAULT 0,
  disbursements_minor bigint NOT NULL DEFAULT 0,
  total_minor     bigint NOT NULL CHECK (total_minor > 0),
  entry_id        text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

-- What settled a fee note: a receipt, a retainer applied (posts its own journal) or a credit note.
CREATE TABLE IF NOT EXISTS app.allocations (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  fee_note_id   uuid NOT NULL REFERENCES app.fee_notes(id),
  source_type   text NOT NULL CHECK (source_type IN ('receipt', 'retainer', 'credit_note')),
  source_id     uuid NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  allocated_on  date NOT NULL,
  status        text NOT NULL DEFAULT 'done' CHECK (status IN ('posting', 'done')),
  entry_id      text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS allocations_fee_note_idx ON app.allocations(org_id, fee_note_id);
CREATE INDEX IF NOT EXISTS allocations_source_idx ON app.allocations(org_id, source_type, source_id);
