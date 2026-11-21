import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountView } from '@governedai-labs/bookkeeping-runtime';
import type { Db } from '../db/db.ts';
import type { OrgScope } from '../http/middleware.ts';
import { formatMinor } from '../domain/money.ts';
import { TAX_CODES, gctOnFees, type TaxCode } from '../country/jm.ts';
import { audit } from '../audit.ts';
import { BusinessRuleError } from './rule-error.ts';
import {
  ACCOUNT_CODE, AMOUNT_TEXT, ISO_DATE, accountsByCode, amount, debitBalance, nextNumber, pad, postForDocument, requireAccount,
  requireOpenPeriod, tx, yearOf, type Client, type Ctx,
} from './documents.ts';

/**
 * Payables and expenses (Slice 3b): suppliers, expenses paid at once or owed, and supplier payments.
 *
 * An expense posts Dr each line's account (net, plus GCT when it cannot be claimed) / Dr input GCT
 * (claimed only with a receipt on file) / Cr the cash account it was paid from, or Cr payables when owed.
 * A supplier payment posts Dr payables / Cr bank and settles owed expenses. A recorded expense is
 * corrected by cancelling it, which posts the reversing entry; both stay in the history.
 */

// ---------- Records ----------

export interface PayableSettings { payable_account: string; input_gct_account: string; disbursement_account: string; set_up_at: string | null }

export interface SupplierRow {
  id: string; org_id: string; kind: 'supplier' | 'brought_forward'; name: string; trn: string; email: string; address: string; status: 'active' | 'inactive';
}

/** Stored line, minor units as strings. */
export interface ExpenseLine { account: string; description: string; net: string; gct: string; taxCode: TaxCode; matterRef: string }

export interface ExpenseRow {
  id: string; org_id: string; supplier_id: string; number: string | null;
  status: 'draft' | 'recording' | 'recorded' | 'discarded' | 'cancelling' | 'cancelled'; brought_forward: boolean;
  expense_date: string; supplier_invoice: string; description: string; settlement: 'paid' | 'owed';
  paid_from: string; payment_method: string; payment_ref: string; receipt_on_file: boolean; foreign_amount: string; notes: string;
  lines: ExpenseLine[]; net_minor: string; gct_minor: string; total_minor: string;
  entry_id: string | null; cancel_date: string | null; cancel_reason: string; cancel_entry_id: string | null;
}

export interface SupplierPaymentRow {
  id: string; org_id: string; supplier_id: string; number: string; status: 'recording' | 'recorded'; payment_date: string;
  paid_from: string; method: string; reference: string; amount_minor: string; entry_id: string | null;
}

const expenseColumns = (p = '') => `${p}id, ${p}org_id, ${p}supplier_id, ${p}number, ${p}status, ${p}brought_forward, to_char(${p}expense_date, 'YYYY-MM-DD') AS expense_date,
  ${p}supplier_invoice, ${p}description, ${p}settlement, ${p}paid_from, ${p}payment_method, ${p}payment_ref, ${p}receipt_on_file, ${p}foreign_amount, ${p}notes, ${p}lines,
  ${p}net_minor::text AS net_minor, ${p}gct_minor::text AS gct_minor, ${p}total_minor::text AS total_minor, ${p}entry_id,
  to_char(${p}cancel_date, 'YYYY-MM-DD') AS cancel_date, ${p}cancel_reason, ${p}cancel_entry_id`;
const EXPENSE_COLUMNS = expenseColumns();
const paymentColumns = (p = '') => `${p}id, ${p}org_id, ${p}supplier_id, ${p}number, ${p}status, to_char(${p}payment_date, 'YYYY-MM-DD') AS payment_date,
  ${p}paid_from, ${p}method, ${p}reference, ${p}amount_minor::text AS amount_minor, ${p}entry_id`;
const PAYMENT_COLUMNS = paymentColumns();
const SUPPLIER_COLUMNS = 'id, org_id, kind, name, trn, email, address, status';

const expenseNumber = (year: number, n: number) => `EX-${String(year).slice(2)}-${pad(n)}`;
const paymentNumber = (year: number, n: number) => `SP-${String(year).slice(2)}-${pad(n)}`;

const isCash = (a: AccountView) => a.type === 'asset' && (a.classification ?? '').startsWith('BS.CA.CASH');

// ---------- Settings and set-up ----------

export async function getPayableSettings(db: Pick<Db, 'query'>, orgId: string): Promise<PayableSettings | null> {
  const r = await db.query<PayableSettings>('SELECT payable_account, input_gct_account, disbursement_account, set_up_at FROM app.payable_settings WHERE org_id = $1', [orgId]);
  return r.rows[0] ?? null;
}

async function requireSetUp(db: Pick<Db, 'query'>, orgId: string): Promise<PayableSettings> {
  const s = await getPayableSettings(db, orgId);
  if (!s?.set_up_at) throw new BusinessRuleError('PAYABLES_NOT_SET_UP', 'Set up expenses for this client first (Expenses › Settings).');
  return s;
}

export const PayableSettingsInput = z.object({ payableAccount: ACCOUNT_CODE, inputGctAccount: ACCOUNT_CODE, disbursementAccount: ACCOUNT_CODE });

/**
 * Saves the posting accounts. The first save sets payables up: it creates the brought-forward supplier
 * and one brought-forward item equal to the control account's balance at the opening date.
 */
export async function savePayableSettings(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = PayableSettingsInput.parse(raw);
  const accounts = await accountsByCode(ctx, scope);
  const ap = requireAccount(accounts, input.payableAccount, 'payables control');
  if (ap.type !== 'liability') throw new BusinessRuleError('ACCOUNT_TYPE', 'The payables control account must be a liability account.');
  const gct = requireAccount(accounts, input.inputGctAccount, 'input GCT');
  if (gct.type !== 'asset' && gct.type !== 'liability') throw new BusinessRuleError('ACCOUNT_TYPE', 'The input GCT account must be a balance sheet account.');
  requireAccount(accounts, input.disbursementAccount, 'rechargeable costs');
  const existing = await getPayableSettings(ctx.db, scope.org.id);
  if (existing?.set_up_at && existing.payable_account !== input.payableAccount) {
    throw new BusinessRuleError('CONTROL_ACCOUNT_LOCKED', 'The payables control account cannot change after set-up.');
  }
  let broughtForward = 0n;
  if (!existing?.set_up_at) {
    const tb = await ctx.ledger.getTrialBalance(scope.actor, scope.org.opening_date);
    const row = tb.rows.find((r) => r.account.accountId === ap.accountId);
    broughtForward = row ? -debitBalance(row.balance.amount, ap) : 0n; // credit-positive: owed to suppliers
  }
  await tx(ctx.db, async (c) => {
    await c.query(
      `INSERT INTO app.payable_settings (org_id, payable_account, input_gct_account, disbursement_account, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE SET input_gct_account = $3, disbursement_account = $4, updated_by = $5, updated_at = now()`,
      [scope.org.id, input.payableAccount, input.inputGctAccount, input.disbursementAccount, scope.actor.actorId]);
    if (!existing?.set_up_at) {
      const bf = randomUUID();
      await c.query(`INSERT INTO app.suppliers (id, org_id, kind, name, created_by) VALUES ($1, $2, 'brought_forward', 'Balances brought forward (pre-system)', $3)`, [bf, scope.org.id, scope.actor.actorId]);
      if (broughtForward !== 0n) {
        await c.query(
          `INSERT INTO app.expenses (id, org_id, supplier_id, number, status, brought_forward, expense_date, description, settlement, total_minor, created_by, recorded_by, recorded_at)
           VALUES ($1, $2, $3, 'B/F', 'recorded', true, $4, 'Owed to suppliers at the opening date', 'owed', $5, $6, $6, now())`,
          [randomUUID(), scope.org.id, bf, scope.org.opening_date, broughtForward.toString(), scope.actor.actorId]);
      }
      await c.query('UPDATE app.payable_settings SET set_up_at = now() WHERE org_id = $1', [scope.org.id]);
    }
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'payables.settings', detail: { setUp: !existing?.set_up_at, broughtForward: broughtForward.toString() } });
  return { setUp: true, broughtForward: formatMinor(broughtForward) };
}

// ---------- Suppliers ----------

export const SupplierInput = z.object({
  name: z.string().trim().min(1).max(200),
  trn: z.string().trim().max(40).default(''),
  email: z.string().trim().max(200).default(''),
  address: z.string().trim().max(500).default(''),
});

export async function getSupplier(db: Pick<Db, 'query'>, orgId: string, id: string): Promise<SupplierRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return (await db.query<SupplierRow>(`SELECT ${SUPPLIER_COLUMNS} FROM app.suppliers WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0] ?? null;
}

export async function createSupplier(ctx: Ctx, scope: OrgScope, raw: unknown) {
  await requireSetUp(ctx.db, scope.org.id);
  const input = SupplierInput.parse(raw);
  const dup = await ctx.db.query('SELECT 1 FROM app.suppliers WHERE org_id = $1 AND lower(name) = lower($2)', [scope.org.id, input.name]);
  if (dup.rowCount) throw new BusinessRuleError('DUPLICATE', `There is already a supplier called ${input.name}.`);
  const id = randomUUID();
  await ctx.db.query('INSERT INTO app.suppliers (id, org_id, name, trn, email, address, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, scope.org.id, input.name, input.trn, input.email, input.address, scope.actor.actorId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'supplier.create', target: id, detail: { name: input.name } });
  return { id, name: input.name };
}

export async function updateSupplier(ctx: Ctx, scope: OrgScope, id: string, raw: unknown) {
  const input = SupplierInput.extend({ status: z.enum(['active', 'inactive']).default('active') }).parse(raw);
  const supplier = await getSupplier(ctx.db, scope.org.id, id);
  if (!supplier || supplier.kind !== 'supplier') throw new BusinessRuleError('SUPPLIER_NOT_FOUND', 'Supplier not found.');
  await ctx.db.query('UPDATE app.suppliers SET name = $3, trn = $4, email = $5, address = $6, status = $7 WHERE org_id = $1 AND id = $2',
    [scope.org.id, id, input.name, input.trn, input.email, input.address, input.status]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'supplier.update', target: id });
  return { id, name: input.name };
}

// ---------- Expenses ----------

const LineInputSchema = z.object({
  account: ACCOUNT_CODE,
  description: z.string().trim().min(1, 'Describe each line').max(300),
  net: AMOUNT_TEXT,
  /** Blank: 15% of net for GCT15 lines (rounded half up); otherwise the amount on the supplier's invoice. */
  gct: z.string().trim().max(30).default(''),
  taxCode: z.enum(['GCT15', 'EXEMPT', 'OUT']).default('GCT15'),
  matterRef: z.string().trim().max(40).default(''),
});

export const ExpenseInput = z.object({
  supplierId: z.string().uuid(),
  expenseDate: ISO_DATE,
  supplierInvoice: z.string().trim().max(60).default(''),
  description: z.string().trim().max(500).default(''),
  settlement: z.enum(['paid', 'owed']).default('paid'),
  paidFrom: z.string().trim().max(20).default(''),
  paymentMethod: z.string().trim().max(60).default(''),
  paymentRef: z.string().trim().max(60).default(''),
  receiptOnFile: z.boolean().default(true),
  foreignAmount: z.string().trim().max(80).default(''),
  notes: z.string().trim().max(500).default(''),
  lines: z.array(LineInputSchema).min(1, 'An expense needs at least one line').max(100),
});

function buildLines(input: z.infer<typeof ExpenseInput>): ExpenseLine[] {
  return input.lines.map((l, i) => {
    const net = amount(l.net, `Line ${i + 1} amount`);
    let gct: bigint;
    if (l.taxCode !== 'GCT15') {
      if (l.gct && l.gct !== '0' && l.gct !== '0.00') throw new BusinessRuleError('GCT_CODE', `Line ${i + 1}: only GCT 15% lines carry GCT.`);
      gct = 0n;
    } else if (l.gct) {
      const parsed = l.gct.trim() === '0' ? 0n : amount(l.gct, `Line ${i + 1} GCT`);
      gct = parsed;
    } else {
      gct = gctOnFees(net);
    }
    return { account: l.account, description: l.description, net: net.toString(), gct: gct.toString(), taxCode: l.taxCode, matterRef: l.matterRef };
  });
}

function totalsOf(lines: ExpenseLine[], receiptOnFile: boolean) {
  const net = lines.reduce((s, l) => s + BigInt(l.net), 0n);
  const gct = lines.reduce((s, l) => s + BigInt(l.gct), 0n);
  return { net, gct, claimed: receiptOnFile ? gct : 0n, total: net + gct };
}

export async function getExpense(db: Pick<Db, 'query'>, orgId: string, id: string): Promise<ExpenseRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return (await db.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM app.expenses WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0] ?? null;
}

async function requireSupplier(db: Pick<Db, 'query'>, orgId: string, id: string): Promise<SupplierRow> {
  const s = await getSupplier(db, orgId, id);
  if (!s || s.kind !== 'supplier') throw new BusinessRuleError('SUPPLIER_NOT_FOUND', 'Choose a supplier.');
  return s;
}

async function rejectDuplicateInvoice(db: Pick<Db, 'query'>, orgId: string, supplierId: string, invoice: string, exceptId?: string) {
  if (!invoice) return;
  const r = await db.query<{ number: string | null }>(
    `SELECT number FROM app.expenses WHERE org_id = $1 AND supplier_id = $2 AND lower(supplier_invoice) = lower($3) AND status NOT IN ('discarded', 'cancelled') AND id <> COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000')`,
    [orgId, supplierId, invoice, exceptId ?? null]);
  if (r.rowCount) throw new BusinessRuleError('DUPLICATE_INVOICE', `Invoice ${invoice} from this supplier is already entered${r.rows[0]!.number ? ` (${r.rows[0]!.number})` : ' as a draft'}.`);
}

/** Saves a draft expense (nothing posted). With record: true, records it straight away. */
export async function createExpense(ctx: Ctx, scope: OrgScope, raw: unknown) {
  await requireSetUp(ctx.db, scope.org.id);
  const { record, ...rest } = z.object({ record: z.boolean().default(false) }).passthrough().parse(raw);
  const input = ExpenseInput.parse(rest);
  await requireSupplier(ctx.db, scope.org.id, input.supplierId);
  await rejectDuplicateInvoice(ctx.db, scope.org.id, input.supplierId, input.supplierInvoice);
  const lines = buildLines(input);
  const t = totalsOf(lines, input.receiptOnFile);
  if (record) {
    // Refuse before saving anything, so a refused "record" leaves no stray draft.
    const settings = await requireSetUp(ctx.db, scope.org.id);
    await postingAccounts(ctx, scope, settings, { lines, settlement: input.settlement, paid_from: input.paidFrom });
    await requireOpenPeriod(ctx, scope, input.expenseDate);
  }
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO app.expenses (id, org_id, supplier_id, status, expense_date, supplier_invoice, description, settlement, paid_from, payment_method, payment_ref,
       receipt_on_file, foreign_amount, notes, lines, net_minor, gct_minor, total_minor, created_by)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [id, scope.org.id, input.supplierId, input.expenseDate, input.supplierInvoice, input.description, input.settlement, input.settlement === 'paid' ? input.paidFrom : '',
      input.paymentMethod, input.paymentRef, input.receiptOnFile, input.foreignAmount, input.notes, JSON.stringify(lines),
      t.net.toString(), t.claimed.toString(), t.total.toString(), scope.actor.actorId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'expense.create', target: id, detail: { total: t.total.toString() } });
  if (record) return recordExpense(ctx, scope, id);
  return { id, number: null as string | null, total: t.total.toString() };
}

export async function updateExpense(ctx: Ctx, scope: OrgScope, id: string, raw: unknown) {
  const input = ExpenseInput.parse(raw);
  const existing = await getExpense(ctx.db, scope.org.id, id);
  if (!existing || existing.status !== 'draft') throw new BusinessRuleError('EXPENSE_STATUS', 'Only draft expenses can be changed.');
  await requireSupplier(ctx.db, scope.org.id, input.supplierId);
  await rejectDuplicateInvoice(ctx.db, scope.org.id, input.supplierId, input.supplierInvoice, id);
  const lines = buildLines(input);
  const t = totalsOf(lines, input.receiptOnFile);
  const r = await ctx.db.query(
    `UPDATE app.expenses SET supplier_id = $3, expense_date = $4, supplier_invoice = $5, description = $6, settlement = $7, paid_from = $8, payment_method = $9,
       payment_ref = $10, receipt_on_file = $11, foreign_amount = $12, notes = $13, lines = $14, net_minor = $15, gct_minor = $16, total_minor = $17
     WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
    [scope.org.id, id, input.supplierId, input.expenseDate, input.supplierInvoice, input.description, input.settlement, input.settlement === 'paid' ? input.paidFrom : '',
      input.paymentMethod, input.paymentRef, input.receiptOnFile, input.foreignAmount, input.notes, JSON.stringify(lines), t.net.toString(), t.claimed.toString(), t.total.toString()]);
  if (!r.rowCount) throw new BusinessRuleError('EXPENSE_CHANGED', 'This expense was changed by someone else. Reload and try again.');
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'expense.update', target: id, detail: { total: t.total.toString() } });
  return { id, total: t.total.toString() };
}

export async function discardExpense(ctx: Ctx, scope: OrgScope, id: string) {
  const r = await ctx.db.query(`UPDATE app.expenses SET status = 'discarded' WHERE org_id = $1 AND id = $2 AND status = 'draft'`, [scope.org.id, id]);
  if (!r.rowCount) throw new BusinessRuleError('EXPENSE_STATUS', 'Only draft expenses can be discarded.');
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'expense.discard', target: id });
  return { id, status: 'discarded' };
}

interface PostingAccounts { lines: AccountView[]; inputGct: AccountView; credit: AccountView }

/** Checks every account the expense posts to; returns them in line order. */
async function postingAccounts(ctx: Ctx, scope: OrgScope, settings: PayableSettings, e: Pick<ExpenseRow, 'lines' | 'settlement' | 'paid_from'>): Promise<PostingAccounts> {
  const accounts = await accountsByCode(ctx, scope);
  const ap = requireAccount(accounts, settings.payable_account, 'payables control');
  const inputGct = requireAccount(accounts, settings.input_gct_account, 'input GCT');
  const lines = e.lines.map((l, i) => {
    const a = requireAccount(accounts, l.account, `line ${i + 1}`);
    if (a.accountId === ap.accountId || a.accountId === inputGct.accountId || isCash(a)) {
      throw new BusinessRuleError('LINE_ACCOUNT', `Line ${i + 1}: account ${l.account} cannot be charged with an expense.`);
    }
    return a;
  });
  let credit = ap;
  if (e.settlement === 'paid') {
    if (!e.paid_from) throw new BusinessRuleError('PAID_FROM', 'Say which account it was paid from.');
    credit = requireAccount(accounts, e.paid_from, 'paid from');
    if (!isCash(credit)) throw new BusinessRuleError('PAID_FROM', `Account ${e.paid_from} is not a cash or bank account.`);
  }
  return { lines, inputGct, credit };
}

/** Records (numbers and posts) a draft expense. Retrying finishes an interrupted one without posting twice. */
export async function recordExpense(ctx: Ctx, scope: OrgScope, id: string) {
  const settings = await requireSetUp(ctx.db, scope.org.id);
  let e = await getExpense(ctx.db, scope.org.id, id);
  if (!e || e.brought_forward) throw new BusinessRuleError('EXPENSE_NOT_FOUND', 'Expense not found.');
  if (e.status === 'recorded') return { id, number: e.number, entryId: e.entry_id };
  if (e.status !== 'draft' && e.status !== 'recording') throw new BusinessRuleError('EXPENSE_STATUS', 'Only draft expenses can be recorded.');
  const supplier = await requireSupplier(ctx.db, scope.org.id, e.supplier_id);
  const accts = await postingAccounts(ctx, scope, settings, e);
  await requireOpenPeriod(ctx, scope, e.expense_date);
  if (e.status === 'draft') {
    await rejectDuplicateInvoice(ctx.db, scope.org.id, e.supplier_id, e.supplier_invoice, id);
    e = await tx(ctx.db, async (c) => {
      const locked = (await c.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM app.expenses WHERE org_id = $1 AND id = $2 FOR UPDATE`, [scope.org.id, id])).rows[0]!;
      if (locked.status !== 'draft') return locked;
      const n = await nextNumber(c, scope.org.id, 'expense', yearOf(locked.expense_date));
      return (await c.query<ExpenseRow>(`UPDATE app.expenses SET status = 'recording', number = $3, recorded_by = $4 WHERE org_id = $1 AND id = $2 RETURNING ${EXPENSE_COLUMNS}`,
        [scope.org.id, id, expenseNumber(yearOf(locked.expense_date), n), scope.actor.actorId])).rows[0]!;
    });
    if (e.status === 'recorded') return { id, number: e.number, entryId: e.entry_id };
  }
  const posted = await postExpense(ctx, scope, e, supplier, accts, false);
  await ctx.db.query(`UPDATE app.expenses SET status = 'recorded', entry_id = $3, recorded_at = now() WHERE org_id = $1 AND id = $2 AND status = 'recording'`,
    [scope.org.id, id, posted.entryId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'expense.record', target: id, detail: { number: e.number, entryId: posted.entryId, total: e.total_minor } });
  return { id, number: e.number, entryId: posted.entryId };
}

/** The expense's journal; reversed swaps every side (used for cancellation). */
function postExpense(ctx: Ctx, scope: OrgScope, e: ExpenseRow, supplier: SupplierRow, a: PostingAccounts, reversed: boolean) {
  const dr = reversed ? 'credit' as const : 'debit' as const;
  const cr = reversed ? 'debit' as const : 'credit' as const;
  const claimed = e.receipt_on_file;
  return postForDocument(ctx, scope, {
    sourceType: reversed ? 'expense-cancellation' : 'expense', sourceId: e.id, date: reversed ? e.cancel_date! : e.expense_date, reference: e.number!,
    description: `${reversed ? 'Cancelled: ' : ''}Expense ${e.number} – ${supplier.name}${e.supplier_invoice ? ` inv ${e.supplier_invoice}` : ''}`,
    lines: [
      ...e.lines.map((l, i) => ({
        account: a.lines[i]!, side: dr, amount: BigInt(l.net) + (claimed ? 0n : BigInt(l.gct)),
        memo: [l.description, l.matterRef ? `matter ${l.matterRef}` : ''].filter(Boolean).join(' – ').slice(0, 200),
      })),
      { account: a.inputGct, side: dr, amount: BigInt(e.gct_minor), memo: 'Input GCT' },
      { account: a.credit, side: cr, amount: BigInt(e.total_minor), memo: e.settlement === 'paid' ? [e.payment_method, e.payment_ref].filter(Boolean).join(' ') || supplier.name : supplier.name },
    ],
  });
}

export const CancelInput = z.object({ cancelDate: ISO_DATE, reason: z.string().trim().min(1, 'Give a reason').max(500) });

/** Cancels a recorded expense by posting the reversing entry. An owed expense must have no payments against it. */
export async function cancelExpense(ctx: Ctx, scope: OrgScope, id: string, raw: unknown) {
  const settings = await requireSetUp(ctx.db, scope.org.id);
  const input = CancelInput.parse(raw);
  let e = await getExpense(ctx.db, scope.org.id, id);
  if (!e || e.brought_forward) throw new BusinessRuleError('EXPENSE_NOT_FOUND', 'Expense not found.');
  if (e.status === 'cancelled') return { id, entryId: e.cancel_entry_id };
  if (e.status !== 'recorded' && e.status !== 'cancelling') throw new BusinessRuleError('EXPENSE_STATUS', 'Only recorded expenses can be cancelled.');
  if (e.status === 'recorded') {
    if (input.cancelDate < e.expense_date) throw new BusinessRuleError('CANCEL_DATE', 'The cancellation cannot be dated before the expense.');
    if (await paidTowards(ctx.db, scope.org.id, id) > 0n) throw new BusinessRuleError('EXPENSE_PAID', 'Payments have been made against this expense; it cannot be cancelled.');
    await requireOpenPeriod(ctx, scope, input.cancelDate);
    e = (await ctx.db.query<ExpenseRow>(
      `UPDATE app.expenses SET status = 'cancelling', cancel_date = $3, cancel_reason = $4 WHERE org_id = $1 AND id = $2 AND status = 'recorded' RETURNING ${EXPENSE_COLUMNS}`,
      [scope.org.id, id, input.cancelDate, input.reason])).rows[0] ?? null;
    if (!e) throw new BusinessRuleError('EXPENSE_CHANGED', 'This expense was changed by someone else. Reload and try again.');
  }
  const supplier = (await getSupplier(ctx.db, scope.org.id, e.supplier_id))!;
  const posted = await postExpense(ctx, scope, e, supplier, await postingAccounts(ctx, scope, settings, e), true);
  await ctx.db.query(`UPDATE app.expenses SET status = 'cancelled', cancel_entry_id = $3 WHERE org_id = $1 AND id = $2 AND status = 'cancelling'`, [scope.org.id, id, posted.entryId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'expense.cancel', target: id, detail: { number: e.number, reason: e.cancel_reason, entryId: posted.entryId } });
  return { id, entryId: posted.entryId };
}

// ---------- Supplier payments ----------

async function paidTowards(db: Pick<Db, 'query'>, orgId: string, expenseId: string): Promise<bigint> {
  const r = await db.query<{ total: string | null }>('SELECT SUM(amount_minor)::text AS total FROM app.payment_allocations WHERE org_id = $1 AND expense_id = $2', [orgId, expenseId]);
  return BigInt(r.rows[0]?.total ?? '0');
}

export const SupplierPaymentInput = z.object({
  supplierId: z.string().uuid(),
  paymentDate: ISO_DATE,
  paidFrom: ACCOUNT_CODE,
  method: z.string().trim().min(1, 'Say how it was paid').max(60),
  reference: z.string().trim().max(120).default(''),
  allocations: z.array(z.object({ expenseId: z.string().uuid(), amount: AMOUNT_TEXT })).min(1, 'Choose what the payment settles').max(100),
});

/** Pays a supplier for owed expenses: posts Dr payables / Cr bank and settles each expense by the amount given. */
export async function recordSupplierPayment(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const settings = await requireSetUp(ctx.db, scope.org.id);
  const input = SupplierPaymentInput.parse(raw);
  const supplier = await getSupplier(ctx.db, scope.org.id, input.supplierId);
  if (!supplier) throw new BusinessRuleError('SUPPLIER_NOT_FOUND', 'Choose a supplier.');
  const accounts = await accountsByCode(ctx, scope);
  const bank = requireAccount(accounts, input.paidFrom, 'paid from');
  if (!isCash(bank)) throw new BusinessRuleError('PAID_FROM', `Account ${input.paidFrom} is not a cash or bank account.`);
  const ap = requireAccount(accounts, settings.payable_account, 'payables control');
  await requireOpenPeriod(ctx, scope, input.paymentDate);
  const parts = input.allocations.map((a, i) => ({ expenseId: a.expenseId, amount: amount(a.amount, `Amount ${i + 1}`) }));
  const total = parts.reduce((s, p) => s + p.amount, 0n);
  const id = randomUUID();
  const payment = await tx(ctx.db, async (c: Client) => {
    for (const p of parts) {
      const e = (await c.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM app.expenses WHERE org_id = $1 AND id = $2 FOR UPDATE`, [scope.org.id, p.expenseId])).rows[0];
      if (!e || e.status !== 'recorded' || e.settlement !== 'owed') throw new BusinessRuleError('EXPENSE_STATUS', 'A payment can only settle recorded expenses owed to the supplier.');
      if (e.supplier_id !== supplier.id) throw new BusinessRuleError('SUPPLIER_MISMATCH', `${e.number} is not from ${supplier.name}.`);
      const outstanding = BigInt(e.total_minor) - await paidTowards(c, scope.org.id, e.id);
      if (p.amount > outstanding) throw new BusinessRuleError('OVER_PAYMENT', `Only ${formatMinor(outstanding)} is owed on ${e.number}.`);
    }
    const n = await nextNumber(c, scope.org.id, 'supplier-payment', yearOf(input.paymentDate));
    const row = (await c.query<SupplierPaymentRow>(
      `INSERT INTO app.supplier_payments (id, org_id, supplier_id, number, status, payment_date, paid_from, method, reference, amount_minor, created_by)
       VALUES ($1, $2, $3, $4, 'recording', $5, $6, $7, $8, $9, $10) RETURNING ${PAYMENT_COLUMNS}`,
      [id, scope.org.id, supplier.id, paymentNumber(yearOf(input.paymentDate), n), input.paymentDate, input.paidFrom, input.method, input.reference, total.toString(), scope.actor.actorId])).rows[0]!;
    for (const p of parts) {
      await c.query('INSERT INTO app.payment_allocations (id, org_id, payment_id, expense_id, amount_minor) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), scope.org.id, id, p.expenseId, p.amount.toString()]);
    }
    return row;
  });
  const posted = await postSupplierPayment(ctx, scope, payment, supplier, bank, ap);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'supplier-payment.record', target: id, detail: { number: payment.number, amount: total.toString() } });
  return { id, number: payment.number, entryId: posted.entryId };
}

async function postSupplierPayment(ctx: Ctx, scope: OrgScope, p: SupplierPaymentRow, supplier: SupplierRow, bank: AccountView, ap: AccountView) {
  const value = BigInt(p.amount_minor);
  const posted = await postForDocument(ctx, scope, {
    sourceType: 'supplier-payment', sourceId: p.id, date: p.payment_date, reference: p.number,
    description: `Payment ${p.number} – ${supplier.name}`,
    lines: [
      { account: ap, side: 'debit', amount: value, memo: supplier.name },
      { account: bank, side: 'credit', amount: value, memo: [p.method, p.reference].filter(Boolean).join(' ') },
    ],
  });
  await ctx.db.query(`UPDATE app.supplier_payments SET status = 'recorded', entry_id = $3 WHERE org_id = $1 AND id = $2`, [scope.org.id, p.id, posted.entryId]);
  return posted;
}

/** Finishes expenses, cancellations and payments whose posting was interrupted after their number was taken. */
export async function completePendingPayables(ctx: Ctx, scope: OrgScope): Promise<number> {
  const settings = await getPayableSettings(ctx.db, scope.org.id);
  if (!settings?.set_up_at) return 0;
  const orgId = scope.org.id;
  const recording = (await ctx.db.query<{ id: string }>(`SELECT id FROM app.expenses WHERE org_id = $1 AND status = 'recording'`, [orgId])).rows;
  const cancelling = (await ctx.db.query<{ id: string; cancel_date: string; cancel_reason: string }>(
    `SELECT id, to_char(cancel_date, 'YYYY-MM-DD') AS cancel_date, cancel_reason FROM app.expenses WHERE org_id = $1 AND status = 'cancelling'`, [orgId])).rows;
  const payments = (await ctx.db.query<SupplierPaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM app.supplier_payments WHERE org_id = $1 AND status = 'recording'`, [orgId])).rows;
  for (const e of recording) await recordExpense(ctx, scope, e.id);
  for (const e of cancelling) await cancelExpense(ctx, scope, e.id, { cancelDate: e.cancel_date, reason: e.cancel_reason });
  if (payments.length) {
    const accounts = await accountsByCode(ctx, scope);
    const ap = requireAccount(accounts, settings.payable_account, 'payables control');
    for (const p of payments) {
      await postSupplierPayment(ctx, scope, p, (await getSupplier(ctx.db, orgId, p.supplier_id))!, requireAccount(accounts, p.paid_from, 'paid from'), ap);
    }
  }
  return recording.length + cancelling.length + payments.length;
}

// ---------- Read models ----------

export interface ExpenseFlag { code: 'no-receipt' | 'matter' | 'waiting'; label: string }

function flagsOf(e: Pick<ExpenseRow, 'status' | 'receipt_on_file' | 'lines' | 'brought_forward'>, disbursementAccount: string): ExpenseFlag[] {
  if (e.brought_forward) return [];
  const flags: ExpenseFlag[] = [];
  if (e.status === 'draft') flags.push({ code: 'waiting', label: 'Draft – not yet recorded' });
  if (!e.receipt_on_file) flags.push({ code: 'no-receipt', label: 'No receipt on file – GCT not claimed' });
  if (e.lines.some((l) => l.account === disbursementAccount && !l.matterRef)) flags.push({ code: 'matter', label: 'Rechargeable – matter to be identified' });
  return flags;
}

export interface ExpenseSummary {
  id: string; number: string | null; status: ExpenseRow['status']; broughtForward: boolean; date: string;
  supplierId: string; supplierName: string; supplierInvoice: string; description: string; settlement: 'paid' | 'owed';
  paidFrom: string; paymentRef: string; net: string; gct: string; total: string; outstanding: string;
  state: 'draft' | 'paid' | 'owed' | 'part-paid' | 'settled' | 'cancelled' | 'recording'; flags: ExpenseFlag[];
}

export async function expenseSummaries(db: Pick<Db, 'query'>, orgId: string, supplierId?: string): Promise<ExpenseSummary[]> {
  const settings = await getPayableSettings(db, orgId);
  const r = await db.query<ExpenseRow & { supplier_name: string; paid: string }>(
    `SELECT ${expenseColumns('e.')},
       s.name AS supplier_name, COALESCE((SELECT SUM(amount_minor) FROM app.payment_allocations a WHERE a.expense_id = e.id), 0)::text AS paid
     FROM app.expenses e JOIN app.suppliers s ON s.id = e.supplier_id
     WHERE e.org_id = $1 AND e.status <> 'discarded' AND ($2::uuid IS NULL OR e.supplier_id = $2)
     ORDER BY e.expense_date DESC, e.number DESC NULLS FIRST`, [orgId, supplierId ?? null]);
  return r.rows.map((e) => {
    const owedLeft = e.settlement === 'owed' && e.status === 'recorded' ? BigInt(e.total_minor) - BigInt(e.paid) : 0n;
    const state: ExpenseSummary['state'] = e.status === 'draft' ? 'draft' : e.status === 'cancelled' || e.status === 'cancelling' ? 'cancelled'
      : e.status === 'recording' ? 'recording' : e.settlement === 'paid' ? 'paid' : owedLeft === 0n ? 'settled' : BigInt(e.paid) > 0n ? 'part-paid' : 'owed';
    return {
      id: e.id, number: e.number, status: e.status, broughtForward: e.brought_forward, date: e.expense_date, supplierId: e.supplier_id, supplierName: e.supplier_name,
      supplierInvoice: e.supplier_invoice, description: e.brought_forward ? e.description : (e.description || e.lines[0]?.description || ''),
      settlement: e.settlement, paidFrom: e.paid_from, paymentRef: e.payment_ref, net: e.net_minor, gct: e.gct_minor, total: e.total_minor,
      outstanding: owedLeft.toString(), state, flags: flagsOf(e, settings?.disbursement_account ?? ''),
    };
  });
}

export async function supplierPayments(db: Pick<Db, 'query'>, orgId: string, supplierId?: string) {
  const r = await db.query<SupplierPaymentRow & { supplier_name: string }>(
    `SELECT ${paymentColumns('p.')}, s.name AS supplier_name
     FROM app.supplier_payments p JOIN app.suppliers s ON s.id = p.supplier_id
     WHERE p.org_id = $1 AND ($2::uuid IS NULL OR p.supplier_id = $2) ORDER BY p.payment_date DESC, p.number DESC`, [orgId, supplierId ?? null]);
  return r.rows.map((p) => ({ id: p.id, number: p.number, date: p.payment_date, supplierId: p.supplier_id, supplierName: p.supplier_name, paidFrom: p.paid_from,
    method: p.method, reference: p.reference, amount: p.amount_minor, entryId: p.entry_id }));
}

export interface SupplierBalance { id: string; name: string; kind: SupplierRow['kind']; trn: string; status: string; owed: string; spent: string }

/** Per supplier: still owed, and spent this year (recorded expenses, gross). */
export async function supplierBalances(db: Pick<Db, 'query'>, orgId: string, year: number): Promise<SupplierBalance[]> {
  const suppliers = (await db.query<SupplierRow>(`SELECT ${SUPPLIER_COLUMNS} FROM app.suppliers WHERE org_id = $1 ORDER BY kind DESC, name`, [orgId])).rows;
  const expenses = await expenseSummaries(db, orgId);
  return suppliers.map((s) => {
    const mine = expenses.filter((e) => e.supplierId === s.id);
    const owed = mine.reduce((t, e) => t + BigInt(e.outstanding), 0n);
    const spent = mine.filter((e) => !e.broughtForward && (e.state === 'paid' || e.state === 'owed' || e.state === 'part-paid' || e.state === 'settled') && yearOf(e.date) === year)
      .reduce((t, e) => t + BigInt(e.total), 0n);
    return { id: s.id, name: s.name, kind: s.kind, trn: s.trn, status: s.status, owed: owed.toString(), spent: spent.toString() };
  });
}

/** Supplier sub-ledger total against the payables control account (credit-positive). */
export async function payablesControl(ctx: Ctx, scope: OrgScope, settings: PayableSettings) {
  const expenses = await expenseSummaries(ctx.db, scope.org.id);
  const subledger = expenses.reduce((t, e) => t + BigInt(e.outstanding), 0n);
  const accounts = await accountsByCode(ctx, scope);
  const ap = requireAccount(accounts, settings.payable_account, 'payables control');
  const tb = await ctx.ledger.getTrialBalance(scope.actor);
  const row = tb.rows.find((r) => r.account.accountId === ap.accountId);
  const ledger = row ? -debitBalance(row.balance.amount, ap) : 0n;
  return { account: settings.payable_account, subledger: subledger.toString(), ledger: ledger.toString(), difference: (ledger - subledger).toString() };
}

/** Everything the expense workspace shows. */
export async function expenseDetail(db: Pick<Db, 'query'>, orgId: string, e: ExpenseRow) {
  const settings = await getPayableSettings(db, orgId);
  const supplier = (await getSupplier(db, orgId, e.supplier_id))!;
  const payments = (await db.query<{ id: string; number: string; date: string; amount: string; entry_id: string | null }>(
    `SELECT p.id, p.number, to_char(p.payment_date, 'YYYY-MM-DD') AS date, a.amount_minor::text AS amount, p.entry_id
     FROM app.payment_allocations a JOIN app.supplier_payments p ON p.id = a.payment_id WHERE a.org_id = $1 AND a.expense_id = $2 ORDER BY p.payment_date`, [orgId, e.id])).rows;
  const paid = payments.reduce((t, p) => t + BigInt(p.amount), 0n);
  const t = totalsOf(e.lines, e.receipt_on_file);
  return {
    expense: {
      id: e.id, number: e.number, status: e.status, broughtForward: e.brought_forward, date: e.expense_date, supplierId: e.supplier_id,
      supplierInvoice: e.supplier_invoice, description: e.description, settlement: e.settlement, paidFrom: e.paid_from, paymentMethod: e.payment_method,
      paymentRef: e.payment_ref, receiptOnFile: e.receipt_on_file, foreignAmount: e.foreign_amount, notes: e.notes,
      lines: e.lines, net: e.net_minor, gctClaimed: e.gct_minor, gctNotClaimed: (t.gct - t.claimed).toString(), total: e.total_minor,
      entryId: e.entry_id, cancelDate: e.cancel_date, cancelReason: e.cancel_reason, cancelEntryId: e.cancel_entry_id,
    },
    supplier: { id: supplier.id, name: supplier.name, trn: supplier.trn },
    payments: payments.map((p) => ({ id: p.id, number: p.number, date: p.date, amount: p.amount, entryId: p.entry_id })),
    outstanding: e.settlement === 'owed' && e.status === 'recorded' ? (BigInt(e.total_minor) - paid).toString() : '0',
    flags: flagsOf(e, settings?.disbursement_account ?? ''),
  };
}

export const EXPENSE_TAX_CODES = TAX_CODES.map((t) => (t.code === 'OUT' ? { ...t, label: 'Outside scope / no GCT' } : t));

/** The total an expense input would record (net + GCT), without saving anything. */
export function expenseTotalOf(raw: unknown): bigint {
  const { record: _record, ...rest } = z.object({ record: z.boolean().optional() }).passthrough().parse(raw);
  const input = ExpenseInput.parse(rest);
  return totalsOf(buildLines(input), input.receiptOnFile).total;
}
