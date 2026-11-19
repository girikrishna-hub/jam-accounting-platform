/**
 * Loads the demo data. Usage: DEMO_PASSWORD=... npm run seed:demo  (12+ characters, used for every demo user)
 */
import { loadConfig } from '../config.ts';
import { createPool, migrate } from '../db/db.ts';
import { LedgerGateway } from '../ledger/gateway.ts';
import { seedDemo } from '../demo/seed.ts';

const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set DEMO_PASSWORD (at least 12 characters). It is used for every demo user.');
  process.exit(1);
}
const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
await seedDemo(db, await LedgerGateway.create(db, config.decisionSigningKey), password);
await db.end();
