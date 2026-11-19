import {
  ActionRegistry,
  InMemoryContextStore,
  ObjectRegistry,
  WorkspaceRuntime,
  failure,
  success,
  type AccessDecision,
  type AccessDecisionPort,
  type ActionExecutorPort,
  type AuditPort,
  type ContractValidatorPort,
  type NavigationPort,
  type ObjectProjection,
  type ObjectReference,
  type ObjectSourcePort,
} from '@governedai-labs/cowr-runtime';
import { ACTIONS, APPLICATION_ID, OBJECT_TYPES, WORKSPACE_PATH_PATTERN, workspacePath } from '../../../shared/workspace-model.ts';
import { ApiError, api } from '../api.ts';
import { recordFeedback } from './feedback.ts';

/**
 * Wires the object workspace runtime to this app. The runtime owns workspace context and
 * capability navigation; every port below calls the server, which is the only authority for
 * access, object data and action execution.
 */

const EXECUTOR_ID = 'jam-server';

function buildRegistries() {
  const objects = new ObjectRegistry();
  for (const t of OBJECT_TYPES) {
    const registered = objects.register({
      applicationId: APPLICATION_ID,
      objectTypeId: t.objectTypeId,
      version: t.version,
      displayName: t.displayName,
      metadataFields: t.metadataFields,
      headerFieldIds: t.headerFieldIds,
      summaryFieldIds: t.summaryFieldIds,
      capabilities: t.capabilities.map((c) => ({
        capabilityId: c.capabilityId,
        label: c.label,
        order: c.order,
        defaultEligible: c.capabilityId === t.defaultCapabilityId,
        presentationAdapterId: `${t.objectTypeId}/${c.capabilityId}`,
        supportedObjectTypeIds: [t.objectTypeId],
        actionIds: c.actionIds,
        version: '1.0.0',
        configuration: {},
        requiredAccessContext: [],
        compatibleObjectTypeMajorVersions: [Number(t.version.split('.')[0])],
      })),
      defaultCapabilityId: t.defaultCapabilityId,
      identity: { key: 'objectId' },
      search: { enabled: t.objectTypeId !== 'client-organisation', adapterId: 'jam-server-search' },
      presentation: { headerLayout: 'stacked', summaryColumns: 3, ...(t.statusFieldId ? { statusFieldId: t.statusFieldId } : {}) },
    });
    if (!registered.ok) throw new Error(`Workspace definition ${t.objectTypeId} is invalid: ${registered.error.message}`);
  }
  const actions = new ActionRegistry();
  for (const a of ACTIONS) {
    const registered = actions.register({
      applicationId: APPLICATION_ID,
      actionId: a.actionId,
      label: a.label,
      supportedObjectTypeIds: [a.objectTypeId],
      capabilityId: a.capabilityId,
      inputContractId: `${a.actionId}.input`,
      resultContractId: `${a.actionId}.result`,
      executionMode: 'SYNC',
      executorId: EXECUTOR_ID,
      authorizationActionId: a.actionId,
      requiresIdempotencyKey: true,
      // The server audits every business action itself; workspace audit is supplementary.
      auditMode: 'BEST_EFFORT',
      category: a.category,
      requiresConfirmation: a.requiresConfirmation,
    });
    if (!registered.ok) throw new Error(`Action ${a.actionId} is invalid: ${registered.error.message}`);
  }
  return { objects, actions };
}

const accessPort: AccessDecisionPort = {
  async evaluate(request) {
    try {
      const r = await api.post<{ outcome: 'ALLOW' | 'DENY'; decisionReference: string; policyVersion: string; reasonCode?: string }>('/api/workspace/access', request);
      // The server is the authority; the decision is bound here to the exact request it answered.
      const now = Date.now();
      const decision: AccessDecision = {
        outcome: r.outcome,
        decisionReference: r.decisionReference,
        policyVersion: r.policyVersion,
        evaluatedAt: now,
        validUntil: now + 20_000,
        ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
        binding: {
          actor: request.actor,
          object: request.object,
          actionId: request.actionId,
          correlationId: request.correlationId,
          purpose: request.purpose,
          requiredAccessContext: [...(request.requiredAccessContext ?? [])],
        },
      };
      return success(decision);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return failure('SESSION_EXPIRED', 'Session expired.');
      return failure('AUTHORIZATION_UNAVAILABLE', 'Access service unavailable.', true);
    }
  },
};

const objectPort: ObjectSourcePort = {
  async resolve(reference) {
    try {
      const { projection } = await api.post<{ projection: { objectId: string; displayName: string; metadata: ObjectProjection['metadata'] } }>('/api/workspace/resolve', { reference });
      return success({ reference: { ...reference, objectId: projection.objectId }, displayName: projection.displayName, metadata: projection.metadata, resolvedAt: Date.now() });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return failure('OBJECT_NOT_FOUND', 'Not found.');
      return failure('INTEGRATION_FAILED', 'Object service unavailable.', true);
    }
  },
  async search(request) {
    try {
      const { objects } = await api.post<{ objects: { objectTypeId: string; objectId: string; displayName: string; metadata: ObjectProjection['metadata'] }[] }>('/api/workspace/search', {
        organisationId: request.organisationId, query: request.query, limit: Math.min(request.limit, 50),
        ...(request.objectTypeIds ? { objectTypeIds: request.objectTypeIds } : {}),
      });
      return success({
        objects: objects.map((o) => ({
          reference: { applicationId: request.applicationId, tenantId: request.tenantId, organisationId: request.organisationId, objectTypeId: o.objectTypeId, objectId: o.objectId },
          displayName: o.displayName, metadata: o.metadata, resolvedAt: Date.now(),
        })),
      });
    } catch {
      return failure('INTEGRATION_FAILED', 'Search unavailable.', true);
    }
  },
};

const executorPort: ActionExecutorPort = {
  async execute(_executorId, request) {
    const key = request.idempotencyKey ?? '';
    try {
      const { execution } = await api.post<{ execution: { executionId: string; state: 'SUCCEEDED' | 'FAILED'; result?: unknown; errorCode?: string } }>(
        `/api/workspace/actions/${encodeURIComponent(request.action.actionId)}`,
        { object: request.object, input: request.input ?? {}, idempotencyKey: key },
      );
      recordFeedback(key, { ok: execution.state === 'SUCCEEDED', result: execution.result, ...(execution.errorCode ? { message: execution.errorCode } : {}) });
      return success({
        executionId: execution.executionId, state: execution.state, actionId: request.action.actionId, object: request.object,
        ...(execution.result !== undefined ? { result: execution.result } : {}), ...(execution.errorCode ? { errorCode: execution.errorCode } : {}),
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'The action could not be completed.';
      recordFeedback(key, { ok: false, message, ...(error instanceof ApiError && error.details ? { details: error.details } : {}) });
      return failure('ACTION_FAILED', message, false, error instanceof ApiError ? error.code : undefined);
    }
  },
  async cancel() { return failure('ACTION_FAILED', 'These actions complete immediately and cannot be cancelled.'); },
  async getStatus() { return failure('ACTION_FAILED', 'These actions complete immediately.'); },
};

/** Shape checks only; the server validates every input authoritatively. */
const validatorPort: ContractValidatorPort = {
  async validate(contractId, value) {
    if (contractId.endsWith('.result')) return success(undefined);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return failure('ACTION_VALIDATION_FAILED', 'Input must be an object.');
    if ((contractId === 'coa.import.input' || contractId === 'opening-balances.post.input') && typeof (value as { csv?: unknown }).csv !== 'string') {
      return failure('ACTION_VALIDATION_FAILED', 'Choose a CSV file first.');
    }
    return success(undefined);
  },
};

const auditPort: AuditPort = {
  async append(event) {
    try {
      await api.post('/api/workspace/audit', event);
      return success(undefined);
    } catch {
      return failure('AUDIT_FAILED', 'Workspace event not recorded.', true);
    }
  },
};

let navigateTo: (path: string, replace?: boolean) => void = () => undefined;

/** Lets the app's router receive workspace navigation. Destinations are checked against an allowlist. */
export function setWorkspaceNavigator(fn: (path: string, replace?: boolean) => void) {
  navigateTo = fn;
}

const navigationPort: NavigationPort = {
  async navigate({ object, capabilityId }) {
    const path = workspacePath(object.organisationId, object.objectTypeId, object.objectId, capabilityId);
    if (!WORKSPACE_PATH_PATTERN.test(path)) return failure('NAVIGATION_FAILED', 'Destination not allowed.');
    // A capability switch that finishes after the user has moved to another object must not pull them back.
    const objectBase = workspacePath(object.organisationId, object.objectTypeId, object.objectId);
    const here = window.location.pathname;
    if (here !== objectBase && !here.startsWith(objectBase + '/')) return success(undefined);
    navigateTo(path, true);
    return success(undefined);
  },
  async returnToOrigin({ navigationOrigin }) {
    navigateTo(navigationOrigin.startsWith('/') && !navigationOrigin.startsWith('//') ? navigationOrigin : '/');
    return success(undefined);
  },
};

const { objects, actions } = buildRegistries();

export const workspaceRuntime = new WorkspaceRuntime({
  registry: objects,
  objectSource: objectPort,
  access: accessPort,
  contextStore: new InMemoryContextStore(),
  actions,
  validator: validatorPort,
  executor: executorPort,
  navigation: navigationPort,
  audit: auditPort,
});

export function objectRef(firmId: string, orgId: string, objectTypeId: string, objectId: string): ObjectReference {
  return { applicationId: APPLICATION_ID, tenantId: firmId, organisationId: orgId, objectTypeId, objectId };
}
