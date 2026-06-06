import fs from 'fs';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { corsMiddleware } from './lib/cors';
import { healthRouter } from './routes/health';
import { createApiRouter } from './routes/api';
import { env } from './lib/env';
import type { Sender } from './services/send';

export type CreateAppOptions = {
  sender?: Sender;
  rateLimit?: { publicPerMin?: number; loginPerMin?: number };
  // Overrides the directory the admin SPA is served from. Production reads the
  // real `admin/dist/`; tests pass a fixture path.
  adminDistDir?: string;
};

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();

  // helmet: HSTS + X-Content-Type-Options + X-Frame-Options + Referrer-Policy +
  // a handful of other defaults. CSP is disabled because the demo page
  // (public/index.html) uses inline scripts/styles intentionally; a stricter
  // CSP would belong on a follow-up that splits inline assets out.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Production: trust the reverse proxy (Railway / nginx) and redirect HTTP
  // to HTTPS. In dev/test this is a no-op.
  if (env.nodeEnv === 'production') {
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
      if (req.header('x-forwarded-proto') === 'http') {
        return res.redirect(301, `https://${req.header('host')}${req.url}`);
      }
      next();
    });
  }

  app.use(corsMiddleware);
  app.use(express.json({ limit: '64kb' }));

  app.use(healthRouter);
  app.use(
    '/api',
    createApiRouter({
      sender: opts.sender,
      publicPerMin: opts.rateLimit?.publicPerMin ?? env.rateLimit.publicPerMin,
      loginPerMin: opts.rateLimit?.loginPerMin ?? env.rateLimit.loginPerMin,
    }),
  );

  // Admin SPA at /admin/* — mounted AFTER /api so it can never shadow API
  // routes. Only mounts when the built bundle exists, so tests (and dev
  // sessions without a build) don't trip on a missing directory.
  const adminDist = opts.adminDistDir ?? path.resolve(__dirname, '..', 'admin', 'dist');
  const adminIndex = path.join(adminDist, 'index.html');
  if (fs.existsSync(adminIndex)) {
    app.use('/admin', express.static(adminDist));
    app.get('/admin/*', (req, res, next) => {
      // Only catch SPA client-side routes. Asset 404s stay 404 — otherwise
      // a missing /admin/foo.png would 200 with HTML content.
      if (path.extname(req.path)) return next();
      res.sendFile(adminIndex);
    });
  }

  // Dedicated routes for the two assets taxscan.in's vendor template loads
  // from this backend. Kept ahead of express.static so we own the cache
  // headers explicitly — every header is set by us, not inferred by the
  // `send` module's defaults.
  //
  // /taxscan-push.js — public, max-age 5 min, stale-while-revalidate 24 h.
  //   Once a browser has it cached, a returning page-load request is served
  //   from cache (or revalidated in the background) and never blocks on a
  //   cold backend. This is the asset that previously failed to execute at
  //   page time when Railway was cold; the cache headers turn that into a
  //   non-event for repeat visitors.
  //
  // /sw.js — no-cache. Service workers MUST revalidate on every fetch.
  //   Long-caching a service worker is a documented footgun: a stale SW
  //   outlives a fix and poisons every registration in its scope.
  const publicDir = path.resolve(__dirname, '..', 'public');
  const sdkPath = path.join(publicDir, 'taxscan-push.js');
  const swPath = path.join(publicDir, 'sw.js');

  app.get('/taxscan-push.js', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.sendFile(sdkPath, (err) => {
      if (err) next(err);
    });
  });

  app.get('/sw.js', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(swPath, (err) => {
      if (err) next(err);
    });
  });

  app.use(express.static(publicDir));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('unhandled error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
