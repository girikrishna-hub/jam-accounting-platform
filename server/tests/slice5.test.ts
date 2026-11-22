import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo/seed.ts';
import { PASSWORD, TEST_DATABASE_URL, ref, setup, signIn, type Harness } from './helpers.ts';

/**
 * Slice 5 acceptance: month-end close and reports (decisions approved 2026-11-22), on the January demo.
 * The 2025 year-end close journal, the checklist (blocks and acknowledged warnings), close by request and
 * reviewer approval, posting into a closed month refused, draft and issued statements (viewers see issued
 * only), the GCT working and filing journal, reopening and re-issuing, and PDF / Excel downloads.
 */
describe.skipIf(!TEST_DATABASE_URL)('slice 5: month-end close and reports', () => {
  let h: Harness;
  type Session = Awaited<ReturnType<typeof signIn>>;
  let accountant: Session;
  let reviewer: Session;
  let viewer: Session;
  let orgRef: ReturnType<typeof ref>;
  let keyN = 0;
  const act = (who: Session, actionId: string, input: unknown = {}) =>
    who.post(`/api/workspace/actions/${actionId}`, { object: orgRef, input, idempotencyKey: `s5-key-${(keyN += 1).toString().padStart(4, '0')}` });
  const ok = async (who: Session, actionId: string, input: unknown = {}) => {
    const r = await act(who, actionId, input);
    if (r.status !== 200) throw new Error(`${actionId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.execution.result;
  };
  const url = (path: string) => `/api/orgs/${h.orgs.harbourview}${path}`;
  const balance = async (code: string) => BigInt((await accountant.get(url('/accounts'))).body.accounts.find((a: { code: string }) => a.code === code).balance);
  const monthEnd = async (who: Session = accountant, q = '') => (await who.get(url(`/month-end${q}`))).body;
  const statements = async (who: Session = accountant, q = '') => (await who.get(url(`/statements${q}`))).body;
  const line = (s: { content: { lines: { code: string; amount: string; comparativeAmount?: string }[] } }, code: string) => s.content.lines.find((l) => l.code === code)!;
  let january: string;

  beforeAll(async () => {
    h = await setup();
    await seedDemo(h.db, h.ledger, PASSWORD, () => undefined);
    accountant = await signIn(h.app, 'accountant@demo.firm');
    reviewer = await signIn(h.app, 'reviewer@demo.firm');
    viewer = await signIn(h.app, 'owner@harbourview.demo');
    orgRef = ref(h.firmId, h.orgs.harbourview, 'client-organisation', h.orgs.harbourview);
    january = (await monthEnd()).periods.find((p: { startDate: string }) => p.startDate === '2026-01-01').periodId;
  });
  afterAll(async () => { await h?.close(); });

  it('closes 2025 into the partners: current accounts open 2026 as in the sample balance sheet', async () => {
    // Partner A: 4,120,000 opening + 58,036,535 share of 2025 profit − 36,000,000 2025 drawings (January drawings not yet entered).
    expect(await balance('3100')).toBe(2615653500n);
    expect(await balance('4000')).toBeLessThan(10000000000n);
    const draft = (await statements()).drafts.balanceSheet;
    // Comparative = the opening position on 1 January 2026, after the year-end journal.
    expect(draft.content.parameters.comparative).toEqual({ date: '2026-01-01' });
    expect(line(draft, 'CAPITAL').comparativeAmount).toBe('4500000000');
    expect(line(draft, 'CURRENT').comparativeAmount).toBe('5776230000');
    expect(line(draft, 'PARTNERS').comparativeAmount).toBe('10276230000'); // the sample's total partners' funds
    expect(line(draft, 'NET_ASSETS').comparativeAmount).toBe('10276230000');
  });

  it("drafts January's profit and loss from January's activity only", async () => {
    const pl = (await statements()).drafts.profitAndLoss;
    const fees = (await h.db.query<{ fees: string }>(`SELECT SUM(fees_minor)::text AS fees FROM app.fee_notes WHERE org_id = $1 AND status = 'issued' AND NOT brought_forward`, [h.orgs.harbourview])).rows[0]!.fees;
    expect(line(pl, 'FEES').amount).toBe(fees);
    expect(line(pl, 'OTHER_INCOME').amount).toBe('614218'); // interest credited in January
    expect(BigInt(line(pl, 'NET_PROFIT').amount)).toBe(BigInt(line(pl, 'TOTAL_INCOME').amount) - BigInt(line(pl, 'TOTAL_EXPENSES').amount));
    expect(line(pl, 'FEES').amount.length).toBeLessThan(10); // not 2025's 266M
  });

  it('client viewers see no drafts and cannot download them', async () => {
    const v = await statements(viewer);
    expect(v).toMatchObject({ staff: false, issued: [], drafts: null });
    expect((await viewer.get(url('/export/statement?type=profitAndLoss&periodEnd=2026-01-31'))).status).toBe(403);
    expect((await viewer.get(url('/month-end'))).status).toBe(403);
  });

  it('runs the checklist: the bank reconciliation blocks; drafts, unidentified receipts and flags are warnings', async () => {
    const items = Object.fromEntries((await monthEnd()).checklist.map((i: { code: string; level: string }) => [i.code, i.level]));
    expect(items).toEqual({
      bank: 'block', receivables: 'ok', payables: 'ok', journals: 'ok', 'half-posted': 'ok',
      drafts: 'warn', unidentified: 'warn', 'expense-flags': 'warn', 'bank-flags': 'warn',
    });
    expect((await act(accountant, 'period.request-close', { periodId: january })).body.error).toBe('CLOSE_BLOCKED');
  });

  it('closes January once the bank is reconciled: the accountant asks with reasons, a reviewer approves', async () => {
    // The six bank lines left for testers, then the reconciliation.
    const bank = async () => (await accountant.get(url('/bank'))).body;
    const lineOf = async (text: string) => (await bank()).lines.find((l: { description: string }) => l.description.includes(text));
    const lodgement = await lineOf('LODGEMENT');
    await ok(accountant, 'bank.match', { lineId: lodgement.id, entryIds: lodgement.suggestion.entryIds });
    for (const text of ['SERVICE CHARGE', 'GCT ON BANK CHARGES']) {
      const l = await lineOf(text);
      await ok(accountant, 'bank.create', { lineId: l.id, kind: 'entry', targetAccount: l.rule.targetAccount, description: l.rule.description });
    }
    for (const [text, account] of [['PARTNER A', '3200'], ['PARTNER B', '3210'], ['PARTNER C', '3220']]) {
      await ok(accountant, 'bank.create', { lineId: (await lineOf(text!)).id, kind: 'entry', targetAccount: account, description: `Drawings - ${text}` });
    }
    await ok(accountant, 'bank.reconcile', { accountCode: '1000', periodEnd: '2026-01-31' });
    await ok(reviewer, 'bank.sign-off', { accountCode: '1000', periodEnd: '2026-01-31' });
    expect((await monthEnd()).checklist.find((i: { code: string }) => i.code === 'bank').level).toBe('ok');

    expect((await act(accountant, 'period.request-close', { periodId: january })).body.error).toBe('ACKNOWLEDGEMENT_NEEDED');
    const acknowledgements = ['drafts', 'unidentified', 'expense-flags', 'bank-flags'].map((code) => ({ code, reason: 'Known; carried into February' }));
    expect((await act(reviewer, 'period.request-close', { periodId: january, acknowledgements })).status).toBe(403);
    await ok(accountant, 'period.request-close', { periodId: january, acknowledgements });
    expect((await act(accountant, 'period.approve-close', { periodId: january })).status).toBe(403);
    await ok(reviewer, 'period.approve-close', { periodId: january });
    const m = await monthEnd(accountant, `?periodId=${january}`);
    expect(m.periods.find((p: { periodId: string }) => p.periodId === january)).toMatchObject({ state: 'closed', close: { status: 'closed', acknowledgements } });
  });

  it('refuses anything dated in the closed month', async () => {
    const supplier = (await h.db.query<{ id: string }>("SELECT id FROM app.suppliers WHERE name = 'Office Depot Kingston'")).rows[0]!.id;
    const r = await act(accountant, 'expense.create', { supplierId: supplier, expenseDate: '2026-01-31', paidFrom: '1000', lines: [{ account: '5320', description: 'Late', net: '10.00' }], record: true });
    expect(r.status).toBe(422);
  });

  let plIssue: number;
  it('issues January statements; viewers can then see and download them; issued statements verify unchanged', async () => {
    expect((await act(reviewer, 'statement.issue', { type: 'profitAndLoss', periodEnd: '2026-01-31' })).status).toBe(403);
    plIssue = (await ok(accountant, 'statement.issue', { type: 'profitAndLoss', periodEnd: '2026-01-31' })).issueNumber;
    const bsIssue = (await ok(accountant, 'statement.issue', { type: 'balanceSheet', periodEnd: '2026-01-31' })).issueNumber;
    const v = await statements(viewer);
    expect(v.issued.map((s: { statementType: string; issueNumber: number }) => [s.statementType, s.issueNumber])).toEqual(expect.arrayContaining([['profitAndLoss', plIssue], ['balanceSheet', bsIssue]]));
    const pdf = await viewer.get(url(`/export/statement?type=balanceSheet&issue=${bsIssue}&format=pdf`)).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const xlsx = await viewer.get(url(`/export/statement?type=profitAndLoss&issue=${plIssue}&format=xlsx`)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const issued = (await accountant.get(url(`/statements/issued/balanceSheet/${bsIssue}`))).body;
    expect(issued.verification.result).toBe('unchanged');
    expect((await viewer.get(url(`/statements/issued/balanceSheet/${bsIssue}`))).body.verification).toBeNull();
  });

  it("works out January's GCT and, when filed, moves input GCT into GCT payable", async () => {
    const m = await monthEnd(accountant, `?periodId=${january}`);
    const outputs = (await h.db.query<{ g: string }>(`SELECT SUM(gct_minor)::text AS g FROM app.fee_notes WHERE org_id = $1 AND status = 'issued' AND NOT brought_forward`, [h.orgs.harbourview])).rows[0]!.g;
    expect(m.gct).toMatchObject({ outputTotal: outputs, inputTotal: '10450340', net: String(BigInt(outputs) - 10450340n), filed: null });
    expect(m.gct.notClaimed).toEqual([expect.objectContaining({ gct: '166957' })]);
    // Filing posts on the filing date, which must be in an open month.
    expect((await act(accountant, 'gct.file', { periodStart: '2026-01-01', periodEnd: '2026-01-31', filedOn: '2026-01-31' })).status).toBe(422);
    await ok(accountant, 'period.open');
    const before = { input: await balance('1160'), payable: await balance('2100') };
    await ok(accountant, 'gct.file', { periodStart: '2026-01-01', periodEnd: '2026-01-31', filedOn: '2026-02-15', reference: 'TAJ 0001' });
    expect(await balance('1160')).toBe(before.input - 10450340n);
    expect(await balance('2100')).toBe(before.payable - 10450340n);
    expect((await act(accountant, 'gct.file', { periodStart: '2026-01-01', periodEnd: '2026-01-31', filedOn: '2026-02-15' })).body.error).toBe('ALREADY_FILED');
  });

  it('reopens January with a reason; after closing again, a re-issue needs a reason and replaces the first', async () => {
    expect((await act(accountant, 'period.reopen', { periodId: january, reason: 'x' })).status).toBe(403);
    await ok(reviewer, 'period.reopen', { periodId: january, reason: 'Late supplier invoice' });
    expect((await monthEnd(accountant, `?periodId=${january}`)).periods.find((p: { periodId: string }) => p.periodId === january)).toMatchObject({ state: 'open', reopened: [{ reason: 'Late supplier invoice' }] });
    const acknowledgements = ['drafts', 'unidentified', 'expense-flags', 'bank-flags'].map((code) => ({ code, reason: 'Known' }));
    await ok(accountant, 'period.request-close', { periodId: january, acknowledgements });
    await ok(reviewer, 'period.approve-close', { periodId: january });
    expect((await act(accountant, 'statement.issue', { type: 'profitAndLoss', periodEnd: '2026-01-31' })).body.error).toBe('REASON_NEEDED');
    const again = await ok(accountant, 'statement.issue', { type: 'profitAndLoss', periodEnd: '2026-01-31', reason: 'Re-issued after reopening' });
    const list = (await statements()).issued;
    expect(list.find((s: { issueNumber: number; statementType: string }) => s.statementType === 'profitAndLoss' && s.issueNumber === plIssue).replacedBy).toBe(again.issueNumber);
  });

  it('downloads reports and fee notes as PDF and Excel; viewers only the trial balance', async () => {
    for (const path of ['/export/trial-balance?asOf=2026-01-31', '/export/gct?periodEnd=2026-01-31', '/export/aged-debtors?asOf=2026-01-31', '/export/supplier-balances?year=2026']) {
      for (const format of ['pdf', 'xlsx']) {
        const r = await accountant.get(url(`${path}&format=${format}`)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
        expect(r.status, `${path} ${format}`).toBe(200);
        expect((r.body as Buffer).subarray(0, 2).toString()).toBe(format === 'pdf' ? '%P' : 'PK');
      }
    }
    const fn = (await h.db.query<{ id: string }>("SELECT id FROM app.fee_notes WHERE number = 'FN-2026-0002'")).rows[0]!.id;
    const pdf = await accountant.get(url(`/fee-notes/${fn}/pdf`)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-disposition']).toContain('FN-2026-0002');
    expect((await viewer.get(url('/export/trial-balance?asOf=2026-01-31&format=pdf'))).status).toBe(200);
    expect((await viewer.get(url('/export/gct?periodEnd=2026-01-31&format=pdf'))).status).toBe(403);
    expect((await viewer.get(url(`/fee-notes/${fn}/pdf`))).status).toBe(403);
  });
});
