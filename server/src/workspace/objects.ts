import { canViewCapability, objectTypeModel, type ObjectTypeId, type Role } from '../../../shared/workspace-model.ts';
import type { LedgerGateway } from '../ledger/gateway.ts';
import type { OrgScope } from '../http/middleware.ts';
import { formatMinor } from '../domain/money.ts';

export type MetadataValue = string | number | boolean | null;

export interface Projection {
  objectTypeId: ObjectTypeId;
  objectId: string;
  displayName: string;
  metadata: Record<string, MetadataValue>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ROLE_LABEL: Record<Role, string> = { accountant: 'Accountant', reviewer: 'Reviewer', client_viewer: 'Client viewer' };

/** The role may see at least one capability of the object type (otherwise the workspace is closed to it). */
export function mayOpen(role: Role, objectTypeId: string): boolean {
  return Boolean(objectTypeModel(objectTypeId)?.capabilities.some((c) => canViewCapability(role, objectTypeId, c.capabilityId)));
}

/**
 * Resolves an object's presentation metadata from authoritative records, within the caller's
 * client only. Returns null when the object is not in that client or the role may not open it.
 */
export async function resolveObject(ledger: LedgerGateway, scope: OrgScope, objectTypeId: string, objectId: string): Promise<Projection | null> {
  if (!mayOpen(scope.role, objectTypeId)) return null;
  const { org } = scope;
  if (objectTypeId === 'client-organisation') {
    if (objectId !== org.id) return null;
    return {
      objectTypeId, objectId: org.id, displayName: org.name,
      metadata: {
        legalName: org.legal_name || org.name, trn: org.trn || '—', currency: org.currency,
        financialYearStart: MONTHS[org.financial_year_start - 1] ?? '', status: org.status, yourRole: ROLE_LABEL[scope.role],
      },
    };
  }
  if (objectTypeId === 'account') {
    const account = (await ledger.listAccounts(scope.actor)).find((a) => a.accountId === objectId);
    if (!account) return null;
    const tb = await ledger.getTrialBalance(scope.actor);
    const amount = tb.rows.find((row) => row.account.accountId === objectId)?.balance.amount ?? '0';
    return {
      objectTypeId, objectId, displayName: `${account.code} ${account.name}`,
      metadata: {
        code: account.code, type: account.type[0]!.toUpperCase() + account.type.slice(1),
        classification: account.classification ?? 'Unclassified',
        balance: `${org.currency} ${formatMinor(amount)}`, status: account.active ? 'active' : 'inactive',
      },
    };
  }
  if (objectTypeId === 'period') {
    const period = (await ledger.listPeriods(scope.actor)).find((p) => p.periodId === objectId);
    if (!period) return null;
    const d = new Date(`${period.startDate}T00:00:00Z`);
    return {
      objectTypeId, objectId, displayName: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      metadata: { startDate: period.startDate, endDate: period.endDate, status: period.state, reopenCount: period.reopenCount },
    };
  }
  return null;
}

/** Searches accounts and periods in one client. The role's capability rules filter the results. */
export async function searchObjects(ledger: LedgerGateway, scope: OrgScope, query: string, objectTypeIds: readonly string[] | undefined, limit: number): Promise<Projection[]> {
  const q = query.trim().toLowerCase();
  const wants = (t: string) => (!objectTypeIds || objectTypeIds.includes(t)) && mayOpen(scope.role, t);
  const results: Projection[] = [];
  if (wants('client-organisation') && scope.org.name.toLowerCase().includes(q)) {
    const p = await resolveObject(ledger, scope, 'client-organisation', scope.org.id);
    if (p) results.push(p);
  }
  if (wants('account')) {
    for (const a of await ledger.listAccounts(scope.actor)) {
      if (results.length >= limit) break;
      if (a.code.toLowerCase().startsWith(q) || a.name.toLowerCase().includes(q)) {
        results.push({ objectTypeId: 'account', objectId: a.accountId, displayName: `${a.code} ${a.name}`, metadata: { code: a.code, type: a.type, classification: a.classification ?? 'Unclassified', balance: null, status: a.active ? 'active' : 'inactive' } });
      }
    }
  }
  if (wants('period')) {
    for (const p of await ledger.listPeriods(scope.actor)) {
      if (results.length >= limit) break;
      if (p.startDate.includes(q) || p.endDate.includes(q)) {
        results.push({ objectTypeId: 'period', objectId: p.periodId, displayName: `${p.startDate} to ${p.endDate}`, metadata: { startDate: p.startDate, endDate: p.endDate, status: p.state, reopenCount: p.reopenCount } });
      }
    }
  }
  return results.slice(0, limit);
}
