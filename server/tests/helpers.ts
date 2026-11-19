import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { createPool, migrate, type Db } from '../src/db/db.ts';
import { LedgerGateway } from '../src/ledger/gateway.ts';
import { createApp } from '../src/http/app.ts';
import { loadConfig } from '../src/config.ts';
import { createUser, assign } from '../src/services/users.ts';
import { createOrganisation } from '../src/services/organisations.ts';
import type { Role } from '../../shared/workspace-model.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const PASSWORD = 'correct horse battery staple';
export const seedDir = fileURLToPath(new URL('../../seed/harbourview/', import.meta.url));
export const readSeed = (name: string) => readFile(seedDir + name, 'utf8');

export interface Harness {
  db: Db;
  app: Express;
  ledger: LedgerGateway;
  firmId: string;
  users: Record<'admin' | 'accountant' | 'reviewer' | 'hvViewer' | 'bmViewer', string>;
  orgs: { harbourview: string; blueMountain: string };
  close(): Promise<void>;
}

/** A fresh database (app and ledger schemas dropped), two clients and five users. */
export async function setup(): Promise<Harness> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, DECISION_SIGNING_KEY: 't'.repeat(48), FIRM_ID: 'firm-test' });
  const db = createPool(TEST_DATABASE_URL);
  await db.query('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS bookkeeping CASCADE;');
  await migrate(db);
  const ledger = await LedgerGateway.create(db, config.decisionSigningKey);
  const app = createApp({ db, ledger, config });

  const mk = async (email: string, admin = false) => (await createUser(db, null, { email, displayName: email, password: PASSWORD, isFirmAdmin: admin })).id;
  const users = {
    admin: await mk('admin@firm.test', true),
    accountant: await mk('accountant@firm.test'),
    reviewer: await mk('reviewer@firm.test'),
    hvViewer: await mk('hv@firm.test'),
    bmViewer: await mk('bm@firm.test'),
  };
  const harbourview = (await createOrganisation(db, ledger, users.admin, { name: 'Harbourview Chambers', openingDate: '2026-01-01' })).id;
  const blueMountain = (await createOrganisation(db, ledger, users.admin, { name: 'Blue Mountain Traders', openingDate: '2026-01-01' })).id;
  const grants: [string, string, Role][] = [
    [users.accountant, harbourview, 'accountant'], [users.reviewer, harbourview, 'reviewer'], [users.hvViewer, harbourview, 'client_viewer'],
    [users.accountant, blueMountain, 'accountant'], [users.bmViewer, blueMountain, 'client_viewer'],
  ];
  for (const [userId, orgId, role] of grants) await assign(db, users.admin, { userId, orgId, role });
  return { db, app, ledger, firmId: config.firmId, users, orgs: { harbourview, blueMountain }, close: () => db.end() };
}

/** A signed-in agent with the CSRF header on every request. */
export async function signIn(app: Express, email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/sign-in').set('x-jam-csrf', '1').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await agent.get('/api/auth/me');
  return {
    agent,
    me: me.body as { user: { id: string; sessionRef: string }; firmId: string },
    get: (url: string) => agent.get(url),
    post: (url: string, body: unknown) => agent.post(url).set('x-jam-csrf', '1').send(body as object),
  };
}

export function ref(firmId: string, orgId: string, objectTypeId: string, objectId: string) {
  return { applicationId: 'jam-accounting', tenantId: firmId, organisationId: orgId, objectTypeId, objectId };
}
