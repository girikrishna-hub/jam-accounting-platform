import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../errors.ts';
import { requireAllowed } from '../../access/checks.ts';
import { orgScope, scopeOf, type AppContext } from '../middleware.ts';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Reads that back the capability panels. Each asks the same capability question the workspace asks. */
const clientCapability = (ctx: AppContext, res: Parameters<typeof scopeOf>[0], capabilityId: string) => {
  const scope = scopeOf(res);
  return requireAllowed(ctx, scope, 'client-organisation', scope.org.id, `capability.${capabilityId}.view`);
};

export function orgRoutes(ctx: AppContext): Router {
  const r = Router({ mergeParams: true });
  r.use(orgScope(ctx));

  r.get('/', async (_req, res) => {
    await clientCapability(ctx, res, 'overview');
    const { org, role } = scopeOf(res);
    res.json({
      id: org.id, name: org.name, legalName: org.legal_name, trn: org.trn, country: org.country, currency: org.currency,
      financialYearStart: org.financial_year_start, openingDate: org.opening_date, status: org.status, role,
    });
  });

  r.get('/accounts', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'chart-of-accounts');
    const [accounts, tb] = await Promise.all([ctx.ledger.listAccounts(scope.actor), ctx.ledger.getTrialBalance(scope.actor)]);
    const balance = new Map(tb.rows.map((row) => [row.account.accountId, row.balance.amount]));
    res.json({
      currency: scope.org.currency,
      accounts: accounts
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
        .map((a) => ({ ...a, balance: balance.get(a.accountId) ?? '0' })),
    });
  });

  r.get('/accounts/:accountId/ledger', async (req, res) => {
    const scope = scopeOf(res);
    const accountId = z.string().max(128).parse(req.params.accountId);
    await requireAllowed(ctx, scope, 'account', accountId, 'capability.ledger.view');
    const from = ISO_DATE.parse(req.query.from ?? scope.org.opening_date);
    const to = ISO_DATE.parse(req.query.to ?? new Date().toISOString().slice(0, 10));
    const accounts = await ctx.ledger.listAccounts(scope.actor);
    const account = accounts.find((a) => a.accountId === accountId);
    if (!account) throw notFound();
    const lines = await ctx.ledger.getAccountLedger(scope.actor, accountId, from, to);
    res.json({ account, from, to, currency: scope.org.currency, lines });
  });

  r.get('/periods', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'periods');
    const periods = await ctx.ledger.listPeriods(scope.actor);
    res.json({ periods: periods.sort((a, b) => b.startDate.localeCompare(a.startDate)) });
  });

  r.get('/trial-balance', async (req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'trial-balance');
    const asOf = req.query.asOf === undefined ? undefined : ISO_DATE.parse(req.query.asOf);
    const tb = await ctx.ledger.getTrialBalance(scope.actor, asOf);
    res.json({
      ...tb,
      currency: scope.org.currency,
      rows: tb.rows
        .filter((row) => row.balance.amount !== '0')
        .sort((a, b) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true })),
    });
  });

  r.get('/activity', async (_req, res) => {
    const scope = scopeOf(res);
    await clientCapability(ctx, res, 'activity');
    const [app, ledger] = await Promise.all([
      ctx.db.query<{ at: string; action: string; outcome: string; display_name: string | null }>(
        `SELECT a.at, a.action, a.outcome, u.display_name FROM app.audit a LEFT JOIN app.users u ON u.id = a.actor_id
         WHERE a.org_id = $1 ORDER BY a.id DESC LIMIT 200`, [scope.org.id]),
      ctx.ledger.listAuditRecords(scope.actor),
    ]);
    const names = new Map((await ctx.db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM app.users')).rows.map((u) => [u.id, u.display_name]));
    const items = [
      ...app.rows.map((a) => ({ at: new Date(a.at).toISOString(), who: a.display_name ?? 'System', what: a.action, outcome: a.outcome, source: 'app' as const })),
      ...ledger.map((l) => ({ at: l.time, who: names.get(l.actorId) ?? 'System', what: l.operation, outcome: l.outcome, source: 'ledger' as const })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
    res.json({ items });
  });

  return r;
}
