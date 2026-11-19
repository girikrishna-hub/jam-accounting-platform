import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/db.ts';

export const SESSION_COOKIE = 'jam_session';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isFirmAdmin: boolean;
  /** Opaque session reference given to the browser workspace; not a credential. */
  sessionRef: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function startSession(db: Db, userId: string, ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query('INSERT INTO app.sessions (token_hash, public_ref, user_id, expires_at) VALUES ($1, $2, $3, $4)',
    [hashToken(token), randomUUID(), userId, expiresAt]);
  await db.query('DELETE FROM app.sessions WHERE expires_at < now()');
  return { token, expiresAt };
}

export async function sessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const r = await db.query<{ id: string; email: string; display_name: string; is_firm_admin: boolean; public_ref: string }>(
    `SELECT u.id, u.email, u.display_name, u.is_firm_admin, s.public_ref
     FROM app.sessions s JOIN app.users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`, [hashToken(token)]);
  const row = r.rows[0];
  return row ? { id: row.id, email: row.email, displayName: row.display_name, isFirmAdmin: row.is_firm_admin, sessionRef: row.public_ref } : null;
}

export async function endSession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM app.sessions WHERE token_hash = $1', [hashToken(token)]);
}
