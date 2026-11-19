import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '../../../../shared/workspace-model.ts';
import { allOrganisations, createOrganisation } from '../../services/organisations.ts';
import { assign, createUser, listUsers, revoke, setUserStatus } from '../../services/users.ts';
import { MIN_PASSWORD_LENGTH } from '../../auth/passwords.ts';
import { HttpError } from '../errors.ts';
import { requireFirmAdmin, userOf, type AppContext } from '../middleware.ts';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const NewOrg = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).optional(),
  trn: z.string().trim().max(40).optional(),
  financialYearStart: z.number().int().min(1).max(12).optional(),
  openingDate: ISO_DATE,
});

const NewUser = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(1).max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  isFirmAdmin: z.boolean().optional(),
});

const Assignment = z.object({ userId: z.string().uuid(), orgId: z.string().uuid(), role: z.enum(ROLES as [string, ...string[]]) });
const Revoke = z.object({ userId: z.string().uuid(), orgId: z.string().uuid() });

/** Firm administration console (a documented non-object screen). Every change is audited. */
export function adminRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use(requireFirmAdmin);

  r.get('/organisations', async (_req, res) => {
    res.json({ organisations: (await allOrganisations(ctx.db)).map((o) => ({ id: o.id, name: o.name, legalName: o.legal_name, trn: o.trn, currency: o.currency, openingDate: o.opening_date, status: o.status, hasLedger: Boolean(o.ledger_id) })) });
  });

  r.post('/organisations', async (req, res) => {
    const input = NewOrg.parse(req.body);
    const org = await createOrganisation(ctx.db, ctx.ledger, userOf(res).id, input);
    res.status(201).json({ id: org.id, name: org.name });
  });

  r.get('/users', async (_req, res) => {
    res.json({ users: (await listUsers(ctx.db)).map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, isFirmAdmin: u.is_firm_admin, status: u.status, assignments: u.assignments })) });
  });

  r.post('/users', async (req, res) => {
    const input = NewUser.parse(req.body);
    const exists = await ctx.db.query('SELECT 1 FROM app.users WHERE email = $1', [input.email]);
    if (exists.rowCount) throw new HttpError(409, 'EMAIL_TAKEN', 'A user with this email already exists.');
    const user = await createUser(ctx.db, userOf(res).id, input);
    res.status(201).json({ id: user.id });
  });

  r.post('/users/:userId/status', async (req, res) => {
    const { status } = z.object({ status: z.enum(['active', 'disabled']) }).parse(req.body);
    const userId = z.string().uuid().parse(req.params.userId);
    if (userId === userOf(res).id && status === 'disabled') throw new HttpError(422, 'SELF_DISABLE', 'You cannot disable your own account.');
    await setUserStatus(ctx.db, userOf(res).id, userId, status);
    res.json({ ok: true });
  });

  r.post('/assignments', async (req, res) => {
    const input = Assignment.parse(req.body) as z.infer<typeof Assignment> & { role: (typeof ROLES)[number] };
    await assign(ctx.db, userOf(res).id, input);
    res.json({ ok: true });
  });

  r.delete('/assignments', async (req, res) => {
    await revoke(ctx.db, userOf(res).id, Revoke.parse(req.body));
    res.json({ ok: true });
  });

  return r;
}
