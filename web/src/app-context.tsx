import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Me } from './api.ts';

/** Minimal client-side routing on the History API. Every path is re-authorised by the server. */
export function useLocationPath(): [string, (to: string, replace?: boolean) => void] {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string, replace = false) => {
    if (to === window.location.pathname) return;
    if (replace) window.history.replaceState(null, '', to); else window.history.pushState(null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return [path, navigate];
}

export interface AppState {
  me: Me;
  navigate: (to: string, replace?: boolean) => void;
  refreshMe: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider(props: { value: AppState; children: ReactNode }) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const value = useContext(Ctx);
  if (!value) throw new Error('AppProvider missing');
  return value;
}

/** A link that routes in-app on plain clicks and behaves as a normal link otherwise. */
export function Link(props: { to: string; children: ReactNode; className?: string }) {
  const { navigate } = useApp();
  return (
    <a
      href={props.to}
      className={props.className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(props.to);
      }}
    >{props.children}</a>
  );
}
