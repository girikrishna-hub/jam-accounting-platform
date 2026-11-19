import { Router } from 'express';
import { z } from 'zod';
import { DUMMY_HASH, verifyPassword } from '../../auth/passwords.ts';
import { SESSION_COOKIE, endSession, startSession } from '../../auth/sessions.ts';
import { audit } from '../../audit.ts';
import { organisationsForUser } from '../../services/organisations.ts';
import { HttpError } from '../errors.ts';
import { readCookie, requireUser, userOf, type AppContext } from '../middleware.ts';

const SignIn = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(200) });

/** Simple in-process throttle: 10 failed attempts per email per 15 minutes. */
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;

export function authRoutes(ctx: AppContext): Router {
  const r = Router();

  r.post('/sign-in', async (req, res) => {
    const { email, password } = SignIn.parse(req.body);
    const now = Date.now();
    const f = failures.get(email);
    if (f && f.until > now && f.count >= 10) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again in 15 minutes.');
    const row = (await ctx.db.query<{ id: string; password_hash: string; status: string }>(
      'SELECT id, password_hash, status FROM app.users WHERE email = $1', [email])).rows[0];
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || row.status !== 'active') {
      failures.set(email, { count: (f && f.until > now ? f.count : 0) + 1, until: now + WINDOW_MS });
      await audit(ctx.db, { actorId: row?.id ?? null, action: 'auth.sign-in', outcome: 'rejected', detail: { email } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    failures.delete(email);
    const { token, expiresAt } = await startSession(ctx.db, row.id, ctx.config.sessionTtlMs);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: ctx.config.secureCookies, expires: expiresAt, path: '/' });
    await audit(ctx.db, { actorId: row.id, action: 'auth.sign-in' });
    res.json({ ok: true });
  });

  r.post('/sign-out', async (req, res) => {
    await endSession(ctx.db, readCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  /** The signed-in user, the firm (tenant) ID and the clients they are assigned to. */
  r.get('/me', requireUser, async (_req, res) => {
    const user = userOf(res);
    const orgs = await organisationsForUser(ctx.db, user.id);
    res.json({
      user: { id: user.id, email: user.email, displayName: user.displayName, isFirmAdmin: user.isFirmAdmin, sessionRef: user.sessionRef },
      firmId: ctx.config.firmId,
      organisations: orgs.filter((o) => o.status !== 'archived').map((o) => ({ id: o.id, name: o.name, role: o.role, status: o.status, currency: o.currency })),
    });
  });

  return r;
}
