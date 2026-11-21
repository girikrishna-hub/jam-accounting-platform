import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, readSeed, ref, setup, signIn, type Harness } from './helpers.ts';
import { importChartOfAccounts, openNextPeriod, postOpeningBalances } from '../src/services/books.ts';
import { getOrganisation } from '../src/services/organisations.ts';

/**
 * Slice 3b acceptance: payables and expenses (decisions approved 2026-11-21).
 * Expenses paid at once or owed, input GCT to 1160, no receipt → no GCT claim, rechargeable costs with a
 * matter, duplicate supplier invoices, drafts waiting for information, cancellation by reversing entry,
 * supplier payments against owed expenses and the brought-forward balance, the control-account check,
 * access and resume after interruption. Needs TEST_DATABASE_URL.
 */
describe.skipIf(!TEST_DATABASE_URL)('slice 3b: payables and expenses', () => {
  let h: Harness;
  type Session = Awaited<ReturnType<typeof signIn>>;
  let accountant: Session;
  let reviewer: Session;
  let hvViewer: Session;
  let orgRef: ReturnType<typeof ref>;
  let keyN = 0;
  const key = () => `s3b-key-${(keyN += 1).toString().padStart(4, '0')}`;
  const act = (who: Session, actionId: string, object: object, input: unknown = {}) =>
    who.post(`/api/workspace/actions/${actionId}`, { object, input, idempotencyKey: key() });
  const ok = async (who: Session, actionId: string, object: object, input: unknown = {}) => {
    const r = await act(who, actionId, object, input);
    if (r.status !== 200) throw new Error(`${actionId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.execution.result;
  };
  const expRef = (id: string) => ref(h.firmId, h.orgs.harbourview, 'expense', id);
  const url = (path: string) => `/api/orgs/${h.orgs.harbourview}${path}`;
  const balance = async (code: string) => {
    const r = await accountant.get(url('/accounts'));
    return BigInt(r.body.accounts.find((a: { code: string }) => a.code === code).balance);
  };
  const payables = async () => (await accountant.get(url('/payables'))).body;
  const settings = { payableAccount: '2000', inputGctAccount: '1160', disbursementAccount: '1120' };

  beforeAll(async () => {
    h = await setup();
    const org = (await getOrganisation(h.db, h.orgs.harbourview))!;
    const actor = { actorId: h.users.accountant, principal: 'accountant' as const, assignedOrganisationId: org.id, organisationId: org.id, ledgerId: org.ledger_id! };
    await importChartOfAccounts(h.db, h.ledger, actor, org.id, await readSeed('chart-of-accounts.csv'));
    await openNextPeriod(h.ledger, actor, org);
    await postOpeningBalances(h.db, h.ledger, actor, org, await readSeed('trial-balance-2025-12-31.csv'));
    accountant = await signIn(h.app, 'accountant@firm.test');
    reviewer = await signIn(h.app, 'reviewer@firm.test');
    hvViewer = await signIn(h.app, 'hv@firm.test');
    orgRef = ref(h.firmId, h.orgs.harbourview, 'client-organisation', h.orgs.harbourview);
  });
  afterAll(async () => { await h?.close(); });

  let officeDepot: string;
  let jps: string;
  let total: string;
  let courtRegistry: string;
  let ncb: string;

  it('needs set-up first, then brings forward what is owed to suppliers so the control account agrees', async () => {
    expect((await payables()).setUp).toBe(false);
    expect((await act(accountant, 'supplier.create', orgRef, { name: 'Too early' })).body.error).toBe('PAYABLES_NOT_SET_UP');
    expect((await act(accountant, 'payables.settings', orgRef, { ...settings, payableAccount: '1000' })).body.error).toBe('ACCOUNT_TYPE');
    expect(await ok(accountant, 'payables.settings', orgRef, settings)).toMatchObject({ broughtForward: '4,215,660.00' });
    const p = await payables();
    expect(p.control).toEqual({ account: '2000', subledger: '421566000', ledger: '421566000', difference: '0' });
    expect(p.expenses).toEqual([expect.objectContaining({ number: 'B/F', broughtForward: true, outstanding: '421566000', state: 'owed' })]);
    expect((await act(accountant, 'payables.settings', orgRef, { ...settings, payableAccount: '2150' })).body.error).toBe('CONTROL_ACCOUNT_LOCKED');
  });

  it('records an expense paid at once: GCT at 15% goes to input GCT, the bank is credited', async () => {
    officeDepot = (await ok(accountant, 'supplier.create', orgRef, { name: 'Office Depot Kingston', trn: '000-xxx-112' })).id;
    expect((await act(accountant, 'supplier.create', orgRef, { name: 'office depot kingston' })).body.error).toBe('DUPLICATE');
    const before = { exp: await balance('5320'), gct: await balance('1160'), bank: await balance('1000') };
    const e = await ok(accountant, 'expense.create', orgRef, {
      supplierId: officeDepot, expenseDate: '2026-01-02', supplierInvoice: 'OD-5512', settlement: 'paid', paidFrom: '1000', paymentMethod: 'POS – NCB',
      lines: [{ account: '5320', description: 'Stationery & toner', net: '16,028.26' }], record: true,
    });
    expect(e.number).toBe('EX-26-0001');
    expect(await balance('5320')).toBe(before.exp + 1602826n);
    expect(await balance('1160')).toBe(before.gct + 240424n);
    expect(await balance('1000')).toBe(before.bank - 1843250n);
    const detail = (await accountant.get(url(`/expenses/${e.id}`))).body;
    expect(detail.expense).toMatchObject({ number: 'EX-26-0001', total: '1843250', gctClaimed: '240424', gctNotClaimed: '0' });
    // The same supplier invoice cannot be entered twice.
    const again = await act(accountant, 'expense.create', orgRef, {
      supplierId: officeDepot, expenseDate: '2026-01-03', supplierInvoice: 'od-5512', paidFrom: '1000', lines: [{ account: '5320', description: 'x', net: '1' }],
    });
    expect(again.body.error).toBe('DUPLICATE_INVOICE');
    // Accounts that cannot be charged, and paid-from accounts that are not cash.
    expect((await act(accountant, 'expense.create', orgRef, { supplierId: officeDepot, expenseDate: '2026-01-03', paidFrom: '1000', lines: [{ account: '1000', description: 'x', net: '1' }], record: true })).body.error).toBe('LINE_ACCOUNT');
    expect((await act(accountant, 'expense.create', orgRef, { supplierId: officeDepot, expenseDate: '2026-01-03', paidFrom: '5320', lines: [{ account: '5320', description: 'x', net: '1' }], record: true })).body.error).toBe('PAID_FROM');
    expect((await payables()).expenses.filter((x: { state: string }) => x.state === 'draft')).toEqual([]); // nothing left behind
  });

  it('claims no input GCT without a receipt on file, expenses the full amount and flags it', async () => {
    total = (await ok(accountant, 'supplier.create', orgRef, { name: 'TotalEnergies Half Way Tree' })).id;
    const before = { exp: await balance('5330'), gct: await balance('1160') };
    const e = await ok(accountant, 'expense.create', orgRef, {
      supplierId: total, expenseDate: '2026-01-19', paidFrom: '1000', paymentMethod: 'POS – NCB', receiptOnFile: false,
      lines: [{ account: '5330', description: 'Fuel – partner vehicle', net: '11,130.43', gct: '1,669.57' }], record: true,
    });
    expect(await balance('5330')).toBe(before.exp + 1280000n);
    expect(await balance('1160')).toBe(before.gct);
    const detail = (await accountant.get(url(`/expenses/${e.id}`))).body;
    expect(detail.expense).toMatchObject({ total: '1280000', gctClaimed: '0', gctNotClaimed: '166957' });
    expect(detail.flags.map((f: { code: string }) => f.code)).toEqual(['no-receipt']);
  });

  it('charges rechargeable costs to 1120 with the matter, and flags one with no matter', async () => {
    courtRegistry = (await ok(accountant, 'supplier.create', orgRef, { name: 'Supreme Court Registry' })).id;
    const before = await balance('1120');
    const e = await ok(accountant, 'expense.create', orgRef, {
      supplierId: courtRegistry, expenseDate: '2026-01-16', paidFrom: '1000', paymentMethod: 'Cheque', paymentRef: '004813',
      lines: [{ account: '1120', description: 'Filing fees – claim', net: '14,500.00', taxCode: 'OUT' }], record: true,
    });
    expect(await balance('1120')).toBe(before + 1450000n);
    expect((await accountant.get(url(`/expenses/${e.id}`))).body.flags.map((f: { code: string }) => f.code)).toEqual(['matter']);
    // Only GCT 15% lines carry GCT.
    expect((await act(accountant, 'expense.create', orgRef, { supplierId: courtRegistry, expenseDate: '2026-01-16', paidFrom: '1000', lines: [{ account: '1120', description: 'x', net: '1', gct: '0.15', taxCode: 'OUT' }] })).body.error).toBe('GCT_CODE');
  });

  it('records an owed expense to payables and settles it with supplier payments; control agrees throughout', async () => {
    jps = (await ok(accountant, 'supplier.create', orgRef, { name: 'Jamaica Public Service (JPS)' })).id;
    const before = await balance('2000');
    const e = await ok(accountant, 'expense.create', orgRef, {
      supplierId: jps, expenseDate: '2026-01-05', supplierInvoice: 'JPS-DEC', settlement: 'owed',
      lines: [{ account: '5110', description: 'Electricity – Dec usage', net: '277,078.45' }], record: true,
    });
    expect(await balance('2000')).toBe(before + 31864022n);
    let p = await payables();
    expect(p.control.difference).toBe('0');
    expect(p.expenses.find((x: { id: string }) => x.id === e.id)).toMatchObject({ state: 'owed', outstanding: '31864022' });

    const pay = await ok(accountant, 'supplier-payment.record', orgRef, {
      supplierId: jps, paymentDate: '2026-01-20', paidFrom: '1000', method: 'ACH', allocations: [{ expenseId: e.id, amount: '100,000.00' }],
    });
    expect(pay.number).toBe('SP-26-0001');
    expect(await balance('2000')).toBe(before + 21864022n);
    p = await payables();
    expect(p.expenses.find((x: { id: string }) => x.id === e.id)).toMatchObject({ state: 'part-paid', outstanding: '21864022' });
    expect(p.control.difference).toBe('0');
    expect((await act(accountant, 'supplier-payment.record', orgRef, { supplierId: jps, paymentDate: '2026-01-21', paidFrom: '1000', method: 'ACH', allocations: [{ expenseId: e.id, amount: '218,640.23' }] })).body.error).toBe('OVER_PAYMENT');
    // A paid expense cannot be cancelled.
    expect((await act(accountant, 'expense.cancel', expRef(e.id), { cancelDate: '2026-01-31', reason: 'x' })).body.error).toBe('EXPENSE_PAID');

    // Paying the brought-forward balance (a supplier from before the system).
    const bf = p.expenses.find((x: { broughtForward: boolean }) => x.broughtForward);
    await ok(accountant, 'supplier-payment.record', orgRef, { supplierId: bf.supplierId, paymentDate: '2026-01-25', paidFrom: '1000', method: 'Cheque', reference: '004820', allocations: [{ expenseId: bf.id, amount: '215,660.00' }] });
    p = await payables();
    expect(p.expenses.find((x: { broughtForward: boolean }) => x.broughtForward).outstanding).toBe('400000000');
    expect(p.control.difference).toBe('0');
    // A payment cannot settle another supplier's expense.
    expect((await act(accountant, 'supplier-payment.record', orgRef, { supplierId: officeDepot, paymentDate: '2026-01-25', paidFrom: '1000', method: 'ACH', allocations: [{ expenseId: e.id, amount: '1.00' }] })).body.error).toBe('SUPPLIER_MISMATCH');
  });

  it('keeps a draft waiting for information, then records it once the split is known', async () => {
    ncb = (await ok(accountant, 'supplier.create', orgRef, { name: 'NCB Motor Loan' })).id;
    const before = { loan: await balance('2500'), interest: await balance('5410') };
    const draft = await ok(accountant, 'expense.create', orgRef, {
      supplierId: ncb, expenseDate: '2026-01-26', paidFrom: '1000', paymentMethod: 'ACH', notes: 'Split needed from NCB loan statement',
      lines: [{ account: '2500', description: 'Loan instalment (principal + interest)', net: '318,400.00', taxCode: 'OUT' }],
    });
    expect(draft.number).toBeNull();
    expect(await balance('2500')).toBe(before.loan);
    expect((await payables()).expenses.find((x: { id: string }) => x.id === draft.id).flags.map((f: { code: string }) => f.code)).toEqual(['waiting']);
    await ok(accountant, 'expense.update', expRef(draft.id), {
      supplierId: ncb, expenseDate: '2026-01-26', paidFrom: '1000', paymentMethod: 'ACH',
      lines: [
        { account: '2500', description: 'Principal', net: '250,000.00', taxCode: 'OUT' },
        { account: '5410', description: 'Interest', net: '68,400.00', taxCode: 'OUT' },
      ],
    });
    const rec = await ok(accountant, 'expense.record', expRef(draft.id));
    expect(rec.number).toMatch(/^EX-26-/);
    expect(await balance('2500')).toBe(before.loan - 25000000n); // a liability reduced
    expect(await balance('5410')).toBe(before.interest + 6840000n);
    expect((await act(accountant, 'expense.update', expRef(draft.id), { supplierId: ncb, expenseDate: '2026-01-26', lines: [{ account: '5410', description: 'x', net: '1' }] })).body.error).toBe('EXPENSE_STATUS');
  });

  it('cancels a recorded expense with a reversing entry; its journal cannot be reversed directly', async () => {
    const e = await ok(accountant, 'expense.create', orgRef, {
      supplierId: officeDepot, expenseDate: '2026-01-10', supplierInvoice: 'OD-5600', paidFrom: '1000', lines: [{ account: '5320', description: 'Entered by mistake', net: '1,000.00' }], record: true,
    });
    const before = { exp: await balance('5320'), gct: await balance('1160'), bank: await balance('1000') };
    const reverse = await act(accountant, 'journal.reverse', ref(h.firmId, h.orgs.harbourview, 'journal', e.entryId), { reversalDate: '2026-01-31', reason: 'x' });
    expect(reverse.body.error).toBe('SOURCE_DOCUMENT');
    expect((await act(accountant, 'expense.cancel', expRef(e.id), { cancelDate: '2026-01-09', reason: 'x' })).body.error).toBe('CANCEL_DATE');
    const c = await ok(accountant, 'expense.cancel', expRef(e.id), { cancelDate: '2026-01-31', reason: 'Duplicate of another entry' });
    expect(c.entryId).not.toBe(e.entryId);
    expect(await balance('5320')).toBe(before.exp - 100000n);
    expect(await balance('1160')).toBe(before.gct - 15000n);
    expect(await balance('1000')).toBe(before.bank + 115000n);
    expect((await payables()).expenses.find((x: { id: string }) => x.id === e.id).state).toBe('cancelled');
    // Once cancelled, the invoice number can be entered again.
    await ok(accountant, 'expense.create', orgRef, { supplierId: officeDepot, expenseDate: '2026-01-10', supplierInvoice: 'OD-5600', paidFrom: '1000', lines: [{ account: '5320', description: 'Correct entry', net: '100.00' }] });
  });

  it('finishes an expense interrupted after its number was taken, posting it once', async () => {
    const d = await ok(accountant, 'expense.create', orgRef, { supplierId: jps, expenseDate: '2026-01-28', paidFrom: '1000', lines: [{ account: '5110', description: 'Interrupted', net: '200.00' }] });
    await h.db.query(`UPDATE app.expenses SET status = 'recording', number = 'EX-26-0099' WHERE id = $1`, [d.id]);
    const before = await balance('5110');
    await payables();
    await payables();
    expect(await balance('5110')).toBe(before + 20000n);
    expect((await accountant.get(url(`/expenses/${d.id}`))).body.expense).toMatchObject({ status: 'recorded', number: 'EX-26-0099' });
  });

  it('lets reviewers see but not change expenses; client viewers do not see them; other clients cannot reach them', async () => {
    expect((await act(reviewer, 'supplier.create', orgRef, { name: 'Reviewer cannot' })).status).toBe(403);
    expect((await reviewer.get(url('/payables'))).status).toBe(200);
    expect((await hvViewer.get(url('/payables'))).status).toBe(403);
    const anyExpense = (await payables()).expenses.find((x: { number: string | null }) => x.number === 'EX-26-0001').id;
    expect((await hvViewer.get(url(`/expenses/${anyExpense}`))).status).toBeGreaterThanOrEqual(403);
    expect((await accountant.get(`/api/orgs/${h.orgs.blueMountain}/expenses/${anyExpense}`)).status).toBe(404);
    expect((await act(accountant, 'expense.cancel', ref(h.firmId, h.orgs.blueMountain, 'expense', anyExpense), { cancelDate: '2026-01-31', reason: 'x' })).status).toBe(404);
    expect((await payables()).control.difference).toBe('0');
  });
});
