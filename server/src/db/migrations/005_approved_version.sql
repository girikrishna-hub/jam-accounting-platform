-- Bookkeeping 1.2.0: approval is pinned to the entry version the reviewer approved, and the
-- runtime itself refuses to post any other version (expectedVersion, BR-28). This replaces the
-- app's own fingerprint of the approved content.
ALTER TABLE app.journals ADD COLUMN IF NOT EXISTS approved_version integer;

-- Journals approved under the fingerprint scheme go back to the reviewer once, so every
-- approval in the register is pinned to a runtime version.
UPDATE app.journals
   SET status = 'submitted', reviewed_by = NULL, reviewed_at = NULL,
       review_note = 'Approval system upgraded; please approve again.'
 WHERE status = 'approved' AND approved_version IS NULL;

ALTER TABLE app.journals DROP COLUMN IF EXISTS approved_fingerprint;
