import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CapabilityPanelProps } from '@governedai-labs/cowr-react';
import type { ActorContext } from '@governedai-labs/cowr-runtime';
import { api, ApiError } from '../api.ts';
import { takeFeedback, type ActionFeedback } from './feedback.ts';
import { workspaceRuntime } from './runtime.ts';

export interface WorkspaceTools {
  actor: ActorContext;
  firmId: string;
  orgId: string;
  role: 'accountant' | 'reviewer' | 'client_viewer';
  currency: string;
  /** Reopens the workspace so header figures reflect a change. */
  refreshWorkspace: () => void;
}

const Ctx = createContext<WorkspaceTools | null>(null);
export const WorkspaceToolsProvider = (p: { value: WorkspaceTools; children: ReactNode }) => <Ctx.Provider value={p.value}>{p.children}</Ctx.Provider>;
export function useWorkspaceTools(): WorkspaceTools {
  const v = useContext(Ctx);
  if (!v) throw new Error('WorkspaceToolsProvider missing');
  return v;
}

/** Loads JSON for a panel and exposes reload; errors become a message, never a crash. */
export function useData<T>(url: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let active = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get<T>(url)
      .then((data) => { if (active) setState({ data, error: null, loading: false }); })
      .catch((e: unknown) => { if (active) setState({ data: null, error: e instanceof ApiError ? e.message : 'Could not load.', loading: false }); });
    return () => { active = false; };
  }, [url, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Whether the current workspace offers an action to this user (the server decided). */
export function hasAction(props: CapabilityPanelProps, actionId: string): boolean {
  return props.snapshot.actions.some((a) => a.actionId === actionId);
}

/**
 * Runs a workspace action through the workspace runtime (access check, input validation,
 * audit, then the server executor) with a fresh idempotency key, and returns the outcome.
 *
 * Panels call the runtime directly rather than the React adapter's onInvokeAction because the
 * adapter (cowr-react 1.0.0) replaces the whole workspace with an error page when an action
 * fails; a rejected import file should show its line errors in place instead. Recorded as
 * platform feedback in docs/engineering/platform-feedback.md.
 */
export function useAction(props: CapabilityPanelProps) {
  const { actor } = useWorkspaceTools();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (actionId: string, input: unknown): Promise<ActionFeedback | undefined> => {
    const action = props.snapshot.actions.find((a) => a.actionId === actionId);
    if (!action) return { ok: false, message: 'This action is not available to you.' };
    if (action.requiresConfirmation && !window.confirm(`${action.label}?`)) return undefined;
    const key = crypto.randomUUID();
    setBusy(actionId);
    try {
      const result = await workspaceRuntime.invokeAction(props.snapshot.context.contextId, actionId, actor, input, key, true);
      const recorded = takeFeedback(key);
      if (recorded) return recorded;
      if (!result.ok) return { ok: false, message: COWR_MESSAGES[result.error.code] ?? 'The action could not be completed.' };
      return { ok: result.value.execution.state === 'SUCCEEDED', result: result.value.execution.result };
    } finally {
      setBusy(null);
    }
  }, [props.snapshot, actor]);
  return { run, busy };
}

const COWR_MESSAGES: Partial<Record<string, string>> = {
  ACCESS_DENIED: 'You do not have permission for this action.',
  AUTHORIZATION_STALE: 'Your access check expired. Try again.',
  AUTHORIZATION_UNAVAILABLE: 'Access could not be verified. Try again.',
  ACTION_VALIDATION_FAILED: 'Check the details and try again.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again.',
  CONTEXT_INVALID: 'This workspace was closed. Reload the page.',
};

export function Notice(props: { feedback: ActionFeedback | null | undefined; success?: string }) {
  const f = props.feedback;
  if (!f) return null;
  const details = Array.isArray(f.details) ? (f.details as { line?: number; path?: string; message: string }[]) : [];
  return (
    <div className={f.ok ? 'notice notice-ok' : 'notice notice-error'} role={f.ok ? 'status' : 'alert'}>
      <p>{f.ok ? props.success ?? 'Done.' : f.message ?? 'The action could not be completed.'}</p>
      {details.length > 0 && (
        <ul>{details.slice(0, 20).map((d, i) => <li key={i}>{d.line ? `Line ${d.line}: ` : d.path ? `${d.path}: ` : ''}{d.message}</li>)}</ul>
      )}
    </div>
  );
}

export function Loading() {
  return <p className="muted" role="status">Loading…</p>;
}

export function ErrorText(props: { message: string }) {
  return <p className="notice notice-error" role="alert">{props.message}</p>;
}

/** Reads a chosen file as text (UTF-8). */
export function readFileText(file: File): Promise<string> {
  return file.text();
}

export const ROLE_LABEL = { accountant: 'Accountant', reviewer: 'Reviewer', client_viewer: 'Client viewer' } as const;

/**
 * Feedback that survives the workspace reopening after an action (refreshWorkspace remounts
 * the panels so the header shows the new status). Keyed by object and panel.
 */
const flashes = new Map<string, { f: ActionFeedback; success: string }>();

export function useFlash(key: string): [{ f: ActionFeedback; success: string } | null, (value: { f: ActionFeedback; success: string } | null, persist?: boolean) => void] {
  const [value, setValue] = useState(() => {
    const v = flashes.get(key) ?? null;
    flashes.delete(key);
    return v;
  });
  const set = useCallback((v: { f: ActionFeedback; success: string } | null, persist = false) => {
    if (persist && v) flashes.set(key, v);
    setValue(v);
  }, [key]);
  return [value, set];
}
