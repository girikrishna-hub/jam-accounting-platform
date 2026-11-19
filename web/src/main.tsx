import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@governedai-labs/cowr-react/styles.css';
import './styles.css';
import { api, ApiError, type Me } from './api.ts';
import { AppProvider, Link, useLocationPath } from './app-context.tsx';
import { WORKSPACE_PATH_PATTERN } from '../../shared/workspace-model.ts';
import { setWorkspaceNavigator } from './workspace/runtime.ts';
import { SignIn } from './pages/SignIn.tsx';
import { Portfolio } from './pages/Portfolio.tsx';
import { Admin } from './pages/Admin.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';

function App() {
  const [path, navigate] = useLocationPath();
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/api/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => { void refreshMe(); }, [refreshMe]);
  useEffect(() => { setWorkspaceNavigator(navigate); }, [navigate]);
  useEffect(() => {
    const onSignedOut = () => setMe(null);
    window.addEventListener('jam:signed-out', onSignedOut);
    return () => window.removeEventListener('jam:signed-out', onSignedOut);
  }, []);

  if (me === undefined) return <p className="muted page">Loading…</p>;
  if (me === null) return <SignIn onSignedIn={() => void refreshMe()} />;

  async function signOut() {
    await api.post('/api/auth/sign-out').catch(() => undefined);
    setMe(null);
    navigate('/', true);
  }

  const ws = WORKSPACE_PATH_PATTERN.exec(path);
  let content;
  if (ws) {
    const [, orgId, objectTypeId, objectId, capabilityId] = ws.map((v) => (v === undefined ? undefined : decodeURIComponent(v)));
    content = <WorkspacePage key={`${orgId}/${objectTypeId}/${objectId}`} orgId={orgId!} objectTypeId={objectTypeId!} objectId={objectId!} {...(capabilityId ? { capabilityId } : {})} />;
  } else if (path === '/admin' && me.user.isFirmAdmin) {
    content = <Admin />;
  } else if (path === '/') {
    content = <Portfolio />;
  } else {
    content = <main className="page"><p>Page not found.</p><Link to="/">Go to clients</Link></main>;
  }

  return (
    <AppProvider value={{ me, navigate, refreshMe }}>
      <header className="topbar">
        <Link to="/" className="brand">Accounting Platform</Link>
        <nav>
          <Link to="/">Clients</Link>
          {me.user.isFirmAdmin && <Link to="/admin">Administration</Link>}
        </nav>
        <span className="who">{me.user.displayName}</span>
        <button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button>
      </header>
      <div className="content">{content}</div>
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
