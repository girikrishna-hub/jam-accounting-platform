import { useState } from 'react';
import type { CapabilityPanelProps } from '@governedai-labs/cowr-react';
import { workspacePath } from '../../../shared/workspace-model.ts';
import { formatMinor } from '../api.ts';
import { Link } from '../app-context.tsx';
import type { ActionFeedback } from './feedback.ts';
import { ErrorText, Loading, Notice, hasAction, useAction, useData, useFlash, useWorkspaceTools } from './tools.tsx';

// ---------- Types (server read models) ----------

interface ChecklistItem { code: string; label: string; level: 'ok' | 'block' | 'warn'; detail: string[] }
interface MonthRow {
  periodId: string; startDate: string; endDate: string; state: 'open' | 'closed'; reopenCount: number;
  close: null | { status: 'requested' | 'closing' | 'closed'; requestedBy: string; requestedAt: string; approvedBy: string; approvedAt: string | null; acknowledgements: { code: string; reason: string }[] };
  reopened: { reason: string; at: string | null }[];
}
interface GctLine { date: string; reference: string; party: string; base: string; gct: string; kind: string }
interface Gct {
  start: string; end: string; output: GctLine[]; input: GctLine[]; notClaimed: { date: string; reference: string; party: string; gct: string }[];
  outputTotal: string; inputTotal: string; net: string; filed: null | { filed_on: string; reference: string; status: string; entry_id: string | null };
}
interface MonthEndData { currency: string; periods: MonthRow[]; periodId: string | null; checklist: ChecklistItem[]; gct: Gct | null }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const money = (m: string) => formatMinor(m);
const today = () => new Date().toISOString().slice(0, 10);

/** Download links for a report: PDF and Excel. */
export function Downloads(p: { path: string; label?: string }) {
  const { orgId } = useWorkspaceTools();
  const sep = p.path.includes('?') ? '&' : '?';
  return (
    <span className="downloads">{p.label && <span className="muted small">{p.label}: </span>}
      <a href={`/api/orgs/${orgId}${p.path}${sep}format=pdf`} download>PDF</a> · <a href={`/api/orgs/${orgId}${p.path}${sep}format=xlsx`} download>Excel</a>
    </span>
  );
}

// ---------- Client › Month end ----------

export function MonthEnd(props: CapabilityPanelProps) {
  const { orgId, currency } = useWorkspaceTools();
  const [periodId, setPeriodId] = useState<string | null>(null);
  const data = useData<MonthEndData>(`/api/orgs/${orgId}/month-end${periodId ? `?periodId=${encodeURIComponent(periodId)}` : ''}`);
  const { run, busy } = useAction(props);
  const [flash, setFlash] = useFlash(`month-end:${orgId}`);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reopenReason, setReopenReason] = useState('');
  const [gctForm, setGctForm] = useState({ filedOn: today(), reference: '' });

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorText message={data.error} />;
  const d = data.data!;
  const done = (f: ActionFeedback | undefined, success: string) => { if (!f) return; setFlash({ f, success: f.ok ? success : '' }); if (f.ok) data.reload(); };
  const chosen = d.periods.find((p) => p.periodId === d.periodId) ?? null;
  const latestClosed = [...d.periods].reverse().find((p) => p.state === 'closed');
  const warnings = d.checklist.filter((i) => i.level === 'warn');
  const blocked = d.checklist.some((i) => i.level === 'block');
  const missingReason = warnings.some((w) => !(reasons[w.code] ?? '').trim());

  return (
    <div className="panel">
      <div className="toolbar">
        {hasAction(props, 'period.open') && <button type="button" className="secondary" disabled={busy !== null}
          onClick={() => void run('period.open', {}).then((f) => done(f, 'Next month opened.'))}>Open next month</button>}
        <Downloads path={`/export/aged-debtors?asOf=${chosen?.endDate ?? today()}`} label="Aged debtors" />
        <Downloads path={`/export/supplier-balances?year=${(chosen?.endDate ?? today()).slice(0, 4)}`} label="Supplier balances" />
      </div>
      {flash && <Notice feedback={flash.f} success={flash.success} />}
      <table>
        <thead><tr><th>Month</th><th>Status</th><th>Close</th><th /></tr></thead>
        <tbody>{d.periods.map((p) => (
          <tr key={p.periodId} className={p.periodId === d.periodId ? 'selected' : ''}>
            <td><Link to={workspacePath(orgId, 'period', p.periodId)}>{monthName(p.startDate)}</Link></td>
            <td><span className={`badge badge-${p.state}`}>{p.state}</span>{p.reopened.length > 0 && <span className="muted small"> · reopened {p.reopened.length}×</span>}</td>
            <td className="small">{p.close?.status === 'closed' ? `Closed – asked by ${p.close.requestedBy}, approved by ${p.close.approvedBy}` : p.close?.status === 'requested' ? `Close asked for by ${p.close.requestedBy}; waiting for a reviewer` : ''}</td>
            <td><button type="button" className="secondary small" onClick={() => setPeriodId(p.periodId)}>Show</button></td>
          </tr>
        ))}</tbody>
      </table>

      {chosen && (
        <section className="month-card" aria-label={`Month end ${monthName(chosen.startDate)}`}>
          <h3>{monthName(chosen.startDate)}</h3>
          {chosen.state === 'open' && (
            <>
              <ul className="checklist">
                {d.checklist.map((i) => (
                  <li key={i.code} className={`check-${i.level}`}>
                    <span className="mark" aria-hidden>{i.level === 'ok' ? '✓' : i.level === 'block' ? '✕' : '!'}</span>
                    <div>
                      <strong>{i.label}</strong>{i.level === 'block' && <span className="warn small"> – must be done before closing</span>}
                      {i.detail.length > 0 && <ul className="small">{i.detail.slice(0, 8).map((x, n) => <li key={n}>{x}</li>)}{i.detail.length > 8 && <li>…and {i.detail.length - 8} more</li>}</ul>}
                      {i.level === 'warn' && hasAction(props, 'period.request-close') && (
                        <label className="small">Reason for closing with this<input value={reasons[i.code] ?? ''} onChange={(e) => setReasons({ ...reasons, [i.code]: e.target.value })} /></label>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="toolbar">
                {hasAction(props, 'period.request-close') && chosen.close?.status !== 'requested' && (
                  <button type="button" disabled={busy !== null || blocked || missingReason}
                    onClick={() => void run('period.request-close', { periodId: chosen.periodId, acknowledgements: warnings.map((w) => ({ code: w.code, reason: reasons[w.code] ?? '' })) })
                      .then((f) => done(f, 'Close requested. A reviewer can now approve it.'))}>Ask to close {monthName(chosen.startDate)}</button>
                )}
                {chosen.close?.status === 'requested' && <span className="muted">Close asked for by {chosen.close.requestedBy}.</span>}
                {hasAction(props, 'period.approve-close') && chosen.close?.status === 'requested' && (
                  <button type="button" disabled={busy !== null} onClick={() => void run('period.approve-close', { periodId: chosen.periodId }).then((f) => done(f, `${monthName(chosen.startDate)} closed.`))}>Approve and close</button>
                )}
              </div>
              {chosen.close?.status === 'requested' && chosen.close.acknowledgements.length > 0 && (
                <div className="small"><strong>Reasons given:</strong><ul>{chosen.close.acknowledgements.map((a) => <li key={a.code}>{d.checklist.find((i) => i.code === a.code)?.label ?? a.code}: {a.reason}</li>)}</ul></div>
              )}
            </>
          )}
          {chosen.state === 'closed' && (
            <>
              <p>Closed. Nothing more can be posted into {monthName(chosen.startDate)}.</p>
              {chosen.close && chosen.close.acknowledgements.length > 0 && (
                <div className="small"><strong>Closed with:</strong><ul>{chosen.close.acknowledgements.map((a) => <li key={a.code}>{a.code}: {a.reason}</li>)}</ul></div>
              )}
              {hasAction(props, 'period.reopen') && latestClosed?.periodId === chosen.periodId && (
                <div className="toolbar">
                  <label>Reason<input value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} /></label>
                  <button type="button" className="secondary" disabled={busy !== null || !reopenReason.trim()}
                    onClick={() => void run('period.reopen', { periodId: chosen.periodId, reason: reopenReason }).then((f) => { if (f?.ok) setReopenReason(''); done(f, `${monthName(chosen.startDate)} reopened.`); })}>Reopen</button>
                </div>
              )}
            </>
          )}
          {chosen.reopened.length > 0 && <p className="muted small">Reopened before: {chosen.reopened.map((r) => `${r.at?.slice(0, 10) ?? ''} (${r.reason})`).join('; ')}</p>}
          <p className="small">Trial balance at month end: <Downloads path={`/export/trial-balance?asOf=${chosen.endDate}`} /></p>
        </section>
      )}

      {d.gct && chosen && (
        <section className="month-card" aria-label="GCT return working">
          <h3>GCT return – {monthName(chosen.startDate)}</h3>
          <table>
            <tbody>
              <tr><td>Output GCT (fee notes {d.gct.output.filter((l) => l.kind === 'fee-note').length}, credit notes {d.gct.output.filter((l) => l.kind === 'credit-note').length})</td><td className="num">{money(d.gct.outputTotal)}</td></tr>
              <tr><td>Less input GCT claimed ({d.gct.input.length} expenses with a receipt on file)</td><td className="num">({money(d.gct.inputTotal)})</td></tr>
              <tr><th>Net GCT payable to TAJ ({currency})</th><th className="num">{money(d.gct.net)}</th></tr>
              {d.gct.notClaimed.length > 0 && <tr className="small"><td>GCT not claimed for lack of a receipt: {d.gct.notClaimed.map((n) => `${n.reference} ${n.party}`).join(', ')}</td><td className="num">{money(d.gct.notClaimed.reduce((t, n) => t + BigInt(n.gct), 0n).toString())}</td></tr>}
            </tbody>
          </table>
          <p className="small">Working: <Downloads path={`/export/gct?periodEnd=${chosen.endDate}`} /></p>
          {d.gct.filed ? <p className="ok">Marked filed on {d.gct.filed.filed_on}{d.gct.filed.reference ? ` (${d.gct.filed.reference})` : ''}. Input GCT has been set against GCT payable{d.gct.filed.entry_id && <> – <Link to={workspacePath(orgId, 'journal', d.gct.filed.entry_id)}>journal</Link></>}.</p>
            : hasAction(props, 'gct.file') && (
              <div className="toolbar">
                <label>Filed on<input type="date" value={gctForm.filedOn} onChange={(e) => setGctForm({ ...gctForm, filedOn: e.target.value })} /></label>
                <label>TAJ reference<input value={gctForm.reference} onChange={(e) => setGctForm({ ...gctForm, reference: e.target.value })} /></label>
                <button type="button" disabled={busy !== null} onClick={() => void run('gct.file', { periodStart: chosen.startDate, periodEnd: chosen.endDate, ...gctForm })
                  .then((f) => done(f, 'GCT return marked filed; input GCT moved into GCT payable.'))}>Mark filed</button>
                <span className="muted small">Posts on the filing date, which must be in an open month.</span>
              </div>
            )}
        </section>
      )}
    </div>
  );
}

// ---------- Client › Statements ----------

interface StatementLine { code: string; label: string; depth: number; kind: string; side: string; amount: string; comparativeAmount?: string; accounts: { code: string; name: string; amount: string; comparativeAmount?: string }[] }
interface Statement {
  content: { entityName: string; currency: string; parameters: { statementType: 'profitAndLoss' | 'balanceSheet'; startDate?: string; endDate?: string; date?: string; comparative?: { date?: string } }; lines: StatementLine[] };
  contentSha256: string; metadata: { issuedAt?: string; issueNumber?: number; replacesIssue?: number; reason?: string };
}
interface IssuedSummary { statementType: 'profitAndLoss' | 'balanceSheet'; issueNumber: number; parameters: { startDate?: string; endDate?: string; date?: string }; issuedAt: string; replacesIssue?: number; replacedBy?: number }
interface StatementsData {
  currency: string; staff: boolean; registered?: boolean; issued: IssuedSummary[];
  periods: { periodId: string; endDate: string; state: string }[]; periodEnd: string | null; closed?: boolean;
  drafts: null | { profitAndLoss: Statement; balanceSheet: Statement };
}
const TYPE_NAME = { profitAndLoss: 'Profit and loss', balanceSheet: 'Balance sheet' } as const;
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function Statements(props: CapabilityPanelProps) {
  const { orgId } = useWorkspaceTools();
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  const data = useData<StatementsData>(`/api/orgs/${orgId}/statements${periodEnd ? `?periodEnd=${periodEnd}` : ''}`);
  const { run, busy } = useAction(props);
  const [flash, setFlash] = useFlash(`statements:${orgId}`);
  const [view, setView] = useState<null | { type: 'profitAndLoss' | 'balanceSheet'; issue: number }>(null);
  const [reason, setReason] = useState('');

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorText message={data.error} />;
  const d = data.data!;
  const done = (f: ActionFeedback | undefined, success: string) => { if (!f) return; setFlash({ f, success: f.ok ? success : '' }); if (f.ok) { setReason(''); data.reload(); } };
  const issuedFor = (type: 'profitAndLoss' | 'balanceSheet') => d.issued.filter((s) => s.statementType === type && !s.replacedBy && (type === 'profitAndLoss' ? s.parameters.endDate === d.periodEnd : s.parameters.date === d.periodEnd));
  const already = d.periodEnd ? [...issuedFor('profitAndLoss'), ...issuedFor('balanceSheet')].length > 0 : false;

  return (
    <div className="panel">
      {flash && <Notice feedback={flash.f} success={flash.success} />}
      {d.staff && d.periodEnd && (
        <>
          <div className="toolbar">
            <label>Month ending <select value={d.periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}>{d.periods.map((p) => <option key={p.endDate} value={p.endDate}>{p.endDate} ({p.state})</option>)}</select></label>
            {!d.closed && <span className="muted small">Drafts only: statements can be issued once the month is closed.</span>}
          </div>
          {d.drafts && (['profitAndLoss', 'balanceSheet'] as const).map((type) => (
            <section key={type} className="statement-card">
              <div className="toolbar">
                <h3>{TYPE_NAME[type]} <span className="badge badge-draft">Draft</span></h3>
                <Downloads path={`/export/statement?type=${type}&periodEnd=${d.periodEnd}`} />
                {hasAction(props, 'statement.issue') && d.closed && (
                  <button type="button" disabled={busy !== null || (issuedFor(type).length > 0 && !reason.trim())}
                    onClick={() => void run('statement.issue', { type, periodEnd: d.periodEnd, ...(reason.trim() ? { reason } : {}) }).then((f) => done(f, `${TYPE_NAME[type]} issued.`))}>
                    {issuedFor(type).length ? 'Issue again' : 'Issue'}</button>
                )}
              </div>
              <StatementView statement={d.drafts![type]} />
            </section>
          ))}
          {hasAction(props, 'statement.issue') && d.closed && already && (
            <label className="small">Reason for issuing again (needed when a statement for this month is already issued)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          )}
        </>
      )}
      <h3>Issued statements</h3>
      {!d.issued.length ? <p className="muted">No statements issued yet.</p> : (
        <div className="table-scroll"><table>
          <thead><tr><th>No.</th><th>Statement</th><th>For</th><th>Issued</th><th /><th /></tr></thead>
          <tbody>{[...d.issued].reverse().map((s) => (
            <tr key={`${s.statementType}-${s.issueNumber}`}>
              <td>{s.issueNumber}</td><td>{TYPE_NAME[s.statementType]}</td>
              <td>{s.statementType === 'profitAndLoss' ? `${s.parameters.startDate} to ${s.parameters.endDate}` : `at ${s.parameters.date}`}</td>
              <td>{s.issuedAt.slice(0, 10)}{s.replacesIssue ? <span className="muted small"> · replaces {s.replacesIssue}</span> : ''}{s.replacedBy ? <span className="warn small"> · replaced by {s.replacedBy}</span> : ''}</td>
              <td><button type="button" className="secondary small" onClick={() => setView({ type: s.statementType, issue: s.issueNumber })}>View</button></td>
              <td><Downloads path={`/export/statement?type=${s.statementType}&issue=${s.issueNumber}`} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {view && <IssuedView type={view.type} issue={view.issue} onClose={() => setView(null)} />}
    </div>
  );
}

function IssuedView(p: { type: 'profitAndLoss' | 'balanceSheet'; issue: number; onClose: () => void }) {
  const { orgId } = useWorkspaceTools();
  const d = useData<{ statement: { statement: Statement; issueNumber: number; replacedBy?: number }; verification: null | { result: 'unchanged' | 'differs'; differences: unknown[] } }>(`/api/orgs/${orgId}/statements/issued/${p.type}/${p.issue}`);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorText message={d.error} />;
  const s = d.data!.statement;
  const v = d.data!.verification;
  return (
    <section className="statement-card">
      <div className="toolbar"><h3>{TYPE_NAME[p.type]} – issued no. {s.issueNumber}</h3><button type="button" className="secondary small" onClick={p.onClose}>Close</button></div>
      {s.replacedBy && <p className="warn">Replaced by issue {s.replacedBy}.</p>}
      {v && <p className={v.result === 'unchanged' ? 'ok small' : 'warn small'}>{v.result === 'unchanged' ? 'Checked against the ledger: unchanged since issue.' : `The ledger has changed since issue (${v.differences.length} lines differ).`}</p>}
      <StatementView statement={s.statement} />
    </section>
  );
}

function StatementView(p: { statement: Statement }) {
  const c = p.statement.content;
  const pr = c.parameters;
  const cmp = Boolean(pr.comparative);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="table-scroll"><table className="statement">
      <thead><tr><th>{c.entityName} ({c.currency})</th>
        <th className="num">{pr.statementType === 'profitAndLoss' ? `${longDate(pr.startDate!)} to ${longDate(pr.endDate!)}` : `At ${longDate(pr.date!)}`}</th>
        {cmp && <th className="num">{pr.comparative?.date ? `At ${longDate(pr.comparative.date)}` : 'Comparative'}</th>}</tr></thead>
      <tbody>{c.lines.flatMap((l) => {
        const total = l.kind === 'subtotal';
        const expandable = l.kind === 'mapped' && l.accounts.length > 1;
        const rows = [(
          <tr key={l.code} className={total ? 'subtotal' : ''}>
            <td style={{ paddingLeft: `${0.5 + l.depth * 1.2}rem` }}>
              {expandable ? <button type="button" className="link" aria-expanded={Boolean(open[l.code])} onClick={() => setOpen({ ...open, [l.code]: !open[l.code] })}>{open[l.code] ? '▾' : '▸'} {l.label}</button> : l.label}
            </td>
            <td className="num">{formatMinor(l.amount)}</td>{cmp && <td className="num">{l.comparativeAmount ? formatMinor(l.comparativeAmount) : ''}</td>}
          </tr>
        )];
        if (expandable && open[l.code]) {
          for (const a of l.accounts) rows.push(
            <tr key={`${l.code}-${a.code}`} className="small muted"><td style={{ paddingLeft: `${1.7 + l.depth * 1.2}rem` }}>{a.code} {a.name}</td>
              <td className="num">{formatMinor(a.amount)}</td>{cmp && <td className="num">{a.comparativeAmount ? formatMinor(a.comparativeAmount) : ''}</td>}</tr>);
        }
        return rows;
      })}</tbody>
    </table></div>
  );
}
