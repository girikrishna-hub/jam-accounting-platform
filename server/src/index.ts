import { loadConfig } from './config.ts';
import { createPool, migrate } from './db/db.ts';
import { LedgerGateway } from './ledger/gateway.ts';
import { createApp } from './http/app.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
const ledger = await LedgerGateway.create(db, config.decisionSigningKey);

const app = createApp({ db, ledger, config });
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Listening on port ${config.port}`));

// No event consumers in release 1: drain the ledger outbox every 30 seconds.
const drain = setInterval(() => { ledger.dispatchEvents().catch((e) => console.error('Event dispatch failed', e)); }, 30_000);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(drain);
    server.close(() => { void db.end().then(() => process.exit(0)); });
  });
}
