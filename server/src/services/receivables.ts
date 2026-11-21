import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountView, EntryView } from '@governedai-labs/bookkeeping-runtime';
import type { Db } from '../db/db.ts';
import type { LedgerGateway } from '../ledger/gateway.ts';
import type { OrgScope } from '../http/middleware.ts';
import { formatMinor } from '../domain/money.ts';
import { DEFAULT_TAX_CODE, TAX_CODES, gctFor, gctOnFees, type TaxCode } from '../country/jm.ts';
import { audit } from '../audit.ts';
import { BusinessRuleError } from './rule-error.ts';
import {
  ACCOUNT_CODE, AMOUNT_TEXT, ISO_DATE, accountsByCode, amount, debitBalance, nextNumber, pad, postForDocument, requireAccount, requireOpenPeriod, tx, yearOf, type Ctx,
} from './documents.ts';

/**
 * Receivables (Slice 3a): customers, fee notes with GCT, receipts, allocations, retainers and
 * credit notes. The Bookkeeping runtime holds every posting; these records hold the documents and
 * the entry_id each posted. Balances are derived from documents, and the control account check
 * compares them with the ledger.
 *
 * Every posting uses ledger request IDs derived from the document, so a retried call posts once.
 */


// ---------- Records ----------

export interface Settings {
  receivable_account: string;
  gct_account: string;
  disbursement_account: string;
  retainer_account: string;
  set_up_at: string | null;
}

export interface CustomerRow {
  id: string; org_id: string; kind: 'customer' | 'brought_forward' | 'unidentified';
  name: string; trn: string; email: string; address: string; status: 'active' | 'inactive';
}

export interface FeeNoteLine { kind: 'fee' | 'disbursement'; description: string; amount: string; taxCode: TaxCode }

export interface FeeNoteRow {
  id: string; org_id: string; customer_id: string; number: string | null;
  status: 'draft' | 'issuing' | 'issued' | 'discarded'; brought_forward: boolean;
  issue_date: string; matter_ref: string; practice_area: string; description: string; lines: FeeNoteLine[];
  fees_minor: string; gct_minor: string; disbursements_minor: string; total_minor: string;
  entry_id: string | null; created_by: string | null; issued_by: string | null; issued_at: string | null;
}

export interface ReceiptRow {
  id: string; org_id: string; customer_id: string; number: string | null; kind: 'payment' | 'retainer';
  status: 'recording' | 'recorded'; receipt_date: string; method: string; deposit_account: string;
  amount_minor: string; reference: string; notes: string; entry_id: string | null;
}

export interface CreditNoteRow {
  id: string; org_id: string; fee_note_id: string; customer_id: string; number: string | null;
  status: 'issuing' | 'issued'; credit_date: string; reason: string;
  fees_minor: string; gct_minor: string; disbursements_minor: string; total_minor: string; entry_id: string | null;
}

const FEE_NOTE_COLUMNS = `id, org_id, customer_id, number, status, brought_forward, to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
  matter_ref, practice_area, description, lines, fees_minor::text, gct_minor::text, disbursements_minor::text, total_minor::text,
  entry_id, created_by, issued_by, issued_at`;
const RECEIPT_COLUMNS = `id, org_id, customer_id, number, kind, status, to_char(receipt_date, 'YYYY-MM-DD') AS receipt_date,
  method, deposit_account, amount_minor::text, reference, notes, entry_id`;
const CREDIT_COLUMNS = `id, org_id, fee_note_id, customer_id, number, status, to_char(credit_date, 'YYYY-MM-DD') AS credit_date,
  reason, fees_minor::text, gct_minor::text, disbursements_minor::text, total_minor::text, entry_id`;

// ---------- Helpers ----------

const feeNoteNumber = (year: number, n: number) => `FN-${year}-${pad(n)}`;
const receiptNumber = (year: number, n: number) => `RC-${String(year).slice(2)}-${pad(n)}`;
const creditNoteNumber = (year: number, n: number) => `CN-${year}-${pad(n)}`;

export async function getSettings(db: Pick<Db, 'query'>, orgId: string): Promise<Settings | null> {
  const r = await db.query<Settings>(
    'SELECT receivable_account, gct_account, disbursement_account, retainer_account, set_up_at FROM app.receivable_settings WHERE org_id = $1', [orgId]);
  return r.rows[0] ?? null;
}

async function requireSetUp(db: Db, orgId: string): Promise<Settings> {
  const s = await getSettings(db, orgId);
  if (!s?.set_up_at) throw new BusinessRuleError('RECEIVABLES_NOT_SET_UP', 'Set up receivables for this client first (Receivables › Settings).');
  return s;
}

// ---------- Settings and set-up ----------

export const SettingsInput = z.object({
  receivableAccount: ACCOUNT_CODE,
  gctAccount: ACCOUNT_CODE,
  disbursementAccount: ACCOUNT_CODE,
  retainerAccount: ACCOUNT_CODE,
  practiceAreas: z.array(z.object({ name: z.string().trim().min(1).max(60), incomeAccount: ACCOUNT_CODE })).min(1).max(40),
});

/**
 * Saves the posting accounts and practice areas. The first save also sets receivables up: it creates
 * the brought-forward and unidentified customers and one brought-forward item equal to the control
 * account's balance at the opening date, so the sub-ledger agrees with the ledger from day one.
 */
export async function saveSettings(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = SettingsInput.parse(raw);
  const accounts = await accountsByCode(ctx, scope);
  const ar = requireAccount(accounts, input.receivableAccount, 'receivables control');
  if (ar.type !== 'asset') throw new BusinessRuleError('ACCOUNT_TYPE', `The receivables control account must be an asset account.`);
  requireAccount(accounts, input.gctAccount, 'output GCT');
  requireAccount(accounts, input.disbursementAccount, 'disbursements recoverable');
  requireAccount(accounts, input.retainerAccount, 'fees received in advance');
  const names = new Set<string>();
  for (const p of input.practiceAreas) {
    const income = requireAccount(accounts, p.incomeAccount, `income for ${p.name}`);
    if (income.type !== 'income') throw new BusinessRuleError('ACCOUNT_TYPE', `Practice area ${p.name}: account ${p.incomeAccount} is not an income account.`);
    if (names.has(p.name.toLowerCase())) throw new BusinessRuleError('DUPLICATE', `Practice area ${p.name} is listed twice.`);
    names.add(p.name.toLowerCase());
  }
  const existing = await getSettings(ctx.db, scope.org.id);
  if (existing?.set_up_at && existing.receivable_account !== input.receivableAccount) {
    throw new BusinessRuleError('CONTROL_ACCOUNT_LOCKED', 'The receivables control account cannot change after set-up.');
  }
  // The brought-forward amount: control account balance on the opening date (opening balances).
  let broughtForward = 0n;
  if (!existing?.set_up_at) {
    const tb = await ctx.ledger.getTrialBalance(scope.actor, scope.org.opening_date);
    const row = tb.rows.find((r) => r.account.accountId === ar.accountId);
    broughtForward = row ? debitBalance(row.balance.amount, ar) : 0n;
  }
  await tx(ctx.db, async (c) => {
    await c.query(
      `INSERT INTO app.receivable_settings (org_id, receivable_account, gct_account, disbursement_account, retainer_account, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id) DO UPDATE SET gct_account = $3, disbursement_account = $4, retainer_account = $5, updated_by = $6, updated_at = now()`,
      [scope.org.id, input.receivableAccount, input.gctAccount, input.disbursementAccount, input.retainerAccount, scope.actor.actorId]);
    await c.query('DELETE FROM app.practice_areas WHERE org_id = $1', [scope.org.id]);
    for (const p of input.practiceAreas) {
      await c.query('INSERT INTO app.practice_areas (org_id, name, income_account) VALUES ($1, $2, $3)', [scope.org.id, p.name, p.incomeAccount]);
    }
    if (!existing?.set_up_at) {
      const bf = randomUUID();
      await c.query(`INSERT INTO app.customers (id, org_id, kind, name, created_by) VALUES ($1, $2, 'brought_forward', 'Balances brought forward (pre-system)', $3)`, [bf, scope.org.id, scope.actor.actorId]);
      await c.query(`INSERT INTO app.customers (id, org_id, kind, name, created_by) VALUES ($1, $2, 'unidentified', 'Unidentified receipts', $3)`, [randomUUID(), scope.org.id, scope.actor.actorId]);
      if (broughtForward !== 0n) {
        await c.query(
          `INSERT INTO app.fee_notes (id, org_id, customer_id, number, status, brought_forward, issue_date, description, total_minor, created_by, issued_by, issued_at)
           VALUES ($1, $2, $3, 'B/F', 'issued', true, $4, 'Receivables brought forward at the opening date', $5, $6, $6, now())`,
          [randomUUID(), scope.org.id, bf, scope.org.opening_date, broughtForward.toString(), scope.actor.actorId]);
      }
      await c.query('UPDATE app.receivable_settings SET set_up_at = now() WHERE org_id = $1', [scope.org.id]);
    }
  });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'receivables.settings', detail: { setUp: !existing?.set_up_at, broughtForward: broughtForward.toString() } });
  return { setUp: true, broughtForward: formatMinor(broughtForward) };
}

export async function practiceAreas(db: Pick<Db, 'query'>, orgId: string) {
  return (await db.query<{ name: string; income_account: string }>('SELECT name, income_account FROM app.practice_areas WHERE org_id = $1 ORDER BY name', [orgId])).rows;
}

// ---------- Customers ----------

export const CustomerInput = z.object({
  name: z.string().trim().min(1).max(200),
  trn: z.string().trim().max(40).default(''),
  email: z.string().trim().max(200).default(''),
  address: z.string().trim().max(500).default(''),
});

export async function getCustomer(db: Pick<Db, 'query'>, orgId: string, id: string): Promise<CustomerRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const r = await db.query<CustomerRow>('SELECT id, org_id, kind, name, trn, email, address, status FROM app.customers WHERE org_id = $1 AND id = $2', [orgId, id]);
  return r.rows[0] ?? null;
}

export async function createCustomer(ctx: Ctx, scope: OrgScope, raw: unknown) {
  await requireSetUp(ctx.db, scope.org.id);
  const input = CustomerInput.parse(raw);
  const id = randomUUID();
  await ctx.db.query('INSERT INTO app.customers (id, org_id, name, trn, email, address, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, scope.org.id, input.name, input.trn, input.email, input.address, scope.actor.actorId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'customer.create', target: id, detail: { name: input.name } });
  return { id, name: input.name };
}

export async function updateCustomer(ctx: Ctx, scope: OrgScope, id: string, raw: unknown) {
  const customer = await getCustomer(ctx.db, scope.org.id, id);
  if (!customer) throw new BusinessRuleError('CUSTOMER_NOT_FOUND', 'Customer not found.');
  if (customer.kind !== 'customer') throw new BusinessRuleError('SYSTEM_CUSTOMER', 'This is a system account and cannot be edited.');
  const input = CustomerInput.extend({ status: z.enum(['active', 'inactive']).optional() }).parse(raw);
  await ctx.db.query('UPDATE app.customers SET name = $3, trn = $4, email = $5, address = $6, status = COALESCE($7, status) WHERE org_id = $1 AND id = $2',
    [scope.org.id, id, input.name, input.trn, input.email, input.address, input.status ?? null]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'customer.update', target: id });
  return { id, name: input.name };
}

// ---------- Fee notes ----------

export const FeeNoteInput = z.object({
  customerId: z.string().uuid(),
  issueDate: ISO_DATE,
  matterRef: z.string().trim().max(40).default(''),
  practiceArea: z.string().trim().min(1, 'Choose a practice area').max(60),
  description: z.string().trim().max(500).default(''),
  lines: z.array(z.object({
    kind: z.enum(['fee', 'disbursement']),
    description: z.string().trim().min(1, 'Describe each line').max(300),
    amount: AMOUNT_TEXT,
    taxCode: z.enum(['GCT15', 'EXEMPT', 'OUT']).optional(),
  })).min(1, 'A fee note needs at least one line').max(100),
});

function feeNoteTotals(lines: { kind: 'fee' | 'disbursement'; amount: bigint; taxCode: TaxCode }[]) {
  const fees = lines.filter((l) => l.kind === 'fee').reduce((s, l) => s + l.amount, 0n);
  const disbursements = lines.filter((l) => l.kind === 'disbursement').reduce((s, l) => s + l.amount, 0n);
  const gct = gctFor(lines.map((l) => ({ amountMinor: l.amount, taxCode: l.taxCode })));
  return { fees, disbursements, gct, total: fees + disbursements + gct };
}

async function parseFeeNote(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const input = FeeNoteInput.parse(raw);
  const customer = await getCustomer(ctx.db, scope.org.id, input.customerId);
  if (!customer || customer.kind !== 'customer') throw new BusinessRuleError('CUSTOMER_NOT_FOUND', 'Choose a customer.');
  if (customer.status !== 'active') throw new BusinessRuleError('CUSTOMER_INACTIVE', 'This customer is inactive.');
  const areas = await practiceAreas(ctx.db, scope.org.id);
  if (!areas.some((a) => a.name === input.practiceArea)) throw new BusinessRuleError('PRACTICE_AREA', `Unknown practice area ${input.practiceArea}.`);
  const lines = input.lines.map((l, i) => ({
    kind: l.kind, description: l.description, amount: amount(l.amount, `Line ${i + 1}`), taxCode: (l.taxCode ?? DEFAULT_TAX_CODE[l.kind]) as TaxCode,
  }));
  return { input, lines, totals: feeNoteTotals(lines) };
}

const storedLines = (lines: { kind: 'fee' | 'disbursement'; description: string; amount: bigint; taxCode: TaxCode }[]): FeeNoteLine[] =>
  lines.map((l) => ({ kind: l.kind, description: l.description, amount: l.amount.toString(), taxCode: l.taxCode }));

export async function getFeeNote(db: Pick<Db, 'query'>, orgId: string, id: string): Promise<FeeNoteRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const r = await db.query<FeeNoteRow>(`SELECT ${FEE_NOTE_COLUMNS} FROM app.fee_notes WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return r.rows[0] ?? null;
}

export async function createFeeNote(ctx: Ctx, scope: OrgScope, raw: unknown) {
  await requireSetUp(ctx.db, scope.org.id);
  const { input, lines, totals } = await parseFeeNote(ctx, scope, raw);
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO app.fee_notes (id, org_id, customer_id, status, issue_date, matter_ref, practice_area, description, lines,
       fees_minor, gct_minor, disbursements_minor, total_minor, created_by, updated_by)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
    [id, scope.org.id, input.customerId, input.issueDate, input.matterRef, input.practiceArea, input.description, JSON.stringify(storedLines(lines)),
      totals.fees.toString(), totals.gct.toString(), totals.disbursements.toString(), totals.total.toString(), scope.actor.actorId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'fee-note.create', target: id });
  return { id, total: totals.total.toString() };
}

export async function updateFeeNote(ctx: Ctx, scope: OrgScope, id: string, raw: unknown) {
  const note = await getFeeNote(ctx.db, scope.org.id, id);
  if (!note || note.brought_forward) throw new BusinessRuleError('FEE_NOTE_NOT_FOUND', 'Fee note not found.');
  if (note.status !== 'draft') throw new BusinessRuleError('FEE_NOTE_STATUS', 'Only draft fee notes can be edited. Correct an issued fee note with a credit note.');
  const { input, lines, totals } = await parseFeeNote(ctx, scope, raw);
  const r = await ctx.db.query(
    `UPDATE app.fee_notes SET customer_id = $3, issue_date = $4, matter_ref = $5, practice_area = $6, description = $7, lines = $8,
       fees_minor = $9, gct_minor = $10, disbursements_minor = $11, total_minor = $12, updated_by = $13, updated_at = now()
     WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
    [scope.org.id, id, input.customerId, input.issueDate, input.matterRef, input.practiceArea, input.description, JSON.stringify(storedLines(lines)),
      totals.fees.toString(), totals.gct.toString(), totals.disbursements.toString(), totals.total.toString(), scope.actor.actorId]);
  if (!r.rowCount) throw new BusinessRuleError('FEE_NOTE_CHANGED', 'This fee note was changed by someone else. Reload and try again.');
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'fee-note.update', target: id });
  return { id, total: totals.total.toString() };
}

export async function discardFeeNote(ctx: Ctx, scope: OrgScope, id: string) {
  const r = await ctx.db.query(`UPDATE app.fee_notes SET status = 'discarded', updated_by = $3, updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'draft' AND NOT brought_forward`,
    [scope.org.id, id, scope.actor.actorId]);
  if (!r.rowCount) throw new BusinessRuleError('FEE_NOTE_STATUS', 'Only draft fee notes can be discarded.');
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'fee-note.discard', target: id });
  return { id, status: 'discarded' };
}

/**
 * Issues a fee note: checks the period and accounts, takes the next gap-free number, then posts
 * Dr receivables (total) / Cr fee income (practice area) / Cr output GCT / Cr disbursements recoverable.
 * A retry after an interruption keeps the same number and posts once.
 */
export async function issueFeeNote(ctx: Ctx, scope: OrgScope, id: string) {
  const settings = await requireSetUp(ctx.db, scope.org.id);
  let note = await getFeeNote(ctx.db, scope.org.id, id);
  if (!note || note.brought_forward) throw new BusinessRuleError('FEE_NOTE_NOT_FOUND', 'Fee note not found.');
  if (note.status === 'issued') return { id, number: note.number, entryId: note.entry_id };
  if (note.status !== 'draft' && note.status !== 'issuing') throw new BusinessRuleError('FEE_NOTE_STATUS', 'Only draft fee notes can be issued.');
  if (BigInt(note.total_minor) <= 0n) throw new BusinessRuleError('FEE_NOTE_EMPTY', 'The fee note has no amount.');
  const customer = (await getCustomer(ctx.db, scope.org.id, note.customer_id))!;
  const area = (await practiceAreas(ctx.db, scope.org.id)).find((a) => a.name === note!.practice_area);
  if (!area) throw new BusinessRuleError('PRACTICE_AREA', `Practice area ${note.practice_area} is no longer set up.`);
  const accounts = await accountsByCode(ctx, scope);
  const ar = requireAccount(accounts, settings.receivable_account, 'receivables control');
  const income = requireAccount(accounts, area.income_account, 'fee income');
  const gct = requireAccount(accounts, settings.gct_account, 'output GCT');
  const disb = requireAccount(accounts, settings.disbursement_account, 'disbursements recoverable');
  await requireOpenPeriod(ctx, scope, note.issue_date);

  if (note.status === 'draft') {
    note = await tx(ctx.db, async (c) => {
      const locked = (await c.query<FeeNoteRow>(`SELECT ${FEE_NOTE_COLUMNS} FROM app.fee_notes WHERE org_id = $1 AND id = $2 FOR UPDATE`, [scope.org.id, id])).rows[0]!;
      if (locked.status !== 'draft') return locked;
      const n = await nextNumber(c, scope.org.id, 'fee-note', yearOf(locked.issue_date));
      const r = await c.query<FeeNoteRow>(`UPDATE app.fee_notes SET status = 'issuing', number = $3, issued_by = $4 WHERE org_id = $1 AND id = $2 RETURNING ${FEE_NOTE_COLUMNS}`,
        [scope.org.id, id, feeNoteNumber(yearOf(locked.issue_date), n), scope.actor.actorId]);
      return r.rows[0]!;
    });
    if (note.status === 'issued') return { id, number: note.number, entryId: note.entry_id };
  }

  const posted = await postForDocument(ctx, scope, {
    sourceType: 'fee-note', sourceId: id, date: note.issue_date, reference: note.number!,
    description: `Fee note ${note.number} – ${customer.name}${note.matter_ref ? ` (${note.matter_ref})` : ''}`,
    lines: [
      { account: ar, side: 'debit', amount: BigInt(note.total_minor), memo: customer.name },
      { account: income, side: 'credit', amount: BigInt(note.fees_minor), memo: note.practice_area },
      { account: gct, side: 'credit', amount: BigInt(note.gct_minor), memo: 'Output GCT' },
      { account: disb, side: 'credit', amount: BigInt(note.disbursements_minor), memo: 'Disbursements recharged' },
    ],
  });
  await ctx.db.query(`UPDATE app.fee_notes SET status = 'issued', entry_id = $3, issued_at = now() WHERE org_id = $1 AND id = $2 AND status = 'issuing'`,
    [scope.org.id, id, posted.entryId]);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'fee-note.issue', target: id, detail: { number: note.number, entryId: posted.entryId, total: note.total_minor } });
  return { id, number: note.number, entryId: posted.entryId };
}

// ---------- Receipts ----------

export const ReceiptInput = z.object({
  customerId: z.string().uuid().optional(),
  kind: z.enum(['payment', 'retainer']).default('payment'),
  receiptDate: ISO_DATE,
  method: z.string().trim().min(1, 'Say how it was paid').max(60),
  depositAccount: ACCOUNT_CODE,
  amount: AMOUNT_TEXT,
  reference: z.string().trim().max(120).default(''),
  notes: z.string().trim().max(500).default(''),
  /** Optionally allocate straight to one of the customer's fee notes. */
  allocateTo: z.string().uuid().optional(),
});

export async function getReceipt(db: Pick<Db, 'query'>, orgId: string, id: string): Promise<ReceiptRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const r = await db.query<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM app.receipts WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return r.rows[0] ?? null;
}

async function specialCustomer(db: Pick<Db, 'query'>, orgId: string, kind: 'brought_forward' | 'unidentified'): Promise<CustomerRow> {
  const r = await db.query<CustomerRow>('SELECT id, org_id, kind, name, trn, email, address, status FROM app.customers WHERE org_id = $1 AND kind = $2', [orgId, kind]);
  return r.rows[0]!;
}

/**
 * Records money received. A payment posts Dr bank / Cr receivables and can be allocated to fee notes
 * (now or later); a retainer posts Dr bank / Cr fees received in advance until applied. With no
 * customer, the payment is held as unidentified until it is reassigned.
 */
export async function recordReceipt(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const settings = await requireSetUp(ctx.db, scope.org.id);
  const input = ReceiptInput.parse(raw);
  const value = amount(input.amount, 'Amount');
  let customer: CustomerRow | null;
  if (input.customerId) {
    customer = await getCustomer(ctx.db, scope.org.id, input.customerId);
    // Payments of fee notes from before the system settle the brought-forward balance;
    // the payer is named in the reference.
    if (!customer || customer.kind === 'unidentified' || (customer.kind === 'brought_forward' && input.kind !== 'payment')) {
      throw new BusinessRuleError('CUSTOMER_NOT_FOUND', 'Choose a customer.');
    }
  } else {
    if (input.kind === 'retainer') throw new BusinessRuleError('CUSTOMER_REQUIRED', 'A retainer needs a customer.');
    customer = await specialCustomer(ctx.db, scope.org.id, 'unidentified');
  }
  const accounts = await accountsByCode(ctx, scope);
  const bank = requireAccount(accounts, input.depositAccount, 'deposit');
  if (bank.type !== 'asset' || !(bank.classification ?? '').startsWith('BS.CA.CASH')) {
    throw new BusinessRuleError('DEPOSIT_ACCOUNT', `Account ${input.depositAccount} is not a cash or bank account.`);
  }
  const credit = requireAccount(accounts, input.kind === 'retainer' ? settings.retainer_account : settings.receivable_account, input.kind === 'retainer' ? 'fees received in advance' : 'receivables control');
  await requireOpenPeriod(ctx, scope, input.receiptDate);

  const id = randomUUID();
  const receipt = await tx(ctx.db, async (c) => {
    const n = await nextNumber(c, scope.org.id, 'receipt', yearOf(input.receiptDate));
    const r = await c.query<ReceiptRow>(
      `INSERT INTO app.receipts (id, org_id, customer_id, number, kind, status, receipt_date, method, deposit_account, amount_minor, reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, 'recording', $6, $7, $8, $9, $10, $11, $12) RETURNING ${RECEIPT_COLUMNS}`,
      [id, scope.org.id, customer!.id, receiptNumber(yearOf(input.receiptDate), n), input.kind, input.receiptDate, input.method, input.depositAccount,
        value.toString(), input.reference, input.notes, scope.actor.actorId]);
    return r.rows[0]!;
  });
  const posted = await postReceipt(ctx, scope, receipt, customer, bank, credit);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'receipt.record', target: receipt.id, detail: { number: receipt.number, amount: value.toString(), kind: input.kind } });
  let allocated: unknown = null;
  if (input.allocateTo && input.kind === 'payment' && input.customerId) {
    const note = await getFeeNote(ctx.db, scope.org.id, input.allocateTo);
    if (note) {
      const outstanding = await feeNoteOutstanding(ctx.db, scope.org.id, note);
      const amountToAllocate = value < outstanding ? value : outstanding;
      if (amountToAllocate > 0n) allocated = await allocateReceipt(ctx, scope, note.id, { receiptId: receipt.id, amount: formatMinor(amountToAllocate) });
    }
  }
  return { id: receipt.id, number: receipt.number, entryId: posted.entryId, allocated };
}

async function postReceipt(ctx: Ctx, scope: OrgScope, receipt: ReceiptRow, customer: CustomerRow, bank: AccountView, credit: AccountView): Promise<EntryView> {
  const value = BigInt(receipt.amount_minor);
  const posted = await postForDocument(ctx, scope, {
    sourceType: 'receipt', sourceId: receipt.id, date: receipt.receipt_date, reference: receipt.number!,
    description: `Receipt ${receipt.number} – ${customer.name}${receipt.kind === 'retainer' ? ' (retainer)' : ''}`,
    lines: [
      { account: bank, side: 'debit', amount: value, memo: receipt.method },
      { account: credit, side: 'credit', amount: value, memo: customer.name },
    ],
  });
  await ctx.db.query(`UPDATE app.receipts SET status = 'recorded', entry_id = $3 WHERE org_id = $1 AND id = $2`, [scope.org.id, receipt.id, posted.entryId]);
  return posted;
}

/** Moves an unidentified payment to the customer it turned out to be from. No journal: both sit in the control account. */
export async function reassignReceipt(ctx: Ctx, scope: OrgScope, raw: unknown) {
  const { receiptId, customerId } = z.object({ receiptId: z.string().uuid(), customerId: z.string().uuid() }).parse(raw);
  const receipt = await getReceipt(ctx.db, scope.org.id, receiptId);
  const unidentified = await specialCustomer(ctx.db, scope.org.id, 'unidentified');
  if (!receipt || receipt.customer_id !== unidentified.id) throw new BusinessRuleError('RECEIPT_STATUS', 'Only unidentified receipts can be reassigned.');
  const customer = await getCustomer(ctx.db, scope.org.id, customerId);
  if (!customer || customer.kind !== 'customer') throw new BusinessRuleError('CUSTOMER_NOT_FOUND', 'Choose a customer.');
  const r = await ctx.db.query(`UPDATE app.receipts SET customer_id = $3 WHERE org_id = $1 AND id = $2 AND customer_id = $4 AND status = 'recorded'`,
    [scope.org.id, receiptId, customerId, unidentified.id]);
  if (!r.rowCount) throw new BusinessRuleError('RECEIPT_CHANGED', 'This receipt was changed by someone else. Reload and try again.');
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'receipt.reassign', target: receiptId, detail: { customerId } });
  return { id: receiptId, customerId };
}

// ---------- Allocation, retainers, credit notes ----------

async function allocatedTo(db: Pick<Db, 'query'>, orgId: string, feeNoteId: string): Promise<bigint> {
  const r = await db.query<{ total: string | null }>(`SELECT SUM(amount_minor)::text AS total FROM app.allocations WHERE org_id = $1 AND fee_note_id = $2 AND status = 'done'`, [orgId, feeNoteId]);
  return BigInt(r.rows[0]?.total ?? '0');
}

async function allocatedFrom(db: Pick<Db, 'query'>, orgId: string, sourceType: 'receipt' | 'retainer', sourceId: string): Promise<bigint> {
  const r = await db.query<{ total: string | null }>(`SELECT SUM(amount_minor)::text AS total FROM app.allocations WHERE org_id = $1 AND source_type = $2 AND source_id = $3`, [orgId, sourceType, sourceId]);
  return BigInt(r.rows[0]?.total ?? '0');
}

export async function feeNoteOutstanding(db: Pick<Db, 'query'>, orgId: string, note: FeeNoteRow): Promise<bigint> {
  if (note.status !== 'issued') return 0n;
  return BigInt(note.total_minor) - await allocatedTo(db, orgId, note.id);
}

const AllocationInput = z.object({ receiptId: z.string().uuid(), amount: AMOUNT_TEXT });

/** Allocates part or all of a customer's payment to one of their issued fee notes (no journal). */
export async function allocateReceipt(ctx: Ctx, scope: OrgScope, feeNoteId: string, raw: unknown) {
  const input = AllocationInput.parse(raw);
  const value = amount(input.amount, 'Amount');
  return tx(ctx.db, async (c) => {
    const note = (await c.query<FeeNoteRow>(`SELECT ${FEE_NOTE_COLUMNS} FROM app.fee_notes WHERE org_id = $1 AND id = $2 FOR UPDATE`, [scope.org.id, feeNoteId])).rows[0];
    const receipt = (await c.query<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM app.receipts WHERE org_id = $1 AND id = $2 FOR UPDATE`, [scope.org.id, input.receiptId])).rows[0];
    if (!note || note.status !== 'issued') throw new BusinessRuleError('FEE_NOTE_STATUS', 'Only issued fee notes can be settled.');
    if (!receipt || receipt.status !== 'recorded' || receipt.kind !== 'payment') throw new BusinessRuleError('RECEIPT_STATUS', 'Choose a recorded payment.');
    if (receipt.customer_id !== note.customer_id) throw new BusinessRuleError('CUSTOMER_MISMATCH', 'The receipt and the fee note belong to different customers.');
    const outstanding = BigInt(note.total_minor) - await allocatedTo(c, scope.org.id, note.id);
    const available = BigInt(receipt.amount_minor) - await allocatedFrom(c, scope.org.id, 'receipt', receipt.id);
    if (value > outstanding) throw new BusinessRuleError('OVER_ALLOCATION', `Only ${formatMinor(outstanding)} is outstanding on this fee note.`);
    if (value > available) throw new BusinessRuleError('OVER_ALLOCATION', `Only ${formatMinor(available)} of this receipt is unallocated.`);
    const id = randomUUID();
    await c.query(`INSERT INTO app.allocations (id, org_id, fee_note_id, source_type, source_id, amount_minor, allocated_on, created_by) VALUES ($1, $2, $3, 'receipt', $4, $5, $6, $7)`,
      [id, scope.org.id, note.id, receipt.id, value.toString(), receipt.receipt_date, scope.actor.actorId]);
    await audit(c, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'fee-note.allocate', target: note.id, detail: { receipt: receipt.number, amount: value.toString() } });
    return { id, outstanding: (outstanding - value).toString() };
  });
}

/** Applies a retainer held in advance to a fee note: posts Dr fees received in advance / Cr receivables. */
export async function applyRetainer(ctx: Ctx, scope: OrgScope, feeNoteId: string, raw: unknown) {
  const settings = await requireSetUp(ctx.db, scope.org.id);
  const input = AllocationInput.extend({ date: ISO_DATE.optional() }).parse(raw);
  const value = amount(input.amount, 'Amount');
  const accounts = await accountsByCode(ctx, scope);
  const retainerAccount = requireAccount(accounts, settings.retainer_account, 'fees received in advance');
  const ar = requireAccount(accounts, settings.receivable_account, 'receivables control');
  const note = await getFeeNote(ctx.db, scope.org.id, feeNoteId);
  const receipt = await getReceipt(ctx.db, scope.org.id, input.receiptId);
  if (!note || note.status !== 'issued') throw new BusinessRuleError('FEE_NOTE_STATUS', 'Only issued fee notes can be settled.');
  if (!receipt || receipt.kind !== 'retainer') throw new BusinessRuleError('RECEIPT_STATUS', 'Choose a recorded retainer.');
  // Applied on the later of the fee note and the retainer, unless a date is given.
  const date = input.date ?? (note.issue_date > receipt.receipt_date ? note.issue_date : receipt.receipt_date);
  await requireOpenPeriod(ctx, scope, date);
  const allocation = await tx(ctx.db, async (c) => {
    const lockedNote = (await c.query<FeeNoteRow>(`SELECT ${FEE_NOTE_COLUMNS} FROM app.fee_notes WHERE org_id = $1 AND id = $2 FOR UPDATE`, [scope.org.id, feeNoteId])).rows[0]!;
    const lockedReceipt = (await c.query<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM app.receipts WHERE org_id = $1 AND id = $2 FOR UPDATE`, [scope.org.id, input.receiptId])).rows[0];
    if (!lockedReceipt || lockedReceipt.status !== 'recorded' || lockedReceipt.kind !== 'retainer') throw new BusinessRuleError('RECEIPT_STATUS', 'Choose a recorded retainer.');
    if (lockedReceipt.customer_id !== lockedNote.customer_id) throw new BusinessRuleError('CUSTOMER_MISMATCH', 'The retainer and the fee note belong to different customers.');
    const outstanding = BigInt(lockedNote.total_minor) - await allocatedTo(c, scope.org.id, lockedNote.id);
    const available = BigInt(lockedReceipt.amount_minor) - await allocatedFrom(c, scope.org.id, 'retainer', lockedReceipt.id);
    if (value > outstanding) throw new BusinessRuleError('OVER_ALLOCATION', `Only ${formatMinor(outstanding)} is outstanding on this fee note.`);
    if (value > available) throw new BusinessRuleError('OVER_ALLOCATION', `Only ${formatMinor(available)} of this retainer is left.`);
    const id = randomUUID();
    await c.query(`INSERT INTO app.allocations (id, org_id, fee_note_id, source_type, source_id, amount_minor, allocated_on, status, created_by) VALUES ($1, $2, $3, 'retainer', $4, $5, $6, 'posting', $7)`,
      [id, scope.org.id, lockedNote.id, lockedReceipt.id, value.toString(), date, scope.actor.actorId]);
    return { id, note: lockedNote, receipt: lockedReceipt };
  });
  const posted = await postRetainerApplication(ctx, scope, { id: allocation.id, amount: value, date }, note, allocation.receipt, retainerAccount, ar);
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'fee-note.apply-retainer', target: note.id, detail: { retainer: allocation.receipt.number, amount: value.toString(), entryId: posted.entryId } });
  return { id: allocation.id, entryId: posted.entryId };
}

async function postRetainerApplication(ctx: Ctx, scope: OrgScope, a: { id: string; amount: bigint; date: string }, note: FeeNoteRow, receipt: ReceiptRow,
  retainerAccount: AccountView, ar: AccountView): Promise<EntryView> {
  const customer = (await getCustomer(ctx.db, scope.org.id, note.customer_id))!;
  const posted = await postForDocument(ctx, scope, {
    sourceType: 'retainer-application', sourceId: a.id, date: a.date, reference: note.number!,
    description: `Retainer ${receipt.number} applied to fee note ${note.number} – ${customer.name}`,
    lines: [
      { account: retainerAccount, side: 'debit', amount: a.amount, memo: customer.name },
      { account: ar, side: 'credit', amount: a.amount, memo: customer.name },
    ],
  });
  await ctx.db.query(`UPDATE app.allocations SET status = 'done', entry_id = $3 WHERE org_id = $1 AND id = $2`, [scope.org.id, a.id, posted.entryId]);
  return posted;
}

/**
 * Finishes any document whose posting was interrupted after its number was taken (fee note
 * 'issuing', receipt 'recording', credit note 'issuing', retainer application 'posting').
 * Request IDs come from the document, so finishing never posts twice.
 */
export async function completePending(ctx: Ctx, scope: OrgScope): Promise<number> {
  const settings = await getSettings(ctx.db, scope.org.id);
  if (!settings?.set_up_at) return 0;
  const orgId = scope.org.id;
  const notes = (await ctx.db.query<{ id: string }>(`SELECT id FROM app.fee_notes WHERE org_id = $1 AND status = 'issuing'`, [orgId])).rows;
  const receipts = (await ctx.db.query<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM app.receipts WHERE org_id = $1 AND status = 'recording'`, [orgId])).rows;
  const credits = (await ctx.db.query<CreditNoteRow>(`SELECT ${CREDIT_COLUMNS} FROM app.credit_notes WHERE org_id = $1 AND status = 'issuing'`, [orgId])).rows;
  const retainers = (await ctx.db.query<{ id: string; fee_note_id: string; source_id: string; amount_minor: string; allocated_on: string }>(
    `SELECT id, fee_note_id, source_id, amount_minor::text, to_char(allocated_on, 'YYYY-MM-DD') AS allocated_on FROM app.allocations WHERE org_id = $1 AND status = 'posting'`, [orgId])).rows;
  if (!notes.length && !receipts.length && !credits.length && !retainers.length) return 0;
  const accounts = await accountsByCode(ctx, scope);
  const ar = requireAccount(accounts, settings.receivable_account, 'receivables control');
  for (const n of notes) await issueFeeNote(ctx, scope, n.id);
  for (const r of receipts) {
    const customer = (await getCustomer(ctx.db, orgId, r.customer_id))!;
    const credit = requireAccount(accounts, r.kind === 'retainer' ? settings.retainer_account : settings.receivable_account, 'credit');
    await postReceipt(ctx, scope, r, customer, requireAccount(accounts, r.deposit_account, 'deposit'), credit);
  }
  for (const c of credits) {
    const note = (await getFeeNote(ctx.db, orgId, c.fee_note_id))!;
    const area = (await practiceAreas(ctx.db, orgId)).find((a) => a.name === note.practice_area)!;
    await postCreditNote(ctx, scope, c, note, { ar, income: requireAccount(accounts, area.income_account, 'fee income'),
      gctAccount: requireAccount(accounts, settings.gct_account, 'output GCT'), disbAccount: requireAccount(accounts, settings.disbursement_account, 'disbursements') });
  }
  for (const a of retainers) {
    const note = (await getFeeNote(ctx.db, orgId, a.fee_note_id))!;
    const receipt = (await getReceipt(ctx.db, orgId, a.source_id))!;
    await postRetainerApplication(ctx, scope, { id: a.id, amount: BigInt(a.amount_minor), date: a.allocated_on }, note, receipt,
      requireAccount(accounts, settings.retainer_account, 'fees received in advance'), ar);
  }
  return notes.length + receipts.length + credits.length + retainers.length;
}

export const CreditNoteInput = z.object({
  creditDate: ISO_DATE,
  reason: z.string().trim().min(1, 'Give a reason').max(500),
  fees: z.string().trim().max(30).default(''),
  disbursements: z.string().trim().max(30).default(''),
});

/**
 * Credits part or all of an issued fee note: GCT is credited on the credited fees at the standard rate.
 * Posts Dr fee income / Dr output GCT / Dr disbursements recoverable / Cr receivables and settles that
 * much of the fee note.
 */
export async function issueCreditNote(ctx: Ctx, scope: OrgScope, feeNoteId: string, raw: unknown) {
  const settings = await requireSetUp(ctx.db, scope.org.id);
  const input = CreditNoteInput.parse(raw);
  const fees = input.fees ? amount(input.fees, 'Fees') : 0n;
  const disbursements = input.disbursements ? amount(input.disbursements, 'Disbursements') : 0n;
  if (fees + disbursements === 0n) throw new BusinessRuleError('INVALID_AMOUNT', 'Enter the fees and/or disbursements to credit.');
  const note = await getFeeNote(ctx.db, scope.org.id, feeNoteId);
  if (!note || note.status !== 'issued' || note.brought_forward) throw new BusinessRuleError('FEE_NOTE_STATUS', 'Only issued fee notes can be credited.');
  const prior = (await ctx.db.query<{ fees: string | null; disb: string | null; gct: string | null }>(
    `SELECT SUM(fees_minor)::text AS fees, SUM(disbursements_minor)::text AS disb, SUM(gct_minor)::text AS gct FROM app.credit_notes WHERE org_id = $1 AND fee_note_id = $2`,
    [scope.org.id, note.id])).rows[0]!;
  if (fees > BigInt(note.fees_minor) - BigInt(prior.fees ?? '0')) throw new BusinessRuleError('OVER_CREDIT', 'That is more than the fees left to credit on this fee note.');
  if (disbursements > BigInt(note.disbursements_minor) - BigInt(prior.disb ?? '0')) throw new BusinessRuleError('OVER_CREDIT', 'That is more than the disbursements left to credit on this fee note.');
  const gctLeft = BigInt(note.gct_minor) - BigInt(prior.gct ?? '0');
  const gctRaw = BigInt(note.gct_minor) > 0n ? gctOnFees(fees) : 0n;
  const gct = gctRaw > gctLeft ? gctLeft : gctRaw;
  const total = fees + disbursements + gct;
  const outstanding = await feeNoteOutstanding(ctx.db, scope.org.id, note);
  if (total > outstanding) throw new BusinessRuleError('OVER_CREDIT', `Only ${formatMinor(outstanding)} is outstanding; a credit note cannot exceed it.`);
  const area = (await practiceAreas(ctx.db, scope.org.id)).find((a) => a.name === note.practice_area);
  if (!area) throw new BusinessRuleError('PRACTICE_AREA', `Practice area ${note.practice_area} is no longer set up.`);
  const accounts = await accountsByCode(ctx, scope);
  const ar = requireAccount(accounts, settings.receivable_account, 'receivables control');
  const income = requireAccount(accounts, area.income_account, 'fee income');
  const gctAccount = requireAccount(accounts, settings.gct_account, 'output GCT');
  const disbAccount = requireAccount(accounts, settings.disbursement_account, 'disbursements recoverable');
  await requireOpenPeriod(ctx, scope, input.creditDate);
  const credit = await tx(ctx.db, async (c) => {
    const n = await nextNumber(c, scope.org.id, 'credit-note', yearOf(input.creditDate));
    const r = await c.query<CreditNoteRow>(
      `INSERT INTO app.credit_notes (id, org_id, fee_note_id, customer_id, number, status, credit_date, reason, fees_minor, gct_minor, disbursements_minor, total_minor, created_by)
       VALUES ($1, $2, $3, $4, $5, 'issuing', $6, $7, $8, $9, $10, $11, $12) RETURNING ${CREDIT_COLUMNS}`,
      [randomUUID(), scope.org.id, note.id, note.customer_id, creditNoteNumber(yearOf(input.creditDate), n), input.creditDate, input.reason,
        fees.toString(), gct.toString(), disbursements.toString(), total.toString(), scope.actor.actorId]);
    return r.rows[0]!;
  });
  const posted = await postCreditNote(ctx, scope, credit, note, { ar, income, gctAccount, disbAccount });
  await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'fee-note.credit', target: note.id, detail: { creditNote: credit.number, total: total.toString(), reason: input.reason } });
  return { id: credit.id, number: credit.number, total: total.toString(), entryId: posted.entryId };
}

async function postCreditNote(ctx: Ctx, scope: OrgScope, credit: CreditNoteRow, note: FeeNoteRow,
  a: { ar: AccountView; income: AccountView; gctAccount: AccountView; disbAccount: AccountView }): Promise<EntryView> {
  const { ar, income, gctAccount, disbAccount } = a;
  const fees = BigInt(credit.fees_minor); const gct = BigInt(credit.gct_minor);
  const disbursements = BigInt(credit.disbursements_minor); const total = BigInt(credit.total_minor);
  const customer = (await getCustomer(ctx.db, scope.org.id, note.customer_id))!;
  const posted = await postForDocument(ctx, scope, {
    sourceType: 'credit-note', sourceId: credit.id, date: credit.credit_date, reference: credit.number!,
    description: `Credit note ${credit.number} on fee note ${note.number} – ${customer.name}`,
    lines: [
      { account: income, side: 'debit', amount: fees, memo: note.practice_area },
      { account: gctAccount, side: 'debit', amount: gct, memo: 'Output GCT' },
      { account: disbAccount, side: 'debit', amount: disbursements, memo: 'Disbursements' },
      { account: ar, side: 'credit', amount: total, memo: customer.name },
    ],
  });
  await tx(ctx.db, async (c) => {
    const done = await c.query(`UPDATE app.credit_notes SET status = 'issued', entry_id = $3 WHERE org_id = $1 AND id = $2 AND status = 'issuing'`, [scope.org.id, credit.id, posted.entryId]);
    if (done.rowCount) {
      await c.query(`INSERT INTO app.allocations (id, org_id, fee_note_id, source_type, source_id, amount_minor, allocated_on, created_by, entry_id) VALUES ($1, $2, $3, 'credit_note', $4, $5, $6, $7, $8)`,
        [randomUUID(), scope.org.id, note.id, credit.id, total.toString(), credit.credit_date, scope.actor.actorId, posted.entryId]);
    }
  });
  return posted;
}

// ---------- Read models ----------

interface CustomerBalance { id: string; name: string; kind: CustomerRow['kind']; status: string; trn: string; invoiced: string; settled: string; unallocated: string; retainerHeld: string; balance: string }

/** Customer balances from documents: issued fee notes less credit notes, payments and applied retainers. */
export async function customerBalances(db: Pick<Db, 'query'>, orgId: string): Promise<CustomerBalance[]> {
  const r = await db.query<{ id: string; name: string; kind: CustomerRow['kind']; status: string; trn: string; invoiced: string; credited: string; paid: string; applied: string; allocated_payments: string; retainers: string }>(
    `SELECT c.id, c.name, c.kind, c.status, c.trn,
       COALESCE((SELECT SUM(total_minor) FROM app.fee_notes f WHERE f.org_id = c.org_id AND f.customer_id = c.id AND f.status = 'issued'), 0)::text AS invoiced,
       COALESCE((SELECT SUM(total_minor) FROM app.credit_notes n WHERE n.org_id = c.org_id AND n.customer_id = c.id AND n.status = 'issued'), 0)::text AS credited,
       COALESCE((SELECT SUM(amount_minor) FROM app.receipts r WHERE r.org_id = c.org_id AND r.customer_id = c.id AND r.status = 'recorded' AND r.kind = 'payment'), 0)::text AS paid,
       COALESCE((SELECT SUM(a.amount_minor) FROM app.allocations a JOIN app.fee_notes f ON f.id = a.fee_note_id WHERE a.org_id = c.org_id AND f.customer_id = c.id AND a.source_type = 'retainer' AND a.status = 'done'), 0)::text AS applied,
       COALESCE((SELECT SUM(a.amount_minor) FROM app.allocations a JOIN app.receipts r ON r.id = a.source_id WHERE a.org_id = c.org_id AND a.source_type = 'receipt' AND r.customer_id = c.id), 0)::text AS allocated_payments,
       COALESCE((SELECT SUM(amount_minor) FROM app.receipts r WHERE r.org_id = c.org_id AND r.customer_id = c.id AND r.status = 'recorded' AND r.kind = 'retainer'), 0)::text AS retainers
     FROM app.customers c WHERE c.org_id = $1 ORDER BY CASE c.kind WHEN 'customer' THEN 1 ELSE 0 END, c.name`, [orgId]);
  return r.rows.map((row) => {
    const settled = BigInt(row.credited) + BigInt(row.paid) + BigInt(row.applied);
    return {
      id: row.id, name: row.name, kind: row.kind, status: row.status, trn: row.trn,
      invoiced: row.invoiced, settled: settled.toString(),
      unallocated: (BigInt(row.paid) - BigInt(row.allocated_payments)).toString(),
      retainerHeld: (BigInt(row.retainers) - BigInt(row.applied)).toString(),
      balance: (BigInt(row.invoiced) - settled).toString(),
    };
  });
}

/** Sub-ledger total against the control account in the ledger (design pack verification). */
export async function controlCheck(ctx: Ctx, scope: OrgScope, settings: Settings) {
  const subledger = (await customerBalances(ctx.db, scope.org.id)).reduce((s, c) => s + BigInt(c.balance), 0n);
  const accounts = await accountsByCode(ctx, scope);
  const ar = accounts.get(settings.receivable_account);
  let ledger = 0n;
  if (ar) {
    const row = (await ctx.ledger.getTrialBalance(scope.actor)).rows.find((r) => r.account.accountId === ar.accountId);
    ledger = row ? debitBalance(row.balance.amount, ar) : 0n;
  }
  return { account: settings.receivable_account, subledger: subledger.toString(), ledger: ledger.toString(), difference: (ledger - subledger).toString() };
}

export interface FeeNoteSummary {
  id: string; number: string | null; status: string; settlement: string; customerId: string; customerName: string;
  issueDate: string; matterRef: string; practiceArea: string; total: string; outstanding: string; broughtForward: boolean;
}

export async function feeNoteSummaries(db: Pick<Db, 'query'>, orgId: string, customerId?: string): Promise<FeeNoteSummary[]> {
  const r = await db.query<FeeNoteRow & { customer_name: string; allocated: string; credited: string }>(
    `SELECT f.id, f.customer_id, f.number, f.status, f.brought_forward, to_char(f.issue_date, 'YYYY-MM-DD') AS issue_date,
       f.matter_ref, f.practice_area, f.total_minor::text, c.name AS customer_name,
       COALESCE((SELECT SUM(amount_minor) FROM app.allocations a WHERE a.org_id = f.org_id AND a.fee_note_id = f.id AND a.status = 'done'), 0)::text AS allocated,
       COALESCE((SELECT SUM(amount_minor) FROM app.allocations a WHERE a.org_id = f.org_id AND a.fee_note_id = f.id AND a.source_type = 'credit_note'), 0)::text AS credited
     FROM app.fee_notes f JOIN app.customers c ON c.id = f.customer_id
     WHERE f.org_id = $1 AND f.status <> 'discarded' ${customerId ? 'AND f.customer_id = $2' : ''}
     ORDER BY f.issue_date DESC, f.number DESC NULLS FIRST`, customerId ? [orgId, customerId] : [orgId]);
  return r.rows.map((f) => {
    const outstanding = f.status === 'issued' ? BigInt(f.total_minor) - BigInt(f.allocated) : 0n;
    const settlement = f.status !== 'issued' ? f.status
      : outstanding === 0n ? (BigInt(f.credited) === BigInt(f.total_minor) ? 'credited' : 'paid')
      : outstanding < BigInt(f.total_minor) ? 'part-paid' : 'outstanding';
    return {
      id: f.id, number: f.number, status: f.status, settlement, customerId: f.customer_id, customerName: f.customer_name,
      issueDate: f.issue_date, matterRef: f.matter_ref, practiceArea: f.practice_area, total: f.total_minor,
      outstanding: outstanding.toString(), broughtForward: f.brought_forward,
    };
  });
}

export async function receiptSummaries(db: Pick<Db, 'query'>, orgId: string, customerId?: string) {
  const r = await db.query<ReceiptRow & { customer_name: string; customer_kind: string; allocated: string }>(
    `SELECT r.id, r.customer_id, r.number, r.kind, r.status, to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date, r.method, r.deposit_account,
       r.amount_minor::text, r.reference, r.notes, r.entry_id, c.name AS customer_name, c.kind AS customer_kind,
       COALESCE((SELECT SUM(amount_minor) FROM app.allocations a WHERE a.org_id = r.org_id AND a.source_id = r.id), 0)::text AS allocated
     FROM app.receipts r JOIN app.customers c ON c.id = r.customer_id
     WHERE r.org_id = $1 AND r.status = 'recorded' ${customerId ? 'AND r.customer_id = $2' : ''}
     ORDER BY r.receipt_date DESC, r.number DESC`, customerId ? [orgId, customerId] : [orgId]);
  return r.rows.map((x) => ({
    id: x.id, number: x.number, kind: x.kind, date: x.receipt_date, customerId: x.customer_id, customerName: x.customer_name,
    unidentified: x.customer_kind === 'unidentified', method: x.method, depositAccount: x.deposit_account, amount: x.amount_minor,
    available: (BigInt(x.amount_minor) - BigInt(x.allocated)).toString(), reference: x.reference, entryId: x.entry_id,
  }));
}

const BUCKETS = [{ key: 'current', label: '0–30 days', max: 30 }, { key: 'd31', label: '31–60 days', max: 60 }, { key: 'd61', label: '61–90 days', max: 90 }, { key: 'd90', label: 'Over 90 days', max: Infinity }] as const;

/** Outstanding fee notes by age at a date, per customer, with unallocated payments shown separately. */
export async function ageing(db: Pick<Db, 'query'>, orgId: string, asOf: string) {
  const notes = (await feeNoteSummaries(db, orgId)).filter((n) => n.status === 'issued' && n.issueDate <= asOf && BigInt(n.outstanding) !== 0n);
  const receipts = await receiptSummaries(db, orgId);
  const rows = new Map<string, { customerId: string; customerName: string; buckets: Record<string, bigint>; unallocated: bigint }>();
  const row = (id: string, name: string) => {
    if (!rows.has(id)) rows.set(id, { customerId: id, customerName: name, buckets: Object.fromEntries(BUCKETS.map((b) => [b.key, 0n])), unallocated: 0n });
    return rows.get(id)!;
  };
  const days = (date: string) => Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  for (const n of notes) {
    const bucket = BUCKETS.find((b) => days(n.issueDate) <= b.max)!;
    row(n.customerId, n.customerName).buckets[bucket.key]! += BigInt(n.outstanding);
  }
  for (const r of receipts) if (r.kind === 'payment' && r.date <= asOf && BigInt(r.available) > 0n) row(r.customerId, r.customerName).unallocated += BigInt(r.available);
  const list = [...rows.values()].map((r) => {
    const total = Object.values(r.buckets).reduce((s, v) => s + v, 0n) - r.unallocated;
    return { customerId: r.customerId, customerName: r.customerName, buckets: Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, v.toString()])), unallocated: r.unallocated.toString(), total: total.toString() };
  }).sort((a, b) => a.customerName.localeCompare(b.customerName));
  const totals = Object.fromEntries(BUCKETS.map((b) => [b.key, list.reduce((s, r) => s + BigInt(r.buckets[b.key]!), 0n).toString()]));
  return { asOf, buckets: BUCKETS.map(({ key, label }) => ({ key, label })), rows: list, totals,
    unallocated: list.reduce((s, r) => s + BigInt(r.unallocated), 0n).toString(), total: list.reduce((s, r) => s + BigInt(r.total), 0n).toString() };
}

/** A customer's statement: every document in date order with a running balance. */
export async function customerStatement(db: Pick<Db, 'query'>, orgId: string, customerId: string) {
  const r = await db.query<{ date: string; kind: string; ref: string | null; description: string; debit: string; credit: string; doc_id: string; sort: string }>(
    `SELECT to_char(issue_date, 'YYYY-MM-DD') AS date, 'fee-note' AS kind, number AS ref, CASE WHEN brought_forward THEN description ELSE 'Fee note' || CASE WHEN matter_ref <> '' THEN ' – ' || matter_ref ELSE '' END END AS description,
       total_minor::text AS debit, '0' AS credit, id::text AS doc_id, '1' || COALESCE(issued_at::text, '') AS sort
     FROM app.fee_notes WHERE org_id = $1 AND customer_id = $2 AND status = 'issued'
     UNION ALL
     SELECT to_char(credit_date, 'YYYY-MM-DD'), 'credit-note', number, 'Credit note – ' || reason, '0', total_minor::text, fee_note_id::text, '2' || created_at::text
     FROM app.credit_notes WHERE org_id = $1 AND customer_id = $2 AND status = 'issued'
     UNION ALL
     SELECT to_char(receipt_date, 'YYYY-MM-DD'), 'receipt', number, 'Payment received – ' || method, '0', amount_minor::text, id::text, '3' || created_at::text
     FROM app.receipts WHERE org_id = $1 AND customer_id = $2 AND status = 'recorded' AND kind = 'payment'
     UNION ALL
     SELECT to_char(a.allocated_on, 'YYYY-MM-DD'), 'retainer', r.number, 'Retainer applied to ' || f.number, '0', a.amount_minor::text, f.id::text, '4' || a.created_at::text
     FROM app.allocations a JOIN app.receipts r ON r.id = a.source_id JOIN app.fee_notes f ON f.id = a.fee_note_id
     WHERE a.org_id = $1 AND f.customer_id = $2 AND a.source_type = 'retainer' AND a.status = 'done'
     ORDER BY 1, 8`, [orgId, customerId]);
  let running = 0n;
  return r.rows.map((x) => {
    running += BigInt(x.debit) - BigInt(x.credit);
    return { date: x.date, kind: x.kind, reference: x.ref, description: x.description, debit: x.debit, credit: x.credit, balance: running.toString(), documentId: x.doc_id };
  });
}

/** Everything the fee note workspace shows. */
export async function feeNoteDetail(db: Pick<Db, 'query'>, orgId: string, note: FeeNoteRow) {
  const customer = (await getCustomer(db, orgId, note.customer_id))!;
  const allocations = (await db.query<{ id: string; source_type: string; source_id: string; amount_minor: string; allocated_on: string; entry_id: string | null; source_number: string | null }>(
    `SELECT a.id, a.source_type, a.source_id, a.amount_minor::text, to_char(a.allocated_on, 'YYYY-MM-DD') AS allocated_on, a.entry_id,
       COALESCE(r.number, n.number) AS source_number
     FROM app.allocations a LEFT JOIN app.receipts r ON r.id = a.source_id LEFT JOIN app.credit_notes n ON n.id = a.source_id
     WHERE a.org_id = $1 AND a.fee_note_id = $2 AND a.status = 'done' ORDER BY a.allocated_on, a.created_at`, [orgId, note.id])).rows;
  const credits = (await db.query<CreditNoteRow>(`SELECT ${CREDIT_COLUMNS} FROM app.credit_notes WHERE org_id = $1 AND fee_note_id = $2 AND status = 'issued' ORDER BY credit_date`, [orgId, note.id])).rows;
  const receipts = (await receiptSummaries(db, orgId, note.customer_id)).filter((r) => BigInt(r.available) > 0n);
  const settled = allocations.reduce((s, a) => s + BigInt(a.amount_minor), 0n);
  const credited = credits.reduce((acc, c) => ({ fees: acc.fees + BigInt(c.fees_minor), disb: acc.disb + BigInt(c.disbursements_minor) }), { fees: 0n, disb: 0n });
  return {
    customer: { id: customer.id, name: customer.name, trn: customer.trn, address: customer.address, email: customer.email },
    allocations: allocations.map((a) => ({ id: a.id, kind: a.source_type, reference: a.source_number, amount: a.amount_minor, date: a.allocated_on, entryId: a.entry_id })),
    creditNotes: credits.map((c) => ({ id: c.id, number: c.number, date: c.credit_date, reason: c.reason, fees: c.fees_minor, gct: c.gct_minor, disbursements: c.disbursements_minor, total: c.total_minor, entryId: c.entry_id })),
    available: { payments: receipts.filter((r) => r.kind === 'payment'), retainers: receipts.filter((r) => r.kind === 'retainer') },
    outstanding: note.status === 'issued' ? (BigInt(note.total_minor) - settled).toString() : '0',
    creditable: { fees: (BigInt(note.fees_minor) - credited.fees).toString(), disbursements: (BigInt(note.disbursements_minor) - credited.disb).toString() },
  };
}

export const TAX_CODE_OPTIONS = TAX_CODES;
