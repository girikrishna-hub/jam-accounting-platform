import { useMemo, useState, type FormEvent } from 'react';
import type { CapabilityPanelProps } from '@governedai-labs/cowr-react';
import { workspacePath } from '../../../shared/workspace-model.ts';
import { formatMinor } from '../api.ts';
import { Link, useApp } from '../app-context.tsx';
import type { ActionFeedback } from './feedback.ts';
import { ErrorText, Loading, Notice, hasAction, useAction, useData, useFlash, useWorkspaceTools } from './tools.tsx';

interface Account { accountId: string; code: string; name: string; type: string; active: boolean }
interface JournalLine { lineNumber: number; accountId: string; accountCode: string; accountName: string; side: 'debit' | 'credit'; amount: string; memo: string | null }
interface JournalDetail {
  entryId: string; kind: 'standard' | 'opening' | 'reversal'; status: Status; ledgerState: string; entryDate: string; description: string;
  reference: string | null; postingSequence: number | null; reversalOf: string | null; reversedBy: string | null; lines: JournalLine[];
  people: null | {
    preparedBy: string | null; preparedAt: string; lastEditedBy: string | null; submittedBy: string | null; submittedAt: string | null;
    reviewedBy: string | null; reviewedAt: string | null; reviewNote: string | null; postedBy: string | null; postedAt: string | null;
    ids: { createdBy: string | null; updatedBy: string | null; submittedBy: string | null };
  };
}
type Status = 'draft' | 'submitted' | 'returned' | 'approved' | 'posted' | 'discarded' | 'reversed';
interface JournalSummary {
  entryId: string; kind: JournalDetail['kind']; status: Status; entryDate: string; description: string; total: string;
  postingSequence: number | null; preparedBy: string | null; reviewNote: string | null;
}

export const STATUS_LABEL: Record<Status, string> = {
  draft: 'Draft', submitted: 'Awaiting approval', returned: 'Returned', approved: 'Approved', posted: 'Posted', discarded: 'Discarded', reversed: 'Reversed',
};
const KIND_LABEL = { standard: '', opening: 'Opening balances', reversal: 'Reversal' } as const;
const today = () => new Date().toISOString().slice(0, 10);

function StatusBadge(props: { status: Status }) {
  return <span className={`badge badge-${props.status}`}>{STATUS_LABEL[props.status]}</span>;
}

// ---------- Line editor ----------

interface EditorLine { key: number; accountId: string; debit: string; credit: string; memo: string }
export interface JournalDraft { entryDate: string; description: string; reference: string; lines: EditorLine[] }

/** "1,234.56" → minor units, or null if not a plain amount with up to 2 decimals. */
function toMinor(text: string): bigint | null {
  const s = text.trim().replace(/,/g, '');
  if (!s) return 0n;
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? BigInt(m[1]! + (m[2] ?? '').padEnd(2, '0')) : null;
}

let keySeq = 0;
const blankLine = (): EditorLine => ({ key: (keySeq += 1), accountId: '', debit: '', credit: '', memo: '' });

export function draftFromDetail(j: JournalDetail): JournalDraft {
  return {
    entryDate: j.entryDate, description: j.description, reference: j.reference ?? '',
    lines: j.lines.map((l) => ({ ...blankLine(), accountId: l.accountId, debit: l.side === 'debit' ? formatMinor(l.amount) : '', credit: l.side === 'credit' ? formatMinor(l.amount) : '', memo: l.memo ?? '' })),
  };
}

export const emptyDraft = (): JournalDraft => ({ entryDate: today(), description: '', reference: '', lines: [blankLine(), blankLine()] });

/** Debit/credit line editor with running totals. The server re-validates everything. */
export function JournalEditor(props: { initial: JournalDraft; accounts: Account[]; busy: boolean; submitLabel: string; onSubmit: (input: unknown) => void; onCancel?: () => void }) {
  const [d, setD] = useState<JournalDraft>(props.initial);
  const active = useMemo(() => props.accounts.filter((a) => a.active), [props.accounts]);
  const setLine = (key: number, patch: Partial<EditorLine>) => setD((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  let debits = 0n;
  let credits = 0n;
  let invalid = false;
  for (const l of d.lines) {
    const dr = toMinor(l.debit);
    const cr = toMinor(l.credit);
    if (dr === null || cr === null) invalid = true;
    else { debits += dr; credits += cr; }
  }
  const difference = debits - credits;

  function submit(e: FormEvent) {
    e.preventDefault();
    const lines = d.lines.filter((l) => l.accountId || l.debit.trim() || l.credit.trim());
    props.onSubmit({
      entryDate: d.entryDate, description: d.description, ...(d.reference.trim() ? { reference: d.reference.trim() } : {}),
      lines: lines.map((l) => ({ accountId: l.accountId, ...(l.debit.trim() ? { debit: l.debit } : {}), ...(l.credit.trim() ? { credit: l.credit } : {}), ...(l.memo.trim() ? { memo: l.memo.trim() } : {}) })),
    });
  }

  return (
    <form className="journal-editor" onSubmit={submit}>
      <div className="journal-head">
        <label>Date<input type="date" value={d.entryDate} required onChange={(e) => setD({ ...d, entryDate: e.target.value })} /></label>
        <label className="grow">Description<input value={d.description} required maxLength={500} onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
        <label>Reference<input value={d.reference} maxLength={100} onChange={(e) => setD({ ...d, reference: e.target.value })} /></label>
      </div>
      <div className="table-scroll">
        <table className="lines">
          <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th>Memo</th><th aria-label="Remove line" /></tr></thead>
          <tbody>{d.lines.map((l, i) => (
            <tr key={l.key}>
              <td>
                <select aria-label={`Account, line ${i + 1}`} value={l.accountId} onChange={(e) => setLine(l.key, { accountId: e.target.value })}>
                  <option value="">Choose account…</option>
                  {active.map((a) => <option key={a.accountId} value={a.accountId}>{a.code} {a.name}</option>)}
                </select>
              </td>
              <td><input aria-label={`Debit, line ${i + 1}`} className="num" inputMode="decimal" value={l.debit} onChange={(e) => setLine(l.key, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })} /></td>
              <td><input aria-label={`Credit, line ${i + 1}`} className="num" inputMode="decimal" value={l.credit} onChange={(e) => setLine(l.key, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })} /></td>
              <td><input aria-label={`Memo, line ${i + 1}`} value={l.memo} maxLength={500} onChange={(e) => setLine(l.key, { memo: e.target.value })} /></td>
              <td><button type="button" className="link" aria-label={`Remove line ${i + 1}`} disabled={d.lines.length <= 2} onClick={() => setD({ ...d, lines: d.lines.filter((x) => x.key !== l.key) })}>×</button></td>
            </tr>
          ))}</tbody>
          <tfoot>
            <tr>
              <th>Total</th><th className="num">{formatMinor(debits)}</th><th className="num">{formatMinor(credits)}</th>
              <th colSpan={2} className={difference === 0n && debits > 0n ? 'ok' : 'warn'}>
                {invalid ? 'Check the amounts' : difference === 0n ? (debits > 0n ? 'Balanced' : '') : `Out by ${formatMinor(difference < 0n ? -difference : difference)}`}
              </th>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={() => setD({ ...d, lines: [...d.lines, blankLine()] })} disabled={d.lines.length >= 200}>Add line</button>
        <span className="grow" />
        {props.onCancel && <button type="button" className="secondary" onClick={props.onCancel} disabled={props.busy}>Cancel</button>}
        <button type="submit" disabled={props.busy}>{props.busy ? 'Saving…' : props.submitLabel}</button>
      </div>
      <p className="muted small">You can save a draft that does not balance yet. It must balance before it is submitted or posted.</p>
    </form>
  );
}

// ---------- Client: Journals list ----------

const FILTERS: { id: string; label: string; statuses: Status[] | null; staffOnly?: boolean }[] = [
  { id: 'open', label: 'In progress', statuses: ['draft', 'returned', 'submitted', 'approved'], staffOnly: true },
  { id: 'review', label: 'Awaiting approval', statuses: ['submitted'], staffOnly: true },
  { id: 'posted', label: 'Posted', statuses: ['posted', 'reversed'] },
  { id: 'all', label: 'All', statuses: null },
];

export function ClientJournals(props: CapabilityPanelProps) {
  const { orgId, role, currency } = useWorkspaceTools();
  const { navigate } = useApp();
  const staff = role !== 'client_viewer';
  const [filter, setFilter] = useState(staff ? (role === 'reviewer' ? 'review' : 'open') : 'posted');
  const statuses = FILTERS.find((f) => f.id === filter)?.statuses;
  const journals = useData<{ journals: JournalSummary[]; journalApprovalRequired: boolean }>(`/api/orgs/${orgId}/journals${statuses ? `?status=${statuses.join(',')}` : ''}`);
  const canCreate = hasAction(props, 'journal.create');
  const accounts = useData<{ accounts: Account[] }>(canCreate ? `/api/orgs/${orgId}/accounts` : null);
  const { run, busy } = useAction(props);
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  async function create(input: unknown) {
    const result = await run('journal.create', input);
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    const created = result.result as { entry_id: string };
    navigate(workspacePath(orgId, 'journal', created.entry_id));
  }

  return (
    <div className="panel">
      {journals.data && staff && (
        <p className="muted small">{journals.data.journalApprovalRequired ? 'Journals for this client need a reviewer\'s approval before posting.' : 'Journal approval is off for this client: accountants post directly.'}</p>
      )}
      {canCreate && !creating && <div className="toolbar"><button type="button" onClick={() => { setFeedback(null); setCreating(true); }}>New journal</button></div>}
      {creating && (accounts.data
        ? <JournalEditor initial={emptyDraft()} accounts={accounts.data.accounts} busy={busy !== null} submitLabel="Save draft" onSubmit={(i) => void create(i)} onCancel={() => setCreating(false)} />
        : <Loading />)}
      <Notice feedback={feedback} />
      <div className="segmented" role="group" aria-label="Show">
        {FILTERS.filter((f) => staff || !f.staffOnly).map((f) => (
          <button key={f.id} type="button" className={filter === f.id ? 'on' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      {journals.loading ? <Loading /> : journals.error ? <ErrorText message={journals.error} /> : !journals.data?.journals.length ? <p className="muted">No journals here.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Date</th><th>#</th><th>Description</th><th className="num">Total ({currency})</th><th>Status</th>{staff && <th>Prepared by</th>}</tr></thead>
            <tbody>{journals.data.journals.map((j) => (
              <tr key={j.entryId}>
                <td>{j.entryDate}</td><td>{j.postingSequence ?? ''}</td>
                <td><Link to={workspacePath(orgId, 'journal', j.entryId)}>{j.description}</Link>{j.kind !== 'standard' && KIND_LABEL[j.kind] !== j.description && <span className="muted small"> · {KIND_LABEL[j.kind]}</span>}
                  {j.status === 'returned' && j.reviewNote && <div className="warn small">Returned: {j.reviewNote}</div>}</td>
                <td className="num">{formatMinor(j.total)}</td><td><StatusBadge status={j.status} /></td>{staff && <td>{j.preparedBy ?? ''}</td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Journal: Lines ----------

export function JournalLines(props: CapabilityPanelProps) {
  const { orgId, currency, refreshWorkspace, actor } = useWorkspaceTools();
  const entryId = props.snapshot.object.reference.objectId;
  const detail = useData<{ journal: JournalDetail; journalApprovalRequired: boolean }>(`/api/orgs/${orgId}/journals/${encodeURIComponent(entryId)}`);
  const accounts = useData<{ accounts: Account[] }>(hasAction(props, 'journal.update') ? `/api/orgs/${orgId}/accounts` : null);
  const { run, busy } = useAction(props);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useFlash(`journal:${entryId}`);
  const [returning, setReturning] = useState(false);
  const [reversing, setReversing] = useState(false);

  if (detail.loading && !detail.data) return <Loading />;
  if (!detail.data) return <ErrorText message={detail.error ?? 'Could not load.'} />;
  const j = detail.data.journal;
  const approval = detail.data.journalApprovalRequired;
  const can = (id: string) => hasAction(props, id);
  const editable = ['draft', 'returned', 'approved'].includes(j.status);
  const me = actor.principalReference;
  const preparedByMe = Boolean(j.people && [j.people.ids.createdBy, j.people.ids.updatedBy, j.people.ids.submittedBy].includes(me));

  async function go(actionId: string, input: unknown, success: string) {
    const result = await run(actionId, input);
    if (!result) return false;
    // Kept across the workspace reopening, so the confirmation stays on screen.
    setFeedback({ f: result, success }, result.ok);
    if (result.ok) { detail.reload(); refreshWorkspace(); }
    return result.ok;
  }

  let debits = 0n;
  let credits = 0n;
  for (const l of j.lines) if (l.side === 'debit') debits += BigInt(l.amount); else credits += BigInt(l.amount);
  const balanced = debits === credits && debits > 0n;

  return (
    <div className="panel">
      <div className="journal-status">
        <StatusBadge status={j.status} />
        {j.kind !== 'standard' && <span className="muted">{KIND_LABEL[j.kind]}</span>}
        {j.reference && <span className="muted">Ref {j.reference}</span>}
        {j.reversalOf && <Link to={workspacePath(orgId, 'journal', j.reversalOf)}>Reverses an earlier journal</Link>}
        {j.reversedBy && <Link to={workspacePath(orgId, 'journal', j.reversedBy)}>Reversed by a later journal</Link>}
      </div>
      {j.status === 'returned' && j.people?.reviewNote && <p className="notice notice-warn"><b>Returned by {j.people.reviewedBy}:</b> {j.people.reviewNote}</p>}
      {j.status === 'draft' && j.people?.reviewNote && <p className="notice notice-warn">{j.people.reviewNote}</p>}
      {feedback && <Notice feedback={feedback.f} success={feedback.success} />}

      {editing && accounts.data ? (
        <JournalEditor initial={draftFromDetail(j)} accounts={accounts.data.accounts} busy={busy !== null} submitLabel="Save changes"
          onSubmit={(input) => void go('journal.update', input, j.status === 'approved' ? 'Saved. The approval was cleared, so submit it again.' : 'Saved.').then((ok) => ok && setEditing(false))}
          onCancel={() => setEditing(false)} />
      ) : (
        <div className="table-scroll">
          <table className="lines">
            <thead><tr><th>Account</th><th className="num">Debit ({currency})</th><th className="num">Credit ({currency})</th><th>Memo</th></tr></thead>
            <tbody>{j.lines.map((l) => (
              <tr key={l.lineNumber}>
                <td><Link to={workspacePath(orgId, 'account', l.accountId)}>{l.accountCode}</Link> {l.accountName}</td>
                <td className="num">{l.side === 'debit' ? formatMinor(l.amount) : ''}</td>
                <td className="num">{l.side === 'credit' ? formatMinor(l.amount) : ''}</td>
                <td>{l.memo ?? ''}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th>Total</th><th className="num">{formatMinor(debits)}</th><th className="num">{formatMinor(credits)}</th><th className={balanced ? 'ok' : 'warn'}>{balanced ? 'Balanced' : 'Does not balance'}</th></tr></tfoot>
          </table>
        </div>
      )}

      {!editing && (
        <div className="toolbar">
          {editable && can('journal.update') && <button type="button" className="secondary" disabled={busy !== null} onClick={() => setEditing(true)}>Edit</button>}
          {approval && ['draft', 'returned'].includes(j.status) && can('journal.submit') && (
            <button type="button" disabled={busy !== null || !balanced} onClick={() => void go('journal.submit', {}, 'Submitted for approval.')}>Submit for approval</button>
          )}
          {j.status === 'submitted' && can('journal.approve') && (
            preparedByMe
              ? <span className="muted">You prepared this journal, so another reviewer must approve it.</span>
              : <>
                <button type="button" disabled={busy !== null} onClick={() => void go('journal.approve', {}, 'Approved. The accountant can now post it.')}>Approve</button>
                <button type="button" className="secondary" disabled={busy !== null} onClick={() => setReturning(true)}>Return</button>
              </>
          )}
          {can('journal.post') && ((approval && j.status === 'approved') || (!approval && ['draft', 'returned', 'approved', 'submitted'].includes(j.status))) && (
            <button type="button" disabled={busy !== null || !balanced} onClick={() => void go('journal.post', {}, 'Posted to the ledger.')}>Post</button>
          )}
          {editable && can('journal.discard') && <button type="button" className="secondary" disabled={busy !== null} onClick={() => void go('journal.discard', {}, 'Draft discarded.')}>Discard</button>}
          {j.status === 'posted' && j.kind !== 'reversal' && can('journal.reverse') && <button type="button" className="secondary" disabled={busy !== null} onClick={() => setReversing(true)}>Reverse</button>}
          {approval && j.status === 'submitted' && can('journal.submit') && <span className="muted">Waiting for a reviewer.</span>}
        </div>
      )}

      {returning && (
        <ReasonForm title="Return to preparer" label="What needs fixing?" busy={busy !== null} submitLabel="Return"
          onCancel={() => setReturning(false)}
          onSubmit={(reason) => void go('journal.return', { reason }, 'Returned to the preparer.').then((ok) => ok && setReturning(false))} />
      )}
      {reversing && (
        <ReasonForm title="Reverse this journal" label="Reason for the reversal" busy={busy !== null} submitLabel="Reverse" withDate minDate={j.entryDate}
          onCancel={() => setReversing(false)}
          onSubmit={(reason, date) => void go('journal.reverse', { reason, reversalDate: date }, 'Reversed. A reversing journal was posted.').then((ok) => ok && setReversing(false))} />
      )}
    </div>
  );
}

function ReasonForm(props: { title: string; label: string; submitLabel: string; busy: boolean; withDate?: boolean; minDate?: string; onSubmit: (reason: string, date: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  return (
    <form className="form inline" onSubmit={(e) => { e.preventDefault(); props.onSubmit(reason, date); }}>
      <h3>{props.title}</h3>
      {props.withDate && <label>Reversal date<input type="date" value={date} min={props.minDate} required onChange={(e) => setDate(e.target.value)} /></label>}
      <label className="grow">{props.label}<input value={reason} required maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
      <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
      <button type="submit" disabled={props.busy || !reason.trim()}>{props.submitLabel}</button>
    </form>
  );
}

// ---------- Journal: Review trail ----------

export function JournalReview(props: CapabilityPanelProps) {
  const { orgId } = useWorkspaceTools();
  const entryId = props.snapshot.object.reference.objectId;
  const detail = useData<{ journal: JournalDetail }>(`/api/orgs/${orgId}/journals/${encodeURIComponent(entryId)}`);
  if (detail.loading) return <Loading />;
  const p = detail.data?.journal.people;
  if (!p) return <ErrorText message={detail.error ?? 'Not available.'} />;
  const when = (t: string | null) => (t ? new Date(t).toLocaleString() : '');
  const rows: [string, string | null, string | null][] = [
    ['Prepared', p.preparedBy, when(p.preparedAt)],
    ['Last edited', p.lastEditedBy, ''],
    ['Submitted', p.submittedBy, when(p.submittedAt)],
    [detail.data!.journal.status === 'returned' ? 'Returned' : 'Reviewed', p.reviewedBy, when(p.reviewedAt)],
    ['Posted', p.postedBy, when(p.postedAt)],
  ];
  return (
    <div className="panel">
      <table>
        <thead><tr><th>Step</th><th>By</th><th>When</th></tr></thead>
        <tbody>{rows.filter(([, by]) => by).map(([step, by, at]) => <tr key={step}><td>{step}</td><td>{by}</td><td>{at}</td></tr>)}</tbody>
      </table>
      {p.reviewNote && <p className="muted">Note: {p.reviewNote}</p>}
    </div>
  );
}
