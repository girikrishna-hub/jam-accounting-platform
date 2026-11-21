import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../errors.ts';
import { requireAllowed } from '../../access/checks.ts';
import { orgScope, scopeOf, type AppContext } from '../middleware.ts';
import { registerMissingEntries, getJournal, listJournals, VISIBLE_TO_CLIENT, type JournalStatus } from '../../services/journals.ts';
import { journalVisible } from '../../workspace/objects.ts';
import {
  TAX_CODE_OPTIONS, ageing, completePending, controlCheck, customerBalances, customerStatement, feeNoteDetail, feeNoteSummaries,
  getCustomer, getFeeNote, getSettings, practiceAreas, receiptSummaries,
} from '../../services/receivables.ts';
import {
  EXPENSE_TAX_CODES, completePendingPayables, expenseDetail, expenseSummaries, getExpense, getPayableSettings, getSupplier, payablesControl,
  supplierBalances, supplierPayments,
} from '../../services/payables.ts';
import { bankOverview, completePendingBank, flaggedEntries, reconciliation } from '../../services/banking.ts';

const STATUSES = ['draft', 'submitted', 'returned', 'approved', 'posted', 'discarded', 'reversed'] as const;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Reads that back the capability panels. Each asks the same capability question the workspace asks. */
const clientCapability = (ctx: AppContext, res: Parameters<typeof scopeOf>[0], capabilityId: string) => {
  const scope = scopeOf(res);
  return requireAllowed(ctx, scope, 'client-organisation', scope.org.id, `capability.${capabilityId}.view`);
};

export function orgRoutes(ctx: AppContext): Router {
  const r = Router({ mergeParams: true });
  r.use(orgScope(ctx));

  r.get('/', async (_req, res) => {
    await clientCapability(ctx, res, 'overview');
    const { org, role } = scopeOf(res);
    res.json({
      id: org.id, name: org.name, legalName: org.legal_name, trn: org.trn, country: org.country, currency: org.currency,
      financialYearStart: org.financial_year_start, openingDate: org.opening_date, status: org.status, role,
      journalApprovalRequired: org.journal_approval_required,
    });
  });

  r.get('/accounts', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'chart-of-accounts');
    const [accounts, tb] = await Promise.all([ctx.ledger.listAccounts(scope.actor), ctx.ledger.getTrialBalance(scope.actor)]);
    const balance = new Map(tb.rows.map((row) => [row.account.accountId, row.balance.amount]));
    res.json({
      currency: scope.org.currency,
      accounts: accounts
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
        .map((a) => ({ ...a, balance: balance.get(a.accountId) ?? '0' })),
    });
  });

  r.get('/accounts/:accountId/ledger', async (req, res) => {
    const scope = scopeOf(res);
    const accountId = z.string().max(128).parse(req.params.accountId);
    await requireAllowed(ctx, scope, 'account', accountId, 'capability.ledger.view');
    const from = ISO_DATE.parse(req.query.from ?? scope.org.opening_date);
    const to = ISO_DATE.parse(req.query.to ?? new Date().toISOString().slice(0, 10));
    const accounts = await ctx.ledger.listAccounts(scope.actor);
    const account = accounts.find((a) => a.accountId === accountId);
    if (!account) throw notFound();
    const lines = await ctx.ledger.getAccountLedger(scope.actor, accountId, from, to);
    // Journal descriptions from the register, so each line says what it was for and links to its journal.
    const journals = await ctx.db.query<{ entry_id: string; description: string }>(
      'SELECT entry_id, description FROM app.journals WHERE org_id = $1 AND entry_id = ANY($2)', [scope.org.id, [...new Set(lines.map((l) => l.entryId))]]);
    const described = new Map(journals.rows.map((j) => [j.entry_id, j.description]));
    res.json({ account, from, to, currency: scope.org.currency, lines: lines.map((l) => ({ ...l, description: described.get(l.entryId) ?? null })) });
  });

  r.get('/journals', async (req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'journals');
    await registerMissingEntries(ctx.db, ctx.ledger, scope);
    const wanted = z.array(z.enum(STATUSES)).optional().parse(typeof req.query.status === 'string' && req.query.status ? req.query.status.split(',') : undefined);
    // Client viewers only ever see posted journals and reversals, whatever they ask for.
    const statuses: readonly JournalStatus[] | undefined = scope.role === 'client_viewer'
      ? (wanted ?? VISIBLE_TO_CLIENT).filter((st) => VISIBLE_TO_CLIENT.includes(st))
      : wanted;
    const rows = await listJournals(ctx.db, scope.org.id, statuses);
    const names = await peopleNames(ctx, rows.flatMap((r) => [r.created_by, r.submitted_by, r.reviewed_by, r.posted_by]));
    res.json({
      currency: scope.org.currency,
      journalApprovalRequired: scope.org.journal_approval_required,
      journals: rows.map((r) => ({
        entryId: r.entry_id, kind: r.kind, status: r.status, entryDate: r.entry_date, description: r.description, total: r.total_minor,
        postingSequence: r.posting_sequence, preparedBy: name(names, r.created_by), submittedBy: name(names, r.submitted_by),
        reviewedBy: name(names, r.reviewed_by), postedBy: name(names, r.posted_by), reviewNote: scope.role === 'client_viewer' ? null : r.review_note,
      })),
    });
  });

  r.get('/journals/:entryId', async (req, res) => {
    const scope = scopeOf(res);
    const entryId = z.string().max(128).parse(req.params.entryId);
    await requireAllowed(ctx, scope, 'journal', entryId, 'capability.lines.view');
    const row = await getJournal(ctx.db, scope.org.id, entryId);
    if (!row || !journalVisible(scope, row)) throw notFound();
    const [entry, accounts] = await Promise.all([ctx.ledger.getEntry(scope.actor, entryId), ctx.ledger.listAccounts(scope.actor)]);
    const byId = new Map(accounts.map((a) => [a.accountId, a]));
    const names = await peopleNames(ctx, [row.created_by, row.updated_by, row.submitted_by, row.reviewed_by, row.posted_by]);
    const staff = scope.role !== 'client_viewer';
    res.json({
      currency: scope.org.currency,
      journalApprovalRequired: scope.org.journal_approval_required,
      journal: {
        entryId, kind: row.kind, status: row.status, ledgerState: entry.state, entryDate: entry.entryDate, description: entry.description,
        reference: entry.externalReference ?? null, postingSequence: entry.postingSequence ?? null,
        reversalOf: entry.reversalOf ?? null, reversedBy: entry.reversedBy ?? null,
        lines: entry.lines.map((l) => ({
          lineNumber: l.lineNumber, accountId: l.accountId, accountCode: byId.get(l.accountId)?.code ?? '', accountName: byId.get(l.accountId)?.name ?? '',
          side: l.side, amount: l.amount.amount, memo: l.memo ?? null,
        })),
        people: staff ? {
          preparedBy: name(names, row.created_by), preparedAt: row.created_at, lastEditedBy: name(names, row.updated_by),
          submittedBy: name(names, row.submitted_by), submittedAt: row.submitted_at,
          reviewedBy: name(names, row.reviewed_by), reviewedAt: row.reviewed_at, reviewNote: row.review_note,
          postedBy: name(names, row.posted_by), postedAt: row.posted_at,
          ids: { createdBy: row.created_by, updatedBy: row.updated_by, submittedBy: row.submitted_by },
        } : null,
      },
    });
  });

  r.get('/periods', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'periods');
    const periods = await ctx.ledger.listPeriods(scope.actor);
    res.json({ periods: periods.sort((a, b) => b.startDate.localeCompare(a.startDate)) });
  });

  r.get('/trial-balance', async (req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'trial-balance');
    const asOf = req.query.asOf === undefined ? undefined : ISO_DATE.parse(req.query.asOf);
    const tb = await ctx.ledger.getTrialBalance(scope.actor, asOf);
    res.json({
      ...tb,
      currency: scope.org.currency,
      rows: tb.rows
        .filter((row) => row.balance.amount !== '0')
        .sort((a, b) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true })),
    });
  });

  r.get('/activity', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'activity');
    const [app, ledger] = await Promise.all([
      ctx.db.query<{ at: string; action: string; outcome: string; display_name: string | null }>(
        `SELECT a.at, a.action, a.outcome, u.display_name FROM app.audit a LEFT JOIN app.users u ON u.id = a.actor_id
         WHERE a.org_id = $1 ORDER BY a.id DESC LIMIT 200`, [scope.org.id]),
      ctx.ledger.listAuditRecords(scope.actor),
    ]);
    const names = new Map((await ctx.db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM app.users')).rows.map((u) => [u.id, u.display_name]));
    const items = [
      ...app.rows.map((a) => ({ at: new Date(a.at).toISOString(), who: a.display_name ?? 'System', what: a.action, outcome: a.outcome, source: 'app' as const })),
      ...ledger.map((l) => ({ at: l.time, who: names.get(l.actorId) ?? 'System', what: l.operation, outcome: l.outcome, source: 'ledger' as const })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
    res.json({ items });
  });

  // ---------- Slice 3a: receivables ----------

  r.get('/receivables', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'receivables');
    await completePending(ctx, scope);
    const settings = await getSettings(ctx.db, scope.org.id);
    const accounts = (await ctx.ledger.listAccounts(scope.actor)).filter((a) => a.active)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((a) => ({ code: a.code, name: a.name, type: a.type, classification: a.classification ?? null }));
    if (!settings?.set_up_at) {
      res.json({ currency: scope.org.currency, setUp: false, settings, practiceAreas: await practiceAreas(ctx.db, scope.org.id), accounts, taxCodes: TAX_CODE_OPTIONS });
      return;
    }
    const [customers, feeNotes, receipts, control, areas] = await Promise.all([
      customerBalances(ctx.db, scope.org.id), feeNoteSummaries(ctx.db, scope.org.id), receiptSummaries(ctx.db, scope.org.id),
      controlCheck(ctx, scope, settings), practiceAreas(ctx.db, scope.org.id),
    ]);
    res.json({ currency: scope.org.currency, setUp: true, settings, practiceAreas: areas, accounts, taxCodes: TAX_CODE_OPTIONS, customers, feeNotes, receipts, control });
  });

  r.get('/receivables/ageing', async (req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'receivables');
    const asOf = ISO_DATE.parse(req.query.asOf ?? new Date().toISOString().slice(0, 10));
    res.json({ currency: scope.org.currency, ...(await ageing(ctx.db, scope.org.id, asOf)) });
  });

  r.get('/customers/:customerId', async (req, res) => {
    const scope = scopeOf(res);
    const customerId = z.string().uuid().parse(req.params.customerId);
    await requireAllowed(ctx, scope, 'customer', customerId, 'capability.statement.view');
    const customer = await getCustomer(ctx.db, scope.org.id, customerId);
    if (!customer) throw notFound();
    const [statement, feeNotes, receipts, balances] = await Promise.all([
      customerStatement(ctx.db, scope.org.id, customerId), feeNoteSummaries(ctx.db, scope.org.id, customerId),
      receiptSummaries(ctx.db, scope.org.id, customerId), customerBalances(ctx.db, scope.org.id),
    ]);
    res.json({ currency: scope.org.currency, customer, balance: balances.find((b) => b.id === customerId), statement, feeNotes, receipts });
  });

  r.get('/fee-notes/:feeNoteId', async (req, res) => {
    const scope = scopeOf(res);
    const feeNoteId = z.string().uuid().parse(req.params.feeNoteId);
    await requireAllowed(ctx, scope, 'fee-note', feeNoteId, 'capability.details.view');
    const note = await getFeeNote(ctx.db, scope.org.id, feeNoteId);
    if (!note || note.status === 'discarded') throw notFound();
    const [detail, areas, customers] = await Promise.all([
      feeNoteDetail(ctx.db, scope.org.id, note), practiceAreas(ctx.db, scope.org.id), customerBalances(ctx.db, scope.org.id),
    ]);
    res.json({
      currency: scope.org.currency,
      firm: { name: scope.org.name, legalName: scope.org.legal_name, trn: scope.org.trn },
      feeNote: {
        id: note.id, number: note.number, status: note.status, broughtForward: note.brought_forward, issueDate: note.issue_date,
        customerId: note.customer_id, matterRef: note.matter_ref, practiceArea: note.practice_area, description: note.description,
        lines: note.lines, fees: note.fees_minor, gct: note.gct_minor, disbursements: note.disbursements_minor, total: note.total_minor, entryId: note.entry_id,
      },
      ...detail,
      practiceAreas: areas,
      customers: customers.filter((c) => c.kind === 'customer' && c.status === 'active').map((c) => ({ id: c.id, name: c.name })),
      taxCodes: TAX_CODE_OPTIONS,
    });
  });

  // ---------- Slice 3b: payables and expenses ----------

  const accountOptions = async (scope: ReturnType<typeof scopeOf>) => (await ctx.ledger.listAccounts(scope.actor)).filter((a) => a.active)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((a) => ({ code: a.code, name: a.name, type: a.type, classification: a.classification ?? null }));
  const activeSuppliers = async (orgId: string) => (await supplierBalances(ctx.db, orgId, new Date().getUTCFullYear()))
    .filter((s) => s.kind === 'supplier' && s.status === 'active').map((s) => ({ id: s.id, name: s.name }));

  r.get('/payables', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'payables');
    await completePendingPayables(ctx, scope);
    const settings = await getPayableSettings(ctx.db, scope.org.id);
    const accounts = await accountOptions(scope);
    if (!settings?.set_up_at) {
      res.json({ currency: scope.org.currency, setUp: false, settings, accounts, taxCodes: EXPENSE_TAX_CODES });
      return;
    }
    const [suppliers, expenses, payments, control] = await Promise.all([
      supplierBalances(ctx.db, scope.org.id, new Date().getUTCFullYear()), expenseSummaries(ctx.db, scope.org.id),
      supplierPayments(ctx.db, scope.org.id), payablesControl(ctx, scope, settings),
    ]);
    res.json({ currency: scope.org.currency, setUp: true, settings, accounts, taxCodes: EXPENSE_TAX_CODES, suppliers, expenses, payments, control });
  });

  r.get('/suppliers/:supplierId', async (req, res) => {
    const scope = scopeOf(res);
    const supplierId = z.string().uuid().parse(req.params.supplierId);
    await requireAllowed(ctx, scope, 'supplier', supplierId, 'capability.expenses.view');
    const supplier = await getSupplier(ctx.db, scope.org.id, supplierId);
    if (!supplier) throw notFound();
    const [expenses, payments, balances] = await Promise.all([
      expenseSummaries(ctx.db, scope.org.id, supplierId), supplierPayments(ctx.db, scope.org.id, supplierId),
      supplierBalances(ctx.db, scope.org.id, new Date().getUTCFullYear()),
    ]);
    res.json({ currency: scope.org.currency, supplier, balance: balances.find((b) => b.id === supplierId), expenses, payments });
  });

  r.get('/expenses/:expenseId', async (req, res) => {
    const scope = scopeOf(res);
    const expenseId = z.string().uuid().parse(req.params.expenseId);
    await requireAllowed(ctx, scope, 'expense', expenseId, 'capability.details.view');
    const e = await getExpense(ctx.db, scope.org.id, expenseId);
    if (!e || e.status === 'discarded') throw notFound();
    const [detail, suppliers, accounts] = await Promise.all([expenseDetail(ctx.db, scope.org.id, e), activeSuppliers(scope.org.id), accountOptions(scope)]);
    res.json({ currency: scope.org.currency, ...detail, suppliers, accounts, taxCodes: EXPENSE_TAX_CODES });
  });

  // ---------- Slice 4: bank reconciliation ----------

  r.get('/bank', async (req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'banking');
    await completePendingBank(ctx, scope);
    const accounts = await accountOptions(scope);
    const bankAccounts = accounts.filter((a) => a.type === 'asset' && (a.classification ?? '').startsWith('BS.CA.CASH'));
    const code = z.string().max(20).optional().parse(req.query.account) ?? bankAccounts[0]?.code;
    if (!code) { res.json({ currency: scope.org.currency, bankAccounts, account: null }); return; }
    const overview = await bankOverview(ctx, scope, code);
    const periods = (await ctx.ledger.listPeriods(scope.actor)).map((p) => p.endDate).sort();
    const lastLine = overview.statements[overview.statements.length - 1]?.last;
    const asked = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().parse(req.query.periodEnd);
    const periodEnd = asked ?? [...periods].reverse().find((p) => !lastLine || p <= lastLine) ?? periods[periods.length - 1];
    const rec = overview.statements.length && periodEnd ? await reconciliation(ctx, scope, code, periodEnd) : null;
    res.json({ currency: scope.org.currency, bankAccounts, ...overview, periods, periodEnd, reconciliation: rec, flagged: await flaggedEntries(ctx.db, scope.org.id), accounts });
  });

  return r;
}

async function peopleNames(ctx: AppContext, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!wanted.length) return new Map();
  const r = await ctx.db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM app.users WHERE id = ANY($1)', [wanted]);
  return new Map(r.rows.map((u) => [u.id, u.display_name]));
}

function name(names: Map<string, string>, id: string | null): string | null {
  return id ? names.get(id) ?? 'Former user' : null;
}
