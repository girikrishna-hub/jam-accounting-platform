import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo/seed.ts';
import { getOrganisation } from '../src/services/organisations.ts';
import { controlCheck, customerBalances, feeNoteSummaries, getSettings, receiptSummaries } from '../src/services/receivables.ts';
import { expenseSummaries, getPayableSettings, payablesControl } from '../src/services/payables.ts';
import { setup, type Harness } from './helpers.ts';

/** The demo seed loads Harbourview's January receivables to match the sample data pack's registers. */
describe('demo seed: January receivables', () => {
  let h: Harness;
  let scope: Parameters<typeof controlCheck>[1];
  beforeAll(async () => {
    h = await setup();
    await seedDemo(h.db, h.ledger, 'Demo-Password-2026', () => undefined);
    const org = (await getOrganisation(h.db, h.orgs.harbourview))!;
    const accountant = (await h.db.query<{ id: string }>("SELECT id FROM app.users WHERE email = 'accountant@demo.firm'")).rows[0]!.id;
    scope = { org: { ...org, ledger_id: org.ledger_id! }, role: 'accountant', actor: { actorId: accountant, principal: 'accountant', assignedOrganisationId: org.id, organisationId: org.id, ledgerId: org.ledger_id! } };
  });
  afterAll(async () => { await h?.close(); });

  it('issues FN-2026-0001 to 0012 with the register totals and settles the office receipts', async () => {
    const notes = (await feeNoteSummaries(h.db, h.orgs.harbourview)).filter((n) => !n.broughtForward).sort((a, b) => a.number!.localeCompare(b.number!));
    expect(notes.map((n) => n.number)).toEqual(Array.from({ length: 12 }, (_, i) => `FN-2026-${String(i + 1).padStart(4, '0')}`));
    expect(notes.reduce((t, n) => t + BigInt(n.total), 0n)).toBe(786270000n);
    const status = Object.fromEntries(notes.map((n) => [n.number, n.settlement]));
    // FN-2026-0001 and 0003 are paid by the transfers from the client account found on the bank statement.
    expect(status).toMatchObject({ 'FN-2026-0005': 'paid', 'FN-2026-0006': 'paid', 'FN-2026-0007': 'paid', 'FN-2026-0011': 'paid', 'FN-2026-0001': 'paid', 'FN-2026-0003': 'paid', 'FN-2026-0002': 'outstanding' });

    const receipts = await receiptSummaries(h.db, h.orgs.harbourview);
    // 8 office receipts from TX_Receipts (5,425,700.00) and 6 found on the bank statement (10,996,100.00).
    expect(receipts).toHaveLength(14);
    expect(receipts.reduce((t, r) => t + BigInt(r.amount), 0n)).toBe(542570000n + 1099610000n);
    expect(receipts.filter((r) => r.unidentified).map((r) => r.amount).sort()).toEqual(['57500000', '8360000']);
  });

  it('keeps the customer total in agreement with account 1100', async () => {
    const control = await controlCheck({ db: h.db, ledger: h.ledger }, scope, (await getSettings(h.db, h.orgs.harbourview))!);
    // 31,940,880 b/f + 7,862,700 issued − 3,925,700 paid − 1,500,000 retainer applied (34,377,880),
    // then − 10,912,500 paid per the bank statement − 83,600 unidentified WiPay.
    expect(control).toEqual({ account: '1100', subledger: '2338178000', ledger: '2338178000', difference: '0' });
    const bf = (await customerBalances(h.db, h.orgs.harbourview)).find((c) => c.kind === 'brought_forward')!;
    expect(bf.balance).toBe(String(3194088000n - 207000000n - 86250000n - 480000000n - 325000000n));
  });

  it('records 13 January expenses matching the register, flags two and keeps the loan instalment as a draft', async () => {
    const expenses = (await expenseSummaries(h.db, h.orgs.harbourview)).filter((e) => !e.broughtForward);
    const recorded = expenses.filter((e) => e.state === 'paid');
    expect(recorded).toHaveLength(13);
    expect(recorded.map((e) => e.number).sort()[0]).toBe('EX-26-0001');
    expect(recorded.reduce((t, e) => t + BigInt(e.total), 0n)).toBe(282074272n);
    expect(recorded.reduce((t, e) => t + BigInt(e.gct), 0n)).toBe(10450340n); // input GCT claimed
    const flagged = Object.fromEntries(expenses.filter((e) => e.flags.length).map((e) => [e.supplierName, e.flags.map((f) => f.code)]));
    expect(flagged).toEqual({ 'TotalEnergies Half Way Tree': ['no-receipt'], 'Supreme Court Registry': ['matter'], 'NCB Motor Loan': ['waiting'] });
    const control = await payablesControl({ db: h.db, ledger: h.ledger }, scope, (await getPayableSettings(h.db, h.orgs.harbourview))!);
    expect(control).toEqual({ account: '2000', subledger: '421566000', ledger: '421566000', difference: '0' });
  });

  it('is safe to run again', async () => {
    const logs: string[] = [];
    await seedDemo(h.db, h.ledger, 'Demo-Password-2026', (l) => logs.push(l));
    expect(logs).toContain('January receivables already loaded.');
    expect(logs).toContain('January expenses already loaded.');
    expect((await feeNoteSummaries(h.db, h.orgs.harbourview)).length).toBe(13);
  });

  it('skips without failing when January is not open', async () => {
    const logs: string[] = [];
    await h.db.query("DELETE FROM app.allocations; DELETE FROM app.receipts; DELETE FROM app.fee_notes WHERE NOT brought_forward; DELETE FROM app.expenses WHERE NOT brought_forward");
    const closed = Object.assign(Object.create(h.ledger) as typeof h.ledger, { listPeriods: async () => [{ startDate: '2026-01-01', endDate: '2026-01-31', state: 'closed' }] });
    await seedDemo(h.db, closed, 'Demo-Password-2026', (l) => logs.push(l));
    expect(logs).toContain('January receivables not loaded: January 2026 is not open.');
    expect(logs).toContain('January expenses not loaded: January 2026 is not open.');
  });

});
