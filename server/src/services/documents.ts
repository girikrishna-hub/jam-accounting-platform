import type pg from 'pg';
import { z } from 'zod';
import type { AccountView, EntryView, LineInput } from '@governedai-labs/bookkeeping-runtime';
import type { Db } from '../db/db.ts';
import type { LedgerGateway } from '../ledger/gateway.ts';
import type { OrgScope } from '../http/middleware.ts';
import { parseAmount } from '../domain/money.ts';
import { BusinessRuleError } from './rule-error.ts';

/**
 * Shared building blocks for source documents (receivables and payables): transactions, gap-free
 * numbering, account and period checks, and posting one journal per document with request IDs
 * derived from the document, so a retried call posts once.
 */

export interface Ctx { db: Db; ledger: LedgerGateway }
export type Client = pg.PoolClient;
export type SourceType = 'fee-note' | 'receipt' | 'credit-note' | 'retainer-application' | 'expense' | 'expense-cancellation' | 'supplier-payment' | 'bank-entry';


export async function tx<T>(db: Db, run: (c: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Next gap-free number in a series for the year, inside the caller's transaction. */
export async function nextNumber(c: Client, orgId: string, series: string, year: number): Promise<number> {
  const r = await c.query<{ last: number }>(
    `INSERT INTO app.document_sequences (org_id, series, year, last) VALUES ($1, $2, $3, 1)
     ON CONFLICT (org_id, series, year) DO UPDATE SET last = app.document_sequences.last + 1 RETURNING last`,
    [orgId, series, year]);
  return r.rows[0]!.last;
}

export const pad = (n: number) => String(n).padStart(4, '0');
export const yearOf = (date: string) => Number(date.slice(0, 4));

export const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const AMOUNT_TEXT = z.string().trim().min(1).max(30);
export const ACCOUNT_CODE = z.string().trim().min(1).max(20);

export function amount(text: string, field: string): bigint {
  const minor = parseAmount(text);
  if (minor === null || minor <= 0n) throw new BusinessRuleError('INVALID_AMOUNT', `${field}: enter a positive amount with at most 2 decimals.`);
  return minor;
}

/** The ledger reports balances signed on the account's normal side; this returns debit-positive. */
export const debitBalance = (amount: string, account: AccountView) => BigInt(amount) * (account.normalBalance === 'credit' ? -1n : 1n);

export async function accountsByCode(ctx: Ctx, scope: OrgScope): Promise<Map<string, AccountView>> {
  return new Map((await ctx.ledger.listAccounts(scope.actor)).map((a) => [a.code, a]));
}

export function requireAccount(accounts: Map<string, AccountView>, code: string, purpose: string): AccountView {
  const account = accounts.get(code);
  if (!account) throw new BusinessRuleError('ACCOUNT_MISSING', `The ${purpose} account ${code} is not in this client's chart of accounts.`);
  if (!account.active) throw new BusinessRuleError('ACCOUNT_INACTIVE', `The ${purpose} account ${code} is inactive.`);
  return account;
}

export async function requireOpenPeriod(ctx: Ctx, scope: OrgScope, date: string): Promise<void> {
  if (date < scope.org.opening_date) throw new BusinessRuleError('BEFORE_OPENING', `The date is before this client's opening date (${scope.org.opening_date}).`);
  const periods = await ctx.ledger.listPeriods(scope.actor);
  const period = periods.find((p) => p.startDate <= date && date <= p.endDate);
  if (!period) throw new BusinessRuleError('NO_OPEN_PERIOD', `No period is open for ${date}. Open it under Periods first.`);
  if (period.state !== 'open') throw new BusinessRuleError('PERIOD_CLOSED', `The period containing ${date} is closed.`);
}


/**
 * Drafts and posts one journal for a source document and records it in the journal register.
 * Request IDs come from the document, so a retry of the same document returns the same entry.
 */
export async function postForDocument(ctx: Ctx, scope: OrgScope, doc: {
  sourceType: SourceType; sourceId: string;
  date: string; description: string; reference?: string;
  lines: { account: AccountView; side: 'debit' | 'credit'; amount: bigint; memo?: string }[];
}): Promise<EntryView> {
  const lines: LineInput[] = doc.lines.filter((l) => l.amount > 0n).map((l) => ({
    accountId: l.account.accountId, side: l.side, amount: l.amount.toString(), ...(l.memo ? { memo: l.memo } : {}),
  }));
  const base = `${doc.sourceType}:${scope.actor.ledgerId}:${doc.sourceId}`;
  const draft = await ctx.ledger.draftEntry(scope.actor, {
    entryDate: doc.date, description: doc.description, lines, ...(doc.reference ? { externalReference: doc.reference } : {}),
  }, `${base}:draft`);
  const posted = await ctx.ledger.postEntry(scope.actor, draft.entryId, `${base}:post`);
  const total = lines.filter((l) => l.side === 'debit').reduce((sum, l) => sum + BigInt(l.amount), 0n);
  await ctx.db.query(
    `INSERT INTO app.journals (org_id, entry_id, kind, status, entry_date, description, total_minor, created_by, updated_by, posted_by, posted_at, posting_sequence, source_type, source_id)
     VALUES ($1, $2, 'standard', 'posted', $3, $4, $5, $6, $6, $6, now(), $7, $8, $9)
     ON CONFLICT (org_id, entry_id) DO UPDATE SET source_type = EXCLUDED.source_type, source_id = EXCLUDED.source_id`,
    [scope.org.id, posted.entryId, posted.entryDate, posted.description, total.toString(), scope.actor.actorId, posted.postingSequence ?? null, doc.sourceType, doc.sourceId]);
  return posted;
}

