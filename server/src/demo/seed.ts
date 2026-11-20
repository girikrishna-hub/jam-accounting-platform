/**
 * Fictitious Harbourview Chambers demo (Jamaica sample data pack): a firm admin, an accountant,
 * a reviewer and two client viewers; Harbourview with its 67-account chart, January 2026 open and
 * opening balances from the 31 Dec 2025 trial balance; an empty second client to show isolation.
 * Safe to run repeatedly: anything already present is left as it is.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/db.ts';
import type { LedgerGateway } from '../ledger/gateway.ts';
import { createUser, assign } from '../services/users.ts';
import { createOrganisation, getOrganisation, type OrganisationRow } from '../services/organisations.ts';
import { importChartOfAccounts, openNextPeriod, postOpeningBalances } from '../services/books.ts';
import type { Role } from '../../../shared/workspace-model.ts';
import {
  allocateReceipt, applyRetainer, createCustomer, createFeeNote, feeNoteSummaries, getSettings, issueFeeNote, recordReceipt, saveSettings,
} from '../services/receivables.ts';

export async function seedDemo(db: Db, ledger: LedgerGateway, password: string, log: (line: string) => void = console.log): Promise<void> {
  const seedDir = fileURLToPath(new URL('../../../seed/harbourview/', import.meta.url));

  async function user(email: string, displayName: string, isFirmAdmin = false): Promise<string> {
    const found = await db.query<{ id: string }>('SELECT id FROM app.users WHERE email = $1', [email]);
    if (found.rows[0]) return found.rows[0].id;
    return (await createUser(db, null, { email, displayName, password, isFirmAdmin })).id;
  }

  async function org(name: string, legalName: string, trn: string, adminId: string): Promise<OrganisationRow> {
    const found = await db.query<{ id: string }>('SELECT id FROM app.organisations WHERE name = $1', [name]);
    if (found.rows[0]) return (await getOrganisation(db, found.rows[0].id))!;
    return createOrganisation(db, ledger, adminId, { name, legalName, trn, openingDate: '2026-01-01', financialYearStart: 1 });
  }

  const adminId = await user('admin@demo.firm', 'Firm Administrator', true);
  const accountantId = await user('accountant@demo.firm', 'Andrea Accountant');
  const reviewerId = await user('reviewer@demo.firm', 'Rohan Reviewer');
  const viewerId = await user('owner@harbourview.demo', 'Harbourview Partner (client)');
  const otherViewerId = await user('owner@bluemountain.demo', 'Blue Mountain Owner (client)');

  const harbourview = await org('Harbourview Chambers', 'Harbourview Chambers (partnership)', '000-000-000', adminId);
  const blueMountain = await org('Blue Mountain Traders', 'Blue Mountain Traders Ltd', '000-000-001', adminId);

  const grants: [string, string, Role][] = [
    [accountantId, harbourview.id, 'accountant'], [reviewerId, harbourview.id, 'reviewer'], [viewerId, harbourview.id, 'client_viewer'],
    [accountantId, blueMountain.id, 'accountant'], [otherViewerId, blueMountain.id, 'client_viewer'],
  ];
  for (const [userId, orgId, role] of grants) await assign(db, adminId, { userId, orgId, role });

  const actor = {
    actorId: accountantId, principal: 'accountant' as const,
    assignedOrganisationId: harbourview.id, organisationId: harbourview.id, ledgerId: harbourview.ledger_id!,
  };
  const coa = await importChartOfAccounts(db, ledger, actor, harbourview.id, await readFile(seedDir + 'chart-of-accounts.csv', 'utf8'));
  log(`Chart of accounts: ${coa.created} created, ${coa.alreadyPresent} already present, ${coa.errors.length} errors`);
  for (const e of coa.errors) log(`  line ${e.line}: ${e.message}`);

  const periods = await ledger.listPeriods(actor);
  if (!periods.length) {
    const p = await openNextPeriod(ledger, actor, harbourview);
    log(`Opened period ${p.startDate} to ${p.endDate}`);
  }

  const tb = await ledger.getTrialBalance(actor);
  if (tb.totalDebits.amount === '0') {
    const result = await postOpeningBalances(db, ledger, actor, harbourview, await readFile(seedDir + 'trial-balance-2025-12-31.csv', 'utf8'));
    log(`Opening balances posted: ${result.lines} lines, debits ${result.totalDebits}, credits ${result.totalCredits}`);
  } else {
    log('Opening balances already posted.');
  }

  await seedJanuaryReceivables(db, ledger, { org: { ...harbourview, ledger_id: harbourview.ledger_id! }, role: 'accountant', actor }, log);

  log('\nDemo users (password = DEMO_PASSWORD):');
  log('  admin@demo.firm          firm administrator');
  log('  accountant@demo.firm     accountant for both clients');
  log('  reviewer@demo.firm       reviewer for Harbourview');
  log('  owner@harbourview.demo   client viewer, Harbourview only');
  log('  owner@bluemountain.demo  client viewer, Blue Mountain only');
}

// ---------- January 2026 receivables (sample data pack: TX_FeeNotes and TX_Receipts) ----------

type Scope = Parameters<typeof saveSettings>[1];

/** The 12 fee notes, in issue order so they take FN-2026-0001 to 0012. Fee earner goes on the fee line. */
const FEE_NOTES: [date: string, matter: string, client: string, area: string, earner: string, fees: string, disbursements: string | null][] = [
  ['2026-01-05', 'M-0388', 'Client 0388', 'Litigation', 'Associate 2', '1173913.04', null],
  ['2026-01-06', 'M-0420', 'Client 0420', 'Corporate', 'Partner B', '850000.00', '12500.00'],
  ['2026-01-08', 'M-0415', 'Client 0415', 'Conveyancing', 'Associate 1', '523478.26', '48000.00'],
  ['2026-01-09', 'M-0430', 'Client 0430', 'Family', 'Associate 3', '180000.00', '6000.00'],
  ['2026-01-12', 'M-0119', 'Portland Holdings', 'Retainer', 'Partner A', '1304347.83', null],
  ['2026-01-14', 'M-0441', 'Client 0441', 'Notarial', 'Associate 1', '15000.00', null],
  ['2026-01-16', 'M-0402', 'Estate of M.E.T.', 'Probate', 'Partner C', '950000.00', '57500.00'],
  ['2026-01-20', 'M-0450', 'Client 0450', 'Corporate', 'Partner B', '420000.00', '8500.00'],
  ['2026-01-22', 'M-0317', 'Client 0317', 'Conveyancing', 'Associate 1', '300000.00', '14500.00'],
  ['2026-01-27', 'M-0388', 'Client 0388', 'Litigation', 'Associate 2', '250000.00', '22000.00'],
  ['2026-01-28', 'M-0460', 'Client 0460', 'Immigration', 'Associate 3', '95000.00', '4200.00'],
  ['2026-01-30', 'M-0411', 'Estate of A.R.', 'Probate', 'Partner C', '600000.00', '28500.00'],
];

/**
 * The 8 office-account receipts. Clients' money receipts wait for release 1b, so FN-2026-0001 and 0003
 * (settled from the client account) stay outstanding. "BF" = a fee note from before the system.
 */
const RECEIPTS: { date: string; from: string | 'BF' | null; payer?: string; kind?: 'retainer'; method: string; amount: string; reference: string; applyTo?: string }[] = [
  { date: '2026-01-02', from: 'BF', payer: 'Carib Distributors Ltd', method: 'RTGS', amount: '1725000.00', reference: 'FN-2025-1188' },
  { date: '2026-01-07', from: 'BF', payer: 'Client 0430', method: 'Cheque', amount: '120000.00', reference: 'FN-2025-1230 – cheque #33018' },
  { date: '2026-01-07', from: 'BF', payer: 'Client 0377', method: 'Cheque', amount: '225000.00', reference: 'FN-2025-1214 – cheque #551' },
  { date: '2026-01-12', from: 'Portland Holdings', kind: 'retainer', method: 'RTGS', amount: '1500000.00', reference: 'Retainer Jan 2026' },
  { date: '2026-01-14', from: 'Client 0441', method: 'Card (WiPay)', amount: '17250.00', reference: '', applyTo: 'FN-2026-0006' },
  { date: '2026-01-20', from: 'Estate of M.E.T.', method: 'Transfer from client a/c', amount: '1150000.00', reference: '', applyTo: 'FN-2026-0007' },
  { date: '2026-01-23', from: 'Client 0460', method: 'Card (WiPay)', amount: '113450.00', reference: '', applyTo: 'FN-2026-0011' },
  { date: '2026-01-30', from: null, method: 'RTGS', amount: '575000.00', reference: 'Ref 88213 – needs identification' },
];

async function seedJanuaryReceivables(db: Db, ledger: LedgerGateway, scope: Scope, log: (line: string) => void): Promise<void> {
  if ((await getSettings(db, scope.org.id))?.set_up_at) { log('Receivables already set up.'); return; }
  const ctx = { db, ledger };
  const set = await saveSettings(ctx, scope, {
    receivableAccount: '1100', gctAccount: '2100', disbursementAccount: '1120', retainerAccount: '2200',
    practiceAreas: [
      ['Conveyancing', '4000'], ['Litigation', '4010'], ['Corporate', '4020'], ['Probate', '4030'],
      ['Family', '4040'], ['Notarial', '4050'], ['Immigration', '4050'], ['Retainer', '4100'],
    ].map(([name, incomeAccount]) => ({ name, incomeAccount })),
  });
  log(`Receivables set up; brought forward ${set.broughtForward}`);

  const customers = new Map<string, string>();
  for (const name of new Set(FEE_NOTES.map((f) => f[2]))) customers.set(name, (await createCustomer(ctx, scope, { name })).id);

  const notes = new Map<string, string>();
  for (const [issueDate, matterRef, client, practiceArea, earner, fees, disbursements] of FEE_NOTES) {
    const lines = [{ kind: 'fee', description: `Professional services – ${earner}`, amount: fees, taxCode: 'GCT15' }];
    if (disbursements) lines.push({ kind: 'disbursement', description: 'Disbursements at cost', amount: disbursements, taxCode: 'OUT' });
    const draft = await createFeeNote(ctx, scope, { customerId: customers.get(client)!, issueDate, matterRef, practiceArea, lines });
    const issued = await issueFeeNote(ctx, scope, draft.id);
    notes.set(issued.number!, draft.id);
  }

  const summaries = await feeNoteSummaries(db, scope.org.id);
  const bf = summaries.find((n) => n.broughtForward)!;
  let retainerId = '';
  for (const r of RECEIPTS) {
    const customerId = r.from === 'BF' ? bf.customerId : r.from ? customers.get(r.from)! : undefined;
    const receipt = await recordReceipt(ctx, scope, {
      ...(customerId ? { customerId } : {}), kind: r.kind ?? 'payment', receiptDate: r.date, method: r.method, depositAccount: '1000',
      amount: r.amount, reference: r.payer ? `${r.payer} – ${r.reference}` : r.reference,
    });
    if (r.from === 'BF') await allocateReceipt(ctx, scope, bf.id, { receiptId: receipt.id, amount: r.amount });
    if (r.applyTo) await allocateReceipt(ctx, scope, notes.get(r.applyTo)!, { receiptId: receipt.id, amount: r.amount });
    if (r.kind === 'retainer') retainerId = receipt.id;
  }
  await applyRetainer(ctx, scope, notes.get('FN-2026-0005')!, { receiptId: retainerId, amount: '1500000.00' });
  log(`January receivables: ${FEE_NOTES.length} fee notes issued, ${RECEIPTS.length} office receipts recorded`);
}
