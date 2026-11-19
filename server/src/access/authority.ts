import { randomUUID } from 'node:crypto';
import { AuthorizationRuntimeAdapter } from '@governedai-labs/identity-orchestrator-runtime';
import type { AuthorizationPolicy, Role as RbacRole } from '@governedai-labs/identity-contracts';
import { ACTIONS, OBJECT_TYPES, type Role } from '../../../shared/workspace-model.ts';
import { LEDGER_POLICY } from './policy.ts';

/**
 * The app's access authority: every allow/deny decision is made by the certified
 * Authorization Runtime (through identity-orchestrator-runtime's AuthorizationRuntimeAdapter,
 * the same integration PEP uses).
 *
 * Policies are generated from the app's role model, one per role and resource type. Each one
 * carries two conditions: the firm (tenant) must match, and the client the user is assigned to
 * must own the resource (ownership: subject.assignedOrganisationId == resource.organisationId).
 * The client that owns a resource always comes from the authoritative record, never the request.
 */

export const FIRM_ADMIN = 'firm_admin';
const ROLE_NAMES = new Map<string, string>([
  ['accountant', 'Accountant'], ['reviewer', 'Reviewer'], ['client_viewer', 'Client viewer'], [FIRM_ADMIN, 'Firm administrator'],
]);
export type Principal = Role | typeof FIRM_ADMIN;
export type ResourceType = 'client-organisation' | 'account' | 'period' | 'ledger' | 'firm';

export interface AccessQuestion {
  readonly userId: string;
  readonly sessionRef?: string;
  /** The role the user holds in the client (or firm_admin for firm-level actions). */
  readonly role: Principal;
  /** The client the role was granted for; null for firm-level actions. */
  readonly assignedOrganisationId: string | null;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  /** The client that owns the resource, from the stored record; null for firm-level resources. */
  readonly resourceOrganisationId: string | null;
  readonly action: string;
  /** Record a denial in the app audit. Set for actions and direct requests, not for the workspace's routine "may I show this?" checks. */
  readonly auditDenial?: boolean;
}

export interface AccessAnswer {
  readonly allowed: boolean;
  readonly decision: string;
  readonly reason: string;
}

/** Actions each role may take on each resource type, derived from the shared model. */
export function roleActions(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (role: string, type: string, action: string) => {
    const key = `${role}|${type}`;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(action);
  };
  for (const t of OBJECT_TYPES) {
    for (const c of t.capabilities) {
      for (const role of c.roles) {
        add(role, t.objectTypeId, `capability.${c.capabilityId}.view`);
        add(role, t.objectTypeId, 'workspace.open');
        add(role, t.objectTypeId, 'object.search');
      }
    }
  }
  for (const a of ACTIONS) {
    const capability = OBJECT_TYPES.find((t) => t.objectTypeId === a.objectTypeId)?.capabilities.find((c) => c.capabilityId === a.capabilityId);
    for (const role of a.roles) if (capability?.roles.includes(role)) add(role, a.objectTypeId, a.actionId);
  }
  for (const [operation, principals] of Object.entries(LEDGER_POLICY)) {
    for (const p of principals) add(p === 'system' ? FIRM_ADMIN : p, 'ledger', operation);
  }
  for (const action of ['admin.organisations.read', 'admin.organisations.create', 'admin.users.read', 'admin.users.create', 'admin.users.status', 'admin.assignments.change']) {
    add(FIRM_ADMIN, 'firm', action);
  }
  return out;
}

export function buildPolicies(firmId: string): AuthorizationPolicy[] {
  const policies: AuthorizationPolicy[] = [];
  for (const [key, actions] of roleActions()) {
    const [role, resourceType] = key.split('|') as [string, string];
    const conditions: AuthorizationPolicy['conditions'] = [{ type: 'tenant', equals: firmId }];
    // Client-owned resources: the user's assigned client must own the resource.
    if (resourceType !== 'firm' && role !== FIRM_ADMIN) {
      conditions.push({ type: 'ownership', subjectAttributeKey: 'assignedOrganisationId', resourceAttributeKey: 'organisationId' });
    }
    policies.push({
      policyId: `jam.${role}.${resourceType}`,
      version: '1',
      priority: 10,
      effect: 'Allow',
      status: 'active',
      explicit: false,
      subjects: { roles: [role] },
      resources: { resourceTypes: [resourceType] },
      actions: [...actions].sort(),
      conditions,
      obligations: [],
      constraints: {},
      metadata: { source: 'shared/workspace-model.ts' },
    } as AuthorizationPolicy);
  }
  return policies;
}

/** Records denials in the app audit; allows are not recorded (they are the normal path and very frequent). */
export type DenialSink = (q: AccessQuestion, decision: string, reason: string) => Promise<void> | void;

export class AccessAuthority {
  private readonly runtime: AuthorizationRuntimeAdapter;

  constructor(private readonly firmId: string, private readonly onDenied?: DenialSink) {
    const policies = buildPolicies(firmId);
    // RBAC role definitions for the app's roles (the RBAC runtime requires every assigned role to be defined).
    const roles = new Map<string, RbacRole>(
      [...ROLE_NAMES].map(([roleId, name]) => [roleId, {
        roleId, name, tenantId: firmId, parentRoleIds: [], permissionIds: [], metadata: {}, version: '1', status: 'active',
      } satisfies RbacRole]),
    );
    this.runtime = new AuthorizationRuntimeAdapter({
      roleStore: { get: (roleId: string) => roles.get(roleId), list: () => [...roles.values()] },
      policyProvider: { listCandidatePolicies: () => policies },
      // Decisions are not kept in process memory; denials go to the app audit via onDenied.
      auditRecorder: { record: () => undefined },
      rbacAuditRecorder: { record: () => undefined },
    });
  }

  /** Fails closed: any runtime error is a denial. */
  async decide(q: AccessQuestion): Promise<AccessAnswer> {
    let result;
    try {
      result = await this.runtime.authorize({
      subject: {
        principalId: q.userId,
        tenantId: this.firmId,
        assignedRoles: [q.role],
        attributes: q.assignedOrganisationId ? { assignedOrganisationId: q.assignedOrganisationId } : {},
      },
      resource: q.resourceId,
      resourceType: q.resourceType,
      resourceAttributes: q.resourceOrganisationId ? { organisationId: q.resourceOrganisationId } : {},
      action: q.action,
      tenantId: this.firmId,
      environment: 'jam-accounting',
      sessionContext: q.sessionRef ? { sessionRef: q.sessionRef } : {},
      requestContext: {},
      customAttributes: {},
      deviceAttributes: {},
      riskAttributes: {},
      sensitiveAttributeKeys: [],
      evaluatedAt: new Date().toISOString(),
      correlationId: randomUUID(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'AUTHORIZATION_ERROR';
      if (this.onDenied && q.auditDenial) await this.onDenied(q, 'INDETERMINATE', reason);
      return { allowed: false, decision: 'INDETERMINATE', reason };
    }
    const allowed = result.decision === 'ALLOW';
    if (!allowed && this.onDenied && q.auditDenial) await this.onDenied(q, result.decision, result.reason);
    return { allowed, decision: result.decision, reason: result.reason };
  }
}
