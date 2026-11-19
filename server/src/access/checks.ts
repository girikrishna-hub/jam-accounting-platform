import type { AppContext, OrgScope } from '../http/middleware.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError } from '../http/errors.ts';
import { FIRM_ADMIN, type ResourceType } from './authority.ts';

/**
 * Asks the Authorization Runtime whether the scoped user may take `action` on a resource of
 * this client. The resource's owning client is the scope's organisation, resolved from the
 * stored record.
 */
export async function isAllowed(ctx: AppContext, scope: OrgScope, resourceType: ResourceType, resourceId: string, action: string, auditDenial = false): Promise<boolean> {
  const answer = await ctx.access.decide({
    userId: scope.actor.actorId,
    ...(scope.actor.sessionRef ? { sessionRef: scope.actor.sessionRef } : {}),
    role: scope.role,
    assignedOrganisationId: scope.actor.assignedOrganisationId,
    resourceType,
    resourceId,
    resourceOrganisationId: scope.org.id,
    action,
    auditDenial,
  });
  return answer.allowed;
}

export async function requireAllowed(ctx: AppContext, scope: OrgScope, resourceType: ResourceType, resourceId: string, action: string): Promise<void> {
  if (!(await isAllowed(ctx, scope, resourceType, resourceId, action, true))) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission for this.');
  }
}

/** Firm-level administration: the user must be a firm administrator and the runtime must allow the action. */
export async function requireFirmAction(ctx: AppContext, user: SessionUser, action: string): Promise<void> {
  const answer = user.isFirmAdmin
    ? await ctx.access.decide({
      userId: user.id, sessionRef: user.sessionRef, role: FIRM_ADMIN, assignedOrganisationId: null,
      resourceType: 'firm', resourceId: ctx.config.firmId, resourceOrganisationId: null, action, auditDenial: true,
    })
    : { allowed: false };
  if (!answer.allowed) throw new HttpError(403, 'FORBIDDEN', 'Firm administrators only.');
}
