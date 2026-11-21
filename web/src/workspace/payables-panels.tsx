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
interface Flag { code: 'no-receipt' | 'matter' | 'waiting'; label: string }
interface ExpenseSummary {
  id: string; number: string | null; status: string; broughtForward: boolean; date: string; supplierId: string; supplierName: string;
  supplierInvoice: string; description: string; settlement: 'paid' | 'owed'; paidFrom: string; paymentRef: string;
  net: string; gct: string; total: string; outstanding: string; state: string; flags: Flag[];
}
interface SupplierBalance { id: string; name: string; kind: 'supplier' | 'brought_forward'; trn: string; status: string; owed: string; spent: string }
interface Payment { id: string; number: string; date: string; supplierId: string; supplierName: string; paidFrom: string; method: string; reference: string; amount: string; entryId: string | null }
interface Overview {
  currency: string; setUp: boolean; settings: { payable_account: string; input_gct_account: string; disbursement_account: string; set_up_at: string | null } | null;
  accounts: AccountOption[]; taxCodes: { code: TaxCode; label: string }[];
  suppliers?: SupplierBalance[]; expenses?: ExpenseSummary[]; payments?: Payment[];
  control?: { account: string; subledger: string; ledger: string; difference: string };
}
interface StoredLine { account: string; description: string; net: string; gct: string; taxCode: TaxCode; matterRef: string }
interface ExpenseDetailData {
  currency: string;
  expense: {
    id: string; number: string | null; status: string; broughtForward: boolean; date: string; supplierId: string; supplierInvoice: string; description: string;
    settlement: 'paid' | 'owed'; paidFrom: string; paymentMethod: string; paymentRef: string; receiptOnFile: boolean; foreignAmount: string; notes: string;
    lines: StoredLine[]; net: string; gctClaimed: string; gctNotClaimed: string; total: string; entryId: string | null;
    cancelDate: string | null; cancelReason: string; cancelEntryId: string | null;
  };
  supplier: { id: string; name: string; trn: string };
  payments: { id: string; number: string; date: string; amount: string; entryId: string | null }[];
  outstanding: string; flags: Flag[];
  suppliers: { id: string; name: string }[]; accounts: AccountOption[]; taxCodes: { code: TaxCode; label: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);
const money = (minor: string | bigint) => formatMinor(minor);
const isCash = (a: AccountOption) => a.type === 'asset' && (a.classification ?? '').startsWith('BS.CA.CASH');
const STATE_LABEL: Record<string, string> = { draft: 'Draft', recording: 'Recording', paid: 'Paid', owed: 'Owed', 'part-paid': 'Part-paid', settled: 'Settled', cancelled: 'Cancelled' };
const STATE_BADGE: Record<string, string> = { draft: 'draft', recording: 'submitted', paid: 'posted', owed: 'submitted', 'part-paid': 'approved', settled: 'posted', cancelled: 'reversed' };
const StateBadge = (p: { value: string }) => <span className={`badge badge-${STATE_BADGE[p.value] ?? 'draft'}`}>{STATE_LABEL[p.value] ?? p.value}</span>;
const Flags = (p: { flags: Flag[] }) => <>{p.flags.map((f) => <span key={f.code} className="flag" title={f.label}>{f.code === 'no-receipt' ? 'No receipt' : f.code === 'matter' ? 'Matter?' : 'Waiting'}</span>)}</>;

function toMinor(text: string): bigint | null {
  const s = text.trim().replace(/,/g, '').replace(/^J\$/i, '');
  if (!s) return 0n;
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? BigInt(m[1]! + (m[2] ?? '').padEnd(2, '0')) : null;
}
const gct15 = (net: bigint) => (net * 15n * 2n + 100n) / 200n;

// ---------- Client › Expenses ----------

type Tab = 'expenses' | 'attention' | 'suppliers' | 'payments' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'expenses', label: 'Expenses' }, { id: 'attention', label: 'Needs attention' }, { id: 'suppliers', label: 'Suppliers' },
  { id: 'payments', label: 'Supplier payments' }, { id: 'settings', label: 'Settings' },
];

export function ClientExpenses(props: CapabilityPanelProps) {
  const { orgId, currency } = useWorkspaceTools();
  const data = useData<Overview>(`/api/orgs/${orgId}/payables`);
  const [tab, setTab] = useState<Tab>('expenses');
  const [form, setForm] = useState<null | 'supplier' | 'expense' | 'payment'>(null);
  const [flash, setFlash] = useFlash(`payables:${orgId}`);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorText message={data.error} />;
  const d = data.data!;
  if (!d.setUp) {
    return (
      <div className="panel">
        <p>Set up expenses for this client: choose the supplier control account, where input GCT is held, and where rechargeable costs go.
          What is owed to suppliers at the opening date is brought forward as one item, so suppliers agree with the ledger from day one.</p>
        {hasAction(props, 'payables.settings')
          ? <SettingsForm props={props} overview={d} onSaved={(f) => { setFlash(f, true); data.reload(); }} />
          : <p className="muted">An accountant sets this up.</p>}
        {flash && <Notice feedback={flash.f} success={flash.success} />}
      </div>
    );
  }
  const done = (f: { f: ActionFeedback; success: string }) => { setForm(null); setFlash(f); data.reload(); };
  const suppliers = d.suppliers!.filter((s) => s.kind === 'supplier' && s.status === 'active');
  const attention = d.expenses!.filter((e) => e.flags.length > 0 && e.state !== 'cancelled');
  const c = d.control!;
  return (
    <div className="panel">
      <div className="cards">
        <div className="card"><span>Owed to suppliers ({currency})</span><strong>{money(c.subledger)}</strong>
          <small className={c.difference === '0' ? 'ok' : 'warn'}>{c.difference === '0' ? `Agrees with account ${c.account}` : `Account ${c.account} shows ${money(c.ledger)}: difference ${money(c.difference)}`}</small></div>
        <div className="card"><span>Needs attention</span><strong>{attention.length}</strong><small>{attention.length ? 'Drafts, missing receipts, unknown matters' : 'Nothing outstanding'}</small></div>
      </div>
      <div className="toolbar">
        {hasAction(props, 'expense.create') && <button type="button" onClick={() => setForm('expense')}>New expense</button>}
        {hasAction(props, 'supplier-payment.record') && <button type="button" className="secondary" onClick={() => setForm('payment')}>Pay supplier</button>}
        {hasAction(props, 'supplier.create') && <button type="button" className="secondary" onClick={() => setForm('supplier')}>Add supplier</button>}
      </div>
      {form === 'supplier' && <SupplierForm props={props} onDone={done} onCancel={() => setForm(null)} />}
      {form === 'expense' && <NewExpense props={props} overview={d} suppliers={suppliers} onDone={done} onCancel={() => setForm(null)} />}
      {form === 'payment' && <PaymentForm props={props} overview={d} onDone={done} onCancel={() => setForm(null)} />}
      {flash && <Notice feedback={flash.f} success={flash.success} />}
      <div className="segmented" role="group" aria-label="Show">
        {TABS.map((t) => <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
          {t.label}{t.id === 'attention' && attention.length ? ` (${attention.length})` : ''}</button>)}
      </div>
      {tab === 'expenses' && <ExpenseTable expenses={d.expenses!} showSupplier />}
      {tab === 'attention' && (attention.length ? <ExpenseTable expenses={attention} showSupplier showFlagText /> : <p className="muted">Nothing needs attention.</p>)}
      {tab === 'suppliers' && <SupplierTable suppliers={d.suppliers!} />}
      {tab === 'payments' && <PaymentTable payments={d.payments!} />}
      {tab === 'settings' && (hasAction(props, 'payables.settings') ? <SettingsForm props={props} overview={d} onSaved={done} />
        : <p>Payables {d.settings!.payable_account} · Input GCT {d.settings!.input_gct_account} · Rechargeable costs {d.settings!.disbursement_account}</p>)}
    </div>
  );
}

function ExpenseTable(props: { expenses: ExpenseSummary[]; showSupplier?: boolean; showFlagText?: boolean }) {
  const { orgId, currency } = useWorkspaceTools();
  if (!props.expenses.length) return <p className="muted">No expenses yet.</p>;
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Number</th><th>Date</th>{props.showSupplier && <th>Supplier</th>}<th>Details</th><th className="num">Total ({currency})</th><th className="num">Owed</th><th>Status</th></tr></thead>
      <tbody>{props.expenses.map((e) => (
        <tr key={e.id}>
          <td><Link to={workspacePath(orgId, 'expense', e.id)}>{e.broughtForward ? 'B/F' : e.number ?? 'Draft'}</Link></td>
          <td>{e.date}</td>
          {props.showSupplier && <td><Link to={workspacePath(orgId, 'supplier', e.supplierId)}>{e.supplierName}</Link></td>}
          <td>{e.description}{e.supplierInvoice && <span className="muted small"> · inv {e.supplierInvoice}</span>}
            {props.showFlagText ? e.flags.map((f) => <div key={f.code} className="warn small">{f.label}</div>) : <> <Flags flags={e.flags} /></>}</td>
          <td className="num">{money(e.total)}</td><td className="num">{e.outstanding === '0' ? '' : money(e.outstanding)}</td>
          <td><StateBadge value={e.state} /></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function SupplierTable(props: { suppliers: SupplierBalance[] }) {
  const { orgId, currency } = useWorkspaceTools();
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Supplier</th><th>TRN</th><th className="num">Owed ({currency})</th><th className="num">Spent this year</th></tr></thead>
      <tbody>{props.suppliers.map((s) => (
        <tr key={s.id}>
          <td><Link to={workspacePath(orgId, 'supplier', s.id)}>{s.name}</Link>{s.kind !== 'supplier' && <span className="muted small"> · system</span>}{s.status === 'inactive' && <span className="muted small"> · inactive</span>}</td>
          <td>{s.trn}</td><td className="num">{s.owed === '0' ? '' : money(s.owed)}</td><td className="num">{s.spent === '0' ? '' : money(s.spent)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function PaymentTable(props: { payments: Payment[]; hideSupplier?: boolean }) {
  const { orgId, currency } = useWorkspaceTools();
  if (!props.payments.length) return <p className="muted">No supplier payments yet.</p>;
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Number</th><th>Date</th>{!props.hideSupplier && <th>Supplier</th>}<th>Method</th><th className="num">Amount ({currency})</th><th /></tr></thead>
      <tbody>{props.payments.map((p) => (
        <tr key={p.id}><td>{p.number}</td><td>{p.date}</td>
          {!props.hideSupplier && <td><Link to={workspacePath(orgId, 'supplier', p.supplierId)}>{p.supplierName}</Link></td>}
          <td>{[p.method, p.reference].filter(Boolean).join(' ')}</td><td className="num">{money(p.amount)}</td>
          <td>{p.entryId && <Link to={workspacePath(orgId, 'journal', p.entryId)}>Journal</Link>}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

// ---------- Settings ----------

function AccountSelect(props: { label: string; value: string; accounts: AccountOption[]; filter: (a: AccountOption) => boolean; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label>{props.label}
      <select value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">Choose…</option>{props.accounts.filter(props.filter).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
      </select>
    </label>
  );
}

function SettingsForm(props: { props: CapabilityPanelProps; overview: Overview; onSaved: (f: { f: ActionFeedback; success: string }) => void }) {
  const o = props.overview;
  const { run, busy } = useAction(props.props);
  const find = (test: (a: AccountOption) => boolean) => o.accounts.find(test)?.code ?? '';
  const [s, setS] = useState({
    payableAccount: o.settings?.payable_account ?? find((a) => a.classification === 'BS.CL.PAY.TRADE' || /payable/i.test(a.name) && a.type === 'liability'),
    inputGctAccount: o.settings?.input_gct_account ?? find((a) => /input/i.test(a.name) && /GCT/i.test(a.name)),
    disbursementAccount: o.settings?.disbursement_account ?? find((a) => /disbursement/i.test(a.name)),
  });
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const locked = Boolean(o.settings?.set_up_at);
  async function save(e: FormEvent) {
    e.preventDefault();
    const result = await run('payables.settings', s);
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    const bf = (result.result as { broughtForward: string }).broughtForward;
    props.onSaved({ f: result, success: locked ? 'Expense settings saved.' : `Expenses set up. Owed to suppliers brought forward: ${o.currency} ${bf}.` });
  }
  return (
    <form className="journal-editor" onSubmit={(e) => void save(e)}>
      <div className="journal-head">
        <AccountSelect label="Suppliers control account" value={s.payableAccount} accounts={o.accounts} filter={(a) => a.type === 'liability'} disabled={locked} onChange={(v) => setS({ ...s, payableAccount: v })} />
        <AccountSelect label="Input GCT recoverable" value={s.inputGctAccount} accounts={o.accounts} filter={(a) => a.type === 'asset' || a.type === 'liability'} onChange={(v) => setS({ ...s, inputGctAccount: v })} />
        <AccountSelect label="Rechargeable costs" value={s.disbursementAccount} accounts={o.accounts} filter={(a) => a.type === 'asset'} onChange={(v) => setS({ ...s, disbursementAccount: v })} />
      </div>
      <div className="toolbar"><button type="submit" disabled={busy !== null}>{locked ? 'Save settings' : 'Set up expenses'}</button></div>
      {locked && <p className="muted small">The control account is fixed after set-up.</p>}
      <Notice feedback={feedback} />
    </form>
  );
}

// ---------- Supplier form ----------

function SupplierForm(props: { props: CapabilityPanelProps; initial?: { name: string; trn: string; email: string; address: string; status?: string }; actionId?: 'supplier.create' | 'supplier.update'; onDone: (f: { f: ActionFeedback; success: string }) => void; onCancel?: () => void }) {
  const { run, busy } = useAction(props.props);
  const [c, setC] = useState(props.initial ?? { name: '', trn: '', email: '', address: '' });
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const actionId = props.actionId ?? 'supplier.create';
  async function save(e: FormEvent) {
    e.preventDefault();
    const result = await run(actionId, c);
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    props.onDone({ f: result, success: actionId === 'supplier.create' ? `Supplier ${c.name} added.` : 'Supplier saved.' });
  }
  return (
    <form className="journal-editor" onSubmit={(e) => void save(e)}>
      <div className="journal-head">
        <label className="grow">Name<input value={c.name} required onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
        <label>TRN<input value={c.trn} onChange={(e) => setC({ ...c, trn: e.target.value })} /></label>
        <label className="grow">Email<input type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></label>
        <label className="grow">Address<input value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} /></label>
        {c.status !== undefined && <label>Status<select value={c.status} onChange={(e) => setC({ ...c, status: e.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>}
      </div>
      <div className="toolbar">
        <button type="submit" disabled={busy !== null}>{actionId === 'supplier.create' ? 'Add supplier' : 'Save supplier'}</button>
        {props.onCancel && <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>}
      </div>
      <Notice feedback={feedback} />
    </form>
  );
}

// ---------- Expense editor ----------

interface EditorLine { key: number; account: string; description: string; net: string; gct: string; taxCode: TaxCode; matterRef: string }
interface EditorState {
  supplierId: string; expenseDate: string; supplierInvoice: string; description: string; settlement: 'paid' | 'owed'; paidFrom: string;
  paymentMethod: string; paymentRef: string; receiptOnFile: boolean; foreignAmount: string; notes: string; lines: EditorLine[];
}
let lineKey = 0;
const blankLine = (): EditorLine => ({ key: (lineKey += 1), account: '', description: '', net: '', gct: '', taxCode: 'GCT15', matterRef: '' });

function ExpenseEditor(props: {
  initial: EditorState; suppliers: { id: string; name: string }[]; accounts: AccountOption[]; taxCodes: { code: TaxCode; label: string }[];
  disbursementAccount?: string; busy: boolean; onSubmit: (input: unknown, record: boolean) => void; onCancel?: () => void; recordLabel?: string;
}) {
  const { currency } = useWorkspaceTools();
  const [s, setS] = useState(props.initial);
  const cash = props.accounts.filter(isCash);
  const chargeable = props.accounts.filter((a) => !isCash(a) && a.type !== 'income' && a.type !== 'equity');
  const totals = useMemo(() => {
    let net = 0n; let gct = 0n; let bad = false;
    for (const l of s.lines) {
      const n = toMinor(l.net); const g = l.gct.trim() ? toMinor(l.gct) : l.taxCode === 'GCT15' ? gct15(n ?? 0n) : 0n;
      if (n === null || g === null) bad = true;
      net += n ?? 0n; gct += g ?? 0n;
    }
    return { net, gct, claimed: s.receiptOnFile ? gct : 0n, total: net + gct, bad };
  }, [s.lines, s.receiptOnFile]);
  const setLine = (key: number, patch: Partial<EditorLine>) => setS({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  function submit(record: boolean) {
    props.onSubmit({
      supplierId: s.supplierId, expenseDate: s.expenseDate, supplierInvoice: s.supplierInvoice, description: s.description, settlement: s.settlement,
      paidFrom: s.settlement === 'paid' ? s.paidFrom : '', paymentMethod: s.paymentMethod, paymentRef: s.paymentRef, receiptOnFile: s.receiptOnFile,
      foreignAmount: s.foreignAmount, notes: s.notes,
      lines: s.lines.filter((l) => l.description.trim() || l.net.trim()).map(({ account, description, net, gct, taxCode, matterRef }) => ({ account, description, net, gct, taxCode, matterRef })),
    }, record);
  }
  return (
    <form className="journal-editor expense-editor" onSubmit={(e) => { e.preventDefault(); submit(true); }}>
      <div className="journal-head">
        <label className="grow">Supplier<select value={s.supplierId} required onChange={(e) => setS({ ...s, supplierId: e.target.value })}>
          <option value="">Choose…</option>{props.suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Date<input type="date" value={s.expenseDate} required onChange={(e) => setS({ ...s, expenseDate: e.target.value })} /></label>
        <label>Supplier's invoice no.<input value={s.supplierInvoice} onChange={(e) => setS({ ...s, supplierInvoice: e.target.value })} /></label>
        <label>Paid?<select value={s.settlement} onChange={(e) => setS({ ...s, settlement: e.target.value as 'paid' | 'owed' })}>
          <option value="paid">Paid at once</option><option value="owed">Owed – pay later</option></select></label>
        {s.settlement === 'paid' && <>
          <label>Paid from<select value={s.paidFrom} required onChange={(e) => setS({ ...s, paidFrom: e.target.value })}>
            <option value="">Choose…</option>{cash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
          <label>How<input value={s.paymentMethod} placeholder="e.g. Cheque, ACH, POS" onChange={(e) => setS({ ...s, paymentMethod: e.target.value })} /></label>
          <label>Cheque / ref<input value={s.paymentRef} onChange={(e) => setS({ ...s, paymentRef: e.target.value })} /></label>
        </>}
        <label className="check"><input type="checkbox" checked={s.receiptOnFile} onChange={(e) => setS({ ...s, receiptOnFile: e.target.checked })} /> Receipt or invoice on file</label>
        <label className="grow">Foreign currency<input value={s.foreignAmount} placeholder="e.g. USD 2,500.00 at 156.90" onChange={(e) => setS({ ...s, foreignAmount: e.target.value })} /></label>
        <label className="grow">Notes<input value={s.notes} onChange={(e) => setS({ ...s, notes: e.target.value })} /></label>
      </div>
      {!s.receiptOnFile && <p className="warn small">No receipt on file: input GCT is not claimed and the full amount is charged as the expense.</p>}
      <div className="table-scroll"><table className="lines">
        <thead><tr><th>Account</th><th>Description</th><th className="num">Net ({currency})</th><th>Tax</th><th className="num">GCT</th><th>Matter</th><th /></tr></thead>
        <tbody>{s.lines.map((l, i) => {
          const n = toMinor(l.net);
          const auto = l.taxCode === 'GCT15' && n !== null ? formatMinor(gct15(n)) : '0.00';
          const rechargeable = props.disbursementAccount && l.account === props.disbursementAccount;
          return (
            <tr key={l.key}>
              <td><select aria-label={`Line ${i + 1} account`} value={l.account} onChange={(e) => setLine(l.key, { account: e.target.value })}>
                <option value="">Choose…</option>{chargeable.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></td>
              <td><input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></td>
              <td><input aria-label={`Line ${i + 1} net`} className="num" inputMode="decimal" value={l.net} onChange={(e) => setLine(l.key, { net: e.target.value })} /></td>
              <td><select aria-label={`Line ${i + 1} tax`} value={l.taxCode} onChange={(e) => setLine(l.key, { taxCode: e.target.value as TaxCode, gct: '' })}>
                {props.taxCodes.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select></td>
              <td><input aria-label={`Line ${i + 1} GCT`} className="num" inputMode="decimal" value={l.gct} placeholder={auto} disabled={l.taxCode !== 'GCT15'} onChange={(e) => setLine(l.key, { gct: e.target.value })} /></td>
              <td><input aria-label={`Line ${i + 1} matter`} value={l.matterRef} placeholder={rechargeable ? 'Matter, e.g. M-0411' : ''} onChange={(e) => setLine(l.key, { matterRef: e.target.value })} /></td>
              <td>{s.lines.length > 1 && <button type="button" className="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => setS({ ...s, lines: s.lines.filter((x) => x.key !== l.key) })}>Remove</button>}</td>
            </tr>
          );
        })}</tbody>
        <tfoot>
          <tr><td colSpan={2}>Net</td><td className="num">{formatMinor(totals.net)}</td><td colSpan={4} /></tr>
          <tr><td colSpan={2}>GCT{s.receiptOnFile ? ' (claimed as input GCT)' : ' (not claimed)'}</td><td className="num">{formatMinor(totals.gct)}</td><td colSpan={4} /></tr>
          <tr><th colSpan={2}>Total</th><th className="num">{formatMinor(totals.total)}</th><td colSpan={4}>{totals.bad && <span className="warn small">Check the amounts</span>}</td></tr>
        </tfoot>
      </table></div>
      <p className="muted small">GCT is worked out at 15% when left blank; type the amount on the supplier's invoice if it differs.</p>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={() => setS({ ...s, lines: [...s.lines, blankLine()] })}>Add line</button>
        <button type="submit" disabled={props.busy || totals.bad}>{props.recordLabel ?? 'Record expense'}</button>
        <button type="button" className="secondary" disabled={props.busy || totals.bad} onClick={() => submit(false)}>Save as draft</button>
        {props.onCancel && <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function NewExpense(props: { props: CapabilityPanelProps; overview: Overview; suppliers: SupplierBalance[]; onDone: (f: { f: ActionFeedback; success: string }) => void; onCancel: () => void }) {
  const { orgId } = useWorkspaceTools();
  const { navigate } = useApp();
  const { run, busy } = useAction(props.props);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const firstCash = props.overview.accounts.find(isCash)?.code ?? '';
  async function create(input: unknown, record: boolean) {
    if (record && !window.confirm('Record expense? It will be numbered and posted.')) return;
    const result = await run('expense.create', { ...(input as object), record });
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    const r = result.result as { id: string; number: string | null };
    if (record) props.onDone({ f: result, success: `Expense ${r.number} recorded and posted.` });
    else navigate(workspacePath(orgId, 'expense', r.id));
  }
  return (
    <>
      <ExpenseEditor initial={{ supplierId: '', expenseDate: today(), supplierInvoice: '', description: '', settlement: 'paid', paidFrom: firstCash, paymentMethod: '', paymentRef: '',
        receiptOnFile: true, foreignAmount: '', notes: '', lines: [blankLine()] }}
        suppliers={props.suppliers} accounts={props.overview.accounts} taxCodes={props.overview.taxCodes} disbursementAccount={props.overview.settings?.disbursement_account}
        busy={busy !== null} onSubmit={(i, r) => void create(i, r)} onCancel={props.onCancel} />
      <Notice feedback={feedback} />
    </>
  );
}

// ---------- Supplier payment ----------

function PaymentForm(props: { props: CapabilityPanelProps; overview: Overview; onDone: (f: { f: ActionFeedback; success: string }) => void; onCancel: () => void }) {
  const o = props.overview;
  const { run, busy } = useAction(props.props);
  const owing = o.suppliers!.filter((s) => s.owed !== '0');
  const cash = o.accounts.filter(isCash);
  const [p, setP] = useState({ supplierId: owing[0]?.id ?? '', paymentDate: today(), paidFrom: cash[0]?.code ?? '', method: '', reference: '' });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const open = o.expenses!.filter((e) => e.supplierId === p.supplierId && e.outstanding !== '0');
  const total = open.reduce((t, e) => t + (toMinor(amounts[e.id] ?? '') ?? 0n), 0n);
  if (!owing.length) return <p className="muted">Nothing is owed to suppliers. <button type="button" className="secondary" onClick={props.onCancel}>Close</button></p>;
  async function save(e: FormEvent) {
    e.preventDefault();
    const allocations = open.filter((x) => (toMinor(amounts[x.id] ?? '') ?? 0n) > 0n).map((x) => ({ expenseId: x.id, amount: amounts[x.id]! }));
    const result = await run('supplier-payment.record', { ...p, allocations });
    if (!result) return;
    if (!result.ok) { setFeedback(result); return; }
    props.onDone({ f: result, success: `Payment ${(result.result as { number: string }).number} recorded.` });
  }
  return (
    <form className="journal-editor" onSubmit={(e) => void save(e)}>
      <div className="journal-head">
        <label className="grow">Supplier<select value={p.supplierId} onChange={(e) => { setP({ ...p, supplierId: e.target.value }); setAmounts({}); }}>
          {owing.map((s) => <option key={s.id} value={s.id}>{s.name} – owed {formatMinor(s.owed)}</option>)}</select></label>
        <label>Date<input type="date" value={p.paymentDate} required onChange={(e) => setP({ ...p, paymentDate: e.target.value })} /></label>
        <label>Paid from<select value={p.paidFrom} onChange={(e) => setP({ ...p, paidFrom: e.target.value })}>{cash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
        <label>How<input value={p.method} required placeholder="e.g. Cheque" onChange={(e) => setP({ ...p, method: e.target.value })} /></label>
        <label>Cheque / ref<input value={p.reference} onChange={(e) => setP({ ...p, reference: e.target.value })} /></label>
      </div>
      <table className="lines">
        <thead><tr><th>Expense</th><th>Date</th><th className="num">Owed</th><th className="num">Pay now</th></tr></thead>
        <tbody>{open.map((x) => (
          <tr key={x.id}><td>{x.broughtForward ? 'B/F – owed before the system' : `${x.number} ${x.supplierInvoice ? `(inv ${x.supplierInvoice})` : ''}`}</td><td>{x.date}</td>
            <td className="num">{formatMinor(x.outstanding)}</td>
            <td><input aria-label={`Pay ${x.number}`} className="num" inputMode="decimal" value={amounts[x.id] ?? ''} placeholder="0.00" onChange={(e) => setAmounts({ ...amounts, [x.id]: e.target.value })} />
              <button type="button" className="secondary small" onClick={() => setAmounts({ ...amounts, [x.id]: formatMinor(x.outstanding) })}>All</button></td></tr>
        ))}</tbody>
        <tfoot><tr><th colSpan={3}>Payment total</th><th className="num">{formatMinor(total)}</th></tr></tfoot>
      </table>
      <div className="toolbar"><button type="submit" disabled={busy !== null || total <= 0n}>Record payment</button><button type="button" className="secondary" onClick={props.onCancel}>Cancel</button></div>
      <Notice feedback={feedback} />
    </form>
  );
}

// ---------- Supplier workspace ----------

interface SupplierData {
  currency: string; supplier: { id: string; kind: string; name: string; trn: string; email: string; address: string; status: string };
  balance: SupplierBalance; expenses: ExpenseSummary[]; payments: Payment[];
}

export function SupplierExpenses(props: CapabilityPanelProps) {
  const { orgId } = useWorkspaceTools();
  const s = useData<SupplierData>(`/api/orgs/${orgId}/suppliers/${props.snapshot.object.reference.objectId}`);
  if (s.loading) return <Loading />;
  if (s.error) return <ErrorText message={s.error} />;
  return (
    <div className="panel">
      <ExpenseTable expenses={s.data!.expenses} />
      <h3>Payments</h3>
      <PaymentTable payments={s.data!.payments} hideSupplier />
    </div>
  );
}

export function SupplierDetails(props: CapabilityPanelProps) {
  const { orgId, refreshWorkspace } = useWorkspaceTools();
  const id = props.snapshot.object.reference.objectId;
  const s = useData<SupplierData>(`/api/orgs/${orgId}/suppliers/${id}`);
  const [flash, setFlash] = useFlash(`supplier:${id}`);
  if (s.loading) return <Loading />;
  if (s.error) return <ErrorText message={s.error} />;
  const sup = s.data!.supplier;
  if (sup.kind !== 'supplier') return <div className="panel"><p className="muted">This is a system account holding what was owed to suppliers before the system.</p></div>;
  return (
    <div className="panel">
      {hasAction(props, 'supplier.update')
        ? <SupplierForm props={props} actionId="supplier.update" initial={{ name: sup.name, trn: sup.trn, email: sup.email, address: sup.address, status: sup.status }}
            onDone={(f) => { setFlash(f, true); refreshWorkspace(); }} />
        : <dl><dt>TRN</dt><dd>{sup.trn || '—'}</dd><dt>Email</dt><dd>{sup.email || '—'}</dd><dt>Address</dt><dd>{sup.address || '—'}</dd></dl>}
      {flash && <Notice feedback={flash.f} success={flash.success} />}
    </div>
  );
}

// ---------- Expense workspace ----------

export function ExpenseDetails(props: CapabilityPanelProps) {
  const { orgId, currency, refreshWorkspace } = useWorkspaceTools();
  const { navigate } = useApp();
  const id = props.snapshot.object.reference.objectId;
  const d = useData<ExpenseDetailData>(`/api/orgs/${orgId}/expenses/${id}`);
  const { run, busy } = useAction(props);
  const [flash, setFlash] = useFlash(`expense:${id}`);
  const [cancelling, setCancelling] = useState(false);
  const [cancel, setCancel] = useState({ cancelDate: today(), reason: '' });

  if (d.loading) return <Loading />;
  if (d.error) return <ErrorText message={d.error} />;
  const data = d.data!;
  const e = data.expense;
  const after = (f: ActionFeedback, success: string) => {
    if (!f.ok) { setFlash({ f, success: '' }); return; }
    setFlash({ f, success }, true);
    refreshWorkspace();
  };
  const accountName = (code: string) => data.accounts.find((a) => a.code === code)?.name ?? '';

  if (e.status === 'draft') {
    const save = async (input: unknown, record: boolean) => {
      const saved = await run('expense.update', input);
      if (!saved) return;
      if (!saved.ok || !record) { after(saved, 'Draft saved.'); return; }
      const rec = await run('expense.record', {});
      if (rec) after(rec, `Expense ${(rec.result as { number?: string } | undefined)?.number ?? ''} recorded and posted.`);
    };
    return (
      <div className="panel">
        <p className="muted small">Draft: not yet posted. Recording gives it the next expense number and posts it.</p>
        {data.flags.filter((f) => f.code !== 'waiting').map((f) => <p key={f.code} className="warn small">{f.label}</p>)}
        {e.notes && <p className="warn">{e.notes}</p>}
        {hasAction(props, 'expense.update')
          ? <ExpenseEditor
              initial={{ supplierId: e.supplierId, expenseDate: e.date, supplierInvoice: e.supplierInvoice, description: e.description, settlement: e.settlement,
                paidFrom: e.paidFrom, paymentMethod: e.paymentMethod, paymentRef: e.paymentRef, receiptOnFile: e.receiptOnFile, foreignAmount: e.foreignAmount, notes: e.notes,
                lines: e.lines.map((l) => ({ ...l, net: formatMinor(l.net), gct: l.taxCode === 'GCT15' ? formatMinor(l.gct) : '', key: (lineKey += 1) })) }}
              suppliers={data.suppliers} accounts={data.accounts} taxCodes={data.taxCodes} busy={busy !== null} onSubmit={(i, r) => void save(i, r)} />
          : <ExpenseView data={data} accountName={accountName} />}
        {hasAction(props, 'expense.discard') && <div className="toolbar"><button type="button" className="secondary" disabled={busy !== null}
          onClick={() => void run('expense.discard', {}).then((f) => { if (f?.ok) navigate(workspacePath(orgId, 'client-organisation', orgId, 'payables')); else if (f) setFlash({ f, success: '' }); })}>Discard draft</button></div>}
        {flash && <Notice feedback={flash.f} success={flash.success} />}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="toolbar">
        {e.entryId && <Link to={workspacePath(orgId, 'journal', e.entryId)}>Journal</Link>}
        {e.cancelEntryId && <Link to={workspacePath(orgId, 'journal', e.cancelEntryId)}>Cancellation journal</Link>}
        {e.status === 'recorded' && !e.broughtForward && data.payments.length === 0 && hasAction(props, 'expense.cancel') && !cancelling &&
          <button type="button" className="secondary" onClick={() => setCancelling(true)}>Cancel expense</button>}
      </div>
      {cancelling && (
        <form className="journal-editor" onSubmit={(ev) => { ev.preventDefault(); void run('expense.cancel', cancel).then((f) => { if (f) { setCancelling(false); after(f, 'Expense cancelled; the reversing entry is posted.'); } }); }}>
          <strong>Cancel this expense</strong>
          <p className="muted small">Posts the reversing entry. The expense and its cancellation both stay in the history.</p>
          <div className="journal-head">
            <label>Date<input type="date" value={cancel.cancelDate} onChange={(ev) => setCancel({ ...cancel, cancelDate: ev.target.value })} /></label>
            <label className="grow">Reason<input value={cancel.reason} required onChange={(ev) => setCancel({ ...cancel, reason: ev.target.value })} /></label>
          </div>
          <div className="toolbar"><button type="submit" disabled={busy !== null}>Cancel expense</button><button type="button" className="secondary" onClick={() => setCancelling(false)}>Keep it</button></div>
        </form>
      )}
      {flash && <Notice feedback={flash.f} success={flash.success} />}
      {e.status === 'cancelled' && <p className="warn">Cancelled on {e.cancelDate}: {e.cancelReason}</p>}
      {data.flags.map((f) => <p key={f.code} className="warn small">{f.label}</p>)}
      {e.broughtForward
        ? <p>Owed to suppliers at the opening date, brought forward from before this system: {currency} {money(e.total)}. Outstanding {money(data.outstanding)}.</p>
        : <ExpenseView data={data} accountName={accountName} />}
      {data.payments.length > 0 && (
        <>
          <h3>Payments</h3>
          <table><thead><tr><th>Number</th><th>Date</th><th className="num">Amount ({currency})</th><th /></tr></thead>
            <tbody>{data.payments.map((p) => <tr key={p.id}><td>{p.number}</td><td>{p.date}</td><td className="num">{money(p.amount)}</td>
              <td>{p.entryId && <Link to={workspacePath(orgId, 'journal', p.entryId)}>Journal</Link>}</td></tr>)}</tbody>
            <tfoot><tr><th colSpan={2}>Still owed</th><th className="num">{money(data.outstanding)}</th><td /></tr></tfoot></table>
        </>
      )}
    </div>
  );
}

function ExpenseView(props: { data: ExpenseDetailData; accountName: (code: string) => string }) {
  const { currency } = useWorkspaceTools();
  const { expense: e, supplier } = props.data;
  return (
    <article className="expense-view">
      <dl className="facts">
        <dt>Supplier</dt><dd>{supplier.name}{supplier.trn ? ` (TRN ${supplier.trn})` : ''}</dd>
        <dt>Date</dt><dd>{e.date}</dd>
        {e.supplierInvoice && <><dt>Supplier's invoice</dt><dd>{e.supplierInvoice}</dd></>}
        <dt>Paid</dt><dd>{e.settlement === 'paid' ? `At once from ${e.paidFrom} ${props.accountName(e.paidFrom)}${e.paymentMethod ? ` · ${e.paymentMethod}` : ''}${e.paymentRef ? ` ${e.paymentRef}` : ''}` : 'Owed to the supplier'}</dd>
        <dt>Receipt on file</dt><dd>{e.receiptOnFile ? 'Yes' : 'No'}</dd>
        {e.foreignAmount && <><dt>Foreign currency</dt><dd>{e.foreignAmount}</dd></>}
        {e.notes && <><dt>Notes</dt><dd>{e.notes}</dd></>}
      </dl>
      <div className="table-scroll"><table>
        <thead><tr><th>Account</th><th>Description</th><th>Matter</th><th className="num">Net ({currency})</th><th className="num">GCT</th></tr></thead>
        <tbody>{e.lines.map((l, i) => (
          <tr key={i}><td>{l.account} {props.accountName(l.account)}</td><td>{l.description}</td><td>{l.matterRef}</td><td className="num">{money(l.net)}</td><td className="num">{l.gct === '0' ? '' : money(l.gct)}</td></tr>
        ))}</tbody>
        <tfoot>
          <tr><td colSpan={3}>Net</td><td className="num">{money(e.net)}</td><td /></tr>
          <tr><td colSpan={3}>Input GCT claimed</td><td className="num">{money(e.gctClaimed)}</td><td /></tr>
          {e.gctNotClaimed !== '0' && <tr><td colSpan={3}>GCT not claimed (charged to the expense)</td><td className="num">{money(e.gctNotClaimed)}</td><td /></tr>}
          <tr><th colSpan={3}>Total</th><th className="num">{money(e.total)}</th><td /></tr>
        </tfoot>
      </table></div>
    </article>
  );
}
