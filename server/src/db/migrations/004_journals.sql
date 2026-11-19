-- Slice 2: journal approval setting per client, and the journal register.
-- The Bookkeeping runtime holds journal contents and is the authority for posting; it has no
-- "list journals" query, so the app keeps this register of each journal's workflow status and
-- who prepared, approved and posted it (platform feedback PF-10).

ALTER TABLE app.organisations ADD COLUMN IF NOT EXISTS journal_approval_required boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS app.journals (
  org_id                uuid NOT NULL REFERENCES app.organisations(id) ON DELETE CASCADE,
  entry_id              text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('standard', 'opening', 'reversal')),
  status                text NOT NULL CHECK (status IN ('draft', 'submitted', 'returned', 'approved', 'posted', 'discarded', 'reversed')),
  entry_date            date NOT NULL,
  description           text NOT NULL,
  total_minor           bigint NOT NULL DEFAULT 0,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  submitted_by          uuid,
  submitted_at          timestamptz,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  review_note           text,
  approved_fingerprint  text,
  posted_by             uuid,
  posted_at             timestamptz,
  posting_sequence      integer,
  reversal_of           text,
  reversed_by_entry     text,
  PRIMARY KEY (org_id, entry_id)
);
CREATE INDEX IF NOT EXISTS journals_org_status_idx ON app.journals(org_id, status, entry_date DESC);
