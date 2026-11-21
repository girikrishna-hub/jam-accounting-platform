import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo/seed.ts';
import { parseStatement } from '../src/services/banking.ts';
import { PASSWORD, TEST_DATABASE_URL, ref, setup, signIn, type Harness } from './helpers.ts';

/**
 * Slice 4 acceptance: bank reconciliation (decisions approved 2026-11-21), on the January demo data.
 * Import checks, suggestions (including two receipts adding up to one lodgement), entering bank-only
 * items with remembered rules, the reconciliation statement, completion by the accountant and sign-off
 * by the reviewer, locking, access and resume. Needs TEST_DATABASE_URL.
 */
describe.skipIf(!TEST_DATABASE_URL)('slice 4: bank reconciliation', () => {
  let h: Harness;
  type Session = Awaited<ReturnType<typeof signIn>>;
  let accountant: Session;
  let reviewer: Session;
  let viewer: Session;
  let orgRef: ReturnType<typeof ref>;
  let keyN = 0;
  const act = (who: Session, actionId: string, input: unknown = {}) =>
    who.post(`/api/workspace/actions/${actionId}`, { object: orgRef, input, idempotencyKey: `s4-key-${(keyN += 1).toString().padStart(4, '0')}` });
  const ok = async (who: Session, actionId: string, input: unknown = {}) => {
    const r = await act(who, actionId, input);
    if (r.status !== 200) throw new Error(`${actionId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.execution.result;
  };
  const bank = async (who: Session = accountant) => (await who.get(`/api/orgs/${h.orgs.harbourview}/bank`)).body;
  const lineOf = async (text: string) => (await bank()).lines.find((l: { description: string }) => l.description.includes(text));
  const balance = async (code: string) => BigInt((await accountant.get(`/api/orgs/${h.orgs.harbourview}/accounts`)).body.accounts.find((a: { code: string }) => a.code === code).balance);

  beforeAll(async () => {
    h = await setup();
    await seedDemo(h.db, h.ledger, PASSWORD, () => undefined);
    accountant = await signIn(h.app, 'accountant@demo.firm');
    reviewer = await signIn(h.app, 'reviewer@demo.firm');
    viewer = await signIn(h.app, 'owner@harbourview.demo');
    orgRef = ref(h.firmId, h.orgs.harbourview, 'client-organisation', h.orgs.harbourview);
  });
  afterAll(async () => { await h?.close(); });

  it('reads the bank layout and checks every running balance', () => {
    const csv = 'Date,Value date,Reference,Description,Debit (JMD),Credit (JMD),Balance (JMD)\nBALANCE BROUGHT FORWARD,,,,,,"1,000.00"\n02/01/2026,,X,In,,100.00,"1,100.00"\n03/01/2026,,Y,Out,50.00,,"1,040.00"\n';
    const p = parseStatement(csv);
    expect(p.opening).toBe(100000n);
    expect(p.lines.map((l) => [l.date, l.amount])).toEqual([['2026-01-02', 10000n], ['2026-01-03', -5000n]]);
    expect(p.errors).toEqual(['Row 4: balance 1,040.00 does not follow from the line before (expected 1,050.00).']);
    expect(parseStatement('a,b\n1,2').errors[0]).toMatch(/header/);
  });

  it('loads January: 33 lines, the opening agreeing with the ledger; the same file cannot come in twice', async () => {
    const b = await bank();
    expect(b.statements).toEqual([expect.objectContaining({ first: '2026-01-02', last: '2026-01-31', opening: '845231055', closing: '637161001', line_count: 33 })]);
    expect(b.lines).toHaveLength(33);
    const csv = (await import('node:fs/promises')).readFile(new URL('../../seed/harbourview/bank-statement-2026-01.csv', import.meta.url), 'utf8');
    expect((await act(accountant, 'bank.import', { accountCode: '1000', csv: await csv })).body.error).toBe('DUPLICATE_STATEMENT');
    expect((await act(accountant, 'bank.import', { accountCode: '1000', csv: (await csv) + '\n' })).body.error).toMatch(/DUPLICATE_STATEMENT|OPENING_MISMATCH/);
    expect((await act(accountant, 'bank.import', { accountCode: '5400', csv: await csv })).body.error).toBe('NOT_A_BANK_ACCOUNT');
  });

  it('shows the reconciling items the demo leaves for testers', async () => {
    const rec = (await bank()).reconciliation;
    expect(rec).toMatchObject({ periodEnd: '2026-01-31', covered: true, statementBalance: '637161001', difference: '0' });
    const notEntered = rec.notEntered.map((l: { description: string; amount: string }) => [l.description.slice(0, 22), l.amount]);
    expect(notEntered).toEqual([
      ['CASH/CHEQUE LODGEMENT ', '34500000'], ['SERVICE CHARGE - ACCOU', '-250000'], ['TRF TO PARTNER A - DRA', '-300000000'],
      ['TRF TO PARTNER B - DRA', '-230000000'], ['TRF TO PARTNER C - DRA', '-140000000'], ['ACH DR - NCB MOTOR LOA', '-31840000'], ['GCT ON BANK CHARGES', '-37500'],
    ]);
    expect(rec.notOnStatement.map((i: { amount: string }) => i.amount).sort()).toEqual(['-8050000', '12000000', '22500000']);
  });

  it('suggests the two cheque receipts for the lodgement, and rule accounts for the charges', async () => {
    const lodgement = await lineOf('LODGEMENT');
    expect(lodgement.suggestion).toMatchObject({ reason: 'Two items add up to this line' });
    expect((await lineOf('SERVICE CHARGE')).rule).toMatchObject({ targetAccount: '5400' });
    // Matching too much is refused; the suggestion is accepted.
    const b = await bank();
    const big = b.unmatched.find((i: { amount: string }) => i.amount === '-8050000');
    expect((await act(accountant, 'bank.match', { lineId: lodgement.id, entryIds: [big.entryId] })).body.error).toBe('MATCH_AMOUNT');
    await ok(accountant, 'bank.match', { lineId: lodgement.id, entryIds: lodgement.suggestion.entryIds });
    expect((await lineOf('LODGEMENT')).remaining).toBe('0');
    expect((await act(accountant, 'bank.match', { lineId: (await lineOf('PARTNER A')).id, entryIds: [lodgement.suggestion.entryIds[0]] })).body.error).toBe('ALREADY_MATCHED');
    // Unmatch and match again.
    await ok(accountant, 'bank.unmatch', { lineId: lodgement.id });
    expect((await lineOf('LODGEMENT')).remaining).toBe('34500000');
    await ok(accountant, 'bank.match', { lineId: lodgement.id, entryIds: lodgement.suggestion.entryIds });
  });

  it('enters bank-only items: drawings and charges post against the bank and match the line; a rule is remembered', async () => {
    const before = { bank: await balance('1000'), drawA: await balance('3200'), charges: await balance('5400') };
    for (const [text, account, description] of [['PARTNER A', '3200', 'Drawings - Partner A'], ['PARTNER B', '3210', 'Drawings - Partner B'], ['PARTNER C', '3220', 'Drawings - Partner C']]) {
      await ok(accountant, 'bank.create', { lineId: (await lineOf(text!)).id, kind: 'entry', targetAccount: account, description, remember: text === 'PARTNER A' ? 'TRF TO PARTNER A' : undefined });
    }
    for (const text of ['SERVICE CHARGE', 'GCT ON BANK CHARGES']) {
      const l = await lineOf(text);
      await ok(accountant, 'bank.create', { lineId: l.id, kind: 'entry', targetAccount: l.rule.targetAccount, description: l.rule.description });
    }
    expect(await balance('1000')).toBe(before.bank - 300000000n - 230000000n - 140000000n - 250000n - 37500n);
    expect(await balance('5400')).toBe(before.charges + 287500n);
    expect((await bank()).rules.map((r: { containsText: string }) => r.containsText)).toContain('TRF TO PARTNER A');
    // A bank entry's journal can only be undone through the bank line, not reversed directly.
    const entryId = (await lineOf('PARTNER A')).matches[0].entryId;
    const rev = await accountant.post('/api/workspace/actions/journal.reverse', { object: ref(h.firmId, h.orgs.harbourview, 'journal', entryId), input: { reversalDate: '2026-01-31', reason: 'x' }, idempotencyKey: 's4-rev-1' });
    expect(rev.body.error).toBe('SOURCE_DOCUMENT');
    // Wrong direction and wrong totals are refused.
    const loan = await lineOf('MOTOR LOAN');
    expect((await act(accountant, 'bank.create', { lineId: loan.id, kind: 'receipt' })).body.error).toBe('WRONG_DIRECTION');
    expect((await act(accountant, 'bank.create', { lineId: loan.id, kind: 'expense', expense: { supplierId: '00000000-0000-4000-8000-000000000000', lines: [{ account: '5410', description: 'x', net: '1.00', taxCode: 'OUT' }] } })).body.error).toBe('MATCH_AMOUNT');
  });

  it('reconciles January: the statement less the unpresented cheque agrees with the ledger less the loan not yet entered', async () => {
    const rec = (await bank()).reconciliation;
    expect(rec.notOnStatement).toEqual([expect.objectContaining({ amount: '-8050000', description: expect.stringContaining('Valuation surveyor') })]);
    expect(rec.notEntered).toEqual([expect.objectContaining({ amount: '-31840000', description: expect.stringContaining('MOTOR LOAN') })]);
    expect(rec).toMatchObject({ statementBalance: '637161001', ledgerBalance: '660951001', adjustedStatement: '629111001', adjustedLedger: '629111001', difference: '0' });
  });

  it('is completed by the accountant and signed off by a reviewer, after which its lines are locked', async () => {
    const period = { accountCode: '1000', periodEnd: '2026-01-31' };
    expect((await act(reviewer, 'bank.reconcile', period)).status).toBe(403);
    expect((await act(accountant, 'bank.sign-off', period)).status).toBe(403);
    expect((await act(reviewer, 'bank.sign-off', period)).body.error).toBe('NOT_COMPLETE');
    await ok(accountant, 'bank.reconcile', period);
    // A change after completion must be completed again before sign-off.
    const lodgement = await lineOf('LODGEMENT');
    await ok(accountant, 'bank.unmatch', { lineId: lodgement.id });
    expect((await act(reviewer, 'bank.sign-off', period)).body.error).toBe('RECONCILIATION_CHANGED');
    await ok(accountant, 'bank.match', { lineId: lodgement.id, entryIds: (await lineOf('LODGEMENT')).suggestion.entryIds });
    await ok(accountant, 'bank.reconcile', period);
    await ok(reviewer, 'bank.sign-off', period);
    const b = await bank();
    expect(b.reconciliation.saved).toMatchObject({ status: 'signed_off', changed: false });
    expect(b.locked).toBe('2026-01-31');
    expect((await act(accountant, 'bank.unmatch', { lineId: lodgement.id })).body.error).toBe('RECONCILED');
    expect((await act(accountant, 'bank.create', { lineId: (await lineOf('MOTOR LOAN')).id, kind: 'entry', targetAccount: '2500', description: 'x' })).body.error).toBe('RECONCILED');
    expect((await act(accountant, 'bank.reconcile', period)).body.error).toBe('RECONCILED');
  });

  it('lets reviewers see the bank screen; client viewers cannot', async () => {
    expect((await reviewer.get(`/api/orgs/${h.orgs.harbourview}/bank`)).status).toBe(200);
    expect((await viewer.get(`/api/orgs/${h.orgs.harbourview}/bank`)).status).toBe(403);
    expect((await act(viewer, 'bank.match', { lineId: '00000000-0000-4000-8000-000000000000', entryIds: ['x'] })).status).toBe(403);
  });

  it('finishes a bank entry interrupted before posting, once', async () => {
    const line = (await h.db.query<{ id: string }>("SELECT id FROM app.bank_lines WHERE description LIKE '%INTEREST CREDIT%'")).rows[0]!.id;
    const id = '11111111-1111-4111-8111-111111111111';
    await h.db.query(`INSERT INTO app.bank_entries (id, org_id, line_id, account_code, target_account, description, amount_minor, status) VALUES ($1, $2, $3, '1000', '4500', 'Interrupted', 100, 'recording')`, [id, h.orgs.harbourview, line]);
    const before = await balance('4500');
    await bank(); await bank();
    expect(await balance('4500')).toBe(before + 100n);
    expect((await h.db.query("SELECT status FROM app.bank_entries WHERE id = $1", [id])).rows[0].status).toBe('recorded');
  });
});
