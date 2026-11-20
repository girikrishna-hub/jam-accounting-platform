import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { errorHandler, HttpError } from './errors.ts';
import { authenticate, requireCsrfHeader, requireUser, type AppContext } from './middleware.ts';
import { authRoutes } from './routes/auth.ts';
import { adminRoutes } from './routes/admin.ts';
import { orgRoutes } from './routes/orgs.ts';
import { workspaceRoutes } from './routes/workspace.ts';

const webDist = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
  });

  // /api/health works in production: Cloud Run (Replit autoscale) reserves paths ending in "z",
  // so /healthz never reaches the app there. /healthz is kept for local use.
  const health = (_req: unknown, res: { json: (body: unknown) => void }) => { res.json({ ok: true }); };
  app.get('/api/health', health);
  app.get('/healthz', health);

  const api = express.Router();
  api.use(express.json({ limit: '3mb' }));
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(requireCsrfHeader);
  api.use(authenticate(ctx));
  api.use('/auth', authRoutes(ctx));
  api.use('/admin', adminRoutes(ctx));
  api.use('/orgs/:orgId', requireUser, orgRoutes(ctx));
  api.use('/workspace', requireUser, workspaceRoutes(ctx));
  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')));
  app.use('/api', api);

  // The built web app, with client-side routing falling back to index.html.
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(webDist + 'index.html'));
  }

  app.use(errorHandler);
  return app;
}
