import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { env, type DigestEnv } from '../lib/env';
import { makePublicLimiter } from '../lib/rateLimit';
import { redactError } from '../services/digest/sender';
import { MalformedWebhookError, handleMailercloudWebhook, webhookTokenMatches } from '../services/digest/webhook';

/**
 * Inbound provider webhooks, mounted at `/api/webhooks` BEFORE the app's
 * global JSON parser and session middleware (docs/EMAIL_DIGEST_DESIGN.md §6, §9).
 *
 *   POST /api/webhooks/mailercloud/:token
 *
 * Public; protected by a ≥32-char secret token in the path (Mailercloud signs
 * nothing), compared in constant time. 404 — indistinguishable from "no such
 * route" — when DIGEST_WEBHOOKS_ENABLED is off, the token is unset/short, or
 * the token is wrong. The token check runs BEFORE the body is read.
 *
 * Mounted ahead of `express.json` on purpose: body-parser's parse error
 * carries the raw body, and the app's catch-all error handler logs the error
 * object, which would put reader addresses in the logs. Here a malformed body
 * is answered 400 with nothing echoed and nothing logged but its length.
 *
 * Never logs the request path (it contains the token) or any address. The
 * one log line per request carries counts and event types only.
 */
export type WebhookRouterOptions = {
  cfg?: DigestEnv;
  /**
   * Per-IP limit on requests with a WRONG/missing token (or the route off).
   * Only failures count, so a token-guessing flood — even one sharing a
   * Cloudflare edge IP with Mailercloud (`trust proxy 1`) — cannot 429 a real
   * delivery: a 429 counts toward Mailercloud switching the webhook off.
   */
  invalidPerMin?: number;
  /** Ceiling for requests with the RIGHT token: far above any real delivery rate; only a leaked token hits it. */
  validPerMin?: number;
  clock?: () => Date;
};

const DEFAULT_INVALID_PER_MIN = 120;
const DEFAULT_VALID_PER_MIN = 20_000;
const BODY_LIMIT = '256kb';

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[digest-webhook] ${msg}`);
}

export function createWebhooksRouter(opts: WebhookRouterOptions = {}): Router {
  const router = Router();
  const invalidLimiter = makePublicLimiter(opts.invalidPerMin ?? DEFAULT_INVALID_PER_MIN);
  const validLimiter = makePublicLimiter(opts.validPerMin ?? DEFAULT_VALID_PER_MIN);

  // Token first, before the body is read. Only a failed check is counted by the
  // strict limiter (429 once over it, else the plain 404); the path is never echoed.
  const verify = (req: Request, res: Response, next: NextFunction): void => {
    const cfg = opts.cfg ?? env.digest;
    if (!cfg.webhooksEnabled || !webhookTokenMatches(String(req.params.token ?? ''), cfg)) {
      void invalidLimiter(req, res, () => notFound(res));
      return;
    }
    void validLimiter(req, res, next);
  };

  router.post(
    '/mailercloud/:token',
    verify,
    // Form posts become objects; everything else arrives as text and is parsed
    // below, whatever Content-Type Mailercloud sends (UNVERIFIED: likely JSON).
    express.urlencoded({ extended: true, limit: BODY_LIMIT }),
    express.text({ type: () => true, limit: BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const cfg = opts.cfg ?? env.digest;
      let body: unknown = req.body;
      if (typeof body === 'string') {
        const text = body;
        try {
          // A blank body (a provider "test" ping) is an empty payload: acknowledged, nothing stored.
          body = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          log(`malformed: not JSON (${text.length} bytes)`);
          res.status(400).json({ error: 'malformed' });
          return;
        }
      }
      try {
        const r = await handleMailercloudWebhook(body, { cfg, now: opts.clock?.() });
        const by = r.ignoredBy;
        log(
          `received=${r.received} stored=${r.stored} duplicate=${r.duplicates}` +
            ` ignored_type=${by.unknown_type} no_campaign=${by.no_campaign} no_address=${by.no_address}` +
            (r.types.length ? ` types=${r.types.join(',')}` : ''),
        );
        if (by.no_address > 0) {
          // eslint-disable-next-line no-console
          console.warn(`[digest-webhook] ${by.no_address} opt-out event(s) had no readable address — not suppressed (check the payload field names)`);
        }
        res.status(200).json({ ok: true, stored: r.stored, duplicates: r.duplicates, ignored: r.ignored, noAddress: by.no_address });
      } catch (err) {
        if (err instanceof MalformedWebhookError) {
          log(`malformed: ${err.message}`);
          res.status(400).json({ error: 'malformed' });
          return;
        }
        const m = cfg.mailercloud;
        // eslint-disable-next-line no-console
        console.error(`[digest-webhook] store failed: ${redactError(err, [m.apiKey, m.webhookToken, m.webhookTokenPrevious])}`);
        // 5xx: Mailercloud retries, so an opt-out is delayed, not lost.
        res.status(500).json({ error: 'internal_error' });
      }
    },
  );

  // Body-parser errors (bad encoding, over the limit) — never echo or log the body.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err?.status === 413 ? 413 : 400;
    log(`malformed: ${typeof err?.type === 'string' ? err.type : 'unreadable body'}`);
    res.status(status).json({ error: status === 413 ? 'too_large' : 'malformed' });
  });

  // Anything else under /api/webhooks: a plain 404 that never echoes the path.
  router.use((_req: Request, res: Response) => notFound(res));
  return router;
}
