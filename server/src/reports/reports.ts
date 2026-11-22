import type { OrgScope } from '../http/middleware.ts';
import type { Ctx } from '../services/documents.ts';
import { debitBalance } from '../services/documents.ts';
import { ageing, feeNoteDetail, getFeeNote } from '../services/receivables.ts';
import { supplierBalances } from '../services/payables.ts';
import { gctWorking } from '../services/month-end.ts';
import { BusinessRuleError } from '../services/rule-error.ts';
import { money, type Table } from './export.ts';

/** Report tables for PDF and Excel export (Slice 5). Statements are built in export.ts from the runtime's statement. */

const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const entity = (scope: OrgScope) => scope.org.legal_name || scope.org.name;

export async function trialBalanceTable(ctx: Ctx, scope: OrgScope, asOf: string): Promise<Table> {
  const tb = await ctx.ledger.getTrialBalance(scope.actor, asOf);
  let dr = 0n; let cr = 0n;
  const rows = tb.rows.filter((r) => r.balance.amount !== '0')
    .sort((a, b) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true }))
    .map((r) => {
      const v = debitBalance(r.balance.amount, r.account);
      if (v >= 0n) dr += v; else cr -= v;
      return { cells: [`${r.account.code} ${r.account.name}`, v >= 0n ? money(v) : null, v < 0n ? money(-v) : null] };
    });
  return {
    entity: entity(scope), title: 'Trial balance', subtitle: [`${scope.org.currency}, at ${longDate(asOf)}`], fileName: `${entity(scope)} trial balance ${asOf}`,
    columns: [{ label: 'Account' }, { label: 'Debit', money: true }, { label: 'Credit', money: true }],
    rows: [...rows, { cells: ['Total', money(dr), money(cr)], bold: true, rule: true }],
  };
}

export async function gctTable(ctx: Ctx, scope: OrgScope, start: string, end: string): Promise<Table> {
  const w = await gctWorking(ctx.db, scope.org.id, start, end);
  const line = (l: { date: string; reference: string; party: string; base: string; gct: string }) => ({ cells: [`${l.date} ${l.reference} – ${l.party}`, money(l.base), money(l.gct)], indent: 1 });
  return {
    entity: entity(scope), title: 'GCT return working', fileName: `${entity(scope)} GCT working ${start.slice(0, 7)}`,
    subtitle: [`${scope.org.currency}, ${longDate(start)} to ${longDate(end)}`, w.filed ? `Marked filed on ${w.filed.filed_on}${w.filed.reference ? `, ref ${w.filed.reference}` : ''}` : 'Not yet marked filed'],
    columns: [{ label: 'Document' }, { label: 'Net', money: true }, { label: 'GCT', money: true }],
    rows: [
      { cells: ['Output GCT (fee notes less credit notes)', null, null], bold: true },
      ...w.output.map(line),
      { cells: ['Total output GCT', null, money(w.outputTotal)], bold: true, rule: true },
      { cells: ['Input GCT claimed (expenses with a receipt on file)', null, null], bold: true },
      ...w.input.map(line),
      { cells: ['Total input GCT', null, money(w.inputTotal)], bold: true, rule: true },
      { cells: ['Net GCT payable to TAJ', null, money(w.net)], bold: true, rule: true },
      ...(w.notClaimed.length ? [{ cells: ['GCT not claimed (no receipt on file) – for information', null, null], bold: true },
        ...w.notClaimed.map((n) => ({ cells: [`${n.date} ${n.reference} – ${n.party}`, null, money(n.gct)], indent: 1 }))] : []),
    ],
  };
}

export async function agedDebtorsTable(ctx: Ctx, scope: OrgScope, asOf: string): Promise<Table> {
  const a = await ageing(ctx.db, scope.org.id, asOf);
  return {
    entity: entity(scope), title: 'Aged debtors', subtitle: [`${scope.org.currency}, at ${longDate(asOf)}`], fileName: `${entity(scope)} aged debtors ${asOf}`,
    columns: [{ label: 'Customer' }, ...a.buckets.map((b) => ({ label: b.label, money: true, width: 70 })), { label: 'Unallocated', money: true, width: 70 }, { label: 'Owed', money: true, width: 80 }],
    rows: [
      ...a.rows.map((r) => ({ cells: [r.customerName, ...a.buckets.map((b) => money(r.buckets[b.key] ?? '0')), r.unallocated === '0' ? null : money(`-${r.unallocated}`), money(r.total)] })),
      { cells: ['Total', ...a.buckets.map((b) => money(a.totals[b.key] ?? '0')), a.unallocated === '0' ? null : money(`-${a.unallocated}`), money(a.total)], bold: true, rule: true },
    ],
  };
}

export async function supplierBalancesTable(ctx: Ctx, scope: OrgScope, year: number): Promise<Table> {
  const s = await supplierBalances(ctx.db, scope.org.id, year);
  const owed = s.reduce((t, x) => t + BigInt(x.owed), 0n); const spent = s.reduce((t, x) => t + BigInt(x.spent), 0n);
  return {
    entity: entity(scope), title: 'Supplier balances', subtitle: [`${scope.org.currency}; spent in ${year}`], fileName: `${entity(scope)} supplier balances ${year}`,
    columns: [{ label: 'Supplier' }, { label: 'TRN', width: 90 }, { label: 'Owed', money: true }, { label: `Spent ${year}`, money: true }],
    rows: [...s.map((x) => ({ cells: [x.name, x.trn, money(x.owed), money(x.spent)] })), { cells: ['Total', null, money(owed), money(spent)], bold: true, rule: true }],
  };
}

export async function feeNoteTable(ctx: Ctx, scope: OrgScope, feeNoteId: string): Promise<Table> {
  const note = await getFeeNote(ctx.db, scope.org.id, feeNoteId);
  if (!note || note.brought_forward || note.status === 'discarded') throw new BusinessRuleError('NOT_FOUND', 'Fee note not found.');
  const d = await feeNoteDetail(ctx.db, scope.org.id, note);
  const c = d.customer;
  return {
    entity: entity(scope), title: note.status === 'draft' ? 'Draft fee note' : `Fee note ${note.number}`, marking: note.status === 'draft' ? 'DRAFT' : null,
    fileName: `${note.number ?? 'draft'} ${c.name}`,
    subtitle: [
      ...(scope.org.trn ? [`TRN ${scope.org.trn}`] : []), `Date: ${longDate(note.issue_date)}`, `To: ${c.name}${c.trn ? ` (TRN ${c.trn})` : ''}`,
      ...(c.address ? [c.address] : []), ...(note.matter_ref ? [`Matter: ${note.matter_ref}${note.practice_area ? ` – ${note.practice_area}` : ''}`] : []), ...(note.description ? [note.description] : []),
    ],
    columns: [{ label: 'Description' }, { label: 'Tax', width: 70 }, { label: `Amount (${scope.org.currency})`, money: true, width: 110 }],
    rows: [
      ...note.lines.map((l) => ({ cells: [`${l.description}${l.kind === 'disbursement' && !/disbursement/i.test(l.description) ? ' (disbursement)' : ''}`, l.taxCode === 'GCT15' ? 'GCT 15%' : l.taxCode === 'EXEMPT' ? 'Exempt' : '—', money(l.amount)] })),
      { cells: ['Professional fees', null, money(note.fees_minor)], rule: true },
      { cells: ['GCT at 15%', null, money(note.gct_minor)] },
      { cells: ['Disbursements', null, money(note.disbursements_minor)] },
      { cells: ['Total due', null, money(note.total_minor)], bold: true, rule: true },
      ...(note.status === 'issued' ? [{ cells: ['Outstanding', null, money(d.outstanding)] }] : []),
    ],
  };
}
