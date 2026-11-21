import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountView } from '@governedai-labs/bookkeeping-runtime';
import type { Db } from '../db/db.ts';
import type { OrgScope } from '../http/middleware.ts';
import { parseCsv } from '../domain/csv.ts';
import { formatMinor } from '../domain/money.ts';
import { audit } from '../audit.ts';
import { BusinessRuleError } from './rule-error.ts';
import { ACCOUNT_CODE, AMOUNT_TEXT, accountsByCode, amount, debitBalance, postForDocument, requireAccount, requireOpenPeriod, tx, type Ctx } from './documents.ts';
import { recordReceipt } from './receivables.ts';
import { createExpense, expenseTotalOf } from './payables.ts';

/**
 * Bank reconciliation (Slice 4). A statement is imported as CSV in the bank's layout; each line is matched
 * to one or more ledger entries on the bank account, or turned into a receipt, an expense or a simple bank
 * entry. The month reconciles when
 *   statement balance + ledger items not yet on the statement = ledger balance + bank lines not yet entered.
 * The accountant completes it; the reviewer signs it off, after which lines up to that date are locked.
 */

const isCash = (a: AccountView) => a.type === 'asset' && (a.classification ?? '').startsWith('BS.CA.CASH');

async function bankAccount(ctx: Ctx, scope: OrgScope, code: string): Promise<AccountView> {
  const a = requireAccount(await accountsByCode(ctx, scope), code, 'bank account');
  if (!isCash(a)) throw new BusinessRuleError('NOT_A_BANK_ACCOUNT', `Account ${code} is not a cash or bank account.`);
  return a;
}

// ---------- Statement import ----------

/** Parses "2026-01-02", "2026-01-02 00:00:00", "02/01/2026" (day first) or "2-Jan-2026". */
export function parseBankDate(text: string): string | null {
  const s = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/.exec(s);
  if (m) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2]!.toLowerCase());
    if (month >= 0) return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  return null;
}

function money(text: string): bigint | null {
  const s = text.trim().replace(/,/g, '').replace(/^J\$/i, '');
  if (!s) return 0n;
  const m = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[2]! + (m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -v : v;
}

export interface ParsedLine { lineNo: number; date: string; valueDate: string | null; reference: string; description: string; amount: bigint; balance: bigint }
export interface ParsedStatement { opening: bigint; lines: ParsedLine[]; errors: string[] }

/**
 * Reads a statement in the bank's layout: a header row with Date, Value date, Reference, Description,
 * Debit, Credit and Balance (extra columns ignored), an optional "Balance brought forward" row, the lines,
 * and an optional totals row. Checks every running balance.
 */
export function parseStatement(csv: string): ParsedStatement {
  const rows = parseCsv(csv);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s*\(.*\)\s*$/, '');
  const headerAt = rows.findIndex((r) => r.some((c) => norm(c) === 'date') && r.some((c) => norm(c) === 'balance'));
  if (headerAt < 0) return { opening: 0n, lines: [], errors: ['No header row with Date and Balance columns.'] };
  const h = rows[headerAt]!.map(norm);
  const col = (...names: string[]) => h.findIndex((c) => names.includes(c));
  const c = { date: col('date', 'transaction date'), value: col('value date'), ref: col('reference', 'ref'), desc: col('description', 'details', 'narrative'),
    debit: col('debit', 'withdrawals', 'money out'), credit: col('credit', 'deposits', 'money in'), balance: col('balance') };
  const errors: string[] = [];
  for (const [k, v] of Object.entries(c)) if (v < 0 && k !== 'value' && k !== 'ref') errors.push(`Missing column: ${k}.`);
  if (errors.length) return { opening: 0n, lines: [], errors };
  let opening: bigint | null = null;
  const lines: ParsedLine[] = [];
  let running: bigint | null = null;
  for (let i = headerAt + 1; i < rows.length; i += 1) {
    const r = rows[i]!;
    const at = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '');
    const first = r.find((x) => x.trim() !== '')?.trim().toLowerCase() ?? '';
    if (first.startsWith('balance brought forward') || first.startsWith('opening balance')) {
      const nums = r.map((x) => money(x)).filter((x): x is bigint => x !== null && x !== 0n);
      opening = money(at(c.balance)) || nums[nums.length - 1] || 0n;
      running = opening;
      continue;
    }
    if (first.startsWith('total') || first.startsWith('closing')) continue;
    const rowNo = i + 1;
    const date = parseBankDate(at(c.date));
    if (!date) { errors.push(`Row ${rowNo}: date "${at(c.date)}" is not a date.`); continue; }
    const debit = money(at(c.debit)); const credit = money(at(c.credit)); const balance = money(at(c.balance));
    if (debit === null || credit === null || balance === null) { errors.push(`Row ${rowNo}: an amount is not a number.`); continue; }
    const value = credit - debit;
    if (value === 0n) { errors.push(`Row ${rowNo}: no debit or credit amount.`); continue; }
    if (running === null) { running = balance - value; opening = running; }
    running += value;
    if (running !== balance) errors.push(`Row ${rowNo}: balance ${formatMinor(balance)} does not follow from the line before (expected ${formatMinor(running)}).`);
    running = balance;
    lines.push({ lineNo: lines.length + 1, date, valueDate: parseBankDate(at(c.value)), reference: at(c.ref), description: at(c.desc) || at(c.ref), amount: value, balance });
  }
  if (!lines.length && !errors.length) errors.push('The file has no statement lines.');
  return { opening: opening ?? 0n, lines, errors };
}

export const ImportInput = z.object({ accountCode: ACCOUNT_CODE, fileName: z.string().trim().max(200).default(''), csv: z.string().min(1).max(2_000_000) });

/** Imports a statement. Its opening balance must follow on from the last statement, or for the first, agree with the ledger. */
export async function importStatement(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = ImportInput.parse(raw);
  const bank = await bankAccount(ctx, scope, input.accountCode);
  const parsed = parseStatement(input.csv);
  if (parsed.errors.length) throw new BusinessRuleError('STATEMENT_INVALID', parsed.errors.slice(0, 5).join(' '), { errors: parsed.errors });
  const hash = createHash('sha256').update(input.csv.replace(/\r\n/g, '\n').trim()).digest('hex');
  const dup = await ctx.db.query('SELECT 1 FROM app.bank_statements WHERE org_id = $1 AND account_code = $2 AND file_hash = $3', [scope.org.id, input.accountCode, hash]);
  if (dup.rowCount) throw new BusinessRuleError('DUPLICATE_STATEMENT', 'This statement has already been imported.');
  const dates = parsed.lines.map((l) => l.date).sort();
  const first = dates[0]!; const last = dates[dates.length - 1]!;
  const previous = (await ctx.db.query<{ closing: string; last_date: string }>(
    `SELECT closing_minor::text AS closing, to_char(last_date, 'YYYY-MM-DD') AS last_date FROM app.bank_statements WHERE org_id = $1 AND account_code = $2 ORDER BY last_date DESC LIMIT 1`,
    [scope.org.id, input.accountCode])).rows[0];
  if (previous) {
    if (BigInt(previous.closing) !== parsed.opening) {
      throw new BusinessRuleError('OPENING_MISMATCH', `The statement opens at ${formatMinor(parsed.opening)}, but the last statement closed at ${formatMinor(previous.closing)}.`);
    }
  } else {
    const ledgerOpening = await ledgerBalance(ctx, scope, bank, dayBefore(first));
    if (ledgerOpening !== parsed.opening) {
      throw new BusinessRuleError('OPENING_MISMATCH', `The statement opens at ${formatMinor(parsed.opening)}, but account ${input.accountCode} shows ${formatMinor(ledgerOpening)} before ${first}.`);
    }
  }
  const closing = parsed.lines[parsed.lines.length - 1]!.balance;
  const id = randomUUID();
  await tx(ctx.db, async (c) => {
    await c.query(
      `INSERT INTO app.bank_statements (id, org_id, account_code, file_name, file_hash, first_date, last_date, opening_minor, closing_minor, line_count, imported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, scope.org.id, input.accountCode, input.fileName, hash, first, last, parsed.opening.toString(), closing.toString(), parsed.lines.length, scope.actor.actorId]);
    for (const l of parsed.lines) {
      await c.query(
        `INSERT INTO app.bank_lines (id, org_id, statement_id, account_code, line_no, txn_date, value_date, reference, description, amount_minor, balance_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [randomUUID(), scope.org.id, id, input.accountCode, l.lineNo, l.date, l.valueDate, l.reference, l.description, l.amount.toString(), l.balance.toString()]);
    }
  }).catch((e: { code?: string }) => {
    if (e.code === '23505') throw new BusinessRuleError('DUPLICATE_LINES', 'Some of these lines were already imported in another statement.');
    throw e;
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'bank.import', target: id, detail: { account: input.accountCode, lines: parsed.lines.length, first, last } });
  return { id, lines: parsed.lines.length, opening: formatMinor(parsed.opening), closing: formatMinor(closing), first, last };
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function ledgerBalance(ctx: Ctx, scope: OrgScope, bank: AccountView, asOf: string): Promise<bigint> {
  const tb = await ctx.ledger.getTrialBalance(scope.actor, asOf);
  const row = tb.rows.find((r) => r.account.accountId === bank.accountId);
  return row ? debitBalance(row.balance.amount, bank) : 0n;
}

// ---------- Lines and ledger items ----------

export interface BankLine {
  id: string; lineNo: number; date: string; reference: string; description: string; amount: string; balance: string;
  matched: string; remaining: string; matches: { entryId: string; amount: string; date: string; description: string }[];
}
export interface LedgerItem { entryId: string; date: string; description: string; amount: string; lineId: string | null; lineDate: string | null }

async function lines(db: Pick<Db, 'query'>, orgId: string, accountCode: string): Promise<BankLine[]> {
  const r = await db.query<{ id: string; line_no: number; date: string; reference: string; description: string; amount: string; balance: string; matches: { entryId: string; amount: string }[] }>(
    `SELECT l.id, l.line_no, to_char(l.txn_date, 'YYYY-MM-DD') AS date, l.reference, l.description, l.amount_minor::text AS amount, l.balance_minor::text AS balance,
       COALESCE((SELECT json_agg(json_build_object('entryId', m.entry_id, 'amount', m.amount_minor::text) ORDER BY m.matched_at) FROM app.bank_matches m WHERE m.line_id = l.id), '[]') AS matches
     FROM app.bank_lines l JOIN app.bank_statements s ON s.id = l.statement_id
     WHERE l.org_id = $1 AND l.account_code = $2 ORDER BY s.first_date, l.line_no`, [orgId, accountCode]);
  const ids = r.rows.flatMap((l) => l.matches.map((m) => m.entryId));
  const journals = ids.length ? (await db.query<{ entry_id: string; date: string; description: string }>(
    `SELECT entry_id, to_char(entry_date, 'YYYY-MM-DD') AS date, description FROM app.journals WHERE org_id = $1 AND entry_id = ANY($2)`, [orgId, ids])).rows : [];
  const byId = new Map(journals.map((j) => [j.entry_id, j]));
  return r.rows.map((l) => {
    const matched = l.matches.reduce((t, m) => t + BigInt(m.amount), 0n);
    return {
      id: l.id, lineNo: l.line_no, date: l.date, reference: l.reference, description: l.description, amount: l.amount, balance: l.balance,
      matched: matched.toString(), remaining: (BigInt(l.amount) - matched).toString(),
      matches: l.matches.map((m) => ({ ...m, date: byId.get(m.entryId)?.date ?? '', description: byId.get(m.entryId)?.description ?? '' })),
    };
  });
}

/** Every posted entry that moves the bank account (the opening balance aside), with its signed effect and any match. */
async function ledgerItems(ctx: Ctx, scope: OrgScope, bank: AccountView, toDate: string): Promise<LedgerItem[]> {
  const from = scope.org.opening_date;
  const opening = new Set((await ctx.ledger.listEntries(scope.actor, { kinds: ['opening'] })).map((e) => e.entryId));
  const byEntry = new Map<string, { date: string; amount: bigint }>();
  for (const l of await ctx.ledger.getAccountLedger(scope.actor, bank.accountId, from, toDate)) {
    if (opening.has(l.entryId)) continue;
    const v = BigInt(l.line.amount.amount) * (l.line.side === 'debit' ? 1n : -1n);
    const cur = byEntry.get(l.entryId) ?? { date: l.entryDate, amount: 0n };
    cur.amount += v;
    byEntry.set(l.entryId, cur);
  }
  const ids = [...byEntry.keys()];
  if (!ids.length) return [];
  const meta = (await ctx.db.query<{ entry_id: string; description: string; line_id: string | null; line_date: string | null }>(
    `SELECT j.entry_id, j.description, m.line_id, to_char(l.txn_date, 'YYYY-MM-DD') AS line_date
     FROM app.journals j LEFT JOIN app.bank_matches m ON m.org_id = j.org_id AND m.entry_id = j.entry_id LEFT JOIN app.bank_lines l ON l.id = m.line_id
     WHERE j.org_id = $1 AND j.entry_id = ANY($2)`, [scope.org.id, ids])).rows;
  const byId = new Map(meta.map((m) => [m.entry_id, m]));
  return ids.map((id) => {
    const e = byEntry.get(id)!; const m = byId.get(id);
    return { entryId: id, date: e.date, description: m?.description ?? '', amount: e.amount.toString(), lineId: m?.line_id ?? null, lineDate: m?.line_date ?? null };
  }).filter((i) => i.amount !== '0').sort((a, b) => a.date.localeCompare(b.date));
}

export interface Suggestion { entryIds: string[]; reason: string }
export interface RuleSuggestion { ruleId: string; containsText: string; targetAccount: string; description: string; flag: string }

const DAY = 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const tokens = (s: string) => new Set((s.toUpperCase().match(/[A-Z]{2}-\d{2,4}-\d{3,4}|[A-Z]{2}-\d{4}-\d{4}|\b\d{5,6}\b/g) ?? []));

/** Suggests ledger items for a line: a shared document or cheque number, an exact amount nearby, or 2-3 items adding up. */
export function suggest(line: BankLine, open: LedgerItem[]): Suggestion | null {
  const want = BigInt(line.remaining);
  if (want === 0n) return null;
  const sameSign = open.filter((i) => (BigInt(i.amount) > 0n) === (want > 0n));
  const lineTokens = tokens(`${line.reference} ${line.description}`);
  const byToken = sameSign.filter((i) => BigInt(i.amount) === want && [...tokens(i.description)].some((t) => lineTokens.has(t)));
  if (byToken.length) return { entryIds: [byToken[0]!.entryId], reason: 'Same amount and reference' };
  const near = sameSign.filter((i) => daysApart(i.date, line.date) <= 7);
  const exact = near.filter((i) => BigInt(i.amount) === want).sort((a, b) => daysApart(a.date, line.date) - daysApart(b.date, line.date));
  if (exact.length) return { entryIds: [exact[0]!.entryId], reason: 'Same amount within 7 days' };
  const pool = near.filter((i) => (want > 0n ? BigInt(i.amount) < want : BigInt(i.amount) > want)).slice(0, 25);
  for (let a = 0; a < pool.length; a += 1) {
    for (let b = a + 1; b < pool.length; b += 1) {
      const ab = BigInt(pool[a]!.amount) + BigInt(pool[b]!.amount);
      if (ab === want) return { entryIds: [pool[a]!.entryId, pool[b]!.entryId], reason: 'Two items add up to this line' };
      for (let c = b + 1; c < pool.length; c += 1) {
        if (ab + BigInt(pool[c]!.amount) === want) return { entryIds: [pool[a]!.entryId, pool[b]!.entryId, pool[c]!.entryId], reason: 'Three items add up to this line' };
      }
    }
  }
  return null;
}

async function rules(db: Pick<Db, 'query'>, orgId: string): Promise<RuleSuggestion[]> {
  return (await db.query<RuleSuggestion>(
    `SELECT id AS "ruleId", contains_text AS "containsText", target_account AS "targetAccount", description, flag FROM app.bank_rules WHERE org_id = $1 ORDER BY length(contains_text) DESC`, [orgId])).rows;
}

/** The bank screen: lines with suggestions, ledger items not yet matched, rules. */
export async function bankOverview(ctx: Ctx, scope: OrgScope, accountCode: string) {
  const bank = await bankAccount(ctx, scope, accountCode);
  const statements = (await ctx.db.query<{ id: string; file_name: string; first: string; last: string; opening: string; closing: string; line_count: number }>(
    `SELECT id, file_name, to_char(first_date, 'YYYY-MM-DD') AS first, to_char(last_date, 'YYYY-MM-DD') AS last, opening_minor::text AS opening, closing_minor::text AS closing, line_count
     FROM app.bank_statements WHERE org_id = $1 AND account_code = $2 ORDER BY first_date`, [scope.org.id, accountCode])).rows;
  const all = await lines(ctx.db, scope.org.id, accountCode);
  const lastDate = statements.length ? statements[statements.length - 1]!.last : scope.org.opening_date;
  const items = await ledgerItems(ctx, scope, bank, maxDate(lastDate, await latestPeriodEnd(ctx, scope)));
  const open = items.filter((i) => !i.lineId);
  const ruleList = await rules(ctx.db, scope.org.id);
  const taken = new Set<string>();
  const withSuggestions = all.map((l) => {
    const s = suggest(l, open.filter((i) => !taken.has(i.entryId)));
    s?.entryIds.forEach((id) => taken.add(id));
    const desc = `${l.reference} ${l.description}`.toLowerCase();
    const rule = s ? null : ruleList.find((r) => desc.includes(r.containsText.toLowerCase())) ?? null;
    return { ...l, suggestion: s, rule };
  });
  return { account: { code: bank.code, name: bank.name }, statements, lines: withSuggestions, unmatched: open, rules: ruleList, locked: await lockedThrough(ctx.db, scope.org.id, accountCode) };
}

const maxDate = (a: string, b: string) => (a > b ? a : b);
async function latestPeriodEnd(ctx: Ctx, scope: OrgScope): Promise<string> {
  const periods = await ctx.ledger.listPeriods(scope.actor);
  return periods.reduce((m, p) => maxDate(m, p.endDate), scope.org.opening_date);
}

async function lockedThrough(db: Pick<Db, 'query'>, orgId: string, accountCode: string): Promise<string | null> {
  const r = await db.query<{ d: string | null }>(`SELECT to_char(MAX(period_end), 'YYYY-MM-DD') AS d FROM app.bank_reconciliations WHERE org_id = $1 AND account_code = $2 AND status = 'signed_off'`, [orgId, accountCode]);
  return r.rows[0]?.d ?? null;
}

async function requireLine(ctx: Ctx, scope: OrgScope, lineId: string) {
  const found = z.string().uuid().safeParse(lineId).success
    ? (await ctx.db.query<{ account_code: string }>('SELECT account_code FROM app.bank_lines WHERE org_id = $1 AND id = $2', [scope.org.id, lineId])).rows[0] : undefined;
  if (!found) throw new BusinessRuleError('LINE_NOT_FOUND', 'Bank line not found.');
  const accountCode = found.account_code;
  const line = (await lines(ctx.db, scope.org.id, accountCode)).find((l) => l.id === lineId)!;
  const locked = await lockedThrough(ctx.db, scope.org.id, accountCode);
  if (locked && line.date <= locked) throw new BusinessRuleError('RECONCILED', `The bank reconciliation to ${locked} is signed off; its lines cannot change.`);
  return { line, accountCode };
}

// ---------- Matching ----------

export const MatchInput = z.object({ lineId: z.string().uuid(), entryIds: z.array(z.string().min(1).max(200)).min(1).max(20) });

/** Matches ledger entries to a bank line. Together they must not exceed what is left on the line. */
export async function matchLine(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = MatchInput.parse(raw);
  const { line, accountCode } = await requireLine(ctx, scope, input.lineId);
  const bank = await bankAccount(ctx, scope, accountCode);
  const items = await ledgerItems(ctx, scope, bank, await latestPeriodEnd(ctx, scope));
  const chosen = input.entryIds.map((id) => {
    const i = items.find((x) => x.entryId === id);
    if (!i) throw new BusinessRuleError('ENTRY_NOT_FOUND', 'That entry does not touch this bank account.');
    if (i.lineId) throw new BusinessRuleError('ALREADY_MATCHED', `"${i.description}" is already matched to a bank line.`);
    return i;
  });
  const total = chosen.reduce((t, i) => t + BigInt(i.amount), 0n);
  const remaining = BigInt(line.remaining);
  if ((total > 0n) !== (remaining > 0n) || (remaining > 0n ? total > remaining : total < remaining)) {
    throw new BusinessRuleError('MATCH_AMOUNT', `These come to ${formatMinor(total)}; ${formatMinor(remaining)} is left on the bank line.`);
  }
  await tx(ctx.db, async (c) => {
    for (const i of chosen) {
      await c.query('INSERT INTO app.bank_matches (id, org_id, line_id, entry_id, amount_minor, matched_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), scope.org.id, line.id, i.entryId, i.amount, scope.actor.actorId]);
    }
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'bank.match', target: line.id, detail: { entries: input.entryIds } });
  return { lineId: line.id, remaining: (remaining - total).toString() };
}

export async function unmatchLine(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const { lineId } = z.object({ lineId: z.string().uuid() }).parse(raw);
  const { line } = await requireLine(ctx, scope, lineId);
  await ctx.db.query('DELETE FROM app.bank_matches WHERE org_id = $1 AND line_id = $2', [scope.org.id, line.id]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'bank.unmatch', target: line.id });
  return { lineId: line.id };
}

async function matchOne(ctx: Ctx, scope: OrgScope, lineId: string, entryId: string, amountMinor: bigint) {
  await ctx.db.query('INSERT INTO app.bank_matches (id, org_id, line_id, entry_id, amount_minor, matched_by) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), scope.org.id, lineId, entryId, amountMinor.toString(), scope.actor.actorId]);
}

// ---------- Creating from a bank line ----------

const CreateBase = z.object({ lineId: z.string().uuid(), amount: AMOUNT_TEXT.optional() });
export const CreateInput = z.discriminatedUnion('kind', [
  CreateBase.extend({ kind: z.literal('receipt'), customerId: z.string().uuid().optional(), allocateTo: z.string().uuid().optional(), receiptKind: z.enum(['payment', 'retainer']).default('payment'), reference: z.string().trim().max(120).optional() }),
  CreateBase.extend({ kind: z.literal('expense'), expense: z.record(z.string(), z.unknown()) }),
  CreateBase.extend({
    kind: z.literal('entry'), targetAccount: ACCOUNT_CODE, description: z.string().trim().min(1).max(200), flag: z.string().trim().max(120).default(''),
    remember: z.string().trim().max(80).optional(),
  }),
]);

/** Turns (what is left of) a bank line into a receipt, an expense or a bank entry, and matches it. */
export async function createFromLine(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = CreateInput.parse(raw);
  const { line, accountCode } = await requireLine(ctx, scope, input.lineId);
  const remaining = BigInt(line.remaining);
  if (remaining === 0n) throw new BusinessRuleError('ALREADY_MATCHED', 'This bank line is already fully matched.');
  const size = input.amount ? amount(input.amount, 'Amount') : remaining < 0n ? -remaining : remaining;
  const signed = remaining < 0n ? -size : size;
  if (size > (remaining < 0n ? -remaining : remaining)) throw new BusinessRuleError('MATCH_AMOUNT', `Only ${formatMinor(remaining < 0n ? -remaining : remaining)} is left on the bank line.`);
  await requireOpenPeriod(ctx, scope, line.date);

  if (input.kind === 'receipt') {
    if (remaining < 0n) throw new BusinessRuleError('WRONG_DIRECTION', 'Money going out cannot be a receipt.');
    const r = await recordReceipt(ctx, scope, {
      ...(input.customerId ? { customerId: input.customerId } : {}), kind: input.receiptKind, receiptDate: line.date, method: line.reference || 'Bank',
      depositAccount: accountCode, amount: formatMinor(size), reference: input.reference ?? line.description.slice(0, 120), ...(input.allocateTo ? { allocateTo: input.allocateTo } : {}),
    });
    await matchOne(ctx, scope, line.id, r.entryId, signed);
    return { kind: 'receipt', id: r.id, number: r.number, entryId: r.entryId };
  }

  if (input.kind === 'expense') {
    if (remaining > 0n) throw new BusinessRuleError('WRONG_DIRECTION', 'Money coming in cannot be an expense.');
    const expense = { ...input.expense, expenseDate: line.date, settlement: 'paid', paidFrom: accountCode, record: true };
    const total = expenseTotalOf(expense);
    if (total !== size) throw new BusinessRuleError('MATCH_AMOUNT', `The expense comes to ${formatMinor(total)}; the bank line is ${formatMinor(size)}.`);
    const e = await createExpense(ctx, scope, expense) as { id: string; number: string | null; entryId: string };
    await matchOne(ctx, scope, line.id, e.entryId, signed);
    return { kind: 'expense', id: e.id, number: e.number, entryId: e.entryId };
  }

  const accounts = await accountsByCode(ctx, scope);
  const bank = requireAccount(accounts, accountCode, 'bank account');
  const target = requireAccount(accounts, input.targetAccount, 'account');
  if (target.accountId === bank.accountId) throw new BusinessRuleError('LINE_ACCOUNT', 'Choose the other side of the entry, not the bank account itself.');
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO app.bank_entries (id, org_id, line_id, account_code, target_account, description, amount_minor, flag, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'recording', $9)`,
    [id, scope.org.id, line.id, accountCode, input.targetAccount, input.description, signed.toString(), input.flag, scope.actor.actorId]);
  const posted = await postBankEntry(ctx, scope, { id, date: line.date, description: input.description, flag: input.flag, amount: signed, reference: line.reference }, bank, target);
  await matchOne(ctx, scope, line.id, posted.entryId, signed);
  if (input.remember) {
    await ctx.db.query(
      `INSERT INTO app.bank_rules (id, org_id, contains_text, target_account, description, flag, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, lower(contains_text)) DO UPDATE SET target_account = $4, description = $5, flag = $6`,
      [randomUUID(), scope.org.id, input.remember, input.targetAccount, input.description, input.flag, scope.actor.actorId]);
  }
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'bank.entry', target: id, detail: { line: line.id, account: input.targetAccount, amount: signed.toString(), entryId: posted.entryId } });
  return { kind: 'entry', id, entryId: posted.entryId };
}

async function postBankEntry(ctx: Ctx, scope: OrgScope, e: { id: string; date: string; description: string; flag: string; amount: bigint; reference: string }, bank: AccountView, target: AccountView) {
  const value = e.amount < 0n ? -e.amount : e.amount;
  const moneyIn = e.amount > 0n;
  const posted = await postForDocument(ctx, scope, {
    sourceType: 'bank-entry', sourceId: e.id, date: e.date, reference: e.reference.slice(0, 60) || 'BANK',
    description: `Bank: ${e.description}`,
    lines: [
      { account: moneyIn ? bank : target, side: 'debit', amount: value, memo: e.flag || e.description },
      { account: moneyIn ? target : bank, side: 'credit', amount: value, memo: e.description },
    ],
  });
  await ctx.db.query(`UPDATE app.bank_entries SET status = 'recorded', entry_id = $3 WHERE org_id = $1 AND id = $2`, [scope.org.id, e.id, posted.entryId]);
  return posted;
}

/** Finishes bank entries interrupted after they were saved, posting each once, and matches them. */
export async function completePendingBank(ctx: Ctx, scope: OrgScope): Promise<number> {
  const pending = (await ctx.db.query<{ id: string; line_id: string; account_code: string; target_account: string; description: string; flag: string; amount: string; date: string; reference: string }>(
    `SELECT e.id, e.line_id, e.account_code, e.target_account, e.description, e.flag, e.amount_minor::text AS amount, to_char(l.txn_date, 'YYYY-MM-DD') AS date, l.reference
     FROM app.bank_entries e JOIN app.bank_lines l ON l.id = e.line_id WHERE e.org_id = $1 AND e.status = 'recording'`, [scope.org.id])).rows;
  if (!pending.length) return 0;
  const accounts = await accountsByCode(ctx, scope);
  for (const p of pending) {
    const posted = await postBankEntry(ctx, scope, { id: p.id, date: p.date, description: p.description, flag: p.flag, amount: BigInt(p.amount), reference: p.reference },
      requireAccount(accounts, p.account_code, 'bank account'), requireAccount(accounts, p.target_account, 'account'));
    const has = await ctx.db.query('SELECT 1 FROM app.bank_matches WHERE org_id = $1 AND entry_id = $2', [scope.org.id, posted.entryId]);
    if (!has.rowCount) await matchOne(ctx, scope, p.line_id, posted.entryId, BigInt(p.amount));
  }
  return pending.length;
}

export async function deleteRule(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(raw);
  const r = await ctx.db.query('DELETE FROM app.bank_rules WHERE org_id = $1 AND id = $2', [scope.org.id, ruleId]);
  if (!r.rowCount) throw new BusinessRuleError('RULE_NOT_FOUND', 'Rule not found.');
  return { ruleId };
}

/** Flags on bank entries (e.g. payroll register needed), for the "needs attention" list. */
export async function flaggedEntries(db: Pick<Db, 'query'>, orgId: string) {
  return (await db.query<{ id: string; description: string; flag: string; amount: string; entry_id: string; date: string }>(
    `SELECT e.id, e.description, e.flag, e.amount_minor::text AS amount, e.entry_id, to_char(l.txn_date, 'YYYY-MM-DD') AS date
     FROM app.bank_entries e JOIN app.bank_lines l ON l.id = e.line_id WHERE e.org_id = $1 AND e.flag <> '' AND e.status = 'recorded' ORDER BY l.txn_date`, [orgId])).rows;
}

// ---------- Reconciliation ----------

export interface Reconciliation {
  accountCode: string; periodEnd: string; covered: boolean;
  statementBalance: string; ledgerBalance: string;
  notOnStatement: { entryId: string; date: string; description: string; amount: string }[];
  notEntered: { lineId: string; date: string; description: string; amount: string }[];
  adjustedStatement: string; adjustedLedger: string; difference: string;
  saved: { status: 'complete' | 'signed_off'; completedAt: string; signedAt: string | null; changed: boolean } | null;
}

/** Works out the reconciliation at a date, from the statement lines, the ledger and the matches. */
export async function reconciliation(ctx: Ctx, scope: OrgScope, accountCode: string, periodEnd: string): Promise<Reconciliation> {
  const bank = await bankAccount(ctx, scope, accountCode);
  const statements = (await ctx.db.query<{ opening: string; first: string; last: string }>(
    `SELECT opening_minor::text AS opening, to_char(first_date, 'YYYY-MM-DD') AS first, to_char(last_date, 'YYYY-MM-DD') AS last FROM app.bank_statements WHERE org_id = $1 AND account_code = $2 ORDER BY first_date`,
    [scope.org.id, accountCode])).rows;
  if (!statements.length) throw new BusinessRuleError('NO_STATEMENT', 'Import a bank statement first.');
  const all = await lines(ctx.db, scope.org.id, accountCode);
  const upTo = all.filter((l) => l.date <= periodEnd);
  const statementBalance = BigInt(statements[0]!.opening) + upTo.reduce((t, l) => t + BigInt(l.amount), 0n);
  const ledger = await ledgerBalance(ctx, scope, bank, periodEnd);
  const items = await ledgerItems(ctx, scope, bank, periodEnd);
  const entryDate = new Map(items.map((i) => [i.entryId, i.date]));
  // Ledger items to the date with no bank line on or before it.
  const notOnStatement = items.filter((i) => !i.lineDate || i.lineDate > periodEnd).map((i) => ({ entryId: i.entryId, date: i.date, description: i.description, amount: i.amount }));
  // Bank lines to the date, less what is matched to entries on or before it.
  const notEntered = upTo.map((l) => {
    const entered = l.matches.filter((m) => (entryDate.get(m.entryId) ?? '9999') <= periodEnd).reduce((t, m) => t + BigInt(m.amount), 0n);
    return { lineId: l.id, date: l.date, description: l.description, amount: (BigInt(l.amount) - entered).toString() };
  }).filter((l) => l.amount !== '0');
  const adjustedStatement = statementBalance + notOnStatement.reduce((t, i) => t + BigInt(i.amount), 0n);
  const adjustedLedger = ledger + notEntered.reduce((t, l) => t + BigInt(l.amount), 0n);
  const saved = (await ctx.db.query<{ status: 'complete' | 'signed_off'; completed_at: string; signed_at: string | null; fingerprint: string }>(
    `SELECT status, completed_at::text, signed_at::text, fingerprint FROM app.bank_reconciliations WHERE org_id = $1 AND account_code = $2 AND period_end = $3`, [scope.org.id, accountCode, periodEnd])).rows[0];
  const rec: Reconciliation = {
    accountCode, periodEnd, covered: statements[statements.length - 1]!.last >= periodEnd || all.some((l) => l.date >= periodEnd),
    statementBalance: statementBalance.toString(), ledgerBalance: ledger.toString(), notOnStatement, notEntered,
    adjustedStatement: adjustedStatement.toString(), adjustedLedger: adjustedLedger.toString(), difference: (adjustedStatement - adjustedLedger).toString(), saved: null,
  };
  if (saved) rec.saved = { status: saved.status, completedAt: saved.completed_at, signedAt: saved.signed_at, changed: saved.fingerprint !== fingerprint(rec) };
  return rec;
}

function fingerprint(r: Reconciliation): string {
  const core = { s: r.statementBalance, l: r.ledgerBalance, o: r.notOnStatement.map((i) => [i.entryId, i.amount]), n: r.notEntered.map((i) => [i.lineId, i.amount]) };
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

export const ReconcileInput = z.object({ accountCode: ACCOUNT_CODE, periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** The accountant completes the month: the statement must cover it and both sides must agree. */
export async function completeReconciliation(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = ReconcileInput.parse(raw);
  const r = await reconciliation(ctx, scope, input.accountCode, input.periodEnd);
  if (r.saved?.status === 'signed_off') throw new BusinessRuleError('RECONCILED', 'This reconciliation is already signed off.');
  if (!r.covered) throw new BusinessRuleError('STATEMENT_SHORT', `The statement does not reach ${input.periodEnd}. Import the rest of it first.`);
  if (r.difference !== '0') throw new BusinessRuleError('NOT_RECONCILED', `The two sides differ by ${formatMinor(r.difference)}. Match or enter the remaining lines first.`);
  await ctx.db.query(
    `INSERT INTO app.bank_reconciliations (id, org_id, account_code, period_end, status, snapshot, fingerprint, completed_by) VALUES ($1, $2, $3, $4, 'complete', $5, $6, $7)
     ON CONFLICT (org_id, account_code, period_end) DO UPDATE SET snapshot = $5, fingerprint = $6, completed_by = $7, completed_at = now()`,
    [randomUUID(), scope.org.id, input.accountCode, input.periodEnd, JSON.stringify({ ...r, saved: null }), fingerprint(r), scope.actor.actorId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'bank.reconcile', detail: { account: input.accountCode, periodEnd: input.periodEnd, statement: r.statementBalance } });
  return { status: 'complete', statementBalance: formatMinor(r.statementBalance), adjusted: formatMinor(r.adjustedStatement) };
}

/** The reviewer signs off a completed reconciliation, if nothing has changed since; lines to that date are then locked. */
export async function signOffReconciliation(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = ReconcileInput.parse(raw);
  const r = await reconciliation(ctx, scope, input.accountCode, input.periodEnd);
  if (!r.saved) throw new BusinessRuleError('NOT_COMPLETE', 'The accountant has not completed this reconciliation yet.');
  if (r.saved.status === 'signed_off') return { status: 'signed_off' };
  if (r.saved.changed) throw new BusinessRuleError('RECONCILIATION_CHANGED', 'Something has changed since the reconciliation was completed. Ask the accountant to complete it again.');
  const done = await ctx.db.query(
    `UPDATE app.bank_reconciliations SET status = 'signed_off', signed_by = $4, signed_at = now() WHERE org_id = $1 AND account_code = $2 AND period_end = $3 AND status = 'complete' AND completed_by <> $4`,
    [scope.org.id, input.accountCode, input.periodEnd, scope.actor.actorId]);
  if (!done.rowCount) throw new BusinessRuleError('SAME_PERSON', 'The person who completed the reconciliation cannot sign it off.');
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'bank.sign-off', detail: { account: input.accountCode, periodEnd: input.periodEnd } });
  return { status: 'signed_off' };
}
