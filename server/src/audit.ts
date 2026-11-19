import type { Db } from './db/db.ts';

export interface AuditEntry {
  actorId: string | null;
  orgId?: string | null;
  action: string;
  target?: string;
  outcome?: 'succeeded' | 'rejected' | 'failed';
  detail?: Record<string, unknown>;
}

/** App audit for actions outside the ledger runtime (the runtime audits its own operations). */
export async function audit(db: Pick<Db, 'query'>, entry: AuditEntry): Promise<void> {
  await db.query(
    'INSERT INTO app.audit (actor_id, org_id, action, target, outcome, detail) VALUES ($1, $2, $3, $4, $5, $6)',
    [entry.actorId, entry.orgId ?? null, entry.action, entry.target ?? '', entry.outcome ?? 'succeeded', JSON.stringify(entry.detail ?? {})],
  );
}
