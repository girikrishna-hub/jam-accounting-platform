import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, TEST_DATABASE_URL, readSeed, ref, setup, signIn, type Harness } from './helpers.ts';
import { importChartOfAccounts, openNextPeriod, postOpeningBalances } from '../src/services/books.ts';
import { getOrganisation } from '../src/services/organisations.ts';
import { assign } from '../src/services/users.ts';

/**
 * Slice 2 acceptance: journals with maker-checker approval (design pack D4), posting,
 * reversal, client visibility and isolation. Needs TEST_DATABASE_URL.
 */
describe.skipIf(!TEST_DATABASE_URL)('slice 2: journals', () => {
  let h: Harness;
  type Session = Awaited<ReturnType<typeof signIn>>;
  let accountant: Session;
  let reviewer: Session;
  let hvViewer: Session;
  let bmViewer: Session;
  let orgRef: ReturnType<typeof ref>;
  let ids: Record<string, string>;
  let keyN = 0;
  const key = () => `test-key-${(keyN += 1).toString().padStart(4, '0')}`;

  const act = (who: Session, actionId: string, object: object, input: unknown = {}, idempotencyKey = key()) =>
    who.post(`/api/workspace/actions/${actionId}`, { object, input, idempotencyKey });
  const journalRef = (entryId: string) => ref(h.firmId, h.orgs.harbourview, 'journal', entryId);
  const balance = async (code: string) => {
    const r = await accountant.get(`/api/orgs/${h.orgs.harbourview}/accounts`);
    return BigInt(r.body.accounts.find((a: { code: string }) => a.code === code).balance);
  };
  const lines = (amount: string) => [
    { accountId: ids['1000'], debit: amount, memo: 'Fees received' },
    { accountId: ids['4000'], credit: amount },
  ];

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
    bmViewer = await signIn(h.app, 'bm@firm.test');
    orgRef = ref(h.firmId, h.orgs.harbourview, 'client-organisation', h.orgs.harbourview);
    const accounts = await accountant.get(`/api/orgs/${h.orgs.harbourview}/accounts`);
    ids = Object.fromEntries(accounts.body.accounts.map((a: { code: string; accountId: string }) => [a.code, a.accountId]));
  });
  afterAll(async () => { await h?.close(); });

  it('requires approval by default and lists the opening journal as posted', async () => {
    const list = await accountant.get(`/api/orgs/${h.orgs.harbourview}/journals`);
    expect(list.body.journalApprovalRequired).toBe(true);
    expect(list.body.journals).toEqual([expect.objectContaining({ kind: 'opening', status: 'posted', postingSequence: 1 })]);
  });

  let entryId: string;

  it('runs the approval path: draft, submit, approve by someone else, post', async () => {
    const created = await act(accountant, 'journal.create', orgRef, { entryDate: '2026-01-15', description: 'January fees', lines: lines('100,000.00').map((l, i) => (i === 1 ? { ...l, credit: '90,000.00' } : l)) });
    expect(created.status).toBe(200);
    entryId = created.body.execution.result.entry_id;
    expect(created.body.execution.result.status).toBe('draft');

    const unbalanced = await act(accountant, 'journal.submit', journalRef(entryId));
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.body.error).toBe('UNBALANCED');

    expect((await act(accountant, 'journal.update', journalRef(entryId), { entryDate: '2026-01-15', description: 'January fees', lines: lines('100,000.00') })).status).toBe(200);
    expect((await act(accountant, 'journal.post', journalRef(entryId))).body.error).toBe('JOURNAL_STATUS');
    expect((await act(accountant, 'journal.submit', journalRef(entryId))).body.execution.result.status).toBe('submitted');

    const editWhileWaiting = await act(accountant, 'journal.update', journalRef(entryId), { entryDate: '2026-01-15', description: 'x', lines: lines('1.00') });
    expect(editWhileWaiting.status).toBe(422);
    expect((await act(accountant, 'journal.approve', journalRef(entryId))).status).toBe(403);

    const approved = await act(reviewer, 'journal.approve', journalRef(entryId));
    expect(approved.status).toBe(200);
    expect(approved.body.execution.result.status).toBe('approved');

    const cashBefore = await balance('1000');
    const posted = await act(accountant, 'journal.post', journalRef(entryId));
    expect(posted.status).toBe(200);
    expect(posted.body.execution.result).toMatchObject({ status: 'posted', posting_sequence: 2 });
    expect(await balance('1000')).toBe(cashBefore + 10_000_000n);
  });

  it('a reviewer who prepared the journal cannot approve it', async () => {
    // The reviewer temporarily acts as accountant and prepares a journal, then becomes reviewer again.
    await assign(h.db, h.users.admin, { userId: h.users.reviewer, orgId: h.orgs.harbourview, role: 'accountant' });
    const created = await act(reviewer, 'journal.create', orgRef, { entryDate: '2026-01-20', description: 'Prepared by reviewer', lines: lines('50.00') });
    const id = created.body.execution.result.entry_id;
    expect((await act(reviewer, 'journal.submit', journalRef(id))).status).toBe(200);
    await assign(h.db, h.users.admin, { userId: h.users.reviewer, orgId: h.orgs.harbourview, role: 'reviewer' });
    const own = await act(reviewer, 'journal.approve', journalRef(id));
    expect(own.status).toBe(422);
    expect(own.body.error).toBe('SAME_PERSON');
  });

  it('return sends a journal back with a reason; an edit after approval needs approval again', async () => {
    const id = (await act(accountant, 'journal.create', orgRef, { entryDate: '2026-01-21', description: 'Office supplies', lines: lines('200.00') })).body.execution.result.entry_id;
    await act(accountant, 'journal.submit', journalRef(id));
    expect((await act(reviewer, 'journal.return', journalRef(id), { reason: '' })).status).toBe(422);
    const returned = await act(reviewer, 'journal.return', journalRef(id), { reason: 'Use the stationery account' });
    expect(returned.body.execution.result).toMatchObject({ status: 'returned', review_note: 'Use the stationery account' });

    await act(accountant, 'journal.submit', journalRef(id));
    await act(reviewer, 'journal.approve', journalRef(id));
    const edited = await act(accountant, 'journal.update', journalRef(id), { entryDate: '2026-01-21', description: 'Office supplies', lines: lines('250.00') });
    expect(edited.body.execution.result.status).toBe('draft');
    expect((await act(accountant, 'journal.post', journalRef(id))).status).toBe(422);
  });

  it('refuses to post when the ledger copy changed after approval', async () => {
    const id = (await act(accountant, 'journal.create', orgRef, { entryDate: '2026-01-22', description: 'Bank charges', lines: lines('10.00') })).body.execution.result.entry_id;
    await act(accountant, 'journal.submit', journalRef(id));
    await act(reviewer, 'journal.approve', journalRef(id));
    const org = (await getOrganisation(h.db, h.orgs.harbourview))!;
    // Changed outside the app's workflow, directly in the ledger.
    await h.ledger.updateDraft({ actorId: h.users.accountant, principal: 'accountant', assignedOrganisationId: org.id, organisationId: org.id, ledgerId: org.ledger_id! }, {
      entryId: id, entryDate: '2026-01-22', description: 'Bank charges',
      lines: [{ accountId: ids['1000']!, side: 'debit', amount: '99900' }, { accountId: ids['4000']!, side: 'credit', amount: '99900' }],
    });
    const post = await act(accountant, 'journal.post', journalRef(id));
    expect(post.status).toBe(422);
    expect(post.body.error).toBe('CHANGED_SINCE_APPROVAL');
    const detail = await accountant.get(`/api/orgs/${h.orgs.harbourview}/journals/${id}`);
    expect(detail.body.journal.status).toBe('draft');
    // The runtime refused the stale version itself (Bookkeeping BR-28): nothing was posted.
    const entry = await h.ledger.getEntry({ actorId: h.users.accountant, principal: 'accountant', assignedOrganisationId: org.id, organisationId: org.id, ledgerId: org.ledger_id! }, id);
    expect(entry).toMatchObject({ state: 'draft', version: 2, postingSequence: null });
  });

  it('reverses a posted journal once, restoring the balance', async () => {
    const cash = await balance('1000');
    expect((await act(accountant, 'journal.reverse', journalRef(entryId), { reversalDate: '2026-01-10', reason: 'Wrong client' })).body.error).toBe('REVERSAL_DATE');
    const reversed = await act(accountant, 'journal.reverse', journalRef(entryId), { reversalDate: '2026-01-31', reason: 'Wrong client' });
    expect(reversed.status).toBe(200);
    expect(reversed.body.execution.result.original.status).toBe('reversed');
    const reversalId = reversed.body.execution.result.reversal.entry_id;
    expect(await balance('1000')).toBe(cash - 10_000_000n);
    expect((await act(accountant, 'journal.reverse', journalRef(entryId), { reversalDate: '2026-01-31', reason: 'Again' })).status).toBe(422);
    expect((await act(accountant, 'journal.reverse', journalRef(reversalId), { reversalDate: '2026-01-31', reason: 'Undo' })).body.error).toBe('REVERSAL_NOT_ALLOWED');
  });

  it('refuses to post into a date with no open period', async () => {
    const id = (await act(accountant, 'journal.create', orgRef, { entryDate: '2026-03-15', description: 'March accrual', lines: lines('5.00') })).body.execution.result.entry_id;
    await act(accountant, 'journal.submit', journalRef(id));
    await act(reviewer, 'journal.approve', journalRef(id));
    const post = await act(accountant, 'journal.post', journalRef(id));
    expect(post.status).toBe(422);
    expect(post.body.error).toBe('NoOpenPeriod');
  });

  it('only a reviewer can switch approval off; then accountants post directly', async () => {
    expect((await act(accountant, 'org.controls.update', orgRef, { journalApprovalRequired: false })).status).toBe(403);
    expect((await act(reviewer, 'org.controls.update', orgRef, { journalApprovalRequired: false })).body.execution.result).toEqual({ journalApprovalRequired: false });
    const id = (await act(accountant, 'journal.create', orgRef, { entryDate: '2026-01-25', description: 'Direct post', lines: lines('1.00') })).body.execution.result.entry_id;
    expect((await act(accountant, 'journal.submit', journalRef(id))).body.error).toBe('APPROVAL_OFF');
    expect((await act(accountant, 'journal.post', journalRef(id))).body.execution.result.status).toBe('posted');
    await act(reviewer, 'org.controls.update', orgRef, { journalApprovalRequired: true });
  });

  it('discards a draft, and a repeated create with the same key drafts once', async () => {
    const input = { entryDate: '2026-01-26', description: 'Duplicate click', lines: lines('3.00') };
    const first = await act(accountant, 'journal.create', orgRef, input, 'same-key-0001');
    const second = await act(accountant, 'journal.create', orgRef, input, 'same-key-0001');
    expect(second.body.execution.result.entry_id).toBe(first.body.execution.result.entry_id);
    const discarded = await act(accountant, 'journal.discard', journalRef(first.body.execution.result.entry_id));
    expect(discarded.body.execution.result.status).toBe('discarded');
  });

  it('shows client viewers posted journals only, and nothing to another client', async () => {
    const list = await hvViewer.get(`/api/orgs/${h.orgs.harbourview}/journals?status=draft,submitted,posted`);
    expect(list.status).toBe(200);
    expect(list.body.journals.length).toBeGreaterThan(0);
    expect(list.body.journals.every((j: { status: string }) => ['posted', 'reversed'].includes(j.status))).toBe(true);
    const draft = (await accountant.get(`/api/orgs/${h.orgs.harbourview}/journals?status=draft`)).body.journals[0];
    expect((await hvViewer.get(`/api/orgs/${h.orgs.harbourview}/journals/${draft.entryId}`)).status).toBe(404);
    expect((await hvViewer.post('/api/workspace/resolve', { reference: journalRef(draft.entryId) })).status).toBe(404);
    const posted = await hvViewer.get(`/api/orgs/${h.orgs.harbourview}/journals/${entryId}`);
    expect(posted.status).toBe(200);
    expect(posted.body.journal.people).toBeNull();
    expect((await act(hvViewer, 'journal.reverse', journalRef(entryId), { reversalDate: '2026-01-31', reason: 'x' })).status).toBe(403);

    expect((await bmViewer.get(`/api/orgs/${h.orgs.harbourview}/journals`)).status).toBe(404);
    expect((await bmViewer.get(`/api/orgs/${h.orgs.harbourview}/journals/${entryId}`)).status).toBe(404);
    expect(PASSWORD).toBeTruthy();
  });

  it('labels account ledger lines with their journal description', async () => {
    const r = await accountant.get(`/api/orgs/${h.orgs.harbourview}/accounts/${ids['1000']}/ledger?from=2026-01-01&to=2026-01-31`);
    expect(r.body.lines.map((l: { description: string | null }) => l.description)).toEqual(expect.arrayContaining(['January fees']));
  });
});
