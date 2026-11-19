import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { ErrorText, Loading, ROLE_LABEL, useData } from '../workspace/tools.tsx';

interface AdminOrg { id: string; name: string; legalName: string; trn: string; currency: string; openingDate: string; status: string; hasLedger: boolean }
interface AdminUser { id: string; email: string; displayName: string; isFirmAdmin: boolean; status: string; assignments: { orgId: string; orgName: string; role: keyof typeof ROLE_LABEL }[] }

/** Firm administration console (a documented non-object screen). The server enforces admin-only access. */
export function Admin() {
  const { me, refreshMe } = useApp();
  const orgs = useData<{ organisations: AdminOrg[] }>('/api/admin/organisations');
  const users = useData<{ users: AdminUser[] }>('/api/admin/users');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(fn: () => Promise<unknown>, ok: string, form?: HTMLFormElement) {
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      form?.reset();
      orgs.reload();
      users.reload();
      await refreshMe();
    } catch (e) {
      const details = e instanceof ApiError && Array.isArray(e.details) ? ` (${(e.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`).join('; ')})` : '';
      setMessage({ ok: false, text: (e instanceof ApiError ? e.message : 'Failed.') + details });
    }
  }

  function createOrg(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void call(() => api.post('/api/admin/organisations', {
      name: String(f.get('name')), legalName: String(f.get('legalName')) || undefined, trn: String(f.get('trn')) || undefined,
      openingDate: String(f.get('openingDate')), financialYearStart: Number(f.get('financialYearStart')),
    }), 'Client created with its own set of books.', e.currentTarget);
  }
  function createUser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void call(() => api.post('/api/admin/users', {
      email: String(f.get('email')), displayName: String(f.get('displayName')), password: String(f.get('password')), isFirmAdmin: f.get('isFirmAdmin') === 'on',
    }), 'User created. Share the password with them securely.', e.currentTarget);
  }
  function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void call(() => api.post('/api/admin/assignments', { userId: String(f.get('userId')), orgId: String(f.get('orgId')), role: String(f.get('role')) }), 'Access granted.', e.currentTarget);
  }

  if (orgs.loading || users.loading) return <main className="page"><Loading /></main>;
  if (orgs.error || users.error) return <main className="page"><ErrorText message={orgs.error ?? users.error ?? ''} /></main>;
  const orgList = orgs.data!.organisations;
  const userList = users.data!.users;

  return (
    <main className="page admin">
      <h1>Administration</h1>
      {message && <p className={message.ok ? 'notice notice-ok' : 'notice notice-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}

      <section>
        <h2>Clients</h2>
        <table>
          <thead><tr><th>Name</th><th>Legal name</th><th>TRN</th><th>Currency</th><th>Books opened</th><th>Status</th></tr></thead>
          <tbody>{orgList.map((o) => <tr key={o.id}><td>{o.name}</td><td>{o.legalName}</td><td>{o.trn || '—'}</td><td>{o.currency}</td><td>{o.openingDate}</td><td>{o.status}{!o.hasLedger && ' (books pending)'}</td></tr>)}</tbody>
        </table>
        <form className="form inline" onSubmit={createOrg}>
          <h3>New client</h3>
          <label>Name<input name="name" required maxLength={200} /></label>
          <label>Legal name<input name="legalName" maxLength={200} /></label>
          <label>TRN<input name="trn" maxLength={40} /></label>
          <label>Books open on<input name="openingDate" type="date" required /></label>
          <label>Financial year starts (month 1–12)<input name="financialYearStart" type="number" min={1} max={12} defaultValue={1} required /></label>
          <p className="muted">Reporting currency is JMD. Currency and opening date cannot be changed later.</p>
          <button type="submit">Create client</button>
        </form>
      </section>

      <section>
        <h2>Users and access</h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Status</th><th /></tr></thead>
          <tbody>{userList.map((u) => (
            <tr key={u.id}>
              <td>{u.displayName}{u.isFirmAdmin && ' (administrator)'}</td><td>{u.email}</td>
              <td>{u.assignments.length ? u.assignments.map((a) => (
                <span key={a.orgId} className="chip">{a.orgName}: {ROLE_LABEL[a.role]}
                  <button type="button" className="link" aria-label={`Remove ${u.displayName} from ${a.orgName}`}
                    onClick={() => window.confirm(`Remove ${u.displayName}'s access to ${a.orgName}?`) && void call(() => api.delete('/api/admin/assignments', { userId: u.id, orgId: a.orgId }), 'Access removed.')}>×</button>
                </span>)) : <span className="muted">None</span>}</td>
              <td>{u.status}</td>
              <td>{u.id !== me.user.id && (
                <button type="button" className="secondary" onClick={() => void call(() => api.post(`/api/admin/users/${u.id}/status`, { status: u.status === 'active' ? 'disabled' : 'active' }), u.status === 'active' ? 'User disabled and signed out.' : 'User enabled.')}>
                  {u.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              )}</td>
            </tr>
          ))}</tbody>
        </table>

        <form className="form inline" onSubmit={assign}>
          <h3>Grant access</h3>
          <label>User<select name="userId" required>{userList.filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>)}</select></label>
          <label>Client<select name="orgId" required>{orgList.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <label>Role<select name="role" required>{Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <button type="submit">Grant access</button>
        </form>

        <form className="form inline" onSubmit={createUser}>
          <h3>New user</h3>
          <label>Name<input name="displayName" required maxLength={200} /></label>
          <label>Email<input name="email" type="email" required /></label>
          <label>Temporary password (12+ characters, upper and lower case, a digit)<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
          <label className="check"><input name="isFirmAdmin" type="checkbox" /> Firm administrator</label>
          <button type="submit">Create user</button>
        </form>
      </section>
    </main>
  );
}
