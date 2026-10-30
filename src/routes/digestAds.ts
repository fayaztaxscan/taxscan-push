import express, { Router, type Request, type Response } from 'express';
import { requireBearerOrUser } from '../lib/auth';
import { recordAudit } from '../lib/audit';
import { prisma } from '../lib/prisma';
import type { DigestEnv } from '../lib/env';
import { reportCategoryLabels } from '../services/reports';
import { ImageRejected, UPLOAD_LIMIT, assetUrl, readAsset, storeImage, ASSET_FILE } from '../services/digest/adImages';
import { AdInputSchema, SLOT_NUMBERS, adCoverage, linkHost, nextBuildAt, utmPreview, type AdInput } from '../services/digest/ads';
import { validateDigestSchedule } from '../services/digest/scheduler';
import { digestUtmCampaign } from '../services/digest/renderer';
import { istDateOf } from '../services/digest/retryPolicy';
import { requestClientIp } from '../lib/clientIp';

/**
 * Digest Ads (docs/EMAIL_DIGEST_DESIGN.md §6, §7 Ads, §9; task 9). Mounted
 * inside `/api/digest`. Any signed-in staff user (ADMIN or PUBLISHER — owner,
 * 29 Oct 2026) or the ADMIN_TOKEN bearer; no session is 401. Every ad change writes an audit
 * row whose metadata holds the link HOST, never the full URL.
 *
 *   GET  /ads                 list (+ coverage, slots, topics)   ?archived=1 includes archived
 *   GET  /ads/coverage        the per-slot coverage check alone
 *   POST /ads                 create                               DIGEST_AD_SAVED
 *   PUT  /ads/:id             update (not an archived ad)          DIGEST_AD_SAVED
 *   POST /ads/:id/archive     {confirm: true}                      DIGEST_AD_ARCHIVED
 *   POST /ad-images           raw JPEG/PNG body (≤ 200 KB on this route only; ≤ 150 KB accepted)
 *
 * The public image route (`GET /email-assets/:sha.(jpg|png)`) is `emailAssetsHandler` below,
 * mounted at the app root.
 */
export type DigestAdsRouterOptions = {
  cfg: () => DigestEnv;
  clock: () => Date;
  portal: () => string;
};

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);

type AdRow = Awaited<ReturnType<typeof loadAds>>[number];

async function loadAds(portal: string, includeArchived: boolean) {
  return prisma.digestAd.findMany({
    where: { portal, ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }) },
    include: { image: { select: { id: true, mime: true, width: true, height: true, size: true } } },
    orderBy: [{ status: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }],
  });
}

/** live | scheduled | ended for the date window at `now` (status is separate). */
function windowState(ad: { startsAt: Date | null; endsAt: Date | null }, now: Date): 'live' | 'scheduled' | 'ended' {
  if (ad.endsAt && ad.endsAt.getTime() <= now.getTime()) return 'ended';
  if (ad.startsAt && ad.startsAt.getTime() > now.getTime()) return 'scheduled';
  return 'live';
}

export function createDigestAdsRouter(o: DigestAdsRouterOptions): Router {
  const router = Router();

  const buildAt = (cfg: DigestEnv): Date => {
    const check = (() => {
      try {
        return validateDigestSchedule(cfg);
      } catch {
        return null;
      }
    })();
    const now = o.clock();
    return check?.ok ? nextBuildAt(now, check.schedule.buildAt) : now;
  };

  const present = (ad: AdRow, cfg: DigestEnv, now: Date, lastPlacedAt: Date | null) => {
    const sampleSlot = ad.slots[0] ?? SLOT_NUMBERS[0];
    return {
      id: ad.id,
      name: ad.name,
      kind: ad.kind,
      headline: ad.headline,
      altText: ad.altText,
      body: ad.body,
      ctaText: ad.ctaText,
      linkUrl: ad.linkUrl,
      imageId: ad.imageId,
      image: ad.image ? { url: assetUrl(cfg.assetBaseUrl, ad.image), width: ad.image.width, height: ad.image.height, size: ad.image.size } : null,
      audience: ad.audience,
      topic: ad.topic,
      slots: ad.slots,
      priority: ad.priority,
      isSlotDefault: ad.isSlotDefault,
      startsAt: ad.startsAt,
      endsAt: ad.endsAt,
      status: ad.status,
      window: windowState(ad, now),
      updatedAt: ad.updatedAt,
      lastPlacedAt,
      utmExample: utmPreview(ad.linkUrl, ad.id, sampleSlot, digestUtmCampaign(istDateOf(now), 'FREE')),
    };
  };

  async function listPayload(includeArchived: boolean) {
    const cfg = o.cfg();
    const now = o.clock();
    const ads = await loadAds(o.portal(), includeArchived);
    const last = ads.length
      ? await prisma.digestAdPlacement.groupBy({ by: ['adId'], where: { adId: { in: ads.map((a) => a.id) } }, _max: { createdAt: true } })
      : [];
    const lastBy = new Map(last.map((l) => [l.adId, l._max.createdAt]));
    return {
      ads: ads.map((a) => present(a, cfg, now, lastBy.get(a.id) ?? null)),
      coverage: await adCoverage(o.portal(), buildAt(cfg)),
      slots: SLOT_NUMBERS,
      topics: reportCategoryLabels(),
    };
  }

  const invalid = (res: Response, issues: { message: string; path?: PropertyKey[] }[]) =>
    res.status(400).json({ error: 'invalid_request', issues: issues.map((i) => ({ message: i.message, path: (i.path ?? []).map(String) })) });

  /** Parses + checks the referenced image exists. Returns the input or sends a 400. */
  async function parseAd(req: Request, res: Response): Promise<AdInput | null> {
    const parsed = AdInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      invalid(res, parsed.error.issues);
      return null;
    }
    if (parsed.data.imageId && !(await prisma.digestAdImage.findUnique({ where: { id: parsed.data.imageId }, select: { id: true } }))) {
      invalid(res, [{ message: 'The image was not found; upload it again', path: ['imageId'] }]);
      return null;
    }
    return parsed.data;
  }

  type AuditSource = Pick<AdRow, 'name' | 'kind' | 'audience' | 'slots' | 'priority' | 'isSlotDefault' | 'status' | 'linkUrl' | 'imageId' | 'startsAt' | 'endsAt'>;
  const auditMeta = (a: AuditSource | AdInput, extra: Record<string, unknown> = {}) => ({
    name: a.name,
    kind: a.kind,
    audience: a.audience,
    slots: a.slots,
    priority: a.priority,
    isSlotDefault: a.isSlotDefault,
    status: a.status,
    linkHost: linkHost(a.linkUrl),
    imageId: a.imageId ?? null,
    startsAt: a.startsAt ? a.startsAt.toISOString() : null,
    endsAt: a.endsAt ? a.endsAt.toISOString() : null,
    ...extra,
  });

  router.get('/ads', STAFF, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await listPayload(req.query.archived === '1'));
    } catch (err) {
      return next(err);
    }
  });

  router.get('/ads/coverage', STAFF, async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await adCoverage(o.portal(), buildAt(o.cfg())));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/ads', STAFF, async (req, res, next) => {
    try {
      const input = await parseAd(req, res);
      if (!input) return;
      const ad = await prisma.digestAd.create({
        data: { ...input, portal: o.portal(), createdByUserId: req.user?.id ?? null },
      });
      await recordAudit({
        userId: req.user?.id ?? null,
        action: 'DIGEST_AD_SAVED',
        resourceType: 'DigestAd',
        resourceId: ad.id,
        metadata: auditMeta(input, { created: true }),
        ipAddress: requestClientIp(req),
      });
      return res.status(201).json({ id: ad.id, ...(await listPayload(false)) });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/ads/:id', STAFF, async (req, res, next) => {
    try {
      const existing = await prisma.digestAd.findFirst({ where: { id: req.params.id, portal: o.portal() } });
      if (!existing) return res.status(404).json({ error: 'not_found' });
      if (existing.status === 'ARCHIVED') return res.status(409).json({ error: 'archived', message: 'An archived ad cannot be edited.' });
      const input = await parseAd(req, res);
      if (!input) return;
      const changed = (Object.keys(input) as (keyof AdInput)[]).filter((k) => JSON.stringify(input[k]) !== JSON.stringify(existing[k]));
      // Conditional on not-archived, so a concurrent archive is never undone by a save.
      const r = await prisma.digestAd.updateMany({ where: { id: existing.id, status: { not: 'ARCHIVED' } }, data: input });
      if (r.count !== 1) return res.status(409).json({ error: 'archived', message: 'An archived ad cannot be edited.' });
      await recordAudit({
        userId: req.user?.id ?? null,
        action: 'DIGEST_AD_SAVED',
        resourceType: 'DigestAd',
        resourceId: existing.id,
        metadata: auditMeta(input, { changed }),
        ipAddress: requestClientIp(req),
      });
      return res.json({ id: existing.id, ...(await listPayload(false)) });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/ads/:id/archive', STAFF, async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm_required', message: 'Archiving needs confirm: true.' });
      const existing = await prisma.digestAd.findFirst({ where: { id: req.params.id, portal: o.portal() } });
      if (!existing) return res.status(404).json({ error: 'not_found' });
      if (existing.status !== 'ARCHIVED') {
        await prisma.digestAd.update({ where: { id: existing.id }, data: { status: 'ARCHIVED' } });
        await recordAudit({
          userId: req.user?.id ?? null,
          action: 'DIGEST_AD_ARCHIVED',
          resourceType: 'DigestAd',
          resourceId: existing.id,
          metadata: auditMeta(existing, { status: 'ARCHIVED', from: existing.status }),
          ipAddress: requestClientIp(req),
        });
      }
      return res.json({ id: existing.id, ...(await listPayload(false)) });
    } catch (err) {
      return next(err);
    }
  });

  // The ONLY route with a body over the global 64 KB JSON limit.
  router.post(
    '/ad-images',
    STAFF,
    express.raw({ type: () => true, limit: UPLOAD_LIMIT }),
    async (req, res, next) => {
      try {
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const filename = typeof req.header('x-filename') === 'string' ? decodeURIComponent(req.header('x-filename') as string).slice(0, 200) : undefined;
        const img = await storeImage(buf, { contentType: req.header('content-type'), filename });
        return res.status(img.deduped ? 200 : 201).json({
          id: img.id,
          url: assetUrl(o.cfg().assetBaseUrl, img),
          width: img.width,
          height: img.height,
          size: img.size,
          mime: img.mime,
          deduped: img.deduped,
        });
      } catch (err) {
        if (err instanceof ImageRejected) return res.status(400).json({ error: err.code, message: err.message });
        if (err instanceof URIError) return res.status(400).json({ error: 'bad_filename', message: 'The file name could not be read.' });
        return next(err);
      }
    },
  );
  router.use(adImageTooLarge);

  return router;
}

/** Too big for the route's raw limit: our words, not a bare 413 page. */
export function adImageTooLarge(err: unknown, _req: Request, res: Response, next: (e?: unknown) => void): void {
  const e = err as { type?: string; status?: number };
  if (e && e.type === 'entity.too.large') {
    res.status(413).json({ error: 'too_big', message: 'The image is over 150 KB; export it smaller.' });
    return;
  }
  next(err);
}

/**
 * `GET /email-assets/:file` — public; serves only a stored ad image by its
 * sha256 name with the matching extension. Anything else (another name, a
 * traversal attempt, a wrong extension) is a 404 from the pattern, before any
 * lookup. Immutable (the name IS the content hash) and cross-origin readable,
 * since mail clients and their image proxies load it from anywhere.
 */
export async function emailAssetsHandler(req: Request, res: Response, next: (e?: unknown) => void): Promise<void> {
  try {
    const file = String(req.params.file ?? '');
    const hit = ASSET_FILE.test(file) ? await readAsset(file) : null;
    if (!hit) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    res.setHeader('Content-Type', hit.mime);
    res.setHeader('Content-Length', String(hit.bytes.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('ETag', `"${file.slice(0, 64)}"`);
    if (req.header('if-none-match') === `"${file.slice(0, 64)}"`) {
      res.status(304).end();
      return;
    }
    res.end(hit.bytes);
  } catch (err) {
    next(err);
  }
}
