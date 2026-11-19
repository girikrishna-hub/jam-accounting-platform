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

  const actor = { actorId: accountantId, principal: 'accountant' as const, ledgerId: harbourview.ledger_id! };
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

  log('\nDemo users (password = DEMO_PASSWORD):');
  log('  admin@demo.firm          firm administrator');
  log('  accountant@demo.firm     accountant for both clients');
  log('  reviewer@demo.firm       reviewer for Harbourview');
  log('  owner@harbourview.demo   client viewer, Harbourview only');
  log('  owner@bluemountain.demo  client viewer, Blue Mountain only');
}
