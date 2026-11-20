import type { ObjectTypeId, Role } from '../../../shared/workspace-model.ts';
import type { AppContext, OrgScope } from '../http/middleware.ts';
import { formatMinor } from '../domain/money.ts';
import { isAllowed } from '../access/checks.ts';
import type { ResourceType } from '../access/authority.ts';
import { VISIBLE_TO_CLIENT, getJournal, listJournals, type JournalRow } from '../services/journals.ts';
import { customerBalances, feeNoteSummaries, getCustomer, getFeeNote, feeNoteOutstanding } from '../services/receivables.ts';

export type MetadataValue = string | number | boolean | null;

export interface Projection {
  objectTypeId: ObjectTypeId;
  objectId: string;
  displayName: string;
  metadata: Record<string, MetadataValue>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ROLE_LABEL: Record<Role, string> = { accountant: 'Accountant', reviewer: 'Reviewer', client_viewer: 'Client viewer' };

const OBJECT_TYPES = new Set(['client-organisation', 'account', 'period', 'journal', 'customer', 'fee-note']);

/** Whether the Authorization Runtime lets this user open a workspace on this object. */
export function mayOpen(ctx: AppContext, scope: OrgScope, objectTypeId: string, objectId: string): Promise<boolean> {
  if (!OBJECT_TYPES.has(objectTypeId)) return Promise.resolve(false);
  return isAllowed(ctx, scope, objectTypeId as ResourceType, objectId, 'workspace.open');
}

/**
 * Resolves an object's presentation metadata from authoritative records, within the caller's
 * client only. Returns null when the object is not in that client or the role may not open it.
 */
export async function resolveObject(ctx: AppContext, scope: OrgScope, objectTypeId: string, objectId: string): Promise<Projection | null> {
  if (!(await mayOpen(ctx, scope, objectTypeId, objectId))) return null;
  const { ledger } = ctx;
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
  if (objectTypeId === 'journal') {
    const row = await getJournal(ctx.db, org.id, objectId);
    if (!row || !journalVisible(scope, row)) return null;
    return journalProjection(org.currency, row);
  }
  if (objectTypeId === 'customer') {
    const customer = await getCustomer(ctx.db, org.id, objectId);
    if (!customer) return null;
    const b = (await customerBalances(ctx.db, org.id)).find((c) => c.id === customer.id)!;
    return {
      objectTypeId, objectId, displayName: customer.name,
      metadata: {
        balance: `${org.currency} ${formatMinor(b.balance)}`, unallocated: `${org.currency} ${formatMinor(b.unallocated)}`,
        retainerHeld: `${org.currency} ${formatMinor(b.retainerHeld)}`, trn: customer.trn || '—',
        status: customer.kind === 'customer' ? customer.status : 'system account',
      },
    };
  }
  if (objectTypeId === 'fee-note') {
    const note = await getFeeNote(ctx.db, org.id, objectId);
    if (!note || note.status === 'discarded') return null;
    const customer = (await getCustomer(ctx.db, org.id, note.customer_id))!;
    const outstanding = await feeNoteOutstanding(ctx.db, org.id, note);
    const settlement = (await feeNoteSummaries(ctx.db, org.id, note.customer_id)).find((n) => n.id === note.id)?.settlement ?? note.status;
    return {
      objectTypeId, objectId, displayName: note.number ? `Fee note ${note.number}` : 'Draft fee note',
      metadata: {
        customer: customer.name, issueDate: note.issue_date, total: `${org.currency} ${formatMinor(note.total_minor)}`,
        outstanding: `${org.currency} ${formatMinor(outstanding)}`, matter: note.matter_ref || '—', status: settlement,
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
export async function searchObjects(ctx: AppContext, scope: OrgScope, query: string, objectTypeIds: readonly string[] | undefined, limit: number): Promise<Projection[]> {
  const { ledger } = ctx;
  const q = query.trim().toLowerCase();
  const wants = async (t: string) => (!objectTypeIds || objectTypeIds.includes(t)) && isAllowed(ctx, scope, t as ResourceType, '*', 'object.search');
  const results: Projection[] = [];
  if ((await wants('client-organisation')) && scope.org.name.toLowerCase().includes(q)) {
    const p = await resolveObject(ctx, scope, 'client-organisation', scope.org.id);
    if (p) results.push(p);
  }
  if (await wants('account')) {
    for (const a of await ledger.listAccounts(scope.actor)) {
      if (results.length >= limit) break;
      if (a.code.toLowerCase().startsWith(q) || a.name.toLowerCase().includes(q)) {
        results.push({ objectTypeId: 'account', objectId: a.accountId, displayName: `${a.code} ${a.name}`, metadata: { code: a.code, type: a.type, classification: a.classification ?? 'Unclassified', balance: null, status: a.active ? 'active' : 'inactive' } });
      }
    }
  }
  if (await wants('period')) {
    for (const p of await ledger.listPeriods(scope.actor)) {
      if (results.length >= limit) break;
      if (p.startDate.includes(q) || p.endDate.includes(q)) {
        results.push({ objectTypeId: 'period', objectId: p.periodId, displayName: `${p.startDate} to ${p.endDate}`, metadata: { startDate: p.startDate, endDate: p.endDate, status: p.state, reopenCount: p.reopenCount } });
      }
    }
  }
  if (await wants('journal')) {
    for (const row of await listJournals(ctx.db, scope.org.id)) {
      if (results.length >= limit) break;
      if (journalVisible(scope, row) && (row.description.toLowerCase().includes(q) || String(row.posting_sequence ?? '').startsWith(q))) {
        results.push(journalProjection(scope.org.currency, row));
      }
    }
  }
  if (await wants('customer')) {
    for (const c of await customerBalances(ctx.db, scope.org.id)) {
      if (results.length >= limit) break;
      if (c.name.toLowerCase().includes(q)) {
        results.push({ objectTypeId: 'customer', objectId: c.id, displayName: c.name, metadata: { balance: `${scope.org.currency} ${formatMinor(c.balance)}`, unallocated: null, retainerHeld: null, trn: c.trn || '—', status: c.kind === 'customer' ? c.status : 'system account' } });
      }
    }
  }
  if (await wants('fee-note')) {
    for (const n of await feeNoteSummaries(ctx.db, scope.org.id)) {
      if (results.length >= limit) break;
      if ((n.number ?? '').toLowerCase().includes(q) || n.customerName.toLowerCase().includes(q) || n.matterRef.toLowerCase().includes(q)) {
        results.push({ objectTypeId: 'fee-note', objectId: n.id, displayName: n.number ? `Fee note ${n.number}` : 'Draft fee note', metadata: { customer: n.customerName, issueDate: n.issueDate, total: `${scope.org.currency} ${formatMinor(n.total)}`, outstanding: `${scope.org.currency} ${formatMinor(n.outstanding)}`, matter: n.matterRef || '—', status: n.settlement } });
      }
    }
  }
  return results.slice(0, limit);
}

const KIND_LABEL = { standard: 'Journal', opening: 'Opening balances', reversal: 'Reversal' } as const;
const STATUS_LABEL = { draft: 'draft', submitted: 'awaiting approval', returned: 'returned', approved: 'approved', posted: 'posted', discarded: 'discarded', reversed: 'reversed' } as const;

/** Client viewers see only posted journals and their reversals. */
export function journalVisible(scope: OrgScope, row: JournalRow): boolean {
  return scope.role !== 'client_viewer' || VISIBLE_TO_CLIENT.includes(row.status);
}

function journalProjection(currency: string, row: JournalRow): Projection {
  return {
    objectTypeId: 'journal', objectId: row.entry_id, displayName: row.description,
    metadata: {
      entryDate: row.entry_date, number: row.posting_sequence ? `#${row.posting_sequence}` : 'Not posted',
      total: `${currency} ${formatMinor(row.total_minor)}`, kind: KIND_LABEL[row.kind], status: STATUS_LABEL[row.status],
    },
  };
}
