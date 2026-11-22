import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PeriodView } from '@governedai-labs/bookkeeping-runtime';
import type { Db } from '../db/db.ts';
import type { OrgScope } from '../http/middleware.ts';
import { formatMinor } from '../domain/money.ts';
import { audit } from '../audit.ts';
import { BusinessRuleError } from './rule-error.ts';
import { ISO_DATE, accountsByCode, postForDocument, requireAccount, requireOpenPeriod, type Ctx } from './documents.ts';
import { completePending, controlCheck, getSettings, receiptSummaries } from './receivables.ts';
import { completePendingPayables, expenseSummaries, getPayableSettings, payablesControl } from './payables.ts';
import { completePendingBank } from './banking.ts';

/**
 * Month-end close (Slice 5). The accountant runs the checklist and asks for the close, giving a reason for
 * each warning; a reviewer (not the same person) approves it, which closes the Bookkeeping period so nothing
 * more can be posted into the month. A reviewer can reopen a closed month with a reason.
 */

export interface ChecklistItem {
  code: string; label: string; level: 'ok' | 'block' | 'warn'; detail: string[];
}

async function period(ctx: Ctx, scope: OrgScope, periodId: string): Promise<PeriodView> {
  const p = (await ctx.ledger.listPeriods(scope.actor)).find((x) => x.periodId === periodId);
  if (!p) throw new BusinessRuleError('PERIOD_NOT_FOUND', 'Period not found.');
  return p;
}

/** Works out the checklist for a month. Finishes any interrupted documents first, so they do not block. */
export async function checklist(ctx: Ctx, scope: OrgScope, p: PeriodView): Promise<ChecklistItem[]> {
  const orgId = scope.org.id;
  const { startDate: start, endDate: end } = p;
  await completePending(ctx, scope);
  await completePendingPayables(ctx, scope);
  await completePendingBank(ctx, scope);
  const items: ChecklistItem[] = [];
  const add = (code: string, label: string, problems: string[], level: 'block' | 'warn') =>
    items.push({ code, label, level: problems.length ? level : 'ok', detail: problems });

  // Blocks ---------------------------------------------------------------------------------------------

  const banks = (await ctx.db.query<{ account_code: string; lines: string }>(
    `SELECT account_code, COUNT(*)::text AS lines FROM app.bank_lines WHERE org_id = $1 AND txn_date BETWEEN $2 AND $3 GROUP BY account_code ORDER BY account_code`, [orgId, start, end])).rows;
  const signed = new Set((await ctx.db.query<{ account_code: string }>(
    `SELECT account_code FROM app.bank_reconciliations WHERE org_id = $1 AND status = 'signed_off' AND period_end >= $2`, [orgId, end])).rows.map((r) => r.account_code));
  add('bank', 'Bank reconciliation signed off', banks.filter((b) => !signed.has(b.account_code)).map((b) => `Account ${b.account_code}: reconciliation to ${end} not signed off.`), 'block');

  const rs = await getSettings(ctx.db, orgId);
  if (rs?.set_up_at) {
    const c = await controlCheck(ctx, scope, rs);
    add('receivables', `Customers agree with account ${c.account}`, c.difference === '0' ? [] : [`Customers ${formatMinor(c.subledger)}, account ${formatMinor(c.ledger)}: difference ${formatMinor(c.difference)}.`], 'block');
  }
  const ps = await getPayableSettings(ctx.db, orgId);
  if (ps?.set_up_at) {
    const c = await payablesControl(ctx, scope, ps);
    add('payables', `Suppliers agree with account ${c.account}`, c.difference === '0' ? [] : [`Suppliers ${formatMinor(c.subledger)}, account ${formatMinor(c.ledger)}: difference ${formatMinor(c.difference)}.`], 'block');
  }

  const journals = (await ctx.db.query<{ description: string; status: string; date: string }>(
    `SELECT description, status, to_char(entry_date, 'YYYY-MM-DD') AS date FROM app.journals
     WHERE org_id = $1 AND entry_date BETWEEN $2 AND $3 AND status IN ('draft', 'submitted', 'returned', 'approved') ORDER BY entry_date`, [orgId, start, end])).rows;
  add('journals', 'Journals all posted or discarded', journals.map((j) => `${j.date} ${j.description} (${j.status})`), 'block');

  const half = (await ctx.db.query<{ what: string; n: string }>(
    `SELECT 'fee note' AS what, COUNT(*)::text AS n FROM app.fee_notes WHERE org_id = $1 AND status = 'issuing' AND issue_date BETWEEN $2 AND $3
     UNION ALL SELECT 'receipt', COUNT(*)::text FROM app.receipts WHERE org_id = $1 AND status = 'recording' AND receipt_date BETWEEN $2 AND $3
     UNION ALL SELECT 'credit note', COUNT(*)::text FROM app.credit_notes WHERE org_id = $1 AND status = 'issuing' AND credit_date BETWEEN $2 AND $3
     UNION ALL SELECT 'expense', COUNT(*)::text FROM app.expenses WHERE org_id = $1 AND status IN ('recording', 'cancelling') AND expense_date BETWEEN $2 AND $3
     UNION ALL SELECT 'supplier payment', COUNT(*)::text FROM app.supplier_payments WHERE org_id = $1 AND status = 'recording' AND payment_date BETWEEN $2 AND $3`,
    [orgId, start, end])).rows.filter((r) => r.n !== '0');
  add('half-posted', 'No documents half-posted', half.map((r) => `${r.n} ${r.what}${r.n === '1' ? '' : 's'} could not finish posting.`), 'block');

  // Warnings -------------------------------------------------------------------------------------------

  const draftNotes = (await ctx.db.query<{ date: string; matter_ref: string }>(
    `SELECT to_char(issue_date, 'YYYY-MM-DD') AS date, matter_ref FROM app.fee_notes WHERE org_id = $1 AND status = 'draft' AND issue_date BETWEEN $2 AND $3`, [orgId, start, end])).rows;
  const expenses = (await expenseSummaries(ctx.db, orgId)).filter((e) => e.date >= start && e.date <= end && e.state !== 'cancelled');
  add('drafts', 'No drafts dated in the month', [
    ...draftNotes.map((n) => `Draft fee note dated ${n.date}${n.matter_ref ? ` (${n.matter_ref})` : ''}`),
    ...expenses.filter((e) => e.state === 'draft').map((e) => `Draft expense dated ${e.date}: ${e.supplierName} – ${e.description}`),
  ], 'warn');

  const unidentified = (await receiptSummaries(ctx.db, orgId)).filter((r) => r.unidentified && r.available !== '0' && r.date <= end);
  add('unidentified', 'No unidentified receipts', unidentified.map((r) => `${r.number} ${r.date}: ${formatMinor(r.available)} ${r.reference}`), 'warn');

  const flagged = expenses.filter((e) => e.state !== 'draft' && e.flags.some((f) => f.code !== 'waiting'));
  add('expense-flags', 'Expenses complete (receipts on file, matters known)', flagged.map((e) => `${e.number} ${e.supplierName}: ${e.flags.map((f) => f.label).join('; ')}`), 'warn');

  const bankFlags = (await ctx.db.query<{ description: string; flag: string; amount: string }>(
    `SELECT e.description, e.flag, e.amount_minor::text AS amount FROM app.bank_entries e JOIN app.bank_lines l ON l.id = e.line_id
     WHERE e.org_id = $1 AND e.flag <> '' AND e.status = 'recorded' AND l.txn_date BETWEEN $2 AND $3`, [orgId, start, end])).rows;
  add('bank-flags', 'Bank entries complete', bankFlags.map((b) => `${b.description} (${formatMinor(b.amount.replace('-', ''))}): ${b.flag}`), 'warn');

  return items;
}

interface CloseRow {
  id: string; period_id: string; status: 'requested' | 'closing' | 'closed' | 'reopened'; checklist: ChecklistItem[];
  acknowledgements: { code: string; reason: string }[]; requested_by: string | null; requested_at: string; approved_by: string | null; approved_at: string | null;
}

async function liveClose(db: Pick<Db, 'query'>, orgId: string, periodId: string): Promise<CloseRow | null> {
  return (await db.query<CloseRow>(
    `SELECT id, period_id, status, checklist, acknowledgements, requested_by, requested_at::text, approved_by, approved_at::text
     FROM app.period_closes WHERE org_id = $1 AND period_id = $2 AND status <> 'reopened'`, [orgId, periodId])).rows[0] ?? null;
}

/** The month-end screen: every month with its state and close, and the checklist for the chosen one. */
export async function monthEnd(ctx: Ctx, scope: OrgScope, periodId?: string) {
  const periods = (await ctx.ledger.listPeriods(scope.actor)).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const closes = (await ctx.db.query<CloseRow & { reopen_reason: string; reopened_at: string | null }>(
    `SELECT id, period_id, status, checklist, acknowledgements, requested_by, requested_at::text, approved_by, approved_at::text, reopen_reason, reopened_at::text
     FROM app.period_closes WHERE org_id = $1 ORDER BY requested_at`, [scope.org.id])).rows;
  const names = await userNames(ctx.db, closes.flatMap((c) => [c.requested_by, c.approved_by]).filter((x): x is string => Boolean(x)));
  const list = periods.map((p) => {
    const live = closes.find((c) => c.period_id === p.periodId && c.status !== 'reopened') ?? null;
    return {
      ...p, close: live && { status: live.status, requestedBy: names.get(live.requested_by ?? '') ?? '', requestedAt: live.requested_at, approvedBy: names.get(live.approved_by ?? '') ?? '', approvedAt: live.approved_at, acknowledgements: live.acknowledgements },
      reopened: closes.filter((c) => c.period_id === p.periodId && c.status === 'reopened').map((c) => ({ reason: c.reopen_reason, at: c.reopened_at })),
    };
  });
  const chosen = list.find((p) => p.periodId === periodId) ?? list.find((p) => p.state === 'open') ?? list[list.length - 1];
  const items = chosen && chosen.state === 'open' ? await checklist(ctx, scope, chosen) : [];
  return { periods: list, periodId: chosen?.periodId ?? null, checklist: items };
}

async function userNames(db: Pick<Db, 'query'>, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const r = await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM app.users WHERE id = ANY($1)', [ids]);
  return new Map(r.rows.map((u) => [u.id, u.display_name]));
}

export const RequestCloseInput = z.object({
  periodId: z.string().min(1).max(100),
  acknowledgements: z.array(z.object({ code: z.string().min(1).max(40), reason: z.string().trim().min(1, 'Give a reason').max(500) })).max(20).default([]),
});

/** The accountant asks to close a month: nothing may block it, and every warning needs a reason. */
export async function requestClose(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = RequestCloseInput.parse(raw);
  const p = await period(ctx, scope, input.periodId);
  if (p.state !== 'open') throw new BusinessRuleError('PERIOD_NOT_OPEN', 'This month is already closed.');
  const earlier = (await ctx.ledger.listPeriods(scope.actor)).filter((x) => x.state === 'open' && x.startDate < p.startDate);
  if (earlier.length) throw new BusinessRuleError('CLOSE_IN_ORDER', `Close ${earlier[0]!.startDate.slice(0, 7)} first.`);
  const items = await checklist(ctx, scope, p);
  const blocks = items.filter((i) => i.level === 'block');
  if (blocks.length) throw new BusinessRuleError('CLOSE_BLOCKED', `This month cannot be closed yet: ${blocks.map((b) => b.label.toLowerCase()).join('; ')}.`, { blocks });
  const missing = items.filter((i) => i.level === 'warn' && !input.acknowledgements.some((a) => a.code === i.code));
  if (missing.length) throw new BusinessRuleError('ACKNOWLEDGEMENT_NEEDED', `Give a reason for closing with: ${missing.map((m) => m.label.toLowerCase()).join('; ')}.`, { missing: missing.map((m) => m.code) });
  const acknowledgements = input.acknowledgements.filter((a) => items.some((i) => i.level === 'warn' && i.code === a.code));
  const live = await liveClose(ctx.db, scope.org.id, p.periodId);
  if (live && live.status !== 'requested') throw new BusinessRuleError('CLOSE_IN_PROGRESS', 'This month is already being closed.');
  if (live) {
    await ctx.db.query(`UPDATE app.period_closes SET checklist = $3, acknowledgements = $4, requested_by = $5, requested_at = now() WHERE org_id = $1 AND id = $2`,
      [scope.org.id, live.id, JSON.stringify(items), JSON.stringify(acknowledgements), scope.actor.actorId]);
  } else {
    await ctx.db.query(
      `INSERT INTO app.period_closes (id, org_id, period_id, start_date, end_date, status, checklist, acknowledgements, requested_by) VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7, $8)`,
      [randomUUID(), scope.org.id, p.periodId, p.startDate, p.endDate, JSON.stringify(items), JSON.stringify(acknowledgements), scope.actor.actorId]);
  }
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'period.request-close', target: p.periodId, detail: { month: p.startDate.slice(0, 7), acknowledgements } });
  return { periodId: p.periodId, status: 'requested' };
}

/** A reviewer approves the close: the checklist must still pass, then the Bookkeeping period is closed. */
export async function approveClose(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const { periodId } = z.object({ periodId: z.string().min(1).max(100) }).parse(raw);
  const p = await period(ctx, scope, periodId);
  let live = await liveClose(ctx.db, scope.org.id, periodId);
  if (!live) throw new BusinessRuleError('NOT_REQUESTED', 'The accountant has not asked to close this month.');
  if (live.status === 'closed') return { periodId, status: 'closed' };
  if (live.requested_by === scope.actor.actorId) throw new BusinessRuleError('SAME_PERSON', 'The person who asked to close the month cannot approve it.');
  if (live.status === 'requested') {
    const blocks = (await checklist(ctx, scope, p)).filter((i) => i.level === 'block');
    if (blocks.length) throw new BusinessRuleError('CLOSE_BLOCKED', `Something changed since the close was requested: ${blocks.map((b) => b.label.toLowerCase()).join('; ')}.`, { blocks });
    await ctx.db.query(`UPDATE app.period_closes SET status = 'closing', approved_by = $3 WHERE org_id = $1 AND id = $2 AND status = 'requested'`, [scope.org.id, live.id, scope.actor.actorId]);
    live = { ...live, status: 'closing' };
  }
  if (p.state === 'open') await ctx.ledger.closePeriod(scope.actor, p.periodId, `close:${live.id}`);
  await ctx.db.query(`UPDATE app.period_closes SET status = 'closed', approved_at = now() WHERE org_id = $1 AND id = $2`, [scope.org.id, live.id]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'period.approve-close', target: periodId, detail: { month: p.startDate.slice(0, 7) } });
  return { periodId, status: 'closed' };
}

/** A reviewer reopens a closed month, latest first, with a reason. */
export async function reopenMonth(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const { periodId, reason } = z.object({ periodId: z.string().min(1).max(100), reason: z.string().trim().min(1, 'Give a reason').max(500) }).parse(raw);
  const p = await period(ctx, scope, periodId);
  if (p.state !== 'closed') throw new BusinessRuleError('PERIOD_NOT_CLOSED', 'This month is not closed.');
  const later = (await ctx.ledger.listPeriods(scope.actor)).filter((x) => x.state === 'closed' && x.startDate > p.startDate);
  if (later.length) throw new BusinessRuleError('REOPEN_IN_ORDER', `Reopen ${later[later.length - 1]!.startDate.slice(0, 7)} first.`);
  const live = await liveClose(ctx.db, scope.org.id, periodId);
  await ctx.ledger.reopenPeriod(scope.actor, p.periodId, reason, `reopen:${p.periodId}:${p.reopenCount + 1}`);
  if (live) {
    await ctx.db.query(`UPDATE app.period_closes SET status = 'reopened', reopened_by = $3, reopened_at = now(), reopen_reason = $4 WHERE org_id = $1 AND id = $2`,
      [scope.org.id, live.id, scope.actor.actorId, reason]);
  }
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'period.reopen', target: periodId, detail: { month: p.startDate.slice(0, 7), reason } });
  return { periodId, status: 'open' };
}

// ---------- GCT return working ----------

export interface GctLine { date: string; reference: string; party: string; base: string; gct: string; kind: 'fee-note' | 'credit-note' | 'expense' | 'cancellation' }

/**
 * The month's GCT working, on documents dated in the month: output GCT on fee notes less credit notes; input
 * GCT claimed on expenses with a receipt on file, less cancellations. GCT not claimed is shown for information.
 */
export async function gctWorking(db: Pick<Db, 'query'>, orgId: string, start: string, end: string) {
  const output: GctLine[] = [
    ...(await db.query<GctLine>(
      `SELECT to_char(f.issue_date, 'YYYY-MM-DD') AS date, f.number AS reference, c.name AS party, f.fees_minor::text AS base, f.gct_minor::text AS gct, 'fee-note' AS kind
       FROM app.fee_notes f JOIN app.customers c ON c.id = f.customer_id WHERE f.org_id = $1 AND f.status = 'issued' AND NOT f.brought_forward AND f.issue_date BETWEEN $2 AND $3`, [orgId, start, end])).rows,
    ...(await db.query<GctLine>(
      `SELECT to_char(n.credit_date, 'YYYY-MM-DD') AS date, n.number AS reference, c.name AS party, (-n.fees_minor)::text AS base, (-n.gct_minor)::text AS gct, 'credit-note' AS kind
       FROM app.credit_notes n JOIN app.fee_notes f ON f.id = n.fee_note_id JOIN app.customers c ON c.id = f.customer_id
       WHERE n.org_id = $1 AND n.status = 'issued' AND n.credit_date BETWEEN $2 AND $3`, [orgId, start, end])).rows,
  ].sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
  const input: GctLine[] = [
    ...(await db.query<GctLine>(
      `SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS date, e.number AS reference, s.name AS party, e.net_minor::text AS base, e.gct_minor::text AS gct, 'expense' AS kind
       FROM app.expenses e JOIN app.suppliers s ON s.id = e.supplier_id
       WHERE e.org_id = $1 AND NOT e.brought_forward AND e.status IN ('recorded', 'cancelling', 'cancelled') AND e.gct_minor <> 0 AND e.expense_date BETWEEN $2 AND $3`, [orgId, start, end])).rows,
    ...(await db.query<GctLine>(
      `SELECT to_char(e.cancel_date, 'YYYY-MM-DD') AS date, e.number AS reference, s.name AS party, (-e.net_minor)::text AS base, (-e.gct_minor)::text AS gct, 'cancellation' AS kind
       FROM app.expenses e JOIN app.suppliers s ON s.id = e.supplier_id
       WHERE e.org_id = $1 AND e.status = 'cancelled' AND e.gct_minor <> 0 AND e.cancel_date BETWEEN $2 AND $3`, [orgId, start, end])).rows,
  ].sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
  const notClaimed = (await db.query<{ date: string; reference: string; party: string; gct: string }>(
    `SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS date, e.number AS reference, s.name AS party,
       (SELECT COALESCE(SUM((l->>'gct')::bigint), 0) FROM jsonb_array_elements(e.lines) l)::text AS gct
     FROM app.expenses e JOIN app.suppliers s ON s.id = e.supplier_id
     WHERE e.org_id = $1 AND e.status = 'recorded' AND NOT e.receipt_on_file AND e.expense_date BETWEEN $2 AND $3`, [orgId, start, end])).rows.filter((r) => r.gct !== '0');
  const sum = (xs: { gct: string }[]) => xs.reduce((t, x) => t + BigInt(x.gct), 0n);
  const filed = (await db.query<{ filed_on: string; reference: string; output: string; input: string; net: string; entry_id: string | null; status: string }>(
    `SELECT to_char(filed_on, 'YYYY-MM-DD') AS filed_on, reference, output_minor::text AS output, input_minor::text AS input, net_minor::text AS net, entry_id, status
     FROM app.gct_returns WHERE org_id = $1 AND period_start = $2`, [orgId, start])).rows[0] ?? null;
  const out = sum(output); const inp = sum(input);
  return { start, end, output, input, notClaimed, outputTotal: out.toString(), inputTotal: inp.toString(), net: (out - inp).toString(), filed };
}

export const FileGctInput = z.object({ periodStart: ISO_DATE, periodEnd: ISO_DATE, filedOn: ISO_DATE, reference: z.string().trim().max(120).default('') });

/**
 * Marks a month's GCT return filed. Posts Dr GCT payable / Cr input GCT for the input claimed, dated the
 * filing date, so GCT payable then shows the net amount due to TAJ.
 */
export async function fileGctReturn(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = FileGctInput.parse(raw);
  if (input.filedOn < input.periodEnd) throw new BusinessRuleError('FILED_ON', 'The return cannot be filed before the end of the month it covers.');
  const rs = await getSettings(ctx.db, scope.org.id); const ps = await getPayableSettings(ctx.db, scope.org.id);
  if (!rs?.set_up_at || !ps?.set_up_at) throw new BusinessRuleError('NOT_SET_UP', 'Receivables and expenses must be set up first.');
  const w = await gctWorking(ctx.db, scope.org.id, input.periodStart, input.periodEnd);
  if (w.filed?.status === 'filed') throw new BusinessRuleError('ALREADY_FILED', `This return was marked filed on ${w.filed.filed_on}.`);
  await requireOpenPeriod(ctx, scope, input.filedOn);
  const accounts = await accountsByCode(ctx, scope);
  const payable = requireAccount(accounts, rs.gct_account, 'GCT payable');
  const recoverable = requireAccount(accounts, ps.input_gct_account, 'input GCT');
  const id = w.filed ? (await ctx.db.query<{ id: string }>('SELECT id FROM app.gct_returns WHERE org_id = $1 AND period_start = $2', [scope.org.id, input.periodStart])).rows[0]!.id : randomUUID();
  if (!w.filed) {
    await ctx.db.query(
      `INSERT INTO app.gct_returns (id, org_id, period_start, period_end, output_minor, input_minor, net_minor, filed_on, reference, status, filed_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'filing', $10)`,
      [id, scope.org.id, input.periodStart, input.periodEnd, w.outputTotal, w.inputTotal, w.net, input.filedOn, input.reference, scope.actor.actorId]);
  }
  let entryId: string | null = null;
  const inputTotal = BigInt(w.filed?.input ?? w.inputTotal);
  if (inputTotal > 0n) {
    const posted = await postForDocument(ctx, scope, {
      sourceType: 'gct-return', sourceId: id, date: w.filed?.filed_on ?? input.filedOn, reference: `GCT ${input.periodStart.slice(0, 7)}`,
      description: `GCT return ${input.periodStart.slice(0, 7)}: input GCT set against output GCT`,
      lines: [
        { account: payable, side: 'debit', amount: inputTotal, memo: 'Input GCT claimed' },
        { account: recoverable, side: 'credit', amount: inputTotal, memo: `GCT return ${input.periodStart.slice(0, 7)}` },
      ],
    });
    entryId = posted.entryId;
  }
  await ctx.db.query(`UPDATE app.gct_returns SET status = 'filed', entry_id = $3 WHERE org_id = $1 AND id = $2`, [scope.org.id, id, entryId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'gct.file', target: id, detail: { month: input.periodStart.slice(0, 7), output: w.outputTotal, input: w.inputTotal, net: w.net } });
  return { id, entryId, net: formatMinor(w.net) };
}
