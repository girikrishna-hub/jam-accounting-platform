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
import { createExpense, createSupplier, getPayableSettings, savePayableSettings } from '../services/payables.ts';
import { bankOverview, createFromLine, importStatement, matchLine } from '../services/banking.ts';

const seedDir = fileURLToPath(new URL('../../../seed/harbourview/', import.meta.url));

export async function seedDemo(db: Db, ledger: LedgerGateway, password: string, log: (line: string) => void = console.log): Promise<void> {
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

  // Never blocks start-up: if January is closed or anything fails, say so and carry on.
  try {
    await seedJanuaryReceivables(db, ledger, { org: { ...harbourview, ledger_id: harbourview.ledger_id! }, role: 'accountant', actor }, log);
  } catch (e) {
    log(`January receivables not loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await seedJanuaryExpenses(db, ledger, { org: { ...harbourview, ledger_id: harbourview.ledger_id! }, role: 'accountant', actor }, log);
  } catch (e) {
    log(`January expenses not loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await seedJanuaryBank(db, ledger, { org: { ...harbourview, ledger_id: harbourview.ledger_id! }, role: 'accountant', actor }, log);
  } catch (e) {
    log(`January bank statement not loaded: ${e instanceof Error ? e.message : String(e)}`);
  }

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
  const ctx = { db, ledger };
  const loaded = await db.query(
    `SELECT 1 FROM app.fee_notes WHERE org_id = $1 AND NOT brought_forward UNION ALL SELECT 1 FROM app.receipts WHERE org_id = $1 LIMIT 1`, [scope.org.id]);
  if (loaded.rowCount) { log('January receivables already loaded.'); return; }
  const january = (await ledger.listPeriods(scope.actor)).find((p) => p.startDate === '2026-01-01');
  if (january?.state !== 'open') { log('January receivables not loaded: January 2026 is not open.'); return; }
  if ((await getSettings(db, scope.org.id))?.set_up_at) {
    log('Receivables were already set up; loading January.');
  } else {
    const set = await saveSettings(ctx, scope, {
    receivableAccount: '1100', gctAccount: '2100', disbursementAccount: '1120', retainerAccount: '2200',
    practiceAreas: [
      ['Conveyancing', '4000'], ['Litigation', '4010'], ['Corporate', '4020'], ['Probate', '4030'],
      ['Family', '4040'], ['Notarial', '4050'], ['Immigration', '4050'], ['Retainer', '4100'],
    ].map(([name, incomeAccount]) => ({ name, incomeAccount })),
    });
    log(`Receivables set up; brought forward ${set.broughtForward}`);
  }

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

// ---------- January 2026 expenses (sample data pack: TX_Expenses) ----------

interface DemoExpense {
  date: string; supplier: string; trn?: string; description: string; account: string; net: string; gct?: string; tax?: 'GCT15' | 'EXEMPT' | 'OUT';
  paidFrom: string; method: string; ref?: string; receipt?: false; matter?: string; foreign?: string;
}

/** 13 expenses recorded as paid at once (input GCT to 1160). Rent and insurance carry no GCT; LexisNexis is a foreign service. */
const EXPENSES: DemoExpense[] = [
  { date: '2026-01-02', supplier: 'Office Depot Kingston', trn: '000-xxx-112', description: 'Stationery & toner', account: '5320', net: '16028.26', paidFrom: '1000', method: 'POS – NCB' },
  { date: '2026-01-03', supplier: 'J. Landlord Properties Ltd', trn: '000-xxx-458', description: 'Office rent – January', account: '5100', net: '1200000.00', tax: 'EXEMPT', paidFrom: '1000', method: 'Cheque', ref: '004812' },
  { date: '2026-01-05', supplier: 'Jamaica Public Service (JPS)', trn: '000-xxx-001', description: 'Electricity – Dec usage', account: '5110', net: '277078.45', paidFrom: '1000', method: 'ACH' },
  { date: '2026-01-05', supplier: 'Flow Business', trn: '000-xxx-203', description: 'Internet & landlines', account: '5300', net: '80100.00', paidFrom: '1000', method: 'ACH' },
  { date: '2026-01-08', supplier: 'National Water Commission (NWC)', trn: '000-xxx-009', description: 'Water', account: '5120', net: '30417.39', paidFrom: '1000', method: 'ACH' },
  { date: '2026-01-16', supplier: 'Supreme Court Registry', description: 'Filing fees – claim', account: '1120', net: '14500.00', tax: 'OUT', paidFrom: '1000', method: 'Cheque', ref: '004813' },
  // No receipt: no input GCT claimed; the bank's 12,800.00 is used (the register shows 12,799.99).
  { date: '2026-01-19', supplier: 'TotalEnergies Half Way Tree', trn: '000-xxx-771', description: 'Fuel – partner vehicle', account: '5330', net: '11130.43', gct: '1669.57', paidFrom: '1000', method: 'POS – NCB', receipt: false },
  { date: '2026-01-21', supplier: 'Digicel Business', trn: '000-xxx-302', description: 'Mobile plans', account: '5300', net: '53347.83', paidFrom: '1000', method: 'ACH' },
  { date: '2026-01-22', supplier: 'LexisNexis', description: 'Legal research subscription', account: '5220', net: '392250.00', tax: 'OUT', paidFrom: '1000', method: 'FX purchase', foreign: 'USD 2,500.00 at 156.90' },
  { date: '2026-01-24', supplier: 'Courier Express JA', trn: '000-xxx-650', description: 'Courier – documents to Montego Bay', account: '1120', net: '4500.00', paidFrom: '1020', method: 'Petty cash', matter: 'M-0405' },
  { date: '2026-01-27', supplier: 'Secure Guard JA Ltd', trn: '000-xxx-889', description: 'Security services – January', account: '5130', net: '165217.39', paidFrom: '1000', method: 'Cheque', ref: '004814' },
  { date: '2026-01-28', supplier: 'PI Insurer', trn: '000-xxx-120', description: 'Professional indemnity – monthly', account: '5200', net: '400000.00', tax: 'EXEMPT', paidFrom: '1000', method: 'Direct debit' },
  { date: '2026-01-29', supplier: 'Valuation surveyor', trn: '000-xxx-347', description: 'Valuation – Estate of A.R. property', account: '1120', net: '70000.00', paidFrom: '1000', method: 'Cheque', ref: '004815', matter: 'M-0411' },
];

async function seedJanuaryExpenses(db: Db, ledger: LedgerGateway, scope: Scope, log: (line: string) => void): Promise<void> {
  const ctx = { db, ledger };
  const loaded = await db.query(`SELECT 1 FROM app.expenses WHERE org_id = $1 AND NOT brought_forward LIMIT 1`, [scope.org.id]);
  if (loaded.rowCount) { log('January expenses already loaded.'); return; }
  const january = (await ledger.listPeriods(scope.actor)).find((p) => p.startDate === '2026-01-01');
  if (january?.state !== 'open') { log('January expenses not loaded: January 2026 is not open.'); return; }
  if (!(await getPayableSettings(db, scope.org.id))?.set_up_at) {
    const set = await savePayableSettings(ctx, scope, { payableAccount: '2000', inputGctAccount: '1160', disbursementAccount: '1120' });
    log(`Expenses set up; owed to suppliers brought forward ${set.broughtForward}`);
  }
  const suppliers = new Map<string, string>();
  const supplier = async (name: string, trn = '') => {
    if (!suppliers.has(name)) suppliers.set(name, (await createSupplier(ctx, scope, { name, trn })).id);
    return suppliers.get(name)!;
  };
  for (const e of EXPENSES) {
    await createExpense(ctx, scope, {
      supplierId: await supplier(e.supplier, e.trn), expenseDate: e.date, description: e.description, settlement: 'paid', paidFrom: e.paidFrom,
      paymentMethod: e.method, paymentRef: e.ref ?? '', receiptOnFile: e.receipt ?? true, foreignAmount: e.foreign ?? '',
      lines: [{ account: e.account, description: e.description, net: e.net, gct: e.gct ?? '', taxCode: e.tax ?? 'GCT15', matterRef: e.matter ?? '' }],
      record: true,
    });
  }
  // Waiting for the principal / interest split from NCB's loan statement: kept as a draft, nothing posted.
  await createExpense(ctx, scope, {
    supplierId: await supplier('NCB Motor Loan'), expenseDate: '2026-01-26', description: 'Loan instalment (principal + interest)', settlement: 'paid', paidFrom: '1000',
    paymentMethod: 'ACH', notes: 'Waiting for the principal / interest split from the NCB loan statement.',
    lines: [{ account: '2500', description: 'Loan instalment – split principal (2500) and interest (5410)', net: '318400.00', taxCode: 'OUT' }],
  });
  log(`January expenses: ${EXPENSES.length} recorded, 1 draft waiting for information`);
}

// ---------- January 2026 bank statement (sample data pack: TX_BankStatement) ----------

/**
 * Imports January's NCB statement and works most of it, leaving a short hands-on list for testers:
 * the two-cheque lodgement (the app suggests both receipts), the three partner drawings and the two bank
 * charges (rules suggest the account). The loan instalment stays unentered (waiting for its split) and
 * cheque 004815 to the valuation surveyor stays unpresented.
 */
async function seedJanuaryBank(db: Db, ledger: LedgerGateway, scope: Scope, log: (line: string) => void): Promise<void> {
  const ctx = { db, ledger };
  const loaded = await db.query('SELECT 1 FROM app.bank_statements WHERE org_id = $1 LIMIT 1', [scope.org.id]);
  if (loaded.rowCount) { log('January bank statement already loaded.'); return; }
  const january = (await ledger.listPeriods(scope.actor)).find((p) => p.startDate === '2026-01-01');
  if (january?.state !== 'open') { log('January bank statement not loaded: January 2026 is not open.'); return; }
  const receivables = await db.query('SELECT 1 FROM app.receipts WHERE org_id = $1 LIMIT 1', [scope.org.id]);
  const payables = await db.query('SELECT 1 FROM app.expenses WHERE org_id = $1 AND NOT brought_forward LIMIT 1', [scope.org.id]);
  if (!receivables.rowCount || !payables.rowCount) { log('January bank statement not loaded: January receipts and expenses are not loaded.'); return; }

  await importStatement(ctx, scope, { accountCode: '1000', fileName: 'bank-statement-2026-01.csv', csv: await readFile(seedDir + 'bank-statement-2026-01.csv', 'utf8') });
  // Rules the testers will see suggested.
  for (const [text, account, description] of [['SERVICE CHARGE', '5400', 'Bank service charge'], ['GCT ON BANK CHARGES', '5400', 'GCT on bank charges (no tax invoice)']] as const) {
    await db.query('INSERT INTO app.bank_rules (id, org_id, contains_text, target_account, description, created_by) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [scope.org.id, text, account, description, scope.actor.actorId]);
  }

  const line = async (text: string) => (await bankOverview(ctx, scope, '1000')).lines.find((l) => l.description.includes(text))!;
  const customer = async (name: string) => (await db.query<{ id: string }>('SELECT id FROM app.customers WHERE org_id = $1 AND name = $2', [scope.org.id, name])).rows[0]!.id;
  const bf = (await db.query<{ customer_id: string; id: string }>('SELECT customer_id, id FROM app.fee_notes WHERE org_id = $1 AND brought_forward', [scope.org.id])).rows[0]!;
  const feeNote = async (n: string) => (await db.query<{ id: string }>('SELECT id FROM app.fee_notes WHERE org_id = $1 AND number = $2', [scope.org.id, n])).rows[0]!.id;
  const receiptEntry = async (amountMinor: string, method: string) => (await db.query<{ entry_id: string }>(
    'SELECT entry_id FROM app.receipts WHERE org_id = $1 AND amount_minor = $2 AND method = $3', [scope.org.id, amountMinor, method])).rows[0]!.entry_id;

  // 1. Accept the app's suggestion for every line already in the books, except the lodgement (left for testers).
  const overview = await bankOverview(ctx, scope, '1000');
  let matched = 0;
  for (const l of overview.lines) {
    if (!l.suggestion || l.description.includes('LODGEMENT')) continue;
    await matchLine(ctx, scope, { lineId: l.id, entryIds: l.suggestion.entryIds });
    matched += 1;
  }
  // 2. Fee notes from before the system, paid in January (against the brought-forward balance).
  for (const [text, reference] of [
    ['FEES FN-2025-1201', 'Transfer from client a/c - FN-2025-1201 (M-0317)'],
    ['CARIB TELECOM', 'Carib Telecom Ltd - FN-2025-1240'],
    ['BLUE MOUNTAIN RESORTS', 'Blue Mountain Resorts Ltd - 2 fee notes'],
  ] as const) {
    await createFromLine(ctx, scope, { lineId: (await line(text)).id, kind: 'receipt', customerId: bf.customer_id, allocateTo: bf.id, reference });
  }
  // 3. Transfers from the client account paying January fee notes (office side; the client side comes in 1b).
  await createFromLine(ctx, scope, { lineId: (await line('FN-2026-0001')).id, kind: 'receipt', customerId: await customer('Client 0388'), allocateTo: await feeNote('FN-2026-0001'), reference: 'Transfer from client a/c - FN-2026-0001 (M-0388)' });
  await createFromLine(ctx, scope, { lineId: (await line('FN-2026-0003')).id, kind: 'receipt', customerId: await customer('Client 0415'), allocateTo: await feeNote('FN-2026-0003'), reference: 'Transfer from client a/c - FN-2026-0003 (M-0415)' });
  // 4. WiPay settlement: the two card receipts already recorded, plus 83,600 not yet identified.
  const wipay = await line('WIPAY');
  await matchLine(ctx, scope, { lineId: wipay.id, entryIds: [await receiptEntry('1725000', 'Card (WiPay)'), await receiptEntry('11345000', 'Card (WiPay)')] });
  await createFromLine(ctx, scope, { lineId: wipay.id, kind: 'receipt', reference: 'WiPay settlement - not yet identified' });
  // 5. Bank-only items.
  for (const [text, account, description, flag, remember] of [
    ['GCT RETURN DEC 2025', '2100', 'GCT return December 2025 paid to TAJ', '', 'TAJ ONLINE - GCT RETURN'],
    ['S01 STATUTORY', '2110', 'S01 statutory deductions December paid to TAJ', '', 'TAJ ONLINE - S01'],
    ['INTEREST CREDIT', '4500', 'Interest on operating account', '', 'INTEREST CREDIT'],
    ['SALARIES 1ST HALF', '5000', 'Salaries 1st half January (net pay)', 'Payroll register needed', 'PAYROLL BATCH'],
    ['SALARIES 2ND HALF', '5000', 'Salaries 2nd half January (net pay)', 'Payroll register needed', 'PAYROLL BATCH'],
  ] as const) {
    await createFromLine(ctx, scope, { lineId: (await line(text)).id, kind: 'entry', targetAccount: account, description, flag, remember });
  }
  log(`January bank statement: 33 lines imported; ${matched + 1} matched to entries already in the books, 10 entered from the bank, 6 left to work, 1 waiting (loan instalment)`);
}
