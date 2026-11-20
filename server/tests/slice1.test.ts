import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PASSWORD, TEST_DATABASE_URL, readSeed, ref, setup, signIn, type Harness } from './helpers.ts';

/**
 * Slice 1 acceptance (design pack, Verification): isolation, read-only clients, opening
 * balances, idempotency and server-side enforcement. Needs TEST_DATABASE_URL.
 */
describe.skipIf(!TEST_DATABASE_URL)('slice 1 acceptance', () => {
  let h: Harness;
  let accountant: Awaited<ReturnType<typeof signIn>>;
  let hvViewer: Awaited<ReturnType<typeof signIn>>;
  let bmViewer: Awaited<ReturnType<typeof signIn>>;
  let hvOrgRef: ReturnType<typeof ref>;
  let accountIds: Record<string, string>;
  let periodId: string;

  const act = (who: typeof accountant, actionId: string, object: object, input: unknown, idempotencyKey?: string) =>
    who.post(`/api/workspace/actions/${actionId}`, { object, input, ...(idempotencyKey ? { idempotencyKey } : {}) });

  beforeAll(async () => {
    h = await setup();
    accountant = await signIn(h.app, 'accountant@firm.test');
    hvViewer = await signIn(h.app, 'hv@firm.test');
    bmViewer = await signIn(h.app, 'bm@firm.test');
    hvOrgRef = ref(h.firmId, h.orgs.harbourview, 'client-organisation', h.orgs.harbourview);
  });
  afterAll(async () => { await h?.close(); });

  it('loads the Harbourview chart, opens January and posts opening balances that total 455,289,935.10', async () => {
    const coa = await act(accountant, 'coa.import', hvOrgRef, { csv: await readSeed('chart-of-accounts.csv') }, 'coa-import-0001');
    expect(coa.status).toBe(200);
    expect(coa.body.execution.result).toMatchObject({ created: 67, alreadyPresent: 0, errors: [] });

    const again = await act(accountant, 'coa.import', hvOrgRef, { csv: await readSeed('chart-of-accounts.csv') }, 'coa-import-0002');
    expect(again.body.execution.result).toMatchObject({ created: 0, alreadyPresent: 67 });

    const tbCsv = await readSeed('trial-balance-2025-12-31.csv');
    const early = await act(accountant, 'opening-balances.post', hvOrgRef, { csv: tbCsv }, 'opening-0001');
    expect(early.status).toBe(422);
    expect(early.body.error).toBe('NO_OPEN_PERIOD');

    const period = await act(accountant, 'period.open', hvOrgRef, {}, 'period-open-0001');
    expect(period.status).toBe(200);
    expect(period.body.execution.result).toMatchObject({ startDate: '2026-01-01', endDate: '2026-01-31', state: 'open' });
    periodId = period.body.execution.result.periodId;

    const posted = await act(accountant, 'opening-balances.post', hvOrgRef, { csv: tbCsv }, 'opening-0002');
    expect(posted.status).toBe(200);
    expect(posted.body.execution.result).toMatchObject({ totalDebits: '455,289,935.10', totalCredits: '455,289,935.10' });

    const tb = await hvViewer.get(`/api/orgs/${h.orgs.harbourview}/trial-balance`);
    expect(tb.status).toBe(200);
    expect(tb.body.totalDebits.amount).toBe(tb.body.totalCredits.amount);

    const accounts = await accountant.get(`/api/orgs/${h.orgs.harbourview}/accounts`);
    accountIds = Object.fromEntries(accounts.body.accounts.map((a: { code: string; accountId: string }) => [a.code, a.accountId]));
    const cash = accounts.body.accounts.find((a: { code: string }) => a.code === '1000');
    expect(cash.balance).toBe('845231055');
  });

  it('answers the health check without sign-in on /api/health and /healthz', async () => {
    for (const path of ['/api/health', '/healthz']) {
      const res = await request(h.app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
  });

  it('posts opening balances only once', async () => {
    const res = await act(accountant, 'opening-balances.post', hvOrgRef, { csv: await readSeed('trial-balance-2025-12-31.csv') }, 'opening-0003');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('OPENING_BALANCES_EXIST');
  });

  it('an idempotency key repeats the first result instead of acting twice', async () => {
    const first = await act(accountant, 'period.open', hvOrgRef, {}, 'period-open-feb-0001');
    const second = await act(accountant, 'period.open', hvOrgRef, {}, 'period-open-feb-0001');
    expect(first.body.execution.executionId).toBe(second.body.execution.executionId);
    const periods = await accountant.get(`/api/orgs/${h.orgs.harbourview}/periods`);
    expect(periods.body.periods.map((p: { startDate: string }) => p.startDate)).toEqual(['2026-02-01', '2026-01-01']);
  });

  describe('client isolation', () => {
    it('returns not-found for every Harbourview read made by the other client', async () => {
      for (const path of ['', '/accounts', '/trial-balance', '/periods', '/activity', `/accounts/${accountIds['1000']}/ledger`]) {
        const res = await bmViewer.get(`/api/orgs/${h.orgs.harbourview}${path}`);
        expect(res.status, path).toBe(404);
      }
    });
    it('does not resolve, search or authorise Harbourview objects for the other client', async () => {
      const accountRef = ref(h.firmId, h.orgs.harbourview, 'account', accountIds['1000']!);
      expect((await bmViewer.post('/api/workspace/resolve', { reference: accountRef })).status).toBe(404);
      expect((await bmViewer.post('/api/workspace/search', { organisationId: h.orgs.harbourview, query: 'cash', limit: 10 })).status).toBe(404);
      const access = await bmViewer.post('/api/workspace/access', {
        actor: { principalReference: bmViewer.me.user.id, sessionReference: bmViewer.me.user.sessionRef, tenantId: h.firmId, organisationId: h.orgs.harbourview },
        object: accountRef, actionId: 'workspace.open', correlationId: 'c1', purpose: 'WORKSPACE_OPEN',
      });
      expect(access.body.outcome).toBe('DENY');
    });
    it('does not let an accountant reach a Harbourview account through the Blue Mountain client', async () => {
      const crossRef = ref(h.firmId, h.orgs.blueMountain, 'account', accountIds['1000']!);
      expect((await accountant.post('/api/workspace/resolve', { reference: crossRef })).status).toBe(404);
      expect((await act(accountant, 'account.deactivate', crossRef, {}, 'cross-0001')).status).toBe(404);
    });
    it('treats malformed and unknown client IDs as not found', async () => {
      expect((await accountant.get('/api/orgs/not-a-uuid/accounts')).status).toBe(404);
      expect((await accountant.get('/api/orgs/00000000-0000-4000-8000-000000000000/accounts')).status).toBe(404);
    });
  });

  describe('client viewers are read-only', () => {
    it('refuses every action with 403 even when sent directly', async () => {
      expect((await act(hvViewer, 'period.open', hvOrgRef, {}, 'viewer-0001')).status).toBe(403);
      expect((await act(hvViewer, 'coa.import', hvOrgRef, { csv: 'x' }, 'viewer-0002')).status).toBe(403);
      const accountRef = ref(h.firmId, h.orgs.harbourview, 'account', accountIds['1000']!);
      expect((await act(hvViewer, 'account.deactivate', accountRef, {}, 'viewer-0003')).status).toBe(403);
      expect((await hvViewer.post('/api/admin/organisations', { name: 'X', openingDate: '2026-01-01' })).status).toBe(403);
    });
    it('cannot see staff-only views', async () => {
      expect((await hvViewer.get(`/api/orgs/${h.orgs.harbourview}/periods`)).status).toBe(403);
      const periodRef = ref(h.firmId, h.orgs.harbourview, 'period', periodId);
      expect((await hvViewer.post('/api/workspace/resolve', { reference: periodRef })).status).toBe(404);
    });
    it('can read its own statements and ledger', async () => {
      expect((await hvViewer.get(`/api/orgs/${h.orgs.harbourview}/accounts/${accountIds['1000']}/ledger?from=2026-01-01&to=2026-12-31`)).status).toBe(200);
    });
  });

  describe('workspace access decisions', () => {
    it('allows an accountant to open an account and invoke its actions, and denies a forged actor', async () => {
      const accountRef = ref(h.firmId, h.orgs.harbourview, 'account', accountIds['1100']!);
      const actor = { principalReference: accountant.me.user.id, sessionReference: accountant.me.user.sessionRef, tenantId: h.firmId, organisationId: h.orgs.harbourview };
      const base = { object: accountRef, correlationId: 'c2' };
      expect((await accountant.post('/api/workspace/access', { ...base, actor, actionId: 'workspace.open', purpose: 'WORKSPACE_OPEN' })).body.outcome).toBe('ALLOW');
      expect((await accountant.post('/api/workspace/access', { ...base, actor, actionId: 'account.update', purpose: 'ACTION_INVOKE' })).body.outcome).toBe('ALLOW');
      expect((await accountant.post('/api/workspace/access', { ...base, actor, actionId: 'period.open', purpose: 'ACTION_INVOKE' })).body.outcome).toBe('DENY');
      const forged = { ...actor, principalReference: hvViewer.me.user.id };
      expect((await accountant.post('/api/workspace/access', { ...base, actor: forged, actionId: 'workspace.open', purpose: 'WORKSPACE_OPEN' })).body).toMatchObject({ outcome: 'DENY', reasonCode: 'ACTOR_NOT_SESSION' });
    });
    it('updates an account classification and rejects an invalid one', async () => {
      const accountRef = ref(h.firmId, h.orgs.harbourview, 'account', accountIds['1110']!);
      const ok = await act(accountant, 'account.update', accountRef, { classification: 'BS.CA.OTHER.WIP' }, 'acct-update-0001');
      expect(ok.status).toBe(200);
      expect(ok.body.execution.result.classification).toBe('BS.CA.OTHER.WIP');
      expect((await act(accountant, 'account.update', accountRef, { classification: 'nonsense' }, 'acct-update-0002')).status).toBe(400);
    });
  });

  describe('sessions and requests', () => {
    it('requires sign-in and the CSRF header', async () => {
      expect((await request(h.app).get(`/api/orgs/${h.orgs.harbourview}/accounts`)).status).toBe(401);
      const noHeader = await accountant.agent.post('/api/workspace/actions/period.open').send({ object: hvOrgRef, input: {} });
      expect(noHeader.status).toBe(403);
    });
    it('rejects a wrong password with a generic message', async () => {
      const res = await request(h.app).post('/api/auth/sign-in').set('x-jam-csrf', '1').send({ email: 'accountant@firm.test', password: PASSWORD + 'x' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
    });
    it('revoking an assignment removes access at once', async () => {
      const admin = await signIn(h.app, 'admin@firm.test');
      expect((await admin.agent.delete('/api/admin/assignments').set('x-jam-csrf', '1').send({ userId: h.users.reviewer, orgId: h.orgs.harbourview })).status).toBe(200);
      const reviewer = await signIn(h.app, 'reviewer@firm.test');
      expect((await reviewer.get(`/api/orgs/${h.orgs.harbourview}/trial-balance`)).status).toBe(404);
    });
    it('locks an account after five failed sign-ins (Authentication Runtime lockout policy)', async () => {
      const attempt = () => request(h.app).post('/api/auth/sign-in').set('x-jam-csrf', '1').send({ email: 'bm@firm.test', password: 'Wrong-Password-000' });
      for (let i = 0; i < 5; i += 1) expect((await attempt()).status).toBe(401);
      expect((await attempt()).status).toBe(429);
      const correct = await request(h.app).post('/api/auth/sign-in').set('x-jam-csrf', '1').send({ email: 'bm@firm.test', password: PASSWORD });
      expect(correct.status).toBe(429);
    });
    it('records refused actions against the actor\'s own client', async () => {
      await act(hvViewer, 'period.open', hvOrgRef, {}, 'viewer-denied-0001');
      const denied = await h.db.query<{ org_id: string }>(`SELECT org_id FROM app.audit WHERE action = 'access.denied' AND actor_id = $1`, [h.users.hvViewer]);
      expect(denied.rows.length).toBeGreaterThan(0);
      expect(denied.rows.every((r) => r.org_id === h.orgs.harbourview)).toBe(true);
      const crossNoise = await h.db.query(`SELECT 1 FROM app.audit WHERE action = 'access.denied' AND org_id = $1`, [h.orgs.harbourview]);
      const bmEntries = await h.db.query(`SELECT 1 FROM app.audit WHERE action = 'access.denied' AND org_id = $1 AND actor_id = $2`, [h.orgs.harbourview, h.users.bmViewer]);
      expect(crossNoise.rowCount).toBeGreaterThan(0);
      expect(bmEntries.rowCount).toBe(0);
    });
    it('records user access changes and imports in the client activity', async () => {
      const activity = await accountant.get(`/api/orgs/${h.orgs.harbourview}/activity`);
      const actions = activity.body.items.map((i: { what: string }) => i.what);
      expect(actions).toEqual(expect.arrayContaining(['coa.import', 'opening-balances.post', 'assignment.revoke', 'PostOpeningBalances']));
    });
  });
});
