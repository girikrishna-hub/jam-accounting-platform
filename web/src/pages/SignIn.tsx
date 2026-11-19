import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';

export function SignIn(props: { onSignedIn: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/sign-in', { email: String(f.get('email')), password: String(f.get('password')) });
      props.onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="sign-in">
      <form className="form card-form" onSubmit={submit}>
        <h1>Sign in</h1>
        <label>Email<input name="email" type="email" autoComplete="username" required autoFocus /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
      </form>
    </main>
  );
}
