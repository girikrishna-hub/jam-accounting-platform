import { useMemo, useState } from 'react';
import { CowrProvider, CowrWorkspace } from '@governedai-labs/cowr-react';
import type { ActorContext } from '@governedai-labs/cowr-runtime';
import { Link, useApp } from '../app-context.tsx';
import { objectRef, workspaceRuntime } from '../workspace/runtime.ts';
import { PANELS } from '../workspace/panels.tsx';
import { WorkspaceToolsProvider } from '../workspace/tools.tsx';
import { workspacePath } from '../../../shared/workspace-model.ts';

const TYPE_LABEL: Record<string, string> = { account: 'Account', period: 'Period', journal: 'Journal' };

/** Opens one object workspace from a deep link. The server re-resolves and re-authorises it. */
export function WorkspacePage(props: { orgId: string; objectTypeId: string; objectId: string; capabilityId?: string }) {
  const { me } = useApp();
  const [epoch, setEpoch] = useState(0);
  // Captured once per object (the router remounts this page per object): selecting a capability
  // updates the URL but must not reopen the workspace.
  const [initialCapability, setInitialCapability] = useState(props.capabilityId);
  const org = me.organisations.find((o) => o.id === props.orgId);

  const actor: ActorContext = useMemo(() => ({
    principalReference: me.user.id,
    sessionReference: me.user.sessionRef,
    tenantId: me.firmId,
    organisationId: props.orgId,
  }), [me.user.id, me.user.sessionRef, me.firmId, props.orgId]);

  const object = useMemo(() => objectRef(me.firmId, props.orgId, props.objectTypeId, props.objectId),
    [me.firmId, props.orgId, props.objectTypeId, props.objectId]);

  if (!org) return <p className="notice notice-error" role="alert">This client is not available to you.</p>;

  // A refresh reopens at the capability now in the URL (the workspace keeps the URL current).
  const refreshWorkspace = () => {
    setInitialCapability(decodeURIComponent(window.location.pathname.split('/')[5] ?? '') || undefined);
    setEpoch((e) => e + 1);
  };

  return (
    <WorkspaceToolsProvider value={{ actor, firmId: me.firmId, orgId: org.id, role: org.role, currency: org.currency, refreshWorkspace }}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">Clients</Link> ›{' '}
        <Link to={workspacePath(org.id, 'client-organisation', org.id)}>{org.name}</Link>
        {props.objectTypeId !== 'client-organisation' && <> › {TYPE_LABEL[props.objectTypeId] ?? ''}</>}
      </nav>
      <CowrProvider runtime={workspaceRuntime}>
        <CowrWorkspace
          key={`${epoch}:${props.objectTypeId}:${props.objectId}`}
          object={object}
          actor={actor}
          panels={PANELS}
          {...(initialCapability ? { initialCapabilityId: initialCapability } : {})}
        />
      </CowrProvider>
    </WorkspaceToolsProvider>
  );
}
