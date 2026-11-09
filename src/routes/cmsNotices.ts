import { Router, type Request, type Response } from 'express';
import { env, isCmsIpAllowed, type AudienceEnv, type NoticesEnv } from '../lib/env';
import { makeHourlyLimiter } from '../lib/rateLimit';
import { safeErrorLog } from '../lib/httpErrors';
import { cmsClientIp } from '../lib/clientIp';
import { CMS_HEADERS, verifyCmsNoticesGet } from '../lib/cmsSignature';
import { claimNonce, digestNoticeList, noticesEtag, noticesNotReady, type NoticeItem } from '../services/audience/notices';

/**
 * Door N: the signed daily list for the CMS's "your digest isn't reaching you" notice (brief 2026-11-09-digest-notice-list;
 * contract in docs/CMS_AUDIENCE_SYNC_DESIGN.md, "Door N"). Mounted at `/api/integrations`, BEFORE door W's router (whose last
 * handler is a catch-all 404), and only for this one path.
 *
 *   GET /api/integrations/cms/digest-notices?nonce=<32 hex>
 *   X-CMS-Timestamp, X-CMS-Signature  (the doors L / V rule mirrored: sha256 HMAC over `<ts>.GET.<path>.<canonical query>`)
 *
 * Checks, in this order, each stopping at the first failure:
 *  1. DIGEST_NOTICES_ENABLED. Off: `404`, as if the door did not exist (before anything else is read);
 *  2. the IP fence (`cmsClientIp`, never `req.ip`): CMS_FEED_ALLOWED_IPS, empty rejects everything → 401;
 *  3. the rate limit, 30 requests an hour per client → 429 (only a fenced client reaches it);
 *  4. no body, both headers, the signature (±300 s, current or previous CMS_FEED_NOTICES_SECRET, the CONSTANT path), a SIGNED
 *     `nonce` and no other query parameter → 401;
 *  5. the nonce, single use for 10 minutes (`claimNonce`, claimed only after the signature verified) → 401;
 *  6. freshness: a COMPLETE full CMS load within 48 h and the breaker closed, else `503 {"error":"not_ready"}`;
 *  7. the list, built on request from Postgres: `If-None-Match` equal to its ETag → 304, else 200.
 *
 * Every failure of steps 2, 4 and 5 is the SAME `401 {"code":"UNAUTHORISED"}`, nothing echoed; the log gets a reason code only (never
 * a header, a query, a signature or an address). The CMS keeps its last copy on any non-200. "No data" is never an empty list: a 200
 * with `count: 0` means nobody should see a notice. Never calls the CMS or Mailercloud.
 */

export type NoticesRouterOptions = {
  cfg?: NoticesEnv;
  audience?: AudienceEnv;
  clock?: () => Date;
  portal?: string;
  /** Requests an hour per client before 429 (default 30). */
  perHour?: number;
  /** Tests inject the list builder. */
  list?: (portal: string, now: Date) => Promise<NoticeItem[]>;
};

type Step = 'fence' | 'body' | 'headers' | 'signature' | 'params' | 'nonce';

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[audience] ${msg}`);
}

/** `If-None-Match` matches our ETag: any listed tag, weak or strong, or `*`. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
    .some((t) => t === etag || t === '*');
}

export function createNoticesRouter(opts: NoticesRouterOptions = {}): Router {
  const router = Router();
  const limiter = makeHourlyLimiter(opts.perHour ?? 30);
  const cfgOf = () => opts.cfg ?? env.notices;
  const audOf = () => opts.audience ?? env.audience;
  const portal = opts.portal ?? 'taxscan';
  const build = opts.list ?? digestNoticeList;

  const refuse = (res: Response, step: Step): void => {
    log(`digest notices refused (step=${step})`);
    res.status(401).json({ code: 'UNAUTHORISED' });
  };

  router.get(
    '/cms/digest-notices',
    // 1. Off: a plain 404 that never reveals the door exists.
    (_req: Request, res: Response, next) => (cfgOf().enabled ? next() : void res.status(404).json({ error: 'not_found' })),
    // 2. The fence.
    (req: Request, res: Response, next) => {
      const client = cmsClientIp(req.header('x-forwarded-for'), req.header('cf-connecting-ip'));
      if (!isCmsIpAllowed(client, audOf().cms.allowedIps)) return refuse(res, 'fence');
      return next();
    },
    // 3. The rate limit.
    limiter,
    async (req: Request, res: Response) => {
      const cfg = cfgOf();
      const now = opts.clock?.() ?? new Date();
      try {
        // 4. A GET carries no body; the headers; the signature over the CONSTANT path; a signed nonce and nothing else in the query.
        const hasBody = Number(req.header('content-length') ?? 0) > 0 || req.header('transfer-encoding') !== undefined;
        if (hasBody) return refuse(res, 'body');
        const ts = req.header(CMS_HEADERS.timestamp);
        const sig = req.header(CMS_HEADERS.signature);
        if (!ts || !sig) return refuse(res, 'headers');
        const qi = req.originalUrl.indexOf('?');
        const v = verifyCmsNoticesGet({
          secrets: [cfg.secret, cfg.secretPrevious],
          rawQuery: qi === -1 ? '' : req.originalUrl.slice(qi + 1),
          timestampHeader: ts,
          signatureHeader: sig,
          now,
        });
        if (!v.ok) return refuse(res, 'signature');
        const names = Object.keys(v.params ?? {});
        if (names.length !== 1 || names[0] !== 'nonce' || !v.nonce) return refuse(res, 'params');
        // 5. Single use for 10 minutes; claimed only now that the signature verified.
        if (!(await claimNonce(v.nonce, now))) return refuse(res, 'nonce');

        // 6. Can we vouch for it?
        const notReady = await noticesNotReady(portal, now);
        if (notReady) {
          log(`digest notices not_ready reason=${notReady}`);
          res.setHeader('Cache-Control', 'no-store');
          return void res.status(503).json({ error: 'not_ready' });
        }

        // 7. The list, built now.
        const items = await build(portal, now);
        const etag = noticesEtag(items);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('ETag', `"${etag}"`);
        if (etagMatches(req.header('if-none-match'), etag)) {
          log(`digest notices served count=${items.length} outcome=not_modified`);
          return void res.status(304).end();
        }
        log(`digest notices served count=${items.length}`);
        return void res.status(200).json({
          as_of: now.toISOString(),
          portal,
          count: items.length,
          items: items.map((i) => ({ account_id: i.accountId, reason: i.reason })),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[audience] digest notices failed', safeErrorLog(err));
        if (!res.headersSent) res.status(500).json({ code: 'INTERNAL' });
      }
    },
  );

  return router;
}
