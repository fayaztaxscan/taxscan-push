import fs from 'fs';
import path from 'path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { corsMiddleware } from './lib/cors';
import { healthRouter } from './routes/health';
import { createApiRouter } from './routes/api';
import { createAuthRouter } from './routes/auth';
import { createUsersRouter } from './routes/users';
import { createAuditRouter } from './routes/audit';
import { createDigestRouter, type DigestRouterOptions } from './routes/digest';
import { createWebhooksRouter, type WebhookRouterOptions } from './routes/webhooks';
import { createIntegrationsRouter, type CmsEventsRouterOptions } from './routes/cmsEvents';
import { createStaffPushRouter, type StaffPushRouterOptions } from './routes/staffPush';
import { emailAssetsHandler } from './routes/digestAds';
import { env } from './lib/env';
import { appErrorHandler } from './lib/httpErrors';
import { requireBearerOrUser } from './lib/auth';
import type { Sender } from './services/send';
import type { EmailSender } from './lib/email';

export type CreateAppOptions = {
  sender?: Sender;
  // Injectable transactional-email sender for the invite flow. Tests pass an
  // in-memory stub; production uses the ElasticEmail default.
  emailSender?: EmailSender;
  rateLimit?: { publicPerMin?: number; loginPerMin?: number };
  // Overrides the directory the admin SPA is served from. Production reads the
  // real `admin/dist/`; tests pass a fixture path.
  adminDistDir?: string;
  // Push now (Queue/Review) guards — injectable so tests don't depend on the
  // wall clock (quiet hours) or the network (link check).
  clock?: () => Date;
  linkCheck?: boolean;
  isUrlDead?: (url: string) => Promise<boolean>;
  // Email digest routes — tests inject config/clock/portal.
  digest?: DigestRouterOptions;
  // Provider webhooks (Mailercloud) — tests inject config, clock, rate limit.
  webhooks?: WebhookRouterOptions;
  // Staff push devices (digest task 14) — tests inject config, kill-switch, transport.
  staffPush?: StaffPushRouterOptions;
  // CMS account events (audience sync task 4) — tests inject config, clock, rate limit.
  cmsEvents?: CmsEventsRouterOptions;
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
  // Provider webhooks parse their own bodies and must come BEFORE the global
  // JSON parser: its parse errors carry the raw body, which the catch-all
  // error handler below would log (reader addresses). No session/cookie use.
  app.use('/api/webhooks', createWebhooksRouter(opts.webhooks));
  // CMS account events (door W): HMAC over the RAW body, so ahead of every JSON parser too.
  // Always mounted; answers 401 to everything while AUDIENCE_SYNC_ENABLED is off (contract v1.2 §3).
  app.use('/api/integrations', createIntegrationsRouter(opts.cmsEvents));
  // Digest templates (task 10; ADMIN or PUBLISHER since 29 Oct) carry a whole email layout: their own,
  // larger JSON limit, ahead of the global one (which then skips a parsed body).
  // Authenticated FIRST (2026-10-23): an anonymous caller gets 401 before a byte of
  // a 600 KB body is parsed. The cookie parser runs here too (it skips itself later).
  app.use(
    '/api/digest/templates',
    cookieParser(env.sessionCookieSecret),
    requireBearerOrUser(['ADMIN', 'PUBLISHER']),
    express.json({ limit: '600kb' }),
  );
  app.use(express.json({ limit: '64kb' }));
  // Signs cookies with SESSION_COOKIE_SECRET. Phase 2's auth router uses the
  // signed-cookie path; the helper reads from req.signedCookies and ignores
  // unsigned cookies entirely.
  app.use(cookieParser(env.sessionCookieSecret));

  app.use(healthRouter);
  app.use(
    '/api/auth',
    createAuthRouter({
      loginPerMin: opts.rateLimit?.loginPerMin ?? env.rateLimit.loginPerMin,
    }),
  );
  app.use('/api/users', createUsersRouter({ emailSender: opts.emailSender }));
  app.use('/api/audit', createAuditRouter());
  app.use('/api/digest', createDigestRouter(opts.digest));
  app.use('/api/staff-push', createStaffPushRouter(opts.staffPush));
  app.use(
    '/api',
    createApiRouter({
      sender: opts.sender,
      publicPerMin: opts.rateLimit?.publicPerMin ?? env.rateLimit.publicPerMin,
      clock: opts.clock,
      linkCheck: opts.linkCheck,
      isUrlDead: opts.isUrlDead,
    }),
  );

  // The staff notification worker (digest task 14), scope /admin/: approvers'
  // devices only, never readers. Served ahead of the SPA's static mount so its
  // headers are ours: no-cache (a service worker must revalidate, like /sw.js)
  // and helmet's same-origin CORP left in place — only push.taxscan.in's own
  // admin pages register it, nothing loads it cross-origin. Deliberately NOT
  // public/sw.js, which www.taxscan.in's readers run.
  const staffSwPath = path.resolve(__dirname, '..', 'public', 'admin', 'sw-staff.js');
  app.get('/admin/sw-staff.js', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(staffSwPath, (err) => {
      if (err) next(err);
    });
  });

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

  // Both files are designed to be loaded cross-origin: taxscan.in embeds
  // the SDK via Hocalwire's Utils.loadScripts(); the SW path serves the
  // demo origin in dev and any future portal in Phase 2. helmet's default
  // `Cross-Origin-Resource-Policy: same-origin` would make the browser
  // refuse the response with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin (exact
  // failure mode that broke the iZooto cutover) — override per route.
  app.get('/taxscan-push.js', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(sdkPath, (err) => {
      if (err) next(err);
    });
  });

  app.get('/sw.js', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(swPath, (err) => {
      if (err) next(err);
    });
  });

  // Digest ad images (task 9): public, immutable, cross-origin; only stored images by sha256 name.
  app.get('/email-assets/:file', emailAssetsHandler);

  // Fixed assets committed in public/email/ (the digest logo) and public/brand/ (the push
  // notification icon): readable cross-origin by mail clients, image proxies and the browser's
  // notification UI, cached for a year. Never overwrite a file here — a changed asset gets a
  // new file name, or readers keep the old one.
  for (const dir of ['email', 'brand']) {
    app.use(
      `/${dir}`,
      (_req, res, next) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
      },
      express.static(path.join(publicDir, dir), { immutable: true, maxAge: '365d', index: false }),
      // Nothing else is served from here: a missing file (or a `..` path) is a plain 404. With
      // `fallthrough: false` send's ENOENT error (status 404, not `expose`) reached the app's
      // error handler as a 500 with a stack trace in the log (QA of task 10).
      (_req: express.Request, res: express.Response) => {
        res.status(404).json({ error: 'not_found' });
      },
    );
  }

  app.use(express.static(publicDir));

  // Last: body-parser errors answer their own 4xx (413 over the 64 KB limit,
  // 400 for bad JSON) and nothing logs a request body (src/lib/httpErrors.ts).
  app.use(appErrorHandler);

  return app;
}
