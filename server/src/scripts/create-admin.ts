/**
 * Creates the first firm administrator.
 * Usage: ADMIN_EMAIL=... ADMIN_NAME="..." ADMIN_PASSWORD=... npm run create-admin
 */
import { loadConfig } from '../config.ts';
import { createPool, migrate } from '../db/db.ts';
import { createUser } from '../services/users.ts';

const email = process.env.ADMIN_EMAIL;
const name = process.env.ADMIN_NAME ?? 'Firm administrator';
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters).');
  process.exit(1);
}

const db = createPool(loadConfig().databaseUrl);
await migrate(db);
const existing = await db.query('SELECT 1 FROM app.users WHERE email = $1', [email.toLowerCase()]);
if (existing.rowCount) {
  console.log(`${email} already exists; nothing changed.`);
} else {
  await createUser(db, null, { email, displayName: name, password, isFirmAdmin: true });
  console.log(`Created firm administrator ${email}.`);
}
await db.end();
