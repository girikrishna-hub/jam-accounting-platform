import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, readSeed, ref, setup, signIn, type Harness } from './helpers.ts';
import { importChartOfAccounts, openNextPeriod, postOpeningBalances } from '../src/services/books.ts';
import { getOrganisation } from '../src/services/organisations.ts';

/**
 * Slice 3a acceptance: receivables (design pack Slice 3, decisions approved 2026-11-20).
 * Fee notes with GCT, receipts, allocation, retainers, credit notes, brought-forward balance,
 * unidentified receipts, ageing, the control-account check, isolation and resume after interruption.
 * Needs TEST_DATABASE_URL.
 */
describe.skipIf(!TEST_DATABASE_URL)('slice 3a: receivables', () => {
  let h: Harness;
  type Session = Awaited<ReturnType<typeof signIn>>;
  let accountant: Session;
  let reviewer: Session;
  let hvViewer: Session;
  let orgRef: ReturnType<typeof ref>;
  let keyN = 0;
  const key = () => `s3-key-${(keyN += 1).toString().padStart(4, '0')}`;
  const act = (who: Session, actionId: string, object: object, input: unknown = {}) =>
    who.post(`/api/workspace/actions/${actionId}`, { object, input, idempotencyKey: key() });
  const ok = async (who: Session, actionId: string, object: object, input: unknown = {}) => {
    const r = await act(who, actionId, object, input);
    if (r.status !== 200) throw new Error(`${actionId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.execution.result;
  };
  const noteRef = (id: string) => ref(h.firmId, h.orgs.harbourview, 'fee-note', id);
  const url = (path: string) => `/api/orgs/${h.orgs.harbourview}${path}`;
  const balance = async (code: string) => {
    const r = await accountant.get(url('/accounts'));
    return BigInt(r.body.accounts.find((a: { code: string }) => a.code === code).balance);
  };
  const receivables = async () => (await accountant.get(url('/receivables'))).body;
  const settings = {
    receivableAccount: '1100', gctAccount: '2100', disbursementAccount: '1120', retainerAccount: '2200',
    practiceAreas: [
      { name: 'Conveyancing', incomeAccount: '4000' }, { name: 'Litigation', incomeAccount: '4010' },
      { name: 'Corporate', incomeAccount: '4020' }, { name: 'Probate', incomeAccount: '4030' },
      { name: 'Family', incomeAccount: '4040' }, { name: 'Notarial', incomeAccount: '4050' },
      { name: 'Immigration', incomeAccount: '4050' }, { name: 'Retainer', incomeAccount: '4100' },
    ],
  };

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

  it('needs set-up first, then brings forward the opening receivables so the control account agrees', async () => {
    expect((await receivables()).setUp).toBe(false);
    const early = await act(accountant, 'customer.create', orgRef, { name: 'Too early' });
    expect(early.status).toBe(422);
    expect(early.body.error).toBe('RECEIVABLES_NOT_SET_UP');

    const wrong = await act(accountant, 'receivables.settings', orgRef, { ...settings, practiceAreas: [{ name: 'Litigation', incomeAccount: '5000' }] });
    expect(wrong.body.error).toBe('ACCOUNT_TYPE');

    expect(await ok(accountant, 'receivables.settings', orgRef, settings)).toMatchObject({ broughtForward: '31,940,880.00' });
    const r = await receivables();
    expect(r.setUp).toBe(true);
    expect(r.control).toEqual({ account: '1100', subledger: '3194088000', ledger: '3194088000', difference: '0' });
    expect(r.customers.map((c: { kind: string }) => c.kind).sort()).toEqual(['brought_forward', 'unidentified']);
    expect(r.feeNotes).toEqual([expect.objectContaining({ number: 'B/F', broughtForward: true, outstanding: '3194088000' })]);
  });

  let client0388: string;
  let client0420: string;
  let portland: string;

  it('issues a fee note with GCT at 15% and posts it to receivables, fee income and output GCT', async () => {
    client0388 = (await ok(accountant, 'customer.create', orgRef, { name: 'Client 0388', trn: '000-000-388' })).id;
    client0420 = (await ok(accountant, 'customer.create', orgRef, { name: 'Client 0420' })).id;
    portland = (await ok(accountant, 'customer.create', orgRef, { name: 'Portland Holdings' })).id;
    const before = { ar: await balance('1100'), lit: await balance('4010'), gct: await balance('2100') };

    const draft = await ok(accountant, 'fee-note.create', orgRef, {
      customerId: client0388, issueDate: '2026-01-05', matterRef: 'M-0388', practiceArea: 'Litigation',
      lines: [{ kind: 'fee', description: 'Professional fees – litigation', amount: '1,173,913.04' }],
    });
    expect(draft.total).toBe('135000000');
    const issued = await ok(accountant, 'fee-note.issue', noteRef(draft.id));
    expect(issued.number).toBe('FN-2026-0001');

    expect(await balance('1100')).toBe(before.ar + 135000000n);
    expect(await balance('4010')).toBe(before.lit + 117391304n);
    expect(await balance('2100')).toBe(before.gct + 17608696n);
    expect((await receivables()).control.difference).toBe('0');

    // The journal it posted is corrected through the fee note, not reversed directly.
    const reverse = await act(accountant, 'journal.reverse', ref(h.firmId, h.orgs.harbourview, 'journal', issued.entryId), { reversalDate: '2026-01-31', reason: 'x' });
    expect(reverse.body.error).toBe('SOURCE_DOCUMENT');
    // An issued fee note cannot be edited or discarded.
    expect((await act(accountant, 'fee-note.update', noteRef(draft.id), { customerId: client0388, issueDate: '2026-01-05', practiceArea: 'Litigation', lines: [{ kind: 'fee', description: 'x', amount: '1' }] })).body.error).toBe('FEE_NOTE_STATUS');
    expect((await act(accountant, 'fee-note.discard', noteRef(draft.id))).body.error).toBe('FEE_NOTE_STATUS');
  });

  let fn2: string;

  it('recharges disbursements without GCT and keeps numbers gap-free across discarded drafts', async () => {
    const discarded = await ok(accountant, 'fee-note.create', orgRef, {
      customerId: client0420, issueDate: '2026-01-06', practiceArea: 'Corporate', lines: [{ kind: 'fee', description: 'Wrong one', amount: '10' }],
    });
    await ok(accountant, 'fee-note.discard', noteRef(discarded.id));
    const disbBefore = await balance('1120');
    const created = await ok(accountant, 'fee-note.create', orgRef, {
      customerId: client0420, issueDate: '2026-01-06', matterRef: 'M-0420', practiceArea: 'Corporate',
      lines: [{ kind: 'fee', description: 'Share purchase – professional fees', amount: '850,000.00' }, { kind: 'disbursement', description: 'Registry fees', amount: '12,500.00' }],
    });
    expect(created.total).toBe('99000000');
    fn2 = created.id;
    expect((await ok(accountant, 'fee-note.issue', noteRef(fn2))).number).toBe('FN-2026-0002');
    expect(await balance('1120')).toBe(disbBefore - 1250000n);
  });

  it('refuses to issue into a period that is not open, without using a number', async () => {
    const feb = await ok(accountant, 'fee-note.create', orgRef, {
      customerId: client0420, issueDate: '2026-02-03', practiceArea: 'Corporate', lines: [{ kind: 'fee', description: 'February work', amount: '100' }],
    });
    expect((await act(accountant, 'fee-note.issue', noteRef(feb.id))).body.error).toBe('NO_OPEN_PERIOD');
    await ok(accountant, 'fee-note.discard', noteRef(feb.id));
  });

  it('records a payment, allocates it in parts, and refuses over-allocation and the wrong customer', async () => {
    const bank = await balance('1000');
    const pay = await ok(accountant, 'receipt.record', orgRef, {
      customerId: client0420, receiptDate: '2026-01-20', method: 'RTGS', depositAccount: '1000', amount: '500,000.00',
    });
    expect(pay.number).toBe('RC-26-0001');
    expect(await balance('1000')).toBe(bank + 50000000n);

    expect((await act(accountant, 'fee-note.allocate', noteRef(fn2), { receiptId: pay.id, amount: '600,000.00' })).body.error).toBe('OVER_ALLOCATION');
    await ok(accountant, 'fee-note.allocate', noteRef(fn2), { receiptId: pay.id, amount: '500,000.00' });
    let note = (await accountant.get(url(`/fee-notes/${fn2}`))).body;
    expect(note.outstanding).toBe('49000000');
    expect((await receivables()).feeNotes.find((n: { id: string }) => n.id === fn2).settlement).toBe('part-paid');

    const other = await ok(accountant, 'receipt.record', orgRef, { customerId: client0388, receiptDate: '2026-01-21', method: 'Cheque', depositAccount: '1000', amount: '1,000.00' });
    expect((await act(accountant, 'fee-note.allocate', noteRef(fn2), { receiptId: other.id, amount: '1,000.00' })).body.error).toBe('CUSTOMER_MISMATCH');

    const rest = await ok(accountant, 'receipt.record', orgRef, {
      customerId: client0420, receiptDate: '2026-01-26', method: 'RTGS', depositAccount: '1000', amount: '490,000.00', allocateTo: fn2,
    });
    expect(rest.allocated).toBeTruthy();
    note = (await accountant.get(url(`/fee-notes/${fn2}`))).body;
    expect(note.outstanding).toBe('0');
    expect((await receivables()).feeNotes.find((n: { id: string }) => n.id === fn2).settlement).toBe('paid');
    expect((await receivables()).control.difference).toBe('0');
  });

  it('holds a retainer as fees received in advance and applies it to a fee note', async () => {
    const advance = await balance('2200');
    const retainer = await ok(accountant, 'receipt.record', orgRef, {
      customerId: portland, kind: 'retainer', receiptDate: '2026-01-12', method: 'RTGS', depositAccount: '1000', amount: '1,500,000.00', reference: 'Retainer Jan 2026',
    });
    expect(await balance('2200')).toBe(advance + 150000000n);
    const fn = await ok(accountant, 'fee-note.create', orgRef, {
      customerId: portland, issueDate: '2026-01-12', matterRef: 'M-0119', practiceArea: 'Retainer',
      lines: [{ kind: 'fee', description: 'Retainer – January', amount: '1,304,347.83' }],
    });
    expect(fn.total).toBe('150000000');
    await ok(accountant, 'fee-note.issue', noteRef(fn.id));
    expect((await act(accountant, 'fee-note.allocate', noteRef(fn.id), { receiptId: retainer.id, amount: '1,500,000.00' })).body.error).toBe('RECEIPT_STATUS');
    await ok(accountant, 'fee-note.apply-retainer', noteRef(fn.id), { receiptId: retainer.id, amount: '1,500,000.00' });
    expect(await balance('2200')).toBe(advance);
    expect((await accountant.get(url(`/fee-notes/${fn.id}`))).body.outstanding).toBe('0');
    const customer = (await accountant.get(url(`/customers/${portland}`))).body;
    expect(customer.balance).toMatchObject({ balance: '0', retainerHeld: '0' });
    expect(customer.statement.map((l: { kind: string }) => l.kind)).toEqual(['fee-note', 'retainer']);
    expect((await receivables()).control.difference).toBe('0');
  });

  it('credits part of a fee note with GCT on the credited fees, and refuses to over-credit', async () => {
    const fn = await ok(accountant, 'fee-note.create', orgRef, {
      customerId: client0388, issueDate: '2026-01-27', matterRef: 'M-0388', practiceArea: 'Litigation',
      lines: [{ kind: 'fee', description: 'Litigation – January', amount: '250,000.00' }, { kind: 'disbursement', description: 'Court filing', amount: '22,000.00' }],
    });
    await ok(accountant, 'fee-note.issue', noteRef(fn.id));
    const gct = await balance('2100');
    const credit = await ok(accountant, 'fee-note.credit', noteRef(fn.id), { creditDate: '2026-01-29', reason: 'Fee reduced after dispute', fees: '100,000.00' });
    expect(credit).toMatchObject({ number: 'CN-2026-0001', total: '11500000' });
    expect(await balance('2100')).toBe(gct - 1500000n);
    expect((await accountant.get(url(`/fee-notes/${fn.id}`))).body.outstanding).toBe(String(30950000n - 11500000n));
    expect((await act(accountant, 'fee-note.credit', noteRef(fn.id), { creditDate: '2026-01-29', reason: 'Too much', fees: '200,000.00' })).body.error).toBe('OVER_CREDIT');
    expect((await receivables()).control.difference).toBe('0');
  });

  it('holds an unidentified payment, then assigns it; settles brought-forward items', async () => {
    const unknown = await ok(accountant, 'receipt.record', orgRef, { receiptDate: '2026-01-30', method: 'RTGS', depositAccount: '1000', amount: '575,000.00', notes: 'Ref 88213' });
    let r = await receivables();
    const held = r.receipts.find((x: { id: string }) => x.id === unknown.id);
    expect(held).toMatchObject({ unidentified: true, available: '57500000' });
    await ok(accountant, 'receipt.reassign', orgRef, { receiptId: unknown.id, customerId: client0388 });
    r = await receivables();
    expect(r.receipts.find((x: { id: string }) => x.id === unknown.id)).toMatchObject({ unidentified: false, customerName: 'Client 0388' });
    expect(r.control.difference).toBe('0');

    // A January payment of a 2025 fee note settles the brought-forward balance; the payer is in the reference.
    const bfCustomer = r.customers.find((c: { kind: string }) => c.kind === 'brought_forward');
    const bfNote = r.feeNotes.find((n: { broughtForward: boolean }) => n.broughtForward);
    const pay = await ok(accountant, 'receipt.record', orgRef, {
      customerId: bfCustomer.id, receiptDate: '2026-01-02', method: 'RTGS', depositAccount: '1000', amount: '1,725,000.00',
      reference: 'Carib Distributors Ltd – FN-2025-1188', allocateTo: bfNote.id,
    });
    expect(pay.allocated).toBeTruthy();
    r = await receivables();
    expect(r.feeNotes.find((n: { broughtForward: boolean }) => n.broughtForward).outstanding).toBe(String(3194088000n - 172500000n));
    expect(r.control.difference).toBe('0');
    // A retainer cannot be taken against the brought-forward balance.
    expect((await act(accountant, 'receipt.record', orgRef, { customerId: bfCustomer.id, kind: 'retainer', receiptDate: '2026-01-02', method: 'RTGS', depositAccount: '1000', amount: '1.00' })).body.error).toBe('CUSTOMER_NOT_FOUND');
  });

  it('ages outstanding fee notes and shows unallocated payments', async () => {
    const a = (await accountant.get(url('/receivables/ageing?asOf=2026-03-15'))).body;
    expect(a.buckets.map((b: { key: string }) => b.key)).toEqual(['current', 'd31', 'd61', 'd90']);
    const bf = a.rows.find((row: { customerName: string }) => row.customerName.startsWith('Balances brought forward'));
    expect(bf.buckets.d61).toBe(String(3194088000n - 172500000n));
    const c0388 = a.rows.find((row: { customerName: string }) => row.customerName === 'Client 0388');
    expect(BigInt(c0388.unallocated)).toBeGreaterThan(0n);
    const r = await receivables();
    expect(BigInt(a.total)).toBe(r.customers.reduce((s: bigint, c: { balance: string }) => s + BigInt(c.balance), 0n));
  });

  it('finishes a posting that was interrupted after its number was taken, exactly once', async () => {
    const fn = await ok(accountant, 'fee-note.create', orgRef, {
      customerId: client0420, issueDate: '2026-01-28', practiceArea: 'Corporate', lines: [{ kind: 'fee', description: 'Interrupted', amount: '1,000.00' }],
    });
    // As if the server stopped right after taking the number.
    await h.db.query(`UPDATE app.fee_notes SET status = 'issuing', number = 'FN-2026-0099' WHERE id = $1`, [fn.id]);
    const ar = await balance('1100');
    await receivables();
    await receivables();
    expect(await balance('1100')).toBe(ar + 115000n);
    const note = (await accountant.get(url(`/fee-notes/${fn.id}`))).body.feeNote;
    expect(note).toMatchObject({ status: 'issued', number: 'FN-2026-0099' });
    expect((await receivables()).control.difference).toBe('0');
  });

  it('lets only accountants act, hides receivables from client viewers, and isolates clients', async () => {
    expect((await act(reviewer, 'customer.create', orgRef, { name: 'Reviewer cannot' })).status).toBe(403);
    expect((await reviewer.get(url('/receivables'))).status).toBe(200);
    expect((await hvViewer.get(url('/receivables'))).status).toBe(403);
    expect((await hvViewer.get(url(`/fee-notes/${fn2}`))).status).toBeGreaterThanOrEqual(403);
    // A Harbourview fee note does not exist from Blue Mountain.
    expect((await accountant.get(`/api/orgs/${h.orgs.blueMountain}/fee-notes/${fn2}`)).status).toBe(404);
    const bmRef = ref(h.firmId, h.orgs.blueMountain, 'fee-note', fn2);
    expect((await act(accountant, 'fee-note.issue', bmRef)).status).toBe(404);
  });
});
