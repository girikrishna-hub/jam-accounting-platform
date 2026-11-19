import { Link, useApp } from '../app-context.tsx';
import { workspacePath } from '../../../shared/workspace-model.ts';
import { ROLE_LABEL } from '../workspace/tools.tsx';

/** Client list: a global screen (documented exception), one row per client the user is assigned to. */
export function Portfolio() {
  const { me } = useApp();
  const orgs = me.organisations;
  return (
    <main className="page">
      <h1>Clients</h1>
      {orgs.length === 0 ? (
        <p className="muted">{me.user.isFirmAdmin ? 'You are not assigned to any client. Use Administration to create clients and assign yourself or your accountants.' : 'You have not been given access to any client yet.'}</p>
      ) : (
        <table>
          <thead><tr><th>Client</th><th>Your role</th><th>Status</th></tr></thead>
          <tbody>{orgs.map((o) => (
            <tr key={o.id}>
              <td><Link to={workspacePath(o.id, 'client-organisation', o.id)}>{o.name}</Link></td>
              <td>{ROLE_LABEL[o.role]}</td><td>{o.status}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </main>
  );
}
