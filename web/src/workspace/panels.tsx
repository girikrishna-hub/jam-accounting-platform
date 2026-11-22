import { useState, type FormEvent } from 'react';
import type { CapabilityPanelProps, CapabilityPanels } from '@governedai-labs/cowr-react';
import { workspacePath } from '../../../shared/workspace-model.ts';
import { formatMinor, type Money } from '../api.ts';
import { Link } from '../app-context.tsx';
import type { ActionFeedback } from './feedback.ts';
import { ErrorText, Loading, Notice, ROLE_LABEL, hasAction, readFileText, useAction, useData, useFlash, useWorkspaceTools } from './tools.tsx';
import { ClientJournals, JournalLines, JournalReview } from './journal-panels.tsx';
import { ClientReceivables, CustomerDetails, CustomerFeeNotes, CustomerStatement, FeeNoteDetails, FeeNoteSettlement } from './receivables-panels.tsx';
import { ClientExpenses, ExpenseDetails, SupplierDetails, SupplierExpenses } from './payables-panels.tsx';
import { ClientBank } from './bank-panels.tsx';
import { Downloads, MonthEnd, Statements } from './month-end-panels.tsx';

interface Account {
  accountId: string; code: string; name: string; type: string; normalBalance: 'debit' | 'credit';
  classification?: string | null; active: boolean; balance: string;
}
interface Period { periodId: string; startDate: string; endDate: string; state: 'open' | 'closed'; reopenCount: number }
interface TrialBalance { asOf: string; currency: string; totalDebits: Money; totalCredits: Money; rows: { account: Account; balance: Money }[] }
interface Org { id: string; name: string; legalName: string; trn: string; currency: string; financialYearStart: number; openingDate: string; status: string; role: keyof typeof ROLE_LABEL; journalApprovalRequired: boolean }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const today = () => new Date().toISOString().slice(0, 10);

/** Debit and credit columns for a signed balance on the account's normal side. */
function debitCredit(balance: string, normal: 'debit' | 'credit'): [string, string] {
  const v = BigInt(balance);
  if (v === 0n) return ['', ''];
  const onDebit = (normal === 'debit') === (v > 0n);
  const abs = formatMinor(v < 0n ? -v : v);
  return onDebit ? [abs, ''] : ['', abs];
}

function AccountLink(props: { account: Account }) {
  const { orgId } = useWorkspaceTools();
  return <Link to={workspacePath(orgId, 'account', props.account.accountId)}>{props.account.code}</Link>;
}

// ---------- Client organisation ----------

function OrgOverview(_props: CapabilityPanelProps) {
  const { orgId, role } = useWorkspaceTools();
  const staff = role !== 'client_viewer';
  const accounts = useData<{ accounts: Account[] }>(`/api/orgs/${orgId}/accounts`);
  const tb = useData<TrialBalance>(`/api/orgs/${orgId}/trial-balance`);
  const periods = useData<{ periods: Period[] }>(staff ? `/api/orgs/${orgId}/periods` : null);
  if (accounts.loading || tb.loading) return <Loading />;
  if (accounts.error) return <ErrorText message={accounts.error} />;
  const list = accounts.data?.accounts ?? [];
  const unclassified = list.filter((a) => a.active && !a.classification).length;
  const open = periods.data?.periods.filter((p) => p.state === 'open') ?? [];
  const balanced = tb.data && tb.data.totalDebits.amount === tb.data.totalCredits.amount;
  return (
    <div className="panel">
      <div className="cards">
        <div className="card"><span>Accounts</span><strong>{list.length}</strong></div>
        {staff && <div className="card"><span>Unclassified accounts</span><strong className={unclassified ? 'warn' : ''}>{unclassified}</strong></div>}
        {staff && <div className="card"><span>Open periods</span><strong>{open.length ? open.map((p) => p.startDate.slice(0, 7)).join(', ') : 'None'}</strong></div>}
        {tb.data && <div className="card"><span>Trial balance ({tb.data.currency})</span><strong>{formatMinor(tb.data.totalDebits.amount)}</strong><small className={balanced ? 'ok' : 'warn'}>{balanced ? 'Debits equal credits' : 'Out of balance'}</small></div>}
      </div>
      {staff && list.length === 0 && <p className="hint">Start in <b>Chart of accounts</b>: import the client's accounts, open the first period, then post opening balances.</p>}
    </div>
  );
}

function OrgProfile(props: CapabilityPanelProps) {
  const { orgId, refreshWorkspace } = useWorkspaceTools();
  const org = useData<Org>(`/api/orgs/${orgId}`);
  const { run, busy } = useAction(props);
  const [flash, setFlash] = useFlash(`profile:${orgId}`);
  const feedback = flash?.f ?? null;
  const canEdit = hasAction(props, 'org.profile.update');
  if (org.loading) return <Loading />;
  if (!org.data) return <ErrorText message={org.error ?? 'Could not load.'} />;
  const o = org.data;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = await run('org.profile.update', {
      name: String(f.get('name')), legalName: String(f.get('legalName')), trn: String(f.get('trn')), financialYearStart: Number(f.get('financialYearStart')),
    });
    if (result) setFlash({ f: result, success: 'Profile saved.' }, result.ok);
    if (result?.ok) refreshWorkspace();
  }

  const controls = <ApprovalControl props={props} org={o} onChanged={() => org.reload()} />;
  if (!canEdit) {
    return (
      <div className="panel">
      <dl className="details">
        <dt>Name</dt><dd>{o.name}</dd><dt>Legal name</dt><dd>{o.legalName}</dd><dt>TRN</dt><dd>{o.trn || '—'}</dd>
        <dt>Reporting currency</dt><dd>{o.currency}</dd><dt>Financial year starts</dt><dd>{MONTHS[o.financialYearStart - 1]}</dd>
        <dt>Books opened</dt><dd>{o.openingDate}</dd>
      </dl>
      {controls}
      </div>
    );
  }
  return (
    <div className="panel">
    <form className="form" onSubmit={submit}>
      <label>Name<input name="name" defaultValue={o.name} required maxLength={200} /></label>
      <label>Legal name<input name="legalName" defaultValue={o.legalName} maxLength={200} /></label>
      <label>TRN<input name="trn" defaultValue={o.trn} maxLength={40} /></label>
      <label>Financial year starts
        <select name="financialYearStart" defaultValue={o.financialYearStart}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
      </label>
      <p className="muted">Reporting currency {o.currency} and books opened {o.openingDate} are fixed when the client is created.</p>
      <button type="submit" disabled={busy !== null}>{busy ? 'Saving…' : 'Save profile'}</button>
      <Notice feedback={feedback} success="Profile saved." />
    </form>
    {controls}
    </div>
  );
}

/** Journal approval (maker-checker) for this client. Reviewers change it; everyone else sees it. */
function ApprovalControl(props: { props: CapabilityPanelProps; org: Org; onChanged: () => void }) {
  const { role } = useWorkspaceTools();
  const { run, busy } = useAction(props.props);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  if (role === 'client_viewer') return null;
  const on = props.org.journalApprovalRequired;
  async function toggle() {
    const result = await run('org.controls.update', { journalApprovalRequired: !on });
    if (!result) return;
    setFeedback(result);
    if (result.ok) props.onChanged();
  }
  return (
    <section className="control">
      <h3>Journal approval</h3>
      <p>{on ? 'On: every journal needs a reviewer\'s approval before it can be posted. The approver must be someone other than the preparer.' : 'Off: accountants post journals directly.'}</p>
      {hasAction(props.props, 'org.controls.update') && (
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void toggle()}>{on ? 'Turn approval off' : 'Turn approval on'}</button>
      )}
      <Notice feedback={feedback} success={`Journal approval is now ${on ? 'on' : 'off'}.`} />
    </section>
  );
}

function ChartOfAccounts(props: CapabilityPanelProps) {
  const { orgId, currency } = useWorkspaceTools();
  const accounts = useData<{ accounts: Account[] }>(`/api/orgs/${orgId}/accounts`);
  const { run, busy } = useAction(props);
  const [feedback, setFeedback] = useState<{ f: ActionFeedback; success: string } | null>(null);
  const [filter, setFilter] = useState('');

  async function upload(actionId: 'coa.import' | 'opening-balances.post', file: File | undefined) {
    if (!file) return;
    if (file.size > 2_000_000) { setFeedback({ f: { ok: false, message: 'The file is larger than 2 MB.' }, success: '' }); return; }
    const result = await run(actionId, { csv: await readFileText(file) });
    if (!result) return;
    if (actionId === 'coa.import' && result.ok) {
      const r = result.result as { created: number; alreadyPresent: number; errors: { line: number; message: string }[] };
      const problems = r.errors.length === 1 ? '1 line needs' : `${r.errors.length} lines need`;
      const message = r.created === 0 && r.alreadyPresent === 0
        ? `Nothing was imported. ${problems} fixing; correct the file and import it again.`
        : `${r.created} accounts created, but ${problems} attention.`;
      setFeedback({ f: r.errors.length ? { ok: false, message, details: r.errors } : result, success: `${r.created} accounts created, ${r.alreadyPresent} already present.` });
    } else if (result.ok) {
      const r = result.result as { lines: number; totalDebits: string };
      setFeedback({ f: result, success: `Opening balances posted: ${r.lines} lines, ${currency} ${r.totalDebits} each side.` });
    } else setFeedback({ f: result, success: '' });
    accounts.reload();
  }

  const list = (accounts.data?.accounts ?? []).filter((a) => !filter || a.code.startsWith(filter) || a.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="panel">
      {(hasAction(props, 'coa.import') || hasAction(props, 'opening-balances.post')) && (
        <div className="toolbar">
          {hasAction(props, 'coa.import') && (
            <label className="file-button">{busy === 'coa.import' ? 'Importing…' : 'Import chart of accounts (CSV)'}
              <input type="file" accept=".csv,text/csv" disabled={busy !== null} onChange={(e) => { void upload('coa.import', e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          )}
          {hasAction(props, 'opening-balances.post') && (
            <label className="file-button">{busy === 'opening-balances.post' ? 'Posting…' : 'Post opening balances (trial balance CSV)'}
              <input type="file" accept=".csv,text/csv" disabled={busy !== null} onChange={(e) => { void upload('opening-balances.post', e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          )}
          <span className="muted">Columns: Account code, Account name, Type, Normal balance, Classification · Trial balance: Account code, Debit, Credit</span>
        </div>
      )}
      {feedback && <Notice feedback={feedback.f} success={feedback.success} />}
      <input className="filter" placeholder="Filter by code or name" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter accounts" />
      {accounts.loading ? <Loading /> : accounts.error ? <ErrorText message={accounts.error} /> : list.length === 0 ? <p className="muted">No accounts yet.</p> : (
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Classification</th><th className="num">Debit ({currency})</th><th className="num">Credit ({currency})</th></tr></thead>
          <tbody>
            {list.map((a) => {
              const [dr, cr] = debitCredit(a.balance, a.normalBalance);
              return (
                <tr key={a.accountId} className={a.active ? '' : 'inactive'}>
                  <td><AccountLink account={a} /></td><td>{a.name}{!a.active && ' (inactive)'}</td><td>{a.type}</td>
                  <td>{a.classification ?? <span className="warn">Unclassified</span>}</td><td className="num">{dr}</td><td className="num">{cr}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function TrialBalanceTable(props: { asOf?: string }) {
  const { orgId } = useWorkspaceTools();
  const [asOf, setAsOf] = useState(props.asOf ?? today());
  const tb = useData<TrialBalance>(`/api/orgs/${orgId}/trial-balance?asOf=${asOf}`);
  return (
    <div className="panel">
      <div className="toolbar">
        <label>As of <input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        {tb.data && <span className={tb.data.totalDebits.amount === tb.data.totalCredits.amount ? 'ok' : 'warn'}>{tb.data.totalDebits.amount === tb.data.totalCredits.amount ? 'Balanced' : 'Out of balance'}</span>}
        <Downloads path={`/export/trial-balance?asOf=${asOf}`} />
      </div>
      {tb.loading ? <Loading /> : tb.error ? <ErrorText message={tb.error} /> : !tb.data?.rows.length ? <p className="muted">No balances at this date.</p> : (
        <table>
          <thead><tr><th>Code</th><th>Account</th><th className="num">Debit ({tb.data.currency})</th><th className="num">Credit ({tb.data.currency})</th></tr></thead>
          <tbody>{tb.data.rows.map((r) => {
            const [dr, cr] = debitCredit(r.balance.amount, r.account.normalBalance);
            return <tr key={r.account.accountId}><td><AccountLink account={{ ...r.account, balance: r.balance.amount }} /></td><td>{r.account.name}</td><td className="num">{dr}</td><td className="num">{cr}</td></tr>;
          })}</tbody>
          <tfoot><tr><th colSpan={2}>Total</th><th className="num">{formatMinor(tb.data.totalDebits.amount)}</th><th className="num">{formatMinor(tb.data.totalCredits.amount)}</th></tr></tfoot>
        </table>
      )}
    </div>
  );
}

function OrgActivity(_props: CapabilityPanelProps) {
  const { orgId } = useWorkspaceTools();
  const activity = useData<{ items: { at: string; who: string; what: string; outcome: string; source: string }[] }>(`/api/orgs/${orgId}/activity`);
  if (activity.loading) return <Loading />;
  if (activity.error) return <ErrorText message={activity.error} />;
  return (
    <div className="panel">
      <table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Outcome</th></tr></thead>
        <tbody>{activity.data!.items.map((i, n) => (
          <tr key={n}><td>{new Date(i.at).toLocaleString()}</td><td>{i.who}</td><td>{i.what}</td><td>{i.outcome}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ---------- Account ----------

function AccountLedger(props: CapabilityPanelProps) {
  const { orgId, currency } = useWorkspaceTools();
  const accountId = props.snapshot.object.reference.objectId;
  const [from, setFrom] = useState(`${new Date().getUTCFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const ledger = useData<{ account: Account; lines: { entryId: string; entryDate: string; postingSequence: number; description: string | null; line: { side: 'debit' | 'credit'; amount: Money; memo?: string | null }; runningBalance: Money }[] }>(
    `/api/orgs/${orgId}/accounts/${encodeURIComponent(accountId)}/ledger?from=${from}&to=${to}`);
  return (
    <div className="panel">
      <div className="toolbar">
        <label>From <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      {ledger.loading ? <Loading /> : ledger.error ? <ErrorText message={ledger.error} /> : !ledger.data?.lines.length ? <p className="muted">No postings in this range.</p> : (
        <table>
          <thead><tr><th>Date</th><th>#</th><th>Journal</th><th className="num">Debit ({currency})</th><th className="num">Credit ({currency})</th><th className="num">Balance</th></tr></thead>
          <tbody>{ledger.data.lines.map((l) => (
            <tr key={`${l.entryId}-${l.postingSequence}-${l.line.side}-${l.line.amount.amount}`}>
              <td>{l.entryDate}</td><td>{l.postingSequence}</td>
              <td><Link to={workspacePath(orgId, 'journal', l.entryId)}>{l.description ?? 'Journal'}</Link>{l.line.memo && l.line.memo !== l.description && <div className="muted small">{l.line.memo}</div>}</td>
              <td className="num">{l.line.side === 'debit' ? formatMinor(l.line.amount.amount) : ''}</td>
              <td className="num">{l.line.side === 'credit' ? formatMinor(l.line.amount.amount) : ''}</td>
              <td className="num">{formatMinor(l.runningBalance.amount)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function AccountDetails(props: CapabilityPanelProps) {
  const { orgId, refreshWorkspace } = useWorkspaceTools();
  const accountId = props.snapshot.object.reference.objectId;
  const accounts = useData<{ accounts: Account[] }>(`/api/orgs/${orgId}/accounts`);
  const { run, busy } = useAction(props);
  const [feedback, setFeedback] = useFlash(`account:${accountId}`);
  const account = accounts.data?.accounts.find((a) => a.accountId === accountId);
  if (accounts.loading) return <Loading />;
  if (!account) return <ErrorText message={accounts.error ?? 'Account not found.'} />;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input: Record<string, string> = {};
    const name = String(f.get('name')).trim();
    const classification = String(f.get('classification')).trim();
    if (name !== account!.name) input.name = name;
    if (classification && classification !== (account!.classification ?? '')) input.classification = classification;
    if (!Object.keys(input).length) { setFeedback({ f: { ok: true }, success: 'Nothing to change.' }); return; }
    const result = await run('account.update', input);
    if (result) setFeedback({ f: result, success: 'Account saved.' }, result.ok);
    if (result?.ok) { accounts.reload(); refreshWorkspace(); }
  }
  async function deactivate() {
    const result = await run('account.deactivate', {});
    if (result) setFeedback({ f: result, success: 'Account deactivated.' }, result.ok);
    if (result?.ok) { accounts.reload(); refreshWorkspace(); }
  }

  const editable = hasAction(props, 'account.update');
  return (
    <form className="panel form" onSubmit={save}>
      <label>Code<input value={account.code} readOnly /></label>
      <label>Name<input name="name" defaultValue={account.name} readOnly={!editable} required maxLength={200} /></label>
      <label>Type<input value={account.type} readOnly /></label>
      <label>Normal balance<input value={account.normalBalance} readOnly /></label>
      <label>Statement classification
        <input name="classification" defaultValue={account.classification ?? ''} readOnly={!editable} placeholder={account.type === 'income' || account.type === 'expense' ? 'PL.…' : 'BS.…'} pattern="(PL|BS)(\.[A-Z0-9_]+){1,5}" />
      </label>
      {editable && <button type="submit" disabled={busy !== null}>{busy === 'account.update' ? 'Saving…' : 'Save account'}</button>}
      {hasAction(props, 'account.deactivate') && account.active && (
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void deactivate()}>{busy === 'account.deactivate' ? 'Working…' : 'Deactivate account'}</button>
      )}
      {feedback && <Notice feedback={feedback.f} success={feedback.success} />}
    </form>
  );
}

// ---------- Period ----------

function PeriodStatus(props: CapabilityPanelProps) {
  const m = props.snapshot.object.metadata;
  return (
    <div className="panel">
      <dl className="details">
        <dt>Starts</dt><dd>{String(m.startDate)}</dd><dt>Ends</dt><dd>{String(m.endDate)}</dd>
        <dt>Status</dt><dd><span className={`badge badge-${String(m.status)}`}>{String(m.status)}</span></dd><dt>Times reopened</dt><dd>{String(m.reopenCount)}</dd>
      </dl>
      <p className="muted">Review and closing arrive with the month-end close in a later release.</p>
    </div>
  );
}

function PeriodTrialBalance(props: CapabilityPanelProps) {
  return <TrialBalanceTable asOf={String(props.snapshot.object.metadata.endDate)} />;
}

/** Panels keyed by presentation adapter ID (`<objectType>/<capability>`). */
export const PANELS: CapabilityPanels = {
  'client-organisation/overview': OrgOverview,
  'client-organisation/profile': OrgProfile,
  'client-organisation/chart-of-accounts': ChartOfAccounts,
  'client-organisation/periods': MonthEnd,
  'client-organisation/statements': Statements,
  'client-organisation/trial-balance': () => <TrialBalanceTable />,
  'client-organisation/activity': OrgActivity,
  'account/ledger': AccountLedger,
  'account/details': AccountDetails,
  'period/status': PeriodStatus,
  'period/trial-balance': PeriodTrialBalance,
  'client-organisation/journals': ClientJournals,
  'journal/lines': JournalLines,
  'journal/review': JournalReview,
  'client-organisation/receivables': ClientReceivables,
  'customer/statement': CustomerStatement,
  'customer/fee-notes': CustomerFeeNotes,
  'customer/details': CustomerDetails,
  'fee-note/details': FeeNoteDetails,
  'fee-note/settlement': FeeNoteSettlement,
  'client-organisation/payables': ClientExpenses,
  'supplier/expenses': SupplierExpenses,
  'supplier/details': SupplierDetails,
  'expense/details': ExpenseDetails,
  'client-organisation/banking': ClientBank,
};
