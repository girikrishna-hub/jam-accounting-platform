import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { LedgerActor, LedgerGateway } from '../ledger/gateway.ts';
import { SESSION_COOKIE, sessionUser, type SessionUser } from '../auth/sessions.ts';
import { ensureLedger, getOrganisation, roleInOrganisation, type OrganisationRow } from '../services/organisations.ts';
import type { Role } from '../../../shared/workspace-model.ts';
import { HttpError, notFound } from './errors.ts';

export interface AppContext {
  readonly db: Db;
  readonly ledger: LedgerGateway;
  readonly config: AppConfig;
}

/** A user's resolved access to one client: the only way route handlers reach client data. */
export interface OrgScope {
  readonly org: OrganisationRow & { ledger_id: string };
  readonly role: Role;
  readonly actor: LedgerActor;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      user?: SessionUser;
      scope?: OrgScope;
    }
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * CSRF defence alongside SameSite=Lax cookies: state-changing API calls must carry a custom
 * header, which a cross-site form or image cannot add.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-jam-csrf') === '1') return next();
  next(new HttpError(403, 'CSRF', 'Missing request header.'));
};

export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = await sessionUser(ctx.db, readCookie(req, SESSION_COOKIE));
      if (user) res.locals.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireUser: RequestHandler = (_req, res, next) => {
  if (!res.locals.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
  next();
};

export const requireFirmAdmin: RequestHandler = (_req, res, next) => {
  if (!res.locals.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
  if (!res.locals.user.isFirmAdmin) return next(new HttpError(403, 'FORBIDDEN', 'Firm administrators only.'));
  next();
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolves a user's access to a client. Unknown client, malformed ID and "not assigned" all
 * return the same not-found, so IDs reveal nothing (spec §6 design principle).
 */
export async function resolveScope(ctx: AppContext, user: SessionUser, orgId: string): Promise<OrgScope> {
  if (!UUID.test(orgId)) throw notFound();
  const role = await roleInOrganisation(ctx.db, user.id, orgId);
  if (!role) throw notFound();
  const org = await getOrganisation(ctx.db, orgId);
  if (!org || org.status === 'archived') throw notFound();
  const ledgerId = org.ledger_id ?? (await ensureLedger(ctx.db, ctx.ledger, user.id, orgId));
  return { org: { ...org, ledger_id: ledgerId }, role, actor: { actorId: user.id, principal: role, ledgerId } };
}

/** For routes under /api/orgs/:orgId. */
export function orgScope(ctx: AppContext): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.scope = await resolveScope(ctx, res.locals.user!, String(req.params.orgId));
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function scopeOf(res: Response): OrgScope {
  if (!res.locals.scope) throw new Error('orgScope middleware missing');
  return res.locals.scope;
}

export function userOf(res: Response): SessionUser {
  if (!res.locals.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
  return res.locals.user;
}
