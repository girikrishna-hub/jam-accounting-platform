import { useState, type FormEvent } from 'react';
import type { CapabilityPanelProps } from '@governedai-labs/cowr-react';
import { workspacePath } from '../../../shared/workspace-model.ts';
import { formatMinor } from '../api.ts';
import { Link } from '../app-context.tsx';
import type { ActionFeedback } from './feedback.ts';
import { ErrorText, Loading, Notice, hasAction, readFileText, useAction, useData, useFlash, useWorkspaceTools } from './tools.tsx';

// ---------- Types (server read models) ----------

interface AccountOption { code: string; name: string; type: string; classification: string | null }
interface Match { entryId: string; amount: string; date: string; description: string }
interface Line {
  id: string; lineNo: number; date: string; reference: string; description: string; amount: string; balance: string; matched: string; remaining: string; matches: Match[];
  suggestion: { entryIds: string[]; reason: string } | null;
  rule: { ruleId: string; containsText: string; targetAccount: string; description: string; flag: string } | null;
}
interface Item { entryId: string; date: string; description: string; amount: string }
interface Reconciliation {
  periodEnd: string; covered: boolean; statementBalance: string; ledgerBalance: string;
  notOnStatement: Item[]; notEntered: { lineId: string; date: string; description: string; amount: string }[];
  adjustedStatement: string; adjustedLedger: string; difference: string;
  saved: { status: 'complete' | 'signed_off'; completedAt: string; signedAt: string | null; changed: boolean } | null;
}
interface BankData {
  currency: string; bankAccounts: AccountOption[]; account: { code: string; name: string } | null;
  statements?: { id: string; file_name: string; first: string; last: string; opening: string; closing: string; line_count: number }[];
  lines?: Line[]; unmatched?: Item[]; rules?: { ruleId: string; containsText: string; targetAccount: string; description: string; flag: string }[];
  locked?: string | null; periods?: string[]; periodEnd?: string; reconciliation?: Reconciliation | null;
  flagged?: { id: string; description: string; flag: string; amount: string; entry_id: string; date: string }[]; accounts?: AccountOption[];
}

const money = (m: string | bigint) => formatMinor(m);
const abs = (m: string) => (m.startsWith('-') ? m.slice(1) : m);
const InOut = (p: { amount: string }) => <span className={p.amount.startsWith('-') ? '' : 'ok'}>{p.amount.startsWith('-') ? `(${money(abs(p.amount))})` : money(p.amount)}</span>;

type Tab = 'todo' | 'all' | 'books' | 'rules';

export function ClientBank(props: CapabilityPanelProps) {
  const { orgId, currency, role } = useWorkspaceTools();
  const [account, setAccount] = useState<string | null>(null);
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  const query = new URLSearchParams({ ...(account ? { account } : {}), ...(periodEnd ? { periodEnd } : {}) }).toString();
  const data = useData<BankData>(`/api/orgs/${orgId}/bank${query ? `?${query}` : ''}`);
  const [tab, setTab] = useState<Tab>('todo');
  const [flash, setFlash] = useFlash(`bank:${orgId}`);
  const { run, busy } = useAction(props);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorText message={data.error} />;
  const d = data.data!;
  if (!d.account) return <div className="panel"><p className="muted">This client has no cash or bank accounts in its chart.</p></div>;
  const done = (f: ActionFeedback | undefined, success: string) => {
    if (!f) return;
    setFlash({ f, success: f.ok ? success : '' });
    if (f.ok) data.reload();
  };
  const lines = d.lines!;
  const todo = lines.filter((l) => l.remaining !== '0');
  const locked = d.locked ?? null;
  const isLocked = (l: Line) => Boolean(locked && l.date <= locked);
  const canWork = hasAction(props, 'bank.match');

  return (
    <div className="panel">
      <div className="toolbar">
        {d.bankAccounts.length > 1 && (
          <label>Account <select value={d.account.code} onChange={(e) => { setAccount(e.target.value); setPeriodEnd(null); }}>
            {d.bankAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
        )}
        {d.bankAccounts.length <= 1 && <strong>{d.account.code} {d.account.name}</strong>}
        {hasAction(props, 'bank.import') && <ImportButton props={props} accountCode={d.account.code} onDone={done} />}
      </div>
      {d.statements!.length === 0
        ? <p className="muted">No statement imported yet. Import the bank's CSV statement for this account.</p>
        : <p className="muted small">Statements: {d.statements!.map((s) => `${s.first} to ${s.last} (${s.line_count} lines, closing ${money(s.closing)})`).join('; ')}</p>}
      {flash && <Notice feedback={flash.f} success={flash.success} />}
      {d.reconciliation && (
        <ReconciliationCard rec={d.reconciliation} currency={currency} periods={d.periods!} onPeriod={setPeriodEnd}
          canComplete={hasAction(props, 'bank.reconcile')} canSignOff={hasAction(props, 'bank.sign-off')} role={role} busy={busy !== null}
          onComplete={() => void run('bank.reconcile', { accountCode: d.account!.code, periodEnd: d.reconciliation!.periodEnd }).then((f) => done(f, 'Reconciliation completed. A reviewer can now sign it off.'))}
          onSignOff={() => void run('bank.sign-off', { accountCode: d.account!.code, periodEnd: d.reconciliation!.periodEnd }).then((f) => done(f, 'Reconciliation signed off. Its bank lines are now locked.'))} />
      )}
      {d.statements!.length > 0 && <>
        <div className="segmented" role="group" aria-label="Show">
          {([['todo', `To do (${todo.length})`], ['all', `All lines (${lines.length})`], ['books', `In the books, not on the statement (${d.unmatched!.length})`], ['rules', 'Rules']] as const)
            .map(([id, label]) => <button key={id} type="button" className={tab === id ? 'on' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        {(tab === 'todo' || tab === 'all') && (
          <div className="bank-lines">
            {(tab === 'todo' ? todo : lines).map((l) => (
              <LineRow key={l.id} line={l} unmatched={d.unmatched!} accounts={d.accounts!} locked={isLocked(l)} canWork={canWork} props={props} onDone={done} />
            ))}
            {tab === 'todo' && !todo.length && <p className="muted">Every bank line is matched or entered.</p>}
          </div>
        )}
        {tab === 'books' && (d.unmatched!.length ? (
          <div className="table-scroll"><table>
            <thead><tr><th>Date</th><th>Entry</th><th className="num">Amount ({currency})</th></tr></thead>
            <tbody>{d.unmatched!.map((i) => <tr key={i.entryId}><td>{i.date}</td><td><Link to={workspacePath(orgId, 'journal', i.entryId)}>{i.description}</Link></td><td className="num"><InOut amount={i.amount} /></td></tr>)}</tbody>
          </table></div>) : <p className="muted">Everything in the books is on the statement.</p>)}
        {tab === 'rules' && <Rules rules={d.rules!} accounts={d.accounts!} props={props} onDone={done} />}
      </>}
      {d.flagged!.length > 0 && (
        <div className="notice notice-warn">
          <strong>Needs attention</strong>
          {d.flagged!.map((f) => <div key={f.id}>{f.date} · {f.description} · {money(abs(f.amount))}: {f.flag} · <Link to={workspacePath(orgId, 'journal', f.entry_id)}>Journal</Link></div>)}
        </div>
      )}
    </div>
  );
}

function ImportButton(props: { props: CapabilityPanelProps; accountCode: string; onDone: (f: ActionFeedback | undefined, success: string) => void }) {
  const { run, busy } = useAction(props.props);
  return (
    <label className="file-button">
      {busy ? 'Importing…' : 'Import statement (CSV)'}
      <input type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const f = await run('bank.import', { accountCode: props.accountCode, fileName: file.name, csv: await readFileText(file) });
        const r = f?.result as { lines?: number; first?: string; last?: string } | undefined;
        props.onDone(f, `Imported ${r?.lines ?? ''} lines, ${r?.first ?? ''} to ${r?.last ?? ''}.`);
      }} />
    </label>
  );
}

function ReconciliationCard(p: {
  rec: Reconciliation; currency: string; periods: string[]; onPeriod: (v: string) => void; canComplete: boolean; canSignOff: boolean; role: string; busy: boolean;
  onComplete: () => void; onSignOff: () => void;
}) {
  const r = p.rec;
  const status = !r.saved ? 'Not completed' : r.saved.status === 'signed_off' ? `Signed off ${r.saved.signedAt?.slice(0, 10) ?? ''}` : `Completed ${r.saved.completedAt.slice(0, 10)}, waiting for sign-off`;
  return (
    <section className="recon" aria-label="Bank reconciliation">
      <div className="toolbar">
        <strong>Reconciliation at</strong>
        <select aria-label="Period end" value={r.periodEnd} onChange={(e) => p.onPeriod(e.target.value)}>{p.periods.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        <span className={`badge badge-${r.saved?.status === 'signed_off' ? 'posted' : r.saved ? 'approved' : 'draft'}`}>{status}</span>
      </div>
      {r.saved?.changed && r.saved.status === 'complete' && <p className="warn small">Something has changed since it was completed; complete it again before sign-off.</p>}
      {!r.covered && <p className="warn small">The statement does not reach {r.periodEnd} yet.</p>}
      <div className="recon-grid">
        <table>
          <tbody>
            <tr><td>Balance per bank statement</td><td className="num">{money(r.statementBalance)}</td></tr>
            {r.notOnStatement.map((i) => <tr key={i.entryId} className="small"><td>{BigInt(i.amount) < 0n ? 'Less: not yet presented' : 'Add: not yet on the statement'} – {i.date} {i.description}</td><td className="num">{BigInt(i.amount) < 0n ? `(${money(abs(i.amount))})` : money(i.amount)}</td></tr>)}
            <tr><th>Adjusted bank balance</th><th className="num">{money(r.adjustedStatement)}</th></tr>
          </tbody>
        </table>
        <table>
          <tbody>
            <tr><td>Balance per ledger</td><td className="num">{money(r.ledgerBalance)}</td></tr>
            {r.notEntered.map((l) => <tr key={l.lineId} className="small"><td>{BigInt(l.amount) < 0n ? 'Less: on the statement, not yet entered' : 'Add: on the statement, not yet entered'} – {l.date} {l.description}</td><td className="num">{BigInt(l.amount) < 0n ? `(${money(abs(l.amount))})` : money(l.amount)}</td></tr>)}
            <tr><th>Adjusted ledger balance</th><th className="num">{money(r.adjustedLedger)}</th></tr>
          </tbody>
        </table>
      </div>
      <p className={r.difference === '0' ? 'ok' : 'warn'}>{r.difference === '0' ? `Both sides agree at ${p.currency} ${money(r.adjustedStatement)}.` : `Difference ${money(r.difference)}.`}</p>
      <div className="toolbar">
        {p.canComplete && r.saved?.status !== 'signed_off' && <button type="button" disabled={p.busy || r.difference !== '0' || !r.covered} onClick={p.onComplete}>{r.saved ? 'Complete again' : 'Complete reconciliation'}</button>}
        {p.canSignOff && r.saved?.status === 'complete' && <button type="button" disabled={p.busy || r.saved.changed} onClick={p.onSignOff}>Sign off</button>}
        {!p.canSignOff && p.role !== 'reviewer' && r.saved?.status === 'complete' && <span className="muted small">A reviewer signs off.</span>}
      </div>
    </section>
  );
}

function LineRow(p: { line: Line; unmatched: Item[]; accounts: AccountOption[]; locked: boolean; canWork: boolean; props: CapabilityPanelProps; onDone: (f: ActionFeedback | undefined, success: string) => void }) {
  const { orgId } = useWorkspaceTools();
  const { run, busy } = useAction(p.props);
  const [open, setOpen] = useState<null | 'match' | 'enter'>(null);
  const l = p.line;
  const moneyIn = !l.amount.startsWith('-');
  const desc = (ids: string[]) => ids.map((id) => p.unmatched.find((i) => i.entryId === id)?.description ?? id).join(' + ');
  return (
    <div className={`bank-line ${l.remaining === '0' ? 'done' : ''}`}>
      <div className="bank-line-head">
        <span className="date">{l.date}</span>
        <span className="desc">{l.description}{l.reference && <span className="muted small"> · {l.reference}</span>}</span>
        <span className="num">{moneyIn ? 'In ' : 'Out '}<InOut amount={l.amount} /></span>
        {l.remaining !== '0' && l.remaining !== l.amount && <span className="muted small">{money(abs(l.remaining))} left</span>}
        {l.remaining === '0' && <span className="badge badge-posted">Matched</span>}
        {p.locked && <span className="badge badge-draft">Locked</span>}
      </div>
      {l.matches.length > 0 && (
        <div className="small muted">
          {l.matches.map((m) => <div key={m.entryId}>↳ <Link to={workspacePath(orgId, 'journal', m.entryId)}>{m.description || 'Entry'}</Link> {money(abs(m.amount))}</div>)}
          {p.canWork && !p.locked && <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void run('bank.unmatch', { lineId: l.id }).then((f) => p.onDone(f, 'Unmatched.'))}>Unmatch</button>}
        </div>
      )}
      {p.canWork && !p.locked && l.remaining !== '0' && (
        <div className="bank-line-actions">
          {l.suggestion && (
            <span className="suggestion">Suggested: {desc(l.suggestion.entryIds)} <span className="muted small">({l.suggestion.reason})</span>
              <button type="button" disabled={busy !== null} onClick={() => void run('bank.match', { lineId: l.id, entryIds: l.suggestion!.entryIds }).then((f) => p.onDone(f, 'Matched.'))}>Accept</button></span>
          )}
          {!l.suggestion && l.rule && (
            <span className="suggestion">Rule: {l.rule.targetAccount} – {l.rule.description}
              <button type="button" disabled={busy !== null} onClick={() => void run('bank.create', { lineId: l.id, kind: 'entry', targetAccount: l.rule!.targetAccount, description: l.rule!.description || l.description.slice(0, 200), flag: l.rule!.flag })
                .then((f) => p.onDone(f, 'Entered and matched.'))}>Enter</button></span>
          )}
          <button type="button" className="secondary small" onClick={() => setOpen(open === 'match' ? null : 'match')}>Match…</button>
          <button type="button" className="secondary small" onClick={() => setOpen(open === 'enter' ? null : 'enter')}>Enter…</button>
        </div>
      )}
      {open === 'match' && <MatchPicker line={l} items={p.unmatched} props={p.props} onDone={(f, s) => { setOpen(null); p.onDone(f, s); }} />}
      {open === 'enter' && <EnterForm line={l} accounts={p.accounts} props={p.props} onDone={(f, s) => { if (f?.ok) setOpen(null); p.onDone(f, s); }} />}
    </div>
  );
}

function MatchPicker(p: { line: Line; items: Item[]; props: CapabilityPanelProps; onDone: (f: ActionFeedback | undefined, s: string) => void }) {
  const { run, busy } = useAction(p.props);
  const moneyIn = !p.line.remaining.startsWith('-');
  const candidates = p.items.filter((i) => !i.amount.startsWith('-') === moneyIn);
  const [chosen, setChosen] = useState<string[]>([]);
  const total = chosen.reduce((t, id) => t + BigInt(candidates.find((i) => i.entryId === id)!.amount), 0n);
  if (!candidates.length) return <p className="muted small">Nothing in the books is waiting to be matched in this direction.</p>;
  return (
    <form className="journal-editor" onSubmit={(e) => { e.preventDefault(); void run('bank.match', { lineId: p.line.id, entryIds: chosen }).then((f) => p.onDone(f, 'Matched.')); }}>
      <table className="lines"><tbody>{candidates.map((i) => (
        <tr key={i.entryId}><td><input type="checkbox" aria-label={`Match ${i.description}`} checked={chosen.includes(i.entryId)}
          onChange={(e) => setChosen(e.target.checked ? [...chosen, i.entryId] : chosen.filter((x) => x !== i.entryId))} /></td>
          <td>{i.date}</td><td>{i.description}</td><td className="num">{money(abs(i.amount))}</td></tr>
      ))}</tbody></table>
      <div className="toolbar"><span className="small">Chosen {money(total < 0n ? -total : total)} of {money(abs(p.line.remaining))}</span>
        <button type="submit" disabled={busy !== null || !chosen.length}>Match</button></div>
    </form>
  );
}

interface Customer { id: string; name: string; kind: string; status: string }
interface FeeNote { id: string; number: string | null; customerId: string; outstanding: string; status: string; broughtForward: boolean }
interface Supplier { id: string; name: string; kind: string; status: string }

function EnterForm(p: { line: Line; accounts: AccountOption[]; props: CapabilityPanelProps; onDone: (f: ActionFeedback | undefined, s: string) => void }) {
  const { orgId } = useWorkspaceTools();
  const { run, busy } = useAction(p.props);
  const moneyIn = !p.line.remaining.startsWith('-');
  const [kind, setKind] = useState<'entry' | 'receipt' | 'expense'>(moneyIn ? 'receipt' : 'entry');
  const rec = useData<{ customers?: Customer[]; feeNotes?: FeeNote[] }>(kind === 'receipt' ? `/api/orgs/${orgId}/receivables` : null);
  const pay = useData<{ suppliers?: Supplier[] }>(kind === 'expense' ? `/api/orgs/${orgId}/payables` : null);
  const [entry, setEntry] = useState({ targetAccount: '', description: p.line.description.slice(0, 200), flag: '', remember: '' });
  const [receipt, setReceipt] = useState({ customerId: '', allocateTo: '', reference: p.line.description.slice(0, 120) });
  const [expense, setExpense] = useState({ supplierId: '', account: '', description: p.line.description.slice(0, 200), net: formatMinor(abs(p.line.remaining)), gct: '', taxCode: 'OUT', matterRef: '', receiptOnFile: true });
  const others = p.accounts.filter((a) => !(a.type === 'asset' && (a.classification ?? '').startsWith('BS.CA.CASH')));
  function submit(e: FormEvent) {
    e.preventDefault();
    const base = { lineId: p.line.id };
    const input = kind === 'entry' ? { ...base, kind, ...entry, remember: entry.remember || undefined }
      : kind === 'receipt' ? { ...base, kind, ...(receipt.customerId ? { customerId: receipt.customerId } : {}), ...(receipt.allocateTo ? { allocateTo: receipt.allocateTo } : {}), reference: receipt.reference }
        : { ...base, kind, expense: { supplierId: expense.supplierId, description: expense.description, receiptOnFile: expense.receiptOnFile, paymentMethod: p.line.reference,
          lines: [{ account: expense.account, description: expense.description, net: expense.net, gct: expense.gct, taxCode: expense.taxCode, matterRef: expense.matterRef }] } };
    void run('bank.create', input).then((f) => p.onDone(f, kind === 'receipt' ? 'Receipt recorded and matched.' : kind === 'expense' ? 'Expense recorded and matched.' : 'Entered and matched.'));
  }
  const customers = (rec.data?.customers ?? []).filter((c) => c.status === 'active');
  const notes = (rec.data?.feeNotes ?? []).filter((n) => n.customerId === receipt.customerId && n.status === 'issued' && n.outstanding !== '0');
  return (
    <form className="journal-editor" onSubmit={submit}>
      <div className="journal-head">
        <label>Enter as<select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {moneyIn && <option value="receipt">Receipt from a customer</option>}
          {!moneyIn && <option value="expense">Expense to a supplier</option>}
          <option value="entry">Bank entry to an account</option></select></label>
        {kind === 'entry' && <>
          <label>Account<select value={entry.targetAccount} required onChange={(e) => setEntry({ ...entry, targetAccount: e.target.value })}>
            <option value="">Choose…</option>{others.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
          <label className="grow">Description<input value={entry.description} required onChange={(e) => setEntry({ ...entry, description: e.target.value })} /></label>
          <label>Flag (optional)<input value={entry.flag} placeholder="e.g. Payroll register needed" onChange={(e) => setEntry({ ...entry, flag: e.target.value })} /></label>
          <label>Remember for lines containing<input value={entry.remember} placeholder="e.g. SERVICE CHARGE" onChange={(e) => setEntry({ ...entry, remember: e.target.value })} /></label>
        </>}
        {kind === 'receipt' && (rec.loading ? <Loading /> : <>
          <label className="grow">From<select value={receipt.customerId} onChange={(e) => setReceipt({ ...receipt, customerId: e.target.value, allocateTo: '' })}>
            <option value="">Not known yet (unidentified)</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.kind === 'brought_forward' ? 'A fee note from before the system (brought forward)' : c.name}</option>)}</select></label>
          {receipt.customerId && <label className="grow">Allocate to<select value={receipt.allocateTo} onChange={(e) => setReceipt({ ...receipt, allocateTo: e.target.value })}>
            <option value="">Leave unallocated</option>{notes.map((n) => <option key={n.id} value={n.id}>{n.broughtForward ? 'B/F' : n.number} – outstanding {formatMinor(n.outstanding)}</option>)}</select></label>}
          <label className="grow">Reference<input value={receipt.reference} onChange={(e) => setReceipt({ ...receipt, reference: e.target.value })} /></label>
        </>)}
        {kind === 'expense' && (pay.loading ? <Loading /> : <>
          <label className="grow">Supplier<select value={expense.supplierId} required onChange={(e) => setExpense({ ...expense, supplierId: e.target.value })}>
            <option value="">Choose…</option>{(pay.data?.suppliers ?? []).filter((s) => s.kind === 'supplier' && s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Account<select value={expense.account} required onChange={(e) => setExpense({ ...expense, account: e.target.value })}>
            <option value="">Choose…</option>{others.filter((a) => a.type !== 'income' && a.type !== 'equity').map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
          <label className="grow">Description<input value={expense.description} required onChange={(e) => setExpense({ ...expense, description: e.target.value })} /></label>
          <label>Net<input className="num" value={expense.net} onChange={(e) => setExpense({ ...expense, net: e.target.value })} /></label>
          <label>Tax<select value={expense.taxCode} onChange={(e) => setExpense({ ...expense, taxCode: e.target.value, gct: '' })}><option value="GCT15">GCT 15%</option><option value="EXEMPT">Exempt</option><option value="OUT">No GCT</option></select></label>
          {expense.taxCode === 'GCT15' && <label>GCT<input className="num" value={expense.gct} placeholder="15%" onChange={(e) => setExpense({ ...expense, gct: e.target.value })} /></label>}
          <label className="check"><input type="checkbox" checked={expense.receiptOnFile} onChange={(e) => setExpense({ ...expense, receiptOnFile: e.target.checked })} /> Receipt on file</label>
          <p className="muted small">Net plus GCT must equal the bank amount, {formatMinor(abs(p.line.remaining))}.</p>
        </>)}
      </div>
      <div className="toolbar"><button type="submit" disabled={busy !== null}>{kind === 'entry' ? 'Enter and match' : kind === 'receipt' ? 'Record receipt and match' : 'Record expense and match'}</button></div>
    </form>
  );
}

function Rules(p: { rules: NonNullable<BankData['rules']>; accounts: AccountOption[]; props: CapabilityPanelProps; onDone: (f: ActionFeedback | undefined, s: string) => void }) {
  const { run, busy } = useAction(p.props);
  if (!p.rules.length) return <p className="muted">No rules yet. When entering a bank line, fill in "Remember for lines containing" to add one.</p>;
  const name = (code: string) => p.accounts.find((a) => a.code === code)?.name ?? '';
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Lines containing</th><th>Suggest account</th><th>Description</th><th>Flag</th><th /></tr></thead>
      <tbody>{p.rules.map((r) => (
        <tr key={r.ruleId}><td>{r.containsText}</td><td>{r.targetAccount} {name(r.targetAccount)}</td><td>{r.description}</td><td>{r.flag}</td>
          <td>{hasAction(p.props, 'bank-rule.delete') && <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void run('bank-rule.delete', { ruleId: r.ruleId }).then((f) => p.onDone(f, 'Rule deleted.'))}>Delete</button>}</td></tr>
      ))}</tbody>
    </table></div>
  );
}
