import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.ts';
import { hashPassword } from '../auth/passwords.ts';
import { audit } from '../audit.ts';
import type { Role } from '../../../shared/workspace-model.ts';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  is_firm_admin: boolean;
  status: 'active' | 'disabled';
}

export async function createUser(db: Db, actorId: string | null, input: { email: string; displayName: string; password: string; isFirmAdmin?: boolean }): Promise<UserRow> {
  const id = randomUUID();
  const email = input.email.trim().toLowerCase();
  const hash = hashPassword(input.password);
  const r = await db.query<UserRow>(
    `INSERT INTO app.users (id, email, display_name, password_hash, is_firm_admin) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, display_name, is_firm_admin, status`,
    [id, email, input.displayName.trim(), hash, Boolean(input.isFirmAdmin)],
  );
  await audit(db, { actorId, action: 'user.create', target: id, detail: { email, isFirmAdmin: Boolean(input.isFirmAdmin) } });
  return r.rows[0]!;
}

export async function listUsers(db: Db): Promise<(UserRow & { assignments: { orgId: string; orgName: string; role: Role }[] })[]> {
  const users = (await db.query<UserRow>('SELECT id, email, display_name, is_firm_admin, status FROM app.users ORDER BY display_name')).rows;
  const assignments = (await db.query<{ user_id: string; org_id: string; name: string; role: Role }>(
    'SELECT a.user_id, a.org_id, o.name, a.role FROM app.assignments a JOIN app.organisations o ON o.id = a.org_id ORDER BY o.name')).rows;
  return users.map((u) => ({
    ...u,
    assignments: assignments.filter((a) => a.user_id === u.id).map((a) => ({ orgId: a.org_id, orgName: a.name, role: a.role })),
  }));
}

export async function setUserStatus(db: Db, actorId: string, userId: string, status: 'active' | 'disabled'): Promise<void> {
  await db.query('UPDATE app.users SET status = $2 WHERE id = $1', [userId, status]);
  if (status === 'disabled') await db.query('DELETE FROM app.sessions WHERE user_id = $1', [userId]);
  await audit(db, { actorId, action: `user.${status === 'disabled' ? 'disable' : 'enable'}`, target: userId });
}

/** Grants or changes a user's role in one client. Audited (spec §6: user access changes). */
export async function assign(db: Db, actorId: string, input: { userId: string; orgId: string; role: Role }): Promise<void> {
  await db.query(
    `INSERT INTO app.assignments (user_id, org_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
    [input.userId, input.orgId, input.role],
  );
  await audit(db, { actorId, orgId: input.orgId, action: 'assignment.set', target: input.userId, detail: { role: input.role } });
}

export async function revoke(db: Db, actorId: string, input: { userId: string; orgId: string }): Promise<void> {
  await db.query('DELETE FROM app.assignments WHERE user_id = $1 AND org_id = $2', [input.userId, input.orgId]);
  await audit(db, { actorId, orgId: input.orgId, action: 'assignment.revoke', target: input.userId });
}
