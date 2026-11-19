import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { APPLICATION_ID, OBJECT_TYPE_IDS } from '../../../../shared/workspace-model.ts';
import { isAllowed } from '../../access/checks.ts';
import type { ResourceType } from '../../access/authority.ts';
import type { SessionUser } from '../../auth/sessions.ts';
import { audit } from '../../audit.ts';
import { executeAction } from '../../workspace/actions.ts';
import { resolveObject, searchObjects } from '../../workspace/objects.ts';
import { HttpError, notFound } from '../errors.ts';
import { resolveScope, userOf, type AppContext } from '../middleware.ts';

/**
 * Server side of the object workspace ports (access decisions, object resolution, search,
 * action execution, audit). The browser workspace is never trusted: each endpoint checks the
 * session, the firm, the client assignment and the role itself.
 */

export const POLICY_VERSION = 'jam-access-2026-11-19.1';

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const ObjectRef = z.object({
  applicationId: z.literal(APPLICATION_ID),
  tenantId: Id,
  organisationId: z.string().uuid(),
  objectTypeId: z.enum(OBJECT_TYPE_IDS as [string, ...string[]]),
  objectId: Id,
  revision: z.string().max(128).optional(),
});
const Actor = z.object({ principalReference: z.string(), sessionReference: z.string(), tenantId: Id, organisationId: z.string().uuid() });
const Purpose = z.enum(['WORKSPACE_OPEN', 'CAPABILITY_VIEW', 'ACTION_DISCOVER', 'ACTION_INVOKE', 'ACTION_CANCEL', 'ACTION_STATUS', 'OBJECT_SEARCH']);
const AccessRequest = z.object({
  actor: Actor,
  object: ObjectRef,
  actionId: z.string().min(1).max(200),
  correlationId: z.string().min(1).max(200),
  purpose: Purpose,
  requiredAccessContext: z.array(z.string()).optional(),
});

type Ref = z.infer<typeof ObjectRef>;

/** The actor in the request must be this session's user, in this firm, acting in the object's client. */
function checkActor(ctx: AppContext, user: SessionUser, actor: z.infer<typeof Actor>, object: Ref): string | null {
  if (actor.principalReference !== user.id || actor.sessionReference !== user.sessionRef) return 'ACTOR_NOT_SESSION';
  if (actor.tenantId !== ctx.config.firmId || object.tenantId !== ctx.config.firmId) return 'TENANT_MISMATCH';
  if (actor.organisationId !== object.organisationId) return 'SCOPE_MISMATCH';
  return null;
}

export function workspaceRoutes(ctx: AppContext): Router {
  const r = Router();

  /** AccessDecisionPort. Returns ALLOW or DENY with a reason; the browser binds it to the request. */
  r.post('/access', async (req, res) => {
    const request = AccessRequest.parse(req.body);
    const user = userOf(res);
    const deny = (reasonCode: string) => res.json({ outcome: 'DENY', decisionReference: randomUUID(), policyVersion: POLICY_VERSION, reasonCode });
    const actorProblem = checkActor(ctx, user, request.actor, request.object);
    if (actorProblem) return deny(actorProblem);
    let scope;
    try {
      scope = await resolveScope(ctx, user, request.object.organisationId);
    } catch {
      return deny('NOT_ASSIGNED');
    }
    const { objectTypeId, objectId } = request.object;
    // The workspace's question, put to the Authorization Runtime as an action on this object.
    const action = request.purpose === 'WORKSPACE_OPEN' ? 'workspace.open'
      : request.purpose === 'OBJECT_SEARCH' ? 'object.search'
      : request.actionId;
    if (!(await isAllowed(ctx, scope, objectTypeId as ResourceType, objectId, action))) return deny('ROLE_NOT_PERMITTED');
    // Except for search, the object must exist inside this client (read from authoritative records).
    if (request.purpose !== 'OBJECT_SEARCH' && !(await resolveObject(ctx, scope, objectTypeId, objectId))) return deny('OBJECT_NOT_IN_SCOPE');
    res.json({ outcome: 'ALLOW', decisionReference: randomUUID(), policyVersion: POLICY_VERSION });
  });

  /** ObjectSourcePort.resolve */
  r.post('/resolve', async (req, res) => {
    const { reference } = z.object({ reference: ObjectRef }).parse(req.body);
    const scope = await resolveScope(ctx, userOf(res), reference.organisationId);
    if (reference.tenantId !== ctx.config.firmId) throw notFound();
    const projection = await resolveObject(ctx, scope, reference.objectTypeId, reference.objectId);
    if (!projection) throw notFound();
    res.json({ projection });
  });

  /** ObjectSourcePort.search, within one client. */
  r.post('/search', async (req, res) => {
    const body = z.object({
      organisationId: z.string().uuid(),
      query: z.string().max(200),
      objectTypeIds: z.array(z.string()).max(10).optional(),
      limit: z.number().int().min(1).max(50),
    }).parse(req.body);
    const scope = await resolveScope(ctx, userOf(res), body.organisationId);
    res.json({ objects: await searchObjects(ctx, scope, body.query, body.objectTypeIds, body.limit) });
  });

  /** ActionExecutorPort.execute */
  r.post('/actions/:actionId', async (req, res) => {
    const body = z.object({ object: ObjectRef, input: z.unknown(), idempotencyKey: z.string().min(8).max(200).optional() }).parse(req.body);
    const scope = await resolveScope(ctx, userOf(res), body.object.organisationId);
    if (body.object.tenantId !== ctx.config.firmId) throw notFound();
    const execution = await executeAction(ctx, scope, {
      actionId: String(req.params.actionId),
      objectTypeId: body.object.objectTypeId,
      objectId: body.object.objectId,
      input: body.input,
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    res.json({ execution });
  });

  /** AuditPort: workspace events recorded in the app audit. */
  r.post('/audit', async (req, res) => {
    const event = z.object({
      eventType: z.string().regex(/^cowr\.[A-Za-z]+$/),
      organisationId: z.string().uuid(),
      objectTypeId: z.string().max(64),
      objectId: z.string().max(128),
      principalReference: z.string(),
      actionId: z.string().max(200).optional(),
      capabilityId: z.string().max(64).optional(),
      outcome: z.string().max(20).optional(),
      correlationId: z.string().max(200),
    }).passthrough().parse(req.body);
    const user = userOf(res);
    if (event.principalReference !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Event actor mismatch.');
    await resolveScope(ctx, user, event.organisationId);
    await audit(ctx.db, {
      actorId: user.id, orgId: event.organisationId, action: event.eventType.replace(/^cowr\./, 'workspace.'),
      target: `${event.objectTypeId}:${event.objectId}`,
      detail: { actionId: event.actionId, capabilityId: event.capabilityId, outcome: event.outcome, correlationId: event.correlationId },
    });
    res.json({ ok: true });
  });

  return r;
}
