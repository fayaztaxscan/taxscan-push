import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { env, isCmsIpAllowed, type AudienceEnv } from '../lib/env';
import { prisma } from '../lib/prisma';
import { makePublicLimiter } from '../lib/rateLimit';
import { safeErrorLog } from '../lib/httpErrors';
import { cmsClientIp } from '../lib/clientIp';
import { CMS_HEADERS, classifyWebhookReplay, verifyCmsWebhook } from '../lib/cmsSignature';
import { audienceIngestReady } from '../services/audience/boot';
import { eventIdOf, parseCmsEvent } from '../services/audience/snapshot';
import { applyAccountSnapshot } from '../services/audience/ingest';

/**
 * Door W — CMS account events (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.1, §8; push-feed contract v1.2
 * §1–§3, §9). Mounted at `/api/integrations` BEFORE the app's JSON parser:
 *
 *   POST /api/integrations/cms/events
 *
 * Checks, in this order, each stopping at the first failure:
 *  1. AUDIENCE_SYNC_ENABLED (and a valid audience config with a webhook secret);
 *  2. the IP fence: the client (`cmsClientIp`: CF-Connecting-IP only from a Cloudflare peer) must be
 *     on CMS_FEED_ALLOWED_IPS — empty rejects everything;
 *  3. the raw body (express.raw; `Buffer.isBuffer`, ≤ 64 KB) — HMAC needs the exact bytes;
 *  4. the three headers;
 *  5. the signature (`verifyCmsWebhook`: ±300 s, current or previous secret, the CONSTANT path);
 *  6. `X-CMS-Event-Id` must equal the body's `event_id` (which the signature covers);
 *  7. replay (`classifyWebhookReplay` against the stored receipt): same timestamp = an exact replay;
 *     a different one = the CMS's own retry → 200, not applied again (the receipt keeps the LATEST
 *     timestamp, so a verbatim copy of the retry is an exact replay too);
 *  8. parse (contract v1.2 snapshot);
 *  9. apply — in ONE transaction with the receipt insert: a failed apply leaves no receipt, so the
 *     CMS's honest retry is processed.
 *
 * Answers (the CONTRACT's codes, which supersede design §5.1's 404s and "duplicate → 200 on conflict"):
 *  - every failure of steps 1–7: the SAME `401 {"code":"UNAUTHORISED"}`, nothing echoed; only these
 *    failures are rate-limited (a valid delivery never is);
 *  - an exact replay: 401; a retry / duplicate: 200 `{ok, duplicate}`;
 *  - a signed body that breaks the schema: 422 (the CMS marks it dead; the nightly list carries the
 *    account); an unknown event type: 200 (stored as `unknown_type`, not applied);
 *  - a storage failure: 500 — the CMS retries.
 *
 * Logs: one line per accepted request with the event type and id only (never an address, a name, an
 * account id, a signature or a body); a refusal logs its step, nothing from the request.
 */

export type CmsEventsRouterOptions = {
  cfg?: AudienceEnv;
  clock?: () => Date;
  /** Refused requests per minute per IP before 429 (default 60, design §5.1). */
  failuresPerMin?: number;
  portal?: string;
};

const BODY_LIMIT = '64kb';
const TXN_TIMEOUT_MS = 20_000;
const DEFAULT_FAILURES_PER_MIN = 60;

type Step = 'off' | 'fence' | 'body' | 'headers' | 'signature' | 'event_id' | 'replay';

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[audience] ${msg}`);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function createIntegrationsRouter(opts: CmsEventsRouterOptions = {}): Router {
  const router = Router();
  const failLimiter = makePublicLimiter(opts.failuresPerMin ?? DEFAULT_FAILURES_PER_MIN);
  const cfgOf = () => opts.cfg ?? env.audience;
  const portal = opts.portal ?? 'taxscan';

  const refuse = (req: Request, res: Response, step: Step): void => {
    void failLimiter(req, res, () => {
      log(`webhook refused (step=${step})`);
      res.status(401).json({ code: 'UNAUTHORISED' });
    });
  };

  // Steps 1–2, before a byte of the body is read.
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    const cfg = cfgOf();
    if (!audienceIngestReady(cfg)) return refuse(req, res, 'off');
    const client = cmsClientIp(req.ip, req.header('cf-connecting-ip'));
    if (!isCmsIpAllowed(client, cfg.cms.allowedIps)) return refuse(req, res, 'fence');
    next();
  };

  router.post(
    '/cms/events',
    gate,
    express.raw({ type: () => true, limit: BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const started = Date.now();
      const cfg = cfgOf();
      const now = opts.clock?.() ?? new Date();

      // 3. The raw bytes (an empty body arrives as {} from body-parser, not a Buffer).
      const raw: unknown = req.body;
      if (!Buffer.isBuffer(raw) || raw.length === 0) return refuse(req, res, 'body');

      // 4. Headers.
      const eventIdHeader = req.header(CMS_HEADERS.eventId);
      const tsHeader = req.header(CMS_HEADERS.timestamp);
      const sigHeader = req.header(CMS_HEADERS.signature);
      if (!eventIdHeader || !tsHeader || !sigHeader) return refuse(req, res, 'headers');

      // 5. Signature over the exact bytes, the constant path, ±300 s, current or previous secret.
      const v = verifyCmsWebhook({
        secrets: [cfg.cms.inboundSecret, cfg.cms.inboundSecretPrevious],
        rawBody: raw,
        timestampHeader: tsHeader,
        signatureHeader: sigHeader,
        now,
      });
      if (!v.ok) return refuse(req, res, 'signature');

      // 6. The header nonce must be the body's event_id (signed). Not JSON → it cannot be.
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return refuse(req, res, 'event_id');
      }
      if (eventIdOf(body) !== eventIdHeader) return refuse(req, res, 'event_id');
      const eventId = eventIdHeader;
      const signedTs = BigInt(v.ts);

      // 7. Replay. Returns the answer for a known event_id, or null for a new one.
      const answerKnown = async (): Promise<boolean> => {
        const receipt = await prisma.cmsEventReceipt.findUnique({ where: { eventId } });
        const replay = classifyWebhookReplay(receipt?.signedTs, v.ts);
        if (replay === 'new') return false;
        if (replay === 'exact_replay') {
          refuse(req, res, 'replay');
          return true;
        }
        // The CMS's retry: keep the LATEST signed timestamp, so a verbatim copy of THIS delivery
        // is an exact replay from now on (not just a copy of the first one).
        await prisma.cmsEventReceipt.updateMany({ where: { eventId, signedTs: { lt: signedTs } }, data: { signedTs } });
        log(`event=${receipt!.event} id=${eventId} outcome=duplicate ms=${Date.now() - started}`);
        res.status(200).json({ ok: true, duplicate: true });
        return true;
      };

      try {
        if (await answerKnown()) return;

        // 8. Parse.
        const parsed = parseCmsEvent(body);
        const eventName = parsed.ok ? parsed.event : (parsed.event ?? 'unknown');
        if (!parsed.ok || 'unknownType' in parsed) {
          const outcome = parsed.ok ? 'unknown_type' : 'invalid';
          await prisma.cmsEventReceipt.create({ data: { eventId, event: eventName.slice(0, 64), signedTs, outcome } });
          log(`event=${eventName.slice(0, 64)} id=${eventId} outcome=${outcome}${parsed.ok ? '' : ` reason=${parsed.reason}`} ms=${Date.now() - started}`);
          if (parsed.ok) res.status(200).json({ ok: true, outcome });
          else res.status(422).json({ code: 'INVALID' });
          return;
        }

        // 9. Apply + receipt + last-webhook time, one transaction.
        const result = await prisma.$transaction(
          async (tx) => {
            const r = await applyAccountSnapshot(tx, parsed.snapshot, 'webhook', { now, cfg, portal });
            await tx.cmsEventReceipt.create({ data: { eventId, event: parsed.event, signedTs, outcome: r.outcome } });
            await tx.$executeRaw`
              INSERT INTO "AudienceSyncState" (portal, "lastWebhookAt", "updatedAt")
              VALUES (${portal}, (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'), (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
              ON CONFLICT (portal) DO UPDATE SET
                "lastWebhookAt" = GREATEST(COALESCE("AudienceSyncState"."lastWebhookAt", EXCLUDED."lastWebhookAt"), EXCLUDED."lastWebhookAt"),
                "updatedAt" = EXCLUDED."updatedAt"`;
            return r;
          },
          { timeout: TXN_TIMEOUT_MS },
        );
        log(`event=${parsed.event} id=${eventId} outcome=${result.outcome} ms=${Date.now() - started}`);
        res.status(200).json({ ok: true, outcome: result.outcome });
      } catch (err) {
        // Two deliveries of one event raced: the loser's receipt insert hit the key. Answer as a known event.
        if (isUniqueViolation(err)) {
          try {
            if (await answerKnown()) return;
          } catch {
            /* fall through to 500 */
          }
        }
        // eslint-disable-next-line no-console
        console.error(`[audience] webhook store failed id=${eventId}`, safeErrorLog(err));
        if (!res.headersSent) res.status(500).json({ code: 'INTERNAL' });
      }
    },
  );

  // Body-parser errors (too large, bad encoding): the same 401, nothing echoed or logged from the body.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((_err: unknown, req: Request, res: Response, _next: NextFunction) => refuse(req, res, 'body'));

  // Anything else under /api/integrations: a plain 404 that never echoes the path.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });
  return router;
}
