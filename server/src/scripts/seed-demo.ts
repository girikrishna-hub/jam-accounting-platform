/**
 * Loads the demo data. Usage: DEMO_PASSWORD=... npm run seed:demo  (used for every demo user; see PASSWORD_RULE)
 */
import { loadConfig } from '../config.ts';
import { createPool, migrate } from '../db/db.ts';
import { LedgerGateway } from '../ledger/gateway.ts';
import { AccessAuthority } from '../access/authority.ts';
import { seedDemo } from '../demo/seed.ts';
import { PASSWORD_RULE, checkPassword } from '../auth/passwords.ts';

const password = process.env.DEMO_PASSWORD;
if (!password || !checkPassword(password).ok) {
  console.error(`Set DEMO_PASSWORD. It is used for every demo user. ${PASSWORD_RULE}`);
  process.exit(1);
}
const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
await seedDemo(db, await LedgerGateway.create(db, config.decisionSigningKey, new AccessAuthority(config.firmId)), password);
await db.end();
