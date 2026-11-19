import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RuntimeError } from '@governedai-labs/bookkeeping-runtime';
import { actionModel } from '../../../shared/workspace-model.ts';
import { requireAllowed } from '../access/checks.ts';
import type { ResourceType } from '../access/authority.ts';
import type { AppContext, OrgScope } from '../http/middleware.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { importChartOfAccounts, openNextPeriod, postOpeningBalances } from '../services/books.ts';
import { setJournalApproval, updateProfile } from '../services/organisations.ts';
import {
  approveJournal, createJournal, discardJournal, postJournal, returnJournal, reverseJournal, submitJournal, updateJournal,
} from '../services/journals.ts';
import { resolveObject } from './objects.ts';
import { audit } from '../audit.ts';

const CSV = z.string().min(1).max(2_000_000);
const ACCOUNT_CLASSIFICATION = /^(PL|BS)(\.[A-Z0-9_]+){1,5}$/;

type Handler = (ctx: AppContext, scope: OrgScope, objectId: string, input: unknown, idempotencyKey: string) => Promise<unknown>;
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Business execution for each workspace action. The workspace only routes; this commits. */
const HANDLERS: Record<string, Handler> = {
  'org.profile.update': async (ctx, scope, _id, input) => {
    const body = z.object({
      name: z.string().trim().min(1).max(200),
      legalName: z.string().trim().max(200),
      trn: z.string().trim().max(40),
      financialYearStart: z.number().int().min(1).max(12),
    }).parse(input);
    const org = await updateProfile(ctx.db, scope.actor.actorId, scope.org.id, body);
    return { name: org.name };
  },
  'coa.import': async (ctx, scope, _id, input) => {
    const { csv } = z.object({ csv: CSV }).parse(input);
    return importChartOfAccounts(ctx.db, ctx.ledger, scope.actor, scope.org.id, csv);
  },
  'opening-balances.post': async (ctx, scope, _id, input) => {
    const { csv } = z.object({ csv: CSV }).parse(input);
    return postOpeningBalances(ctx.db, ctx.ledger, scope.actor, scope.org, csv);
  },
  'period.open': async (ctx, scope) => {
    const period = await openNextPeriod(ctx.ledger, scope.actor, scope.org);
    await audit(ctx.db, { actorId: scope.actor.actorId, orgId: scope.org.id, action: 'period.open', target: period.periodId, detail: { startDate: period.startDate, endDate: period.endDate } });
    return period;
  },
  'account.update': async (ctx, scope, accountId, input) => {
    const body = z.object({
      name: z.string().trim().min(1).max(200).optional(),
      classification: z.string().trim().regex(ACCOUNT_CLASSIFICATION).optional(),
    }).parse(input);
    return ctx.ledger.updateAccount(scope.actor, { accountId, ...body });
  },
  'account.deactivate': async (ctx, scope, accountId) => ctx.ledger.deactivateAccount(scope.actor, accountId),
  'org.controls.update': async (ctx, scope, _id, input) => {
    const { journalApprovalRequired } = z.object({ journalApprovalRequired: z.boolean() }).parse(input);
    const org = await setJournalApproval(ctx.db, scope.actor.actorId, scope.org.id, journalApprovalRequired);
    return { journalApprovalRequired: org.journal_approval_required };
  },
  // The workspace idempotency key doubles as the ledger request ID, so a retried create drafts once.
  'journal.create': async (ctx, scope, _id, input, key) => createJournal(ctx, scope, input, `draft:${scope.actor.ledgerId}:${key}`),
  'journal.update': async (ctx, scope, entryId, input) => updateJournal(ctx, scope, entryId, input),
  'journal.submit': async (ctx, scope, entryId) => submitJournal(ctx, scope, entryId),
  'journal.approve': async (ctx, scope, entryId) => approveJournal(ctx, scope, entryId),
  'journal.return': async (ctx, scope, entryId, input) => returnJournal(ctx, scope, entryId, z.object({ reason: z.string().max(500) }).parse(input).reason),
  'journal.post': async (ctx, scope, entryId) => postJournal(ctx, scope, entryId),
  'journal.discard': async (ctx, scope, entryId) => discardJournal(ctx, scope, entryId),
  'journal.reverse': async (ctx, scope, entryId, input) => reverseJournal(ctx, scope, entryId, z.object({ reversalDate: ISO_DATE, reason: z.string().max(500) }).parse(input)),
};

export interface ExecuteRequest {
  actionId: string;
  objectTypeId: string;
  objectId: string;
  input: unknown;
  idempotencyKey?: string;
}

export interface Execution {
  executionId: string;
  state: 'SUCCEEDED' | 'FAILED' | 'RUNNING';
  result?: unknown;
  errorCode?: string;
}

/**
 * Executes a workspace action at the business commit boundary: asks the Authorization Runtime
 * again for this action, re-resolves the object inside the caller's client, and enforces the
 * idempotency key durably (one execution per client, action and key).
 */
export async function executeAction(ctx: AppContext, scope: OrgScope, req: ExecuteRequest): Promise<Execution> {
  const action = actionModel(req.actionId);
  const handler = HANDLERS[req.actionId];
  if (!action || !handler || action.objectTypeId !== req.objectTypeId) throw notFound();
  await requireAllowed(ctx, scope, req.objectTypeId as ResourceType, req.objectId, req.actionId);
  if (!(await resolveObject(ctx, scope, req.objectTypeId, req.objectId))) throw notFound();

  const key = req.idempotencyKey ?? randomUUID();
  const executionId = randomUUID();
  const claimed = await ctx.db.query<{ execution_id: string }>(
    `INSERT INTO app.action_executions (execution_id, org_id, action_id, object_type_id, object_id, idempotency_key, actor_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RUNNING') ON CONFLICT (org_id, action_id, idempotency_key) DO NOTHING RETURNING execution_id`,
    [executionId, scope.org.id, req.actionId, req.objectTypeId, req.objectId, key, scope.actor.actorId]);
  if (!claimed.rowCount) {
    const prior = (await ctx.db.query<{ execution_id: string; state: Execution['state']; result: unknown; error_code: string | null; actor_id: string; object_id: string }>(
      'SELECT execution_id, state, result, error_code, actor_id, object_id FROM app.action_executions WHERE org_id = $1 AND action_id = $2 AND idempotency_key = $3',
      [scope.org.id, req.actionId, key])).rows[0]!;
    if (prior.actor_id !== scope.actor.actorId || prior.object_id !== req.objectId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request.');
    return { executionId: prior.execution_id, state: prior.state, ...(prior.result !== null ? { result: prior.result } : {}), ...(prior.error_code ? { errorCode: prior.error_code } : {}) };
  }

  try {
    const result = await handler(ctx, scope, req.objectId, req.input, key);
    await ctx.db.query(`UPDATE app.action_executions SET state = 'SUCCEEDED', result = $2, updated_at = now() WHERE execution_id = $1`, [executionId, JSON.stringify(result ?? null)]);
    return { executionId, state: 'SUCCEEDED', result };
  } catch (error) {
    // Validation and rule failures are final for this key; the user corrects and retries with a new key.
    const code = error instanceof RuntimeError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : (error as { code?: string }).code ?? 'FAILED';
    await ctx.db.query(`UPDATE app.action_executions SET state = 'FAILED', error_code = $2, updated_at = now() WHERE execution_id = $1`, [executionId, String(code)]);
    throw error;
  }
}
