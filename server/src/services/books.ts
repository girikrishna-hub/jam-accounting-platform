import { RuntimeError } from '@governedai-labs/bookkeeping-runtime';
import type { Db } from '../db/db.ts';
import type { LedgerActor, LedgerGateway } from '../ledger/gateway.ts';
import { parseChartOfAccounts, type RowError } from '../domain/chart-of-accounts.ts';
import { planOpeningBalances } from '../domain/opening-balances.ts';
import { formatMinor } from '../domain/money.ts';
import { audit } from '../audit.ts';
import type { OrganisationRow } from './organisations.ts';

export class BusinessRuleError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}

export interface ImportSummary {
  created: number;
  alreadyPresent: number;
  errors: RowError[];
}

/**
 * Imports a chart of accounts. Codes already in the ledger are left unchanged, so the same
 * file can be imported again safely. Each account gets a stable request ID derived from the
 * ledger and code, so a retried create never makes a duplicate.
 */
export async function importChartOfAccounts(db: Db, ledger: LedgerGateway, actor: LedgerActor, orgId: string, csv: string): Promise<ImportSummary> {
  const { rows, errors } = parseChartOfAccounts(csv);
  if (errors.length) return { created: 0, alreadyPresent: 0, errors };
  const existing = new Set((await ledger.listAccounts(actor)).map((a) => a.code));
  let created = 0;
  let alreadyPresent = 0;
  const failures: RowError[] = [];
  for (const row of rows) {
    if (existing.has(row.code)) { alreadyPresent += 1; continue; }
    try {
      await ledger.createAccount(actor, {
        code: row.code, name: row.name, type: row.type, normalBalance: row.normalBalance,
        ...(row.classification ? { classification: row.classification } : {}),
      }, `coa:${actor.ledgerId}:${row.code}`);
      created += 1;
    } catch (error) {
      if (error instanceof RuntimeError) failures.push({ line: row.line, message: `Account ${row.code}: ${error.code}${error.reason ? ` (${error.reason})` : ''}` });
      else throw error;
    }
  }
  await audit(db, { actorId: actor.actorId, orgId, action: 'coa.import', target: actor.ledgerId, outcome: failures.length ? 'failed' : 'succeeded', detail: { created, alreadyPresent, failures: failures.length } });
  return { created, alreadyPresent, errors: failures };
}

/** Opens the next monthly period: from the opening date, or the day after the last period ends. */
export async function openNextPeriod(ledger: LedgerGateway, actor: LedgerActor, org: OrganisationRow) {
  const periods = await ledger.listPeriods(actor);
  const last = periods.reduce<string | null>((max, p) => (max === null || p.endDate > max ? p.endDate : max), null);
  const start = last ? addDays(last, 1) : org.opening_date;
  return ledger.openPeriod(actor, start, endOfMonth(start));
}

export interface OpeningBalanceResult {
  entryId: string;
  lines: number;
  totalDebits: string;
  totalCredits: string;
}

/** Posts opening balances from a trial balance CSV. Needs an open period that covers the opening date. */
export async function postOpeningBalances(db: Db, ledger: LedgerGateway, actor: LedgerActor, org: OrganisationRow, csv: string): Promise<OpeningBalanceResult> {
  if (await ledger.hasOpeningBalances(actor)) {
    throw new BusinessRuleError('OPENING_BALANCES_EXIST', 'Opening balances have already been posted for this client. Correct them with a journal.');
  }
  const accounts = await ledger.listAccounts(actor);
  const plan = planOpeningBalances(csv, new Map(accounts.map((a) => [a.code, a.accountId])));
  if (plan.errors.length) throw new BusinessRuleError('INVALID_TRIAL_BALANCE', 'The trial balance file has errors.', plan.errors);
  const periods = await ledger.listPeriods(actor);
  if (!periods.some((p) => p.state === 'open' && p.startDate <= org.opening_date && org.opening_date <= p.endDate)) {
    throw new BusinessRuleError('NO_OPEN_PERIOD', `Open the period that contains the opening date (${org.opening_date}) first.`);
  }
  // One opening journal per ledger: a stable request ID makes a double-click or retry harmless.
  const entry = await ledger.postOpeningBalances(actor, plan.lines, `opening:${actor.ledgerId}`);
  const result = { entryId: entry.entryId, lines: plan.lines.length, totalDebits: formatMinor(plan.totalDebits), totalCredits: formatMinor(plan.totalCredits) };
  await audit(db, { actorId: actor.actorId, orgId: org.id, action: 'opening-balances.post', target: entry.entryId, detail: result });
  return result;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function endOfMonth(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}
