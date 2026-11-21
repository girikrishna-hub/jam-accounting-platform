-- Slice 3b: payables and expenses (suppliers, expenses paid at once or owed, supplier payments).
-- The Bookkeeping runtime holds every posting; these tables hold the documents and the entry_id
-- each one posted.

-- Per client: the accounts payables post to, by account code (validated when used).
CREATE TABLE IF NOT EXISTS app.payable_settings (
  org_id                uuid PRIMARY KEY REFERENCES app.organisations(id) ON DELETE CASCADE,
  payable_account       text NOT NULL,   -- control account, e.g. 2000
  input_gct_account     text NOT NULL,   -- input GCT recoverable, e.g. 1160
  disbursement_account  text NOT NULL,   -- rechargeable costs, e.g. 1120 (lines here carry a matter)
  set_up_at             timestamptz,     -- when the brought-forward supplier balance was created
  updated_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.suppliers (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'supplier' CHECK (kind IN ('supplier', 'brought_forward')),
  name        text NOT NULL,
  trn         text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  address     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppliers_org_idx ON app.suppliers(org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_one_special_kind ON app.suppliers(org_id, kind) WHERE kind <> 'supplier';

-- An expense: paid at once (settlement 'paid', from a cash or bank account) or owed to the supplier
-- ('owed', credited to the payables control account and settled by supplier payments).
-- Lines: [{ account, description, net, gct, taxCode, matterRef }] in minor units.
CREATE TABLE IF NOT EXISTS app.expenses (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  supplier_id       uuid NOT NULL REFERENCES app.suppliers(id),
  number            text,
  status            text NOT NULL CHECK (status IN ('draft', 'recording', 'recorded', 'discarded', 'cancelling', 'cancelled')),
  brought_forward   boolean NOT NULL DEFAULT false,
  expense_date      date NOT NULL,
  supplier_invoice  text NOT NULL DEFAULT '',
  description       text NOT NULL DEFAULT '',
  settlement        text NOT NULL CHECK (settlement IN ('paid', 'owed')),
  paid_from         text NOT NULL DEFAULT '',   -- account code when paid at once
  payment_method    text NOT NULL DEFAULT '',
  payment_ref       text NOT NULL DEFAULT '',   -- cheque number, card slip, etc.
  receipt_on_file   boolean NOT NULL DEFAULT true,
  foreign_amount    text NOT NULL DEFAULT '',   -- e.g. 'USD 2,500.00 at 156.90'
  notes             text NOT NULL DEFAULT '',
  lines             jsonb NOT NULL DEFAULT '[]',
  net_minor         bigint NOT NULL DEFAULT 0,
  gct_minor         bigint NOT NULL DEFAULT 0,   -- input GCT claimed (0 when no receipt is on file)
  total_minor       bigint NOT NULL DEFAULT 0,
  entry_id          text,
  cancel_date       date,
  cancel_reason     text NOT NULL DEFAULT '',
  cancel_entry_id   text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by       uuid,
  recorded_at       timestamptz,
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS expenses_org_idx ON app.expenses(org_id, expense_date);
CREATE INDEX IF NOT EXISTS expenses_supplier_idx ON app.expenses(org_id, supplier_id);
-- The same supplier invoice cannot be entered twice (cancelled and discarded ones excepted).
CREATE UNIQUE INDEX IF NOT EXISTS expenses_supplier_invoice_once ON app.expenses(org_id, supplier_id, lower(supplier_invoice))
  WHERE supplier_invoice <> '' AND status NOT IN ('discarded', 'cancelled');

CREATE TABLE IF NOT EXISTS app.supplier_payments (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  supplier_id   uuid NOT NULL REFERENCES app.suppliers(id),
  number        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('recording', 'recorded')),
  payment_date  date NOT NULL,
  paid_from     text NOT NULL,
  method        text NOT NULL,
  reference     text NOT NULL DEFAULT '',
  amount_minor  bigint NOT NULL,
  entry_id      text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

-- Which owed expenses a supplier payment settles. No journal: the payment posted Dr payables / Cr bank.
CREATE TABLE IF NOT EXISTS app.payment_allocations (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  payment_id    uuid NOT NULL REFERENCES app.supplier_payments(id),
  expense_id    uuid NOT NULL REFERENCES app.expenses(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0)
);
CREATE INDEX IF NOT EXISTS payment_allocations_expense_idx ON app.payment_allocations(org_id, expense_id);
