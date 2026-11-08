import express, { Router, type Request, type Response } from 'express';
import { requireBearerOrUser } from '../lib/auth';
import { env } from '../lib/env';
import { ImageRejected } from '../services/digest/adImages';
import {
  SOCIAL_IMAGE_FILE,
  SOCIAL_MAX_BYTES,
  SOCIAL_MIN_WIDTH,
  SOCIAL_PICTURE_RULES,
  SOCIAL_UPLOAD_LIMIT,
  readSocialImageFile,
  socialImageUrl,
  storeSocialPicture,
} from '../services/social/picture';

/**
 * The Compose picture for LinkedIn + Facebook (brief 2026-11-08-social-picture). ADMIN + PUBLISHER, the same as Compose.
 *
 *   GET  /api/social-picture   { enabled, rules, maxBytes, minWidth }
 *   POST /api/social-picture   raw JPEG/PNG body (≤ 4 MB on this route only; the rule is 2 MB, so a bigger file gets our
 *                              sentence). `X-Filename` (URI-encoded) is optional. 201 new / 200 same bytes again:
 *                              { id, url, width, height, size, mime, deduped }. A refusal is 400 { error, message } in plain
 *                              words. With SOCIAL_PICTURE_ENABLED off: 404 { error: 'social_picture_off' }.
 *
 * The public `GET /social-images/:file` (no login; mounted in app.ts) serves the bytes for Facebook, which fetches the picture by URL.
 */

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);

export type SocialPictureRouterOptions = { enabled?: () => boolean; assetBaseUrl?: () => string };

export function createSocialPictureRouter(o: SocialPictureRouterOptions = {}): Router {
  const enabled = o.enabled ?? (() => env.social.pictureEnabled);
  const base = o.assetBaseUrl ?? (() => env.digest.assetBaseUrl);
  const router = Router();

  router.get('/', STAFF, (_req, res) => {
    res.json({ enabled: enabled(), rules: SOCIAL_PICTURE_RULES, maxBytes: SOCIAL_MAX_BYTES, minWidth: SOCIAL_MIN_WIDTH });
  });

  router.post(
    '/',
    STAFF,
    (_req, res, next) => (enabled() ? next() : void res.status(404).json({ error: 'social_picture_off', message: 'Pictures for social posts are switched off.' })),
    express.raw({ type: () => true, limit: SOCIAL_UPLOAD_LIMIT }),
    async (req, res, next) => {
      try {
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const raw = req.header('x-filename');
        const filename = typeof raw === 'string' ? decodeURIComponent(raw).slice(0, 200) : undefined;
        const img = await storeSocialPicture(buf, { contentType: req.header('content-type'), filename });
        return res.status(img.deduped ? 200 : 201).json({
          id: img.id,
          url: socialImageUrl(img, base()),
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
  router.use(socialPictureTooLarge);
  return router;
}

/** Over the route's raw limit: our words, not a bare 413 page. */
export function socialPictureTooLarge(err: unknown, _req: Request, res: Response, next: (e?: unknown) => void): void {
  const e = err as { type?: string };
  if (e && e.type === 'entity.too.large') {
    res.status(413).json({ error: 'too_big', message: 'The picture is over 2 MB. Export it smaller (JPEG quality ~80 usually does it).' });
    return;
  }
  next(err);
}

/**
 * `GET /social-images/:file`: public, no login. Only a stored picture by its sha256 name with the matching extension; anything else
 * is a 404 before any lookup. Immutable (the name is the content hash) and cross-origin readable (Facebook fetches it by URL).
 * Served whether or not the setting is on: a picture only exists if someone uploaded it.
 */
export async function socialImagesHandler(req: Request, res: Response, next: (e?: unknown) => void): Promise<void> {
  try {
    const file = String(req.params.file ?? '');
    const hit = SOCIAL_IMAGE_FILE.test(file) ? await readSocialImageFile(file) : null;
    if (!hit) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    const etag = `"${file.slice(0, 64)}"`;
    res.setHeader('Content-Type', hit.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('ETag', etag);
    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Length', String(hit.bytes.length));
    res.end(hit.bytes);
  } catch (err) {
    next(err);
  }
}
