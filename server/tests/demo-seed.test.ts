import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo/seed.ts';
import { getOrganisation } from '../src/services/organisations.ts';
import { controlCheck, customerBalances, feeNoteSummaries, getSettings, receiptSummaries } from '../src/services/receivables.ts';
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
    expect(status).toMatchObject({ 'FN-2026-0005': 'paid', 'FN-2026-0006': 'paid', 'FN-2026-0007': 'paid', 'FN-2026-0011': 'paid', 'FN-2026-0001': 'outstanding', 'FN-2026-0003': 'outstanding' });

    const receipts = await receiptSummaries(h.db, h.orgs.harbourview);
    expect(receipts).toHaveLength(8);
    expect(receipts.reduce((t, r) => t + BigInt(r.amount), 0n)).toBe(542570000n); // office account total in TX_Receipts
    expect(receipts.filter((r) => r.unidentified).map((r) => r.amount)).toEqual(['57500000']);
  });

  it('keeps the customer total in agreement with account 1100', async () => {
    const control = await controlCheck({ db: h.db, ledger: h.ledger }, scope, (await getSettings(h.db, h.orgs.harbourview))!);
    // 31,940,880 b/f + 7,862,700 issued − 3,925,700 paid − 1,500,000 retainer applied
    expect(control).toEqual({ account: '1100', subledger: '3437788000', ledger: '3437788000', difference: '0' });
    const bf = (await customerBalances(h.db, h.orgs.harbourview)).find((c) => c.kind === 'brought_forward')!;
    expect(bf.balance).toBe(String(3194088000n - 207000000n));
  });

  it('is safe to run again', async () => {
    await seedDemo(h.db, h.ledger, 'Demo-Password-2026', () => undefined);
    expect((await feeNoteSummaries(h.db, h.orgs.harbourview)).length).toBe(13);
  });
});
