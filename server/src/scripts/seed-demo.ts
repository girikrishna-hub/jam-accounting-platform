/**
 * Loads the fictitious Harbourview Chambers demo (Jamaica sample data pack):
 * a firm admin, an accountant, a reviewer and a client viewer; the client with its 67-account
 * chart, January 2026 open, and opening balances from the 31 Dec 2025 trial balance.
 * A second, empty client ("Blue Mountain Traders") is created to demonstrate isolation.
 *
 * Usage: DEMO_PASSWORD=... npm run seed:demo   (one password for all demo users, 12+ characters)
 * Safe to run twice: existing users, clients, accounts and the opening journal are left as they are.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { createPool, migrate } from '../db/db.ts';
import { LedgerGateway } from '../ledger/gateway.ts';
import { createUser, assign } from '../services/users.ts';
import { createOrganisation, getOrganisation, type OrganisationRow } from '../services/organisations.ts';
import { importChartOfAccounts, openNextPeriod, postOpeningBalances } from '../services/books.ts';
import type { Role } from '../../../shared/workspace-model.ts';

const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set DEMO_PASSWORD (at least 12 characters). It is used for every demo user.');
  process.exit(1);
}

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const ledger = await LedgerGateway.create(db, config.decisionSigningKey);
const seedDir = fileURLToPath(new URL('../../../seed/harbourview/', import.meta.url));

async function user(email: string, displayName: string, isFirmAdmin = false): Promise<string> {
  const found = await db.query<{ id: string }>('SELECT id FROM app.users WHERE email = $1', [email]);
  if (found.rows[0]) return found.rows[0].id;
  return (await createUser(db, null, { email, displayName, password: password!, isFirmAdmin })).id;
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

const actor = { actorId: accountantId, principal: 'accountant' as const, ledgerId: harbourview.ledger_id! };
const coa = await importChartOfAccounts(db, ledger, actor, harbourview.id, await readFile(seedDir + 'chart-of-accounts.csv', 'utf8'));
console.log(`Chart of accounts: ${coa.created} created, ${coa.alreadyPresent} already present, ${coa.errors.length} errors`);
for (const e of coa.errors) console.log(`  line ${e.line}: ${e.message}`);

const periods = await ledger.listPeriods(actor);
if (!periods.length) {
  const p = await openNextPeriod(ledger, actor, harbourview);
  console.log(`Opened period ${p.startDate} to ${p.endDate}`);
}

const tb = await ledger.getTrialBalance(actor);
if (tb.totalDebits.amount === '0') {
  const result = await postOpeningBalances(db, ledger, actor, harbourview, await readFile(seedDir + 'trial-balance-2025-12-31.csv', 'utf8'));
  console.log(`Opening balances posted: ${result.lines} lines, debits ${result.totalDebits}, credits ${result.totalCredits}`);
} else {
  console.log('Opening balances already posted.');
}

console.log('\nDemo users (password = DEMO_PASSWORD):');
console.log('  admin@demo.firm          firm administrator');
console.log('  accountant@demo.firm     accountant for both clients');
console.log('  reviewer@demo.firm       reviewer for Harbourview');
console.log('  owner@harbourview.demo   client viewer, Harbourview only');
console.log('  owner@bluemountain.demo  client viewer, Blue Mountain only');
await db.end();
