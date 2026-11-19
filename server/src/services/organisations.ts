import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.ts';
import type { LedgerGateway } from '../ledger/gateway.ts';
import type { Role } from '../../../shared/workspace-model.ts';
import { audit } from '../audit.ts';

export interface OrganisationRow {
  id: string;
  name: string;
  legal_name: string;
  trn: string;
  country: string;
  currency: string;
  financial_year_start: number;
  journal_approval_required: boolean;
  opening_date: string;
  status: 'active' | 'suspended' | 'archived';
  ledger_request_id: string;
  ledger_id: string | null;
  created_at: string;
}

const COLUMNS = `id, name, legal_name, trn, country, currency, financial_year_start, journal_approval_required,
  to_char(opening_date, 'YYYY-MM-DD') AS opening_date, status, ledger_request_id, ledger_id, created_at`;

export async function getOrganisation(db: Db, orgId: string): Promise<OrganisationRow | null> {
  const r = await db.query<OrganisationRow>(`SELECT ${COLUMNS} FROM app.organisations WHERE id = $1`, [orgId]);
  return r.rows[0] ?? null;
}

/** The caller's role in an org, or null when not assigned. The only gate to client data. */
export async function roleInOrganisation(db: Db, userId: string, orgId: string): Promise<Role | null> {
  const r = await db.query<{ role: Role }>(
    `SELECT a.role FROM app.assignments a JOIN app.users u ON u.id = a.user_id
     WHERE a.user_id = $1 AND a.org_id = $2 AND u.status = 'active'`, [userId, orgId]);
  return r.rows[0]?.role ?? null;
}

export async function organisationsForUser(db: Db, userId: string): Promise<(OrganisationRow & { role: Role })[]> {
  const r = await db.query<OrganisationRow & { role: Role }>(
    `SELECT o.*, a.role FROM (SELECT ${COLUMNS} FROM app.organisations) o
     JOIN app.assignments a ON a.org_id = o.id
     WHERE a.user_id = $1 ORDER BY o.name`, [userId]);
  return r.rows;
}

export async function allOrganisations(db: Db): Promise<OrganisationRow[]> {
  return (await db.query<OrganisationRow>(`SELECT ${COLUMNS} FROM app.organisations ORDER BY name`)).rows;
}

export interface NewOrganisation {
  name: string;
  legalName?: string;
  trn?: string;
  currency?: string;
  financialYearStart?: number;
  openingDate: string;
}

/**
 * Creates a client organisation and its ledger. The ledger request ID is stored first, so a
 * retry after a failure finds the same ledger instead of creating a second one.
 */
export async function createOrganisation(db: Db, ledger: LedgerGateway, adminId: string, input: NewOrganisation): Promise<OrganisationRow> {
  const id = randomUUID();
  const requestId = `org-ledger-${id}`;
  await db.query(
    `INSERT INTO app.organisations (id, name, legal_name, trn, currency, financial_year_start, opening_date, ledger_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.name, input.legalName ?? input.name, input.trn ?? '', input.currency ?? 'JMD', input.financialYearStart ?? 1, input.openingDate, requestId],
  );
  const view = await ensureLedger(db, ledger, adminId, id);
  await audit(db, { actorId: adminId, orgId: id, action: 'organisation.create', target: id, detail: { name: input.name, ledgerId: view } });
  return (await getOrganisation(db, id))!;
}

/** Creates (or, on retry, finds) the org's ledger and records its ID. */
export async function ensureLedger(db: Db, ledger: LedgerGateway, adminId: string, orgId: string): Promise<string> {
  const org = await getOrganisation(db, orgId);
  if (!org) throw new Error('Organisation not found');
  if (org.ledger_id) return org.ledger_id;
  const view = await ledger.createLedger(adminId, {
    requestId: org.ledger_request_id,
    orgId: org.id,
    name: org.name,
    currency: org.currency,
    openingDate: org.opening_date,
  });
  await db.query('UPDATE app.organisations SET ledger_id = $2 WHERE id = $1 AND ledger_id IS NULL', [orgId, view.ledgerId]);
  return view.ledgerId;
}

export async function updateProfile(db: Db, actorId: string, orgId: string, input: { name: string; legalName: string; trn: string; financialYearStart: number }): Promise<OrganisationRow> {
  await db.query(
    'UPDATE app.organisations SET name = $2, legal_name = $3, trn = $4, financial_year_start = $5 WHERE id = $1',
    [orgId, input.name, input.legalName, input.trn, input.financialYearStart],
  );
  await audit(db, { actorId, orgId, action: 'organisation.profile.update', target: orgId, detail: input });
  return (await getOrganisation(db, orgId))!;
}

/** Journal approval (maker-checker) for one client. Changed by a reviewer; audited. */
export async function setJournalApproval(db: Db, actorId: string, orgId: string, required: boolean): Promise<OrganisationRow> {
  await db.query('UPDATE app.organisations SET journal_approval_required = $2 WHERE id = $1', [orgId, required]);
  await audit(db, { actorId, orgId, action: 'organisation.controls.update', target: orgId, detail: { journalApprovalRequired: required } });
  return (await getOrganisation(db, orgId))!;
}
