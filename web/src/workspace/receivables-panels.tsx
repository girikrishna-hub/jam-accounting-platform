import { useMemo, useState, type FormEvent } from 'react';
import type { CapabilityPanelProps } from '@governedai-labs/cowr-react';
import { workspacePath } from '../../../shared/workspace-model.ts';
import { formatMinor } from '../api.ts';
import { Link, useApp } from '../app-context.tsx';
import type { ActionFeedback } from './feedback.ts';
import { ErrorText, Loading, Notice, hasAction, useAction, useData, useFlash, useWorkspaceTools } from './tools.tsx';

// ---------- Types (server read models) ----------

type TaxCode = 'GCT15' | 'EXEMPT' | 'OUT';
interface AccountOption { code: string; name: string; type: string; classification: string | null }
interface Settings { receivable_account: string; gct_account: string; disbursement_account: string; retainer_account: string; set_up_at: string | null }
interface PracticeArea { name: string; income_account: string }
interface CustomerBalance { id: string; name: string; kind: 'customer' | 'brought_forward' | 'unidentified'; status: string; trn: string; balance: string; unallocated: string; retainerHeld: string }
interface FeeNoteSummary { id: string; number: string | null; status: string; settlement: string; customerId: string; customerName: string; issueDate: string; matterRef: string; practiceArea: string; total: string; outstanding: string; broughtForward: boolean }
interface ReceiptSummary { id: string; number: string; kind: 'payment' | 'retainer'; date: string; customerId: string; customerName: string; unidentified: boolean; method: string; depositAccount: string; amount: string; available: string; reference: string }
interface Overview {
  currency: string; setUp: boolean; settings: Settings | null; practiceAreas: PracticeArea[]; accounts: AccountOption[];
  taxCodes: { code: TaxCode; label: string }[];
  customers?: CustomerBalance[]; feeNotes?: FeeNoteSummary[]; receipts?: ReceiptSummary[];
  control?: { account: string; subledger: string; ledger: string; difference: string };
}
interface FeeNoteLine { kind: 'fee' | 'disbursement'; description: string; amount: string; taxCode: TaxCode }
interface FeeNoteDetailData {
  currency: string; firm: { name: string; legalName: string; trn: string };
  feeNote: { id: string; number: string | null; status: string; broughtForward: boolean; issueDate: string; customerId: string; matterRef: string; practiceArea: string; description: string; lines: FeeNoteLine[]; fees: string; gct: string; disbursements: string; total: string; entryId: string | null };
  customer: { id: string; name: string; trn: string; address: string; email: string };
  allocations: { id: string; kind: 'receipt' | 'retainer' | 'credit_note'; reference: string | null; amount: string; date: string; entryId: string | null }[];
  creditNotes: { id: string; number: string; date: string; reason: string; fees: string; gct: string; disbursements: string; total: string; entryId: string }[];
  available: { payments: ReceiptSummary[]; retainers: ReceiptSummary[] };
  outstanding: string; creditable: { fees: string; disbursements: string };
  practiceAreas: PracticeArea[]; customers: { id: string; name: string }[]; taxCodes: { code: TaxCode; label: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);
const SETTLEMENT_LABEL: Record<string, string> = { draft: 'Draft', issuing: 'Issuing', outstanding: 'Outstanding', 'part-paid': 'Part-paid', paid: 'Paid', credited: 'Credited' };
const SETTLEMENT_BADGE: Record<string, string> = { draft: 'draft', issuing: 'submitted', outstanding: 'submitted', 'part-paid': 'approved', paid: 'posted', credited: 'reversed' };
function SettlementBadge(props: { value: string }) {
  return <span className={`badge badge-${SETTLEMENT_BADGE[props.value] ?? 'draft'}`}>{SETTLEMENT_LABEL[props.value] ?? props.value}</span>;
}
const money = (minor: string) => formatMinor(minor);

/** "1,234.56" → minor units, or null. Mirrors the server's parser for preview totals. */
function toMinor(text: string): bigint | null {
  const s = text.trim().replace(/,/g, '').replace(/^J\$/i, '');
  if (!s) return 0n;
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? BigInt(m[1]! + (m[2] ?? '').padEnd(2, '0')) : null;
}
/** GCT preview: 15% of standard-rated lines, rounded half up (the server is authoritative). */
function gctPreview(lines: { amount: string; taxCode: TaxCode }[]): bigint {
  const base = lines.filter((l) => l.taxCode === 'GCT15').reduce((s, l) => s + (toMinor(l.amount) ?? 0n), 0n);
  return (base * 15n * 2n + 100n) / 200n;
}

// ---------- Client › Receivables ----------

type Tab = 'fee-notes' | 'customers' | 'receipts' | 'ageing' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'fee-notes', label: 'Fee notes' }, { id: 'customers', label: 'Customers' }, { id: 'receipts', label: 'Receipts' },
  { id: 'ageing', label: 'Ageing' }, { id: 'settings', label: 'Settings' },
];

export function ClientReceivables(props: CapabilityPanelProps) {
  const { orgId, currency } = useWorkspaceTools();
  const data = useData<Overview>(`/api/orgs/${orgId}/receivables`);
  const [tab, setTab] = useState<Tab>('fee-notes');
  const [form, setForm] = useState<null | 'customer' | 'fee-note' | 'receipt'>(null);
  const [flash, setFlash] = useFlash(`receivables:${orgId}`);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorText message={data.error} />;
  const d = data.data!;
  if (!d.setUp) {
    return (
      <div className="panel">
        <p>Set up receivables for this client: choose the accounts fee notes post to and map each practice area to a fee income account.
          The opening balance of the receivables account is brought forward as one item, so the customer total agrees with the ledger from day one.</p>
        {hasAction(props, 'receivables.settings')
          ? <SettingsForm props={props} overview={d} onSaved={(f) => { setFlash(f, true); data.reload(); }} />
          : <p className="muted">An accountant sets this up.</p>}
        {flash && <Notice feedback={flash.f} success={flash.success} />}
      </div>
    );
  }
  const done = (f: { f: ActionFeedback; success: string }) => { setForm(null); setFlash(f); data.reload(); };
  const customers = d.customers!.filter((c) => c.kind === 'customer' && c.status === 'active');
  const broughtForward = d.customers!.find((c) => c.kind === 'brought_forward');
  return (
    <div className="panel">
      <ControlCheck control={d.control!} currency={currency} />
      <div className="toolbar">
        {hasAction(props, 'fee-note.create') && <button type="button" onClick={() => setForm('fee-note')}>New fee note</button>}
        {hasAction(props, 'receipt.record') && <button type="button" className="secondary" onClick={() => setForm('receipt')}>Record receipt</button>}
        {hasAction(props, 'customer.create') && <button type="button" className="secondary" onClick={() => setForm('customer')}>Add customer</button>}
      </div>
      {form === 'customer' && <CustomerForm props={props} onDone={done} onCancel={() => setForm(null)} />}
      {form === 'fee-note' && <NewFeeNote props={props} overview={d} customers={customers} onCancel={() => setForm(null)} onError={(f) => setFlash(f)} />}
      {form === 'receipt' && <ReceiptForm props={props} overview={d} customers={customers} broughtForward={broughtForward} onDone={done} onCancel={() => setForm(null)} />}
      {flash && <Notice feedback={flash.f} success={flash.success} />}
      <div className="segmented" role="group" aria-label="Show">
        {TABS.map((t) => <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {tab === 'fee-notes' && <FeeNoteTable notes={d.feeNotes!} showCustomer />}
      {tab === 'customers' && <CustomerTable customers={d.customers!} />}
      {tab === 'receipts' && <ReceiptTable props={props} receipts={d.receipts!} customers={customers} onChanged={done} />}
      {tab === 'ageing' && <Ageing />}
      {tab === 'settings' && (hasAction(props, 'receivables.settings')
        ? <SettingsForm props={props} overview={d} onSaved={done} />
        : <SettingsView overview={d} />)}
    </div>
  );
}

function ControlCheck(props: { control: NonNullable<Overview['control']>; currency: string }) {
  const c = props.control;
  const agrees = c.difference === '0';
  return (
    <div className="cards">
      <div className="card"><span>Owed by customers ({props.currency})</span><strong>{money(c.subledger)}</strong>
        <small className={agrees ? 'ok' : 'warn'}>{agrees ? `Agrees with account ${c.account}` : `Account ${c.account} shows ${money(c.ledger)}: difference ${money(c.difference)}`}</small></div>
    </div>
  );
}

function FeeNoteTable(props: { notes: FeeNoteSummary[]; showCustomer?: boolean }) {
  const { orgId, currency } = useWorkspaceTools();
  if (!props.notes.length) return <p className="muted">No fee notes yet.</p>;
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Number</th><th>Date</th>{props.showCustomer && <th>Customer</th>}<th>Matter</th><th className="num">Total ({currency})</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
      <tbody>{props.notes.map((n) => (
        <tr key={n.id}>
          <td>{n.broughtForward ? 'B/F' : <Link to={workspacePath(orgId, 'fee-note', n.id)}>{n.number ?? 'Draft'}</Link>}</td>
          <td>{n.issueDate}</td>
          {props.showCustomer && <td><Link to={workspacePath(orgId, 'customer', n.customerId)}>{n.customerName}</Link></td>}
          <td>{n.matterRef}</td><td className="num">{money(n.total)}</td><td className="num">{money(n.outstanding)}</td>
          <td><SettlementBadge value={n.settlement} /></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function CustomerTable(props: { customers: CustomerBalance[] }) {
  const { orgId, currency } = useWorkspaceTools();
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Customer</th><th>TRN</th><th className="num">Balance ({currency})</th><th className="num">Unallocated payments</th><th className="num">Retainer held</th></tr></thead>
      <tbody>{props.customers.map((c) => (
        <tr key={c.id}>
          <td><Link to={workspacePath(orgId, 'customer', c.id)}>{c.name}</Link>{c.kind !== 'customer' && <span className="muted small"> · system</span>}{c.status === 'inactive' && <span className="muted small"> · inactive</span>}</td>
          <td>{c.trn}</td><td className="num">{money(c.balance)}</td><td className="num">{money(c.unallocated)}</td><td className="num">{money(c.retainerHeld)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function ReceiptTable(props: { props: CapabilityPanelProps; receipts: ReceiptSummary[]; customers: CustomerBalance[]; onChanged: (f: { f: ActionFeedback; success: string }) => void }) {
  const { orgId, currency } = useWorkspaceTools();
  const { run, busy } = useAction(props.props);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const canAssign = hasAction(props.props, 'receipt.reassign');
  if (!props.receipts.length) return <p className="muted">No receipts yet.</p>;
  async function reassign(receiptId: string) {
    const result = await run('receipt.reassign', { receiptId, customerId: assign[receiptId] });
    if (result) props.onChanged({ f: result, success: 'Receipt assigned to the customer.' });
  }
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Number</th><th>Date</th><th>From</th><th>Kind</th><th>Method</th><th className="num">Amount ({currency})</th><th className="num">Not yet allocated</th></tr></thead>
      <tbody>{props.receipts.map((r) => (
        <tr key={r.id}>
          <td>{r.number}</td><td>{r.date}</td>
          <td>{r.unidentified
            ? <span className="warn">Unidentified{r.reference ? ` (${r.reference})` : ''}
                {canAssign && <span className="toolbar small">
                  <select aria-label={`Customer for ${r.number}`} value={assign[r.id] ?? ''} onChange={(e) => setAssign({ ...assign, [r.id]: e.target.value })}>
                    <option value="">Assign to…</option>{props.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button type="button" className="secondary" disabled={!assign[r.id] || busy !== null} onClick={() => void reassign(r.id)}>Assign</button>
                </span>}</span>
            : <Link to={workspacePath(orgId, 'customer', r.customerId)}>{r.customerName}</Link>}</td>
          <td>{r.kind === 'retainer' ? 'Retainer' : 'Payment'}</td><td>{r.method}</td>
          <td className="num">{money(r.amount)}</td><td className="num">{money(r.available)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Ageing() {
  const { orgId, currency } = useWorkspaceTools();
  const [asOf, setAsOf] = useState(today());
  const a = useData<{ buckets: { key: string; label: string }[]; rows: { customerId: string; customerName: string; buckets: Record<string, string>; unallocated: string; total: string }[]; totals: Record<string, string>; unallocated: string; total: string }>(
    `/api/orgs/${orgId}/receivables/ageing?asOf=${asOf}`);
  return (
    <div className="panel">
      <label className="toolbar">As at <input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
      {a.loading ? <Loading /> : a.error ? <ErrorText message={a.error} /> : !a.data!.rows.length ? <p className="muted">Nothing outstanding.</p> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Customer</th>{a.data!.buckets.map((b) => <th key={b.key} className="num">{b.label}</th>)}<th className="num">Unallocated</th><th className="num">Owed ({currency})</th></tr></thead>
          <tbody>{a.data!.rows.map((r) => (
            <tr key={r.customerId}><td><Link to={workspacePath(orgId, 'customer', r.customerId)}>{r.customerName}</Link></td>
              {a.data!.buckets.map((b) => <td key={b.key} className="num">{money(r.buckets[b.key] ?? '0')}</td>)}
              <td className="num">{r.unallocated === '0' ? '' : `(${money(r.unallocated)})`}</td><td className="num">{money(r.total)}</td></tr>
          ))}</tbody>
          <tfoot><tr><th>Total</th>{a.data!.buckets.map((b) => <th key={b.key} className="num">{money(a.data!.totals[b.key] ?? '0')}</th>)}
            <th className="num">{a.data!.unallocated === '0' ? '' : `(${money(a.data!.unallocated)})`}</th><th className="num">{money(a.data!.total)}</th></tr></tfoot>
        </table></div>
      )}
    </div>
  );
}

// ---------- Settings ----------

function guessSettings(accounts: AccountOption[], current: Settings | null, areas: PracticeArea[]) {
  const find = (test: (a: AccountOption) => boolean) => accounts.find(test)?.code ?? '';
  const income = accounts.filter((a) => a.type === 'income' && (a.classification ?? '').startsWith('PL.REV'));
  return {
    receivableAccount: current?.receivable_account ?? find((a) => (a.classification ?? '') === 'BS.CA.REC.FEES' || /receivable/i.test(a.name)),
    gctAccount: current?.gct_account ?? find((a) => /GCT Payable|Output/i.test(a.name)),
    disbursementAccount: current?.disbursement_account ?? find((a) => /Disbursement/i.test(a.name)),
    retainerAccount: current?.retainer_account ?? find((a) => (a.classification ?? '').includes('RETAINER') || /advance|retainer/i.test(a.name) && a.type === 'liability'),
    practiceAreas: areas.length ? areas.map((p) => ({ name: p.name, incomeAccount: p.income_account }))
      : income.map((a) => ({ name: (a.name.split(/\s[–-]\s/)[1] ?? a.name).split(/ & | \/ /)[0]!, incomeAccount: a.code })),
  };
}

function AccountSelect(props: { label: string; value: string; accounts: AccountOption[]; filter?: (a: AccountOption) => boolean; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label>{props.label}
      <select value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">Choose…</option>
        {props.accounts.filter(props.filter ?? (() => true)).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
      </select>
    </label>
  );
}

function SettingsForm(props: { props: CapabilityPanelProps; overview: Overview; onSaved: (f: { f: ActionFeedback; success: string }) => void }) {
  const o = props.overview;
  const { run, busy } = useAction(props.props);
  const [s, setS] = useState(() => guessSettings(o.accounts, o.settings, o.practiceAreas));
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const locked = Boolean(o.settings?.set_up_at);
  async function save(e: FormEvent) {
    e.preventDefault();
    const result = await run('receivables.settings', s);
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    const bf = (result.result as { broughtForward: string }).broughtForward;
    props.onSaved({ f: result, success: locked ? 'Receivables settings saved.' : `Receivables set up. Brought forward: ${o.currency} ${bf}.` });
  }
  const setArea = (i: number, patch: Partial<{ name: string; incomeAccount: string }>) =>
    setS({ ...s, practiceAreas: s.practiceAreas.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <form className="journal-editor" onSubmit={(e) => void save(e)}>
      <div className="journal-head">
        <AccountSelect label="Receivables control account" value={s.receivableAccount} accounts={o.accounts} filter={(a) => a.type === 'asset'} disabled={locked} onChange={(v) => setS({ ...s, receivableAccount: v })} />
        <AccountSelect label="Output GCT" value={s.gctAccount} accounts={o.accounts} filter={(a) => a.type === 'liability'} onChange={(v) => setS({ ...s, gctAccount: v })} />
        <AccountSelect label="Disbursements recoverable" value={s.disbursementAccount} accounts={o.accounts} filter={(a) => a.type === 'asset'} onChange={(v) => setS({ ...s, disbursementAccount: v })} />
        <AccountSelect label="Fees received in advance" value={s.retainerAccount} accounts={o.accounts} filter={(a) => a.type === 'liability'} onChange={(v) => setS({ ...s, retainerAccount: v })} />
      </div>
      <table className="lines">
        <thead><tr><th>Practice area</th><th>Fee income account</th><th /></tr></thead>
        <tbody>{s.practiceAreas.map((p, i) => (
          <tr key={i}>
            <td><input aria-label={`Practice area ${i + 1}`} value={p.name} onChange={(e) => setArea(i, { name: e.target.value })} /></td>
            <td><select aria-label={`Income account for practice area ${i + 1}`} value={p.incomeAccount} onChange={(e) => setArea(i, { incomeAccount: e.target.value })}>
              <option value="">Choose…</option>{o.accounts.filter((a) => a.type === 'income').map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select></td>
            <td><button type="button" className="secondary" aria-label={`Remove practice area ${i + 1}`} onClick={() => setS({ ...s, practiceAreas: s.practiceAreas.filter((_, j) => j !== i) })}>Remove</button></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={() => setS({ ...s, practiceAreas: [...s.practiceAreas, { name: '', incomeAccount: '' }] })}>Add practice area</button>
        <button type="submit" disabled={busy !== null}>{locked ? 'Save settings' : 'Set up receivables'}</button>
      </div>
      {locked && <p className="muted small">The control account is fixed after set-up.</p>}
      <Notice feedback={feedback} />
    </form>
  );
}

function SettingsView(props: { overview: Overview }) {
  const s = props.overview.settings!;
  return (
    <div className="panel">
      <p>Receivables {s.receivable_account} · Output GCT {s.gct_account} · Disbursements {s.disbursement_account} · Fees in advance {s.retainer_account}</p>
      <table><thead><tr><th>Practice area</th><th>Income account</th></tr></thead>
        <tbody>{props.overview.practiceAreas.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.income_account}</td></tr>)}</tbody></table>
    </div>
  );
}

// ---------- Customer form ----------

function CustomerForm(props: { props: CapabilityPanelProps; initial?: { name: string; trn: string; email: string; address: string; status?: string }; actionId?: 'customer.create' | 'customer.update'; onDone: (f: { f: ActionFeedback; success: string }) => void; onCancel?: () => void }) {
  const { run, busy } = useAction(props.props);
  const [c, setC] = useState(props.initial ?? { name: '', trn: '', email: '', address: '' });
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const actionId = props.actionId ?? 'customer.create';
  async function save(e: FormEvent) {
    e.preventDefault();
    const result = await run(actionId, c);
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    props.onDone({ f: result, success: actionId === 'customer.create' ? `Customer ${c.name} added.` : 'Customer saved.' });
  }
  return (
    <form className="journal-editor" onSubmit={(e) => void save(e)}>
      <div className="journal-head">
        <label className="grow">Name<input value={c.name} required onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
        <label>TRN<input value={c.trn} onChange={(e) => setC({ ...c, trn: e.target.value })} /></label>
        <label className="grow">Email<input type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></label>
        <label className="grow">Address<input value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} /></label>
        {c.status !== undefined && (
          <label>Status<select value={c.status} onChange={(e) => setC({ ...c, status: e.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        )}
      </div>
      <div className="toolbar">
        <button type="submit" disabled={busy !== null}>{actionId === 'customer.create' ? 'Add customer' : 'Save customer'}</button>
        {props.onCancel && <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>}
      </div>
      <Notice feedback={feedback} />
    </form>
  );
}

// ---------- Fee note editor ----------

interface EditorState { customerId: string; issueDate: string; matterRef: string; practiceArea: string; description: string; lines: (FeeNoteLine & { key: number })[] }
let lineKey = 0;
const blankLine = (kind: 'fee' | 'disbursement' = 'fee'): EditorState['lines'][number] =>
  ({ key: (lineKey += 1), kind, description: '', amount: '', taxCode: kind === 'fee' ? 'GCT15' : 'OUT' });

function FeeNoteEditor(props: {
  initial: EditorState; customers: { id: string; name: string }[]; practiceAreas: PracticeArea[]; taxCodes: { code: TaxCode; label: string }[];
  busy: boolean; submitLabel: string; onSubmit: (input: unknown) => void; onCancel?: () => void;
}) {
  const { currency } = useWorkspaceTools();
  const [s, setS] = useState(props.initial);
  const totals = useMemo(() => {
    const sum = (kind: 'fee' | 'disbursement') => s.lines.filter((l) => l.kind === kind).reduce((t, l) => t + (toMinor(l.amount) ?? 0n), 0n);
    const fees = sum('fee'); const disb = sum('disbursement'); const gct = gctPreview(s.lines);
    return { fees, disb, gct, total: fees + disb + gct, bad: s.lines.some((l) => toMinor(l.amount) === null) };
  }, [s.lines]);
  const setLine = (key: number, patch: Partial<FeeNoteLine>) => setS({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  function submit(e: FormEvent) {
    e.preventDefault();
    props.onSubmit({
      customerId: s.customerId, issueDate: s.issueDate, matterRef: s.matterRef, practiceArea: s.practiceArea, description: s.description,
      lines: s.lines.filter((l) => l.description.trim() || l.amount.trim()).map(({ kind, description, amount, taxCode }) => ({ kind, description, amount, taxCode })),
    });
  }
  return (
    <form className="journal-editor fee-note-editor" onSubmit={submit}>
      <div className="journal-head">
        <label className="grow">Customer
          <select value={s.customerId} required onChange={(e) => setS({ ...s, customerId: e.target.value })}>
            <option value="">Choose…</option>{props.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label>Date<input type="date" value={s.issueDate} required onChange={(e) => setS({ ...s, issueDate: e.target.value })} /></label>
        <label>Matter<input value={s.matterRef} placeholder="e.g. M-0388" onChange={(e) => setS({ ...s, matterRef: e.target.value })} /></label>
        <label>Practice area
          <select value={s.practiceArea} required onChange={(e) => setS({ ...s, practiceArea: e.target.value })}>
            <option value="">Choose…</option>{props.practiceAreas.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select></label>
        <label className="grow">Description<input value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></label>
      </div>
      <div className="table-scroll"><table className="lines">
        <thead><tr><th>Line</th><th>Description</th><th className="num">Amount ({currency})</th><th>Tax</th><th /></tr></thead>
        <tbody>{s.lines.map((l, i) => (
          <tr key={l.key}>
            <td><select aria-label={`Line ${i + 1} kind`} value={l.kind} onChange={(e) => { const kind = e.target.value as 'fee' | 'disbursement'; setLine(l.key, { kind, taxCode: kind === 'fee' ? 'GCT15' : 'OUT' }); }}>
              <option value="fee">Professional fee</option><option value="disbursement">Disbursement</option></select></td>
            <td><input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></td>
            <td><input aria-label={`Line ${i + 1} amount`} className="num" inputMode="decimal" value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value })} /></td>
            <td><select aria-label={`Line ${i + 1} tax`} value={l.taxCode} onChange={(e) => setLine(l.key, { taxCode: e.target.value as TaxCode })}>
              {props.taxCodes.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select></td>
            <td>{s.lines.length > 1 && <button type="button" className="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => setS({ ...s, lines: s.lines.filter((x) => x.key !== l.key) })}>Remove</button>}</td>
          </tr>
        ))}</tbody>
        <tfoot>
          <tr><td colSpan={2}>Fees</td><td className="num">{formatMinor(totals.fees)}</td><td colSpan={2} /></tr>
          <tr><td colSpan={2}>GCT</td><td className="num">{formatMinor(totals.gct)}</td><td colSpan={2} /></tr>
          <tr><td colSpan={2}>Disbursements</td><td className="num">{formatMinor(totals.disb)}</td><td colSpan={2} /></tr>
          <tr><th colSpan={2}>Total</th><th className="num">{formatMinor(totals.total)}</th><td colSpan={2}>{totals.bad && <span className="warn small">Check the amounts</span>}</td></tr>
        </tfoot>
      </table></div>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={() => setS({ ...s, lines: [...s.lines, blankLine('fee')] })}>Add fee line</button>
        <button type="button" className="secondary" onClick={() => setS({ ...s, lines: [...s.lines, blankLine('disbursement')] })}>Add disbursement</button>
        <button type="submit" disabled={props.busy || totals.bad}>{props.submitLabel}</button>
        {props.onCancel && <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function NewFeeNote(props: { props: CapabilityPanelProps; overview: Overview; customers: CustomerBalance[]; onCancel: () => void; onError: (f: { f: ActionFeedback; success: string }) => void }) {
  const { orgId } = useWorkspaceTools();
  const { navigate } = useApp();
  const { run, busy } = useAction(props.props);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  async function create(input: unknown) {
    const result = await run('fee-note.create', input);
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    navigate(workspacePath(orgId, 'fee-note', (result.result as { id: string }).id));
  }
  return (
    <>
      <FeeNoteEditor initial={{ customerId: '', issueDate: today(), matterRef: '', practiceArea: '', description: '', lines: [blankLine('fee')] }}
        customers={props.customers} practiceAreas={props.overview.practiceAreas} taxCodes={props.overview.taxCodes}
        busy={busy !== null} submitLabel="Save draft" onSubmit={(i) => void create(i)} onCancel={props.onCancel} />
      <Notice feedback={feedback} />
    </>
  );
}

// ---------- Receipt form ----------

function ReceiptForm(props: { props: CapabilityPanelProps; overview: Overview; customers: CustomerBalance[]; broughtForward?: CustomerBalance; onDone: (f: { f: ActionFeedback; success: string }) => void; onCancel: () => void }) {
  const o = props.overview;
  const { run, busy } = useAction(props.props);
  const cash = o.accounts.filter((a) => (a.classification ?? '').startsWith('BS.CA.CASH'));
  const [r, setR] = useState({ customerId: '', kind: 'payment' as 'payment' | 'retainer', receiptDate: today(), method: 'RTGS', depositAccount: cash[0]?.code ?? '', amount: '', reference: '', notes: '', allocateTo: '' });
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const open = (o.feeNotes ?? []).filter((n) => n.customerId === r.customerId && n.status === 'issued' && n.outstanding !== '0');
  async function save(e: FormEvent) {
    e.preventDefault();
    const { customerId, allocateTo, ...rest } = r;
    const result = await run('receipt.record', { ...rest, ...(customerId ? { customerId } : {}), ...(allocateTo && r.kind === 'payment' ? { allocateTo } : {}) });
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    const x = result.result as { number: string; allocated: unknown };
    props.onDone({ f: result, success: `Receipt ${x.number} recorded${x.allocated ? ' and allocated' : ''}.` });
  }
  return (
    <form className="journal-editor" onSubmit={(e) => void save(e)}>
      <div className="journal-head">
        <label>Kind<select value={r.kind} onChange={(e) => setR({ ...r, kind: e.target.value as 'payment' | 'retainer' })}><option value="payment">Payment</option><option value="retainer">Retainer (in advance)</option></select></label>
        <label className="grow">From
          <select value={r.customerId} onChange={(e) => setR({ ...r, customerId: e.target.value, allocateTo: '' })}>
            <option value="">{r.kind === 'payment' ? 'Not known yet (unidentified)' : 'Choose…'}</option>{props.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {r.kind === 'payment' && props.broughtForward && <option value={props.broughtForward.id}>A fee note from before the system (brought forward)</option>}
          </select></label>
        <label>Date<input type="date" value={r.receiptDate} required onChange={(e) => setR({ ...r, receiptDate: e.target.value })} /></label>
        <label>Amount<input className="num" inputMode="decimal" value={r.amount} required onChange={(e) => setR({ ...r, amount: e.target.value })} /></label>
        <label>Method<input value={r.method} required onChange={(e) => setR({ ...r, method: e.target.value })} /></label>
        <label>Paid into<select value={r.depositAccount} onChange={(e) => setR({ ...r, depositAccount: e.target.value })}>{cash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
        <label className="grow">Reference<input value={r.reference} placeholder="e.g. their invoice or bank ref" onChange={(e) => setR({ ...r, reference: e.target.value })} /></label>
        {r.kind === 'payment' && r.customerId && (
          <label className="grow">Allocate to<select value={r.allocateTo} onChange={(e) => setR({ ...r, allocateTo: e.target.value })}>
            <option value="">Leave unallocated for now</option>{open.map((n) => <option key={n.id} value={n.id}>{n.number} – outstanding {formatMinor(n.outstanding)}</option>)}
          </select></label>
        )}
      </div>
      <div className="toolbar">
        <button type="submit" disabled={busy !== null}>Record receipt</button>
        <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
      </div>
      <Notice feedback={feedback} />
    </form>
  );
}

// ---------- Customer workspace ----------

interface CustomerData {
  currency: string; customer: { id: string; kind: string; name: string; trn: string; email: string; address: string; status: string };
  balance: CustomerBalance; feeNotes: FeeNoteSummary[]; receipts: ReceiptSummary[];
  statement: { date: string; kind: string; reference: string | null; description: string; debit: string; credit: string; balance: string; documentId: string }[];
}

export function CustomerStatement(props: CapabilityPanelProps) {
  const { orgId, currency } = useWorkspaceTools();
  const id = props.snapshot.object.reference.objectId;
  const c = useData<CustomerData>(`/api/orgs/${orgId}/customers/${id}`);
  if (c.loading) return <Loading />;
  if (c.error) return <ErrorText message={c.error} />;
  const lines = c.data!.statement;
  return (
    <div className="panel">
      {!lines.length ? <p className="muted">Nothing on this customer's account yet.</p> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Date</th><th>Reference</th><th>Details</th><th className="num">Charged ({currency})</th><th className="num">Paid or credited</th><th className="num">Balance</th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td>{l.date}</td>
              <td>{l.kind === 'fee-note' || l.kind === 'credit-note' || l.kind === 'retainer'
                ? (l.reference === 'B/F' ? 'B/F' : <Link to={workspacePath(orgId, 'fee-note', l.documentId)}>{l.reference}</Link>) : l.reference}</td>
              <td>{l.description}</td>
              <td className="num">{l.debit === '0' ? '' : money(l.debit)}</td><td className="num">{l.credit === '0' ? '' : money(l.credit)}</td><td className="num">{money(l.balance)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export function CustomerFeeNotes(props: CapabilityPanelProps) {
  const { orgId } = useWorkspaceTools();
  const c = useData<CustomerData>(`/api/orgs/${orgId}/customers/${props.snapshot.object.reference.objectId}`);
  if (c.loading) return <Loading />;
  if (c.error) return <ErrorText message={c.error} />;
  return <div className="panel"><FeeNoteTable notes={c.data!.feeNotes} /></div>;
}

export function CustomerDetails(props: CapabilityPanelProps) {
  const { orgId, refreshWorkspace } = useWorkspaceTools();
  const id = props.snapshot.object.reference.objectId;
  const c = useData<CustomerData>(`/api/orgs/${orgId}/customers/${id}`);
  const [flash, setFlash] = useFlash(`customer:${id}`);
  if (c.loading) return <Loading />;
  if (c.error) return <ErrorText message={c.error} />;
  const cust = c.data!.customer;
  if (cust.kind !== 'customer') return <div className="panel"><p className="muted">This is a system account used to hold {cust.kind === 'brought_forward' ? 'balances brought forward from before the system' : 'payments not yet identified'}.</p></div>;
  return (
    <div className="panel">
      {hasAction(props, 'customer.update')
        ? <CustomerForm props={props} actionId="customer.update" initial={{ name: cust.name, trn: cust.trn, email: cust.email, address: cust.address, status: cust.status }}
            onDone={(f) => { setFlash(f, true); refreshWorkspace(); }} />
        : <dl><dt>TRN</dt><dd>{cust.trn || '—'}</dd><dt>Email</dt><dd>{cust.email || '—'}</dd><dt>Address</dt><dd>{cust.address || '—'}</dd></dl>}
      {flash && <Notice feedback={flash.f} success={flash.success} />}
    </div>
  );
}

// ---------- Fee note workspace ----------

export function FeeNoteDetails(props: CapabilityPanelProps) {
  const { orgId, refreshWorkspace } = useWorkspaceTools();
  const { navigate } = useApp();
  const id = props.snapshot.object.reference.objectId;
  const d = useData<FeeNoteDetailData>(`/api/orgs/${orgId}/fee-notes/${id}`);
  const { run, busy } = useAction(props);
  const [flash, setFlash] = useFlash(`fee-note:${id}`);
  const [panel, setPanel] = useState<null | 'allocate' | 'retainer' | 'credit'>(null);

  if (d.loading) return <Loading />;
  if (d.error) return <ErrorText message={d.error} />;
  const data = d.data!;
  const n = data.feeNote;
  const after = (f: ActionFeedback, success: string) => {
    if (!f.ok) { setFlash({ f, success: '' }); return; }
    setFlash({ f, success }, true);
    refreshWorkspace();
  };

  if (n.status === 'draft') {
    return (
      <div className="panel">
        <p className="muted small">Draft: not yet posted. Issuing gives it the next fee note number and posts it to the ledger.</p>
        {hasAction(props, 'fee-note.update')
          ? <FeeNoteEditor
              initial={{ customerId: n.customerId, issueDate: n.issueDate, matterRef: n.matterRef, practiceArea: n.practiceArea, description: n.description,
                lines: n.lines.map((l) => ({ ...l, amount: formatMinor(l.amount), key: (lineKey += 1) })) }}
              customers={data.customers} practiceAreas={data.practiceAreas} taxCodes={data.taxCodes} busy={busy !== null} submitLabel="Save draft"
              onSubmit={(input) => void run('fee-note.update', input).then((f) => f && after(f, 'Draft saved.'))} />
          : <FeeNoteDocument data={data} />}
        <div className="toolbar">
          {hasAction(props, 'fee-note.issue') && <button type="button" disabled={busy !== null} onClick={() => void run('fee-note.issue', {}).then((f) => f && after(f, `Fee note ${(f.result as { number?: string } | undefined)?.number ?? ''} issued and posted.`))}>Issue fee note</button>}
          {hasAction(props, 'fee-note.discard') && <button type="button" className="secondary" disabled={busy !== null} onClick={() => void run('fee-note.discard', {}).then((f) => { if (f?.ok) navigate(workspacePath(orgId, 'client-organisation', orgId, 'receivables')); else if (f) setFlash({ f, success: '' }); })}>Discard draft</button>}
        </div>
        {flash && <Notice feedback={flash.f} success={flash.success} />}
      </div>
    );
  }

  const outstanding = BigInt(data.outstanding);
  return (
    <div className="panel">
      <div className="toolbar no-print">
        <button type="button" className="secondary" onClick={() => window.print()}>Print</button>
        {!n.broughtForward && outstanding > 0n && hasAction(props, 'fee-note.allocate') && data.available.payments.length > 0 && <button type="button" className="secondary" onClick={() => setPanel('allocate')}>Allocate a payment</button>}
        {!n.broughtForward && outstanding > 0n && hasAction(props, 'fee-note.apply-retainer') && data.available.retainers.length > 0 && <button type="button" className="secondary" onClick={() => setPanel('retainer')}>Apply retainer</button>}
        {!n.broughtForward && outstanding > 0n && hasAction(props, 'fee-note.credit') && <button type="button" className="secondary" onClick={() => setPanel('credit')}>Credit note</button>}
        {n.entryId && <Link to={workspacePath(orgId, 'journal', n.entryId)}>Journal</Link>}
      </div>
      {n.broughtForward && outstanding > 0n && hasAction(props, 'fee-note.allocate') && data.available.payments.length > 0 && panel === null &&
        <div className="toolbar no-print"><button type="button" className="secondary" onClick={() => setPanel('allocate')}>Allocate a payment</button></div>}
      {panel === 'allocate' && <SettleForm title="Allocate a payment" sources={data.available.payments} outstanding={data.outstanding} busy={busy !== null}
        onCancel={() => setPanel(null)} onSubmit={(input) => void run('fee-note.allocate', input).then((f) => f && after(f, 'Payment allocated.'))} />}
      {panel === 'retainer' && <SettleForm title="Apply a retainer" sources={data.available.retainers} outstanding={data.outstanding} busy={busy !== null}
        onCancel={() => setPanel(null)} onSubmit={(input) => void run('fee-note.apply-retainer', input).then((f) => f && after(f, 'Retainer applied and posted.'))} />}
      {panel === 'credit' && <CreditForm creditable={data.creditable} busy={busy !== null} hasGct={n.gct !== '0'}
        onCancel={() => setPanel(null)} onSubmit={(input) => void run('fee-note.credit', input).then((f) => f && after(f, `Credit note ${(f.result as { number?: string } | undefined)?.number ?? ''} issued.`))} />}
      {flash && <Notice feedback={flash.f} success={flash.success} />}
      {n.broughtForward
        ? <p>Receivables brought forward from before this system, at the opening date. Allocate January payments of earlier fee notes here.</p>
        : <FeeNoteDocument data={data} />}
    </div>
  );
}

function SettleForm(props: { title: string; sources: ReceiptSummary[]; outstanding: string; busy: boolean; onSubmit: (input: unknown) => void; onCancel: () => void }) {
  const first = props.sources[0];
  const suggest = (r?: ReceiptSummary) => r ? formatMinor(BigInt(r.available) < BigInt(props.outstanding) ? r.available : props.outstanding) : '';
  const [s, setS] = useState({ receiptId: first?.id ?? '', amount: suggest(first) });
  return (
    <form className="journal-editor no-print" onSubmit={(e) => { e.preventDefault(); props.onSubmit(s); }}>
      <strong>{props.title}</strong>
      <div className="journal-head">
        <label className="grow">From<select value={s.receiptId} onChange={(e) => setS({ receiptId: e.target.value, amount: suggest(props.sources.find((r) => r.id === e.target.value)) })}>
          {props.sources.map((r) => <option key={r.id} value={r.id}>{r.number} ({r.date}) – {formatMinor(r.available)} available</option>)}</select></label>
        <label>Amount<input className="num" inputMode="decimal" value={s.amount} onChange={(e) => setS({ ...s, amount: e.target.value })} /></label>
      </div>
      <div className="toolbar"><button type="submit" disabled={props.busy}>Confirm</button><button type="button" className="secondary" onClick={props.onCancel}>Cancel</button></div>
    </form>
  );
}

function CreditForm(props: { creditable: { fees: string; disbursements: string }; hasGct: boolean; busy: boolean; onSubmit: (input: unknown) => void; onCancel: () => void }) {
  const [s, setS] = useState({ creditDate: today(), reason: '', fees: '', disbursements: '' });
  const gct = props.hasGct ? gctPreview([{ amount: s.fees, taxCode: 'GCT15' }]) : 0n;
  const total = (toMinor(s.fees) ?? 0n) + (toMinor(s.disbursements) ?? 0n) + gct;
  return (
    <form className="journal-editor no-print" onSubmit={(e) => { e.preventDefault(); props.onSubmit(s); }}>
      <strong>Credit note</strong>
      <div className="journal-head">
        <label>Date<input type="date" value={s.creditDate} onChange={(e) => setS({ ...s, creditDate: e.target.value })} /></label>
        <label>Fees to credit (up to {formatMinor(props.creditable.fees)})<input className="num" inputMode="decimal" value={s.fees} onChange={(e) => setS({ ...s, fees: e.target.value })} /></label>
        <label>Disbursements (up to {formatMinor(props.creditable.disbursements)})<input className="num" inputMode="decimal" value={s.disbursements} onChange={(e) => setS({ ...s, disbursements: e.target.value })} /></label>
        <label className="grow">Reason<input value={s.reason} required onChange={(e) => setS({ ...s, reason: e.target.value })} /></label>
      </div>
      <p className="muted small">GCT credited: {formatMinor(gct)} · Credit note total: {formatMinor(total)}</p>
      <div className="toolbar"><button type="submit" disabled={props.busy}>Issue credit note</button><button type="button" className="secondary" onClick={props.onCancel}>Cancel</button></div>
    </form>
  );
}

/** The fee note as the customer sees it; also what Print produces. */
function FeeNoteDocument(props: { data: FeeNoteDetailData }) {
  const { currency } = useWorkspaceTools();
  const { firm, feeNote: n, customer } = props.data;
  return (
    <article className="print-doc fee-note-doc" aria-label="Fee note">
      <header className="doc-head">
        <div><h2>{firm.legalName || firm.name}</h2>{firm.trn && <p>TRN {firm.trn}</p>}</div>
        <div className="doc-title"><h2>{n.status === 'draft' ? 'Draft fee note' : 'Fee note'}</h2><p>{n.number ?? ''}</p><p>{n.issueDate}</p></div>
      </header>
      <section className="doc-to">
        <p><strong>To:</strong> {customer.name}</p>
        {customer.address && <p>{customer.address}</p>}
        {customer.trn && <p>TRN {customer.trn}</p>}
        {n.matterRef && <p><strong>Matter:</strong> {n.matterRef}{n.practiceArea ? ` · ${n.practiceArea}` : ''}</p>}
        {n.description && <p>{n.description}</p>}
      </section>
      <table className="doc-lines">
        <thead><tr><th>Description</th><th>Tax</th><th className="num">Amount ({currency})</th></tr></thead>
        <tbody>{n.lines.map((l, i) => (
          <tr key={i}><td>{l.description}{l.kind === 'disbursement' && <span className="muted small"> (disbursement)</span>}</td><td>{l.taxCode === 'GCT15' ? 'GCT 15%' : l.taxCode === 'EXEMPT' ? 'Exempt' : '—'}</td><td className="num">{money(l.amount)}</td></tr>
        ))}</tbody>
        <tfoot>
          <tr><td colSpan={2}>Professional fees</td><td className="num">{money(n.fees)}</td></tr>
          <tr><td colSpan={2}>GCT at 15%</td><td className="num">{money(n.gct)}</td></tr>
          <tr><td colSpan={2}>Disbursements</td><td className="num">{money(n.disbursements)}</td></tr>
          <tr><th colSpan={2}>Total due</th><th className="num">{currency} {money(n.total)}</th></tr>
          {n.status === 'issued' && <tr><td colSpan={2}>Outstanding</td><td className="num">{money(props.data.outstanding)}</td></tr>}
        </tfoot>
      </table>
    </article>
  );
}

export function FeeNoteSettlement(props: CapabilityPanelProps) {
  const { orgId, currency } = useWorkspaceTools();
  const d = useData<FeeNoteDetailData>(`/api/orgs/${orgId}/fee-notes/${props.snapshot.object.reference.objectId}`);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorText message={d.error} />;
  const data = d.data!;
  const KIND = { receipt: 'Payment', retainer: 'Retainer applied', credit_note: 'Credit note' } as const;
  return (
    <div className="panel">
      {!data.allocations.length ? <p className="muted">No payments or credits yet.</p> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Date</th><th>What</th><th>Reference</th><th className="num">Amount ({currency})</th><th /></tr></thead>
          <tbody>{data.allocations.map((a) => (
            <tr key={a.id}><td>{a.date}</td><td>{KIND[a.kind]}</td><td>{a.reference}</td><td className="num">{money(a.amount)}</td>
              <td>{a.entryId && <Link to={workspacePath(orgId, 'journal', a.entryId)}>Journal</Link>}</td></tr>
          ))}</tbody>
          <tfoot><tr><th colSpan={3}>Outstanding</th><th className="num">{money(data.outstanding)}</th><td /></tr></tfoot>
        </table></div>
      )}
      {data.creditNotes.length > 0 && (
        <>
          <h3>Credit notes</h3>
          <table><thead><tr><th>Number</th><th>Date</th><th>Reason</th><th className="num">Fees</th><th className="num">GCT</th><th className="num">Disbursements</th><th className="num">Total</th></tr></thead>
            <tbody>{data.creditNotes.map((c) => (
              <tr key={c.id}><td>{c.number}</td><td>{c.date}</td><td>{c.reason}</td><td className="num">{money(c.fees)}</td><td className="num">{money(c.gct)}</td><td className="num">{money(c.disbursements)}</td><td className="num">{money(c.total)}</td></tr>
            ))}</tbody></table>
        </>
      )}
    </div>
  );
}
