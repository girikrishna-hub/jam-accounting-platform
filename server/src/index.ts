import { loadConfig } from './config.ts';
import { createPool, migrate } from './db/db.ts';
import { LedgerGateway } from './ledger/gateway.ts';
import { createApp } from './http/app.ts';
import { seedDemo } from './demo/seed.ts';
import { PASSWORD_RULE, checkPassword } from './auth/passwords.ts';
import { createUser } from './services/users.ts';
import { AccessAuthority } from './access/authority.ts';
import { audit } from './audit.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
const access = new AccessAuthority(config.firmId, (q, decision, reason) => audit(db, {
  // Recorded against the user's own client, so one client's activity never shows another client's users.
  actorId: q.userId, orgId: q.assignedOrganisationId, action: 'access.denied', target: `${q.resourceType}:${q.resourceId}`,
  outcome: 'rejected', detail: { action: q.action, role: q.role, decision, reason },
}).catch(() => undefined));
const ledger = await LedgerGateway.create(db, config.decisionSigningKey, access);

// Optional start-up setup, so no one has to run database commands by hand.
// SEED_DEMO=1 with DEMO_PASSWORD loads the demo clients and users (skips anything already there).
if (process.env.SEED_DEMO === '1') {
  const password = process.env.DEMO_PASSWORD ?? '';
  if (!checkPassword(password).ok) console.error(`SEED_DEMO=1 needs a valid DEMO_PASSWORD; demo not loaded. ${PASSWORD_RULE}`);
  else await seedDemo(db, ledger, password, (line) => console.log(`[demo] ${line}`));
}
// ADMIN_EMAIL and ADMIN_PASSWORD create the first firm administrator when none exists yet.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const admins = await db.query('SELECT 1 FROM app.users WHERE is_firm_admin');
  if (!admins.rowCount) {
    await createUser(db, null, { email: process.env.ADMIN_EMAIL, displayName: process.env.ADMIN_NAME ?? 'Firm administrator', password: process.env.ADMIN_PASSWORD, isFirmAdmin: true });
    console.log(`Created firm administrator ${process.env.ADMIN_EMAIL}.`);
  }
}

const app = createApp({ db, ledger, access, config });
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Listening on port ${config.port}`));

// No event consumers in release 1: drain the ledger outbox every 30 seconds.
const drain = setInterval(() => { ledger.dispatchEvents().catch((e) => console.error('Event dispatch failed', e)); }, 30_000);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(drain);
    server.close(() => { void db.end().then(() => process.exit(0)); });
  });
}
