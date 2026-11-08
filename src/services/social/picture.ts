import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';
import { EXT_OF, ImageRejected, imageHeader, imageId, type ImageInfo, type ImageMime } from '../digest/adImages';

/**
 * The Compose picture for a push's LinkedIn and Facebook posts (brief 2026-11-08-social-picture). One picture per push, stored
 * once by content hash in `SocialImage` and named on the campaign (`Campaign.socialImageId`). Used only by the social workers:
 * the push notification itself never shows it (`public/sw.js` is untouched).
 *
 * Rules (shown on Compose before a file is picked; every refusal is a plain sentence):
 *  - JPEG or PNG, read from the BYTES (`imageHeader`, shared with the digest ad images: a renamed text file is refused);
 *  - at most 2 MB;
 *  - at least 1080 px wide;
 *  - from 4:5 (portrait) to 1.91:1 (wide); square 1:1 in between. Taller than 4:5 or wider than 1.91:1 is refused.
 * Recommended: 1080 × 1080 (square) or 1200 × 627 (wide). Not resized.
 *
 * NOT in the backup (docs/BACKUPS.md): after a restore a campaign may name a picture that is gone, and the workers then post the
 * ordinary link post. Never logs bytes.
 */

export const SOCIAL_MAX_BYTES = 2 * 1024 * 1024;
export const SOCIAL_MIN_WIDTH = 1080;
/** Widest shape: 1.91:1 (1200 × 627 is 1.914, LinkedIn's and Facebook's own "1.91:1"), so the check allows up to 1.92. */
export const SOCIAL_MAX_WIDE = 1.92;
/** Tallest shape: 4:5 (height at most 1.25 × width). */
export const SOCIAL_MAX_TALL = 1.25;
/** The route's raw-body limit sits above SOCIAL_MAX_BYTES, so a too-big file gets our sentence, not a bare 413. */
export const SOCIAL_UPLOAD_LIMIT = '4mb';

/** The rules as one plain paragraph (the route's config answer; Compose shows its own copy of the same words). */
export const SOCIAL_PICTURE_RULES =
  'JPEG or PNG, at most 2 MB, at least 1080 px wide, from square (1:1) to wide (1.91:1); portrait up to 4:5. Recommended: 1080 × 1080 (square) or 1200 × 627 (wide).';

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** Checks an upload against the rules above. Throws ImageRejected with a plain sentence. Pure. */
export function validateSocialPicture(buf: Buffer, declared: { contentType?: string; filename?: string } = {}): ImageInfo {
  if (!buf || buf.length === 0) throw new ImageRejected('empty', 'The file is empty.');
  if (buf.length > SOCIAL_MAX_BYTES) {
    throw new ImageRejected('too_big', `The picture is ${mb(buf.length)}; the limit is 2 MB. Export it smaller (JPEG quality ~80 usually does it).`);
  }
  const info = imageHeader(buf, declared);
  const { width, height } = info;
  if (width < SOCIAL_MIN_WIDTH) {
    throw new ImageRejected('too_narrow', `The picture is ${width} px wide; it must be at least ${SOCIAL_MIN_WIDTH} px. Use 1080 × 1080 (square) or 1200 × 627 (wide).`);
  }
  if (height > width * SOCIAL_MAX_TALL) {
    throw new ImageRejected(
      'too_tall',
      `The picture is ${width} × ${height} px, taller than 4:5 (${Math.floor(width * SOCIAL_MAX_TALL)} px is the most for this width). Crop it to square (1080 × 1080) or wide (1200 × 627).`,
    );
  }
  if (width > height * SOCIAL_MAX_WIDE) {
    throw new ImageRejected('too_wide_shape', `The picture is ${width} × ${height} px, wider than 1.91:1. Crop it to wide (1200 × 627) or square (1080 × 1080).`);
  }
  return info;
}

export type StoredSocialImage = { id: string; mime: ImageMime; width: number; height: number; size: number; deduped: boolean };

/** Validates and stores an upload. The same bytes twice are one row (sha256 id; a concurrent twin loses on the primary key). */
export async function storeSocialPicture(buf: Buffer, declared: { contentType?: string; filename?: string } = {}): Promise<StoredSocialImage> {
  const info = validateSocialPicture(buf, declared);
  const id = imageId(buf);
  const out = (deduped: boolean): StoredSocialImage => ({ id, ...info, size: buf.length, deduped });
  if (await prisma.socialImage.findUnique({ where: { id }, select: { id: true } })) return out(true);
  try {
    await prisma.socialImage.create({ data: { id, mime: info.mime, width: info.width, height: info.height, size: buf.length, bytes: new Uint8Array(buf) } });
    return out(false);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return out(true);
    throw err;
  }
}

/** Where the public route lives: `<base>/social-images/<sha>.<ext>`. */
export function socialImageUrl(img: { id: string; mime: string }, base: string = env.digest.assetBaseUrl): string {
  return `${base.replace(/\/+$/, '')}/social-images/${img.id}.${EXT_OF[img.mime as ImageMime] ?? 'bin'}`;
}

export const SOCIAL_IMAGE_ID = /^[a-f0-9]{64}$/;
export const SOCIAL_IMAGE_FILE = /^([a-f0-9]{64})\.(jpg|png)$/;

const cache = new Map<string, { mime: ImageMime; bytes: Buffer }>();
const CACHE_MAX = 16;

/** The stored picture by id (immutable by id, so a cached copy is never stale), or null. */
export async function loadSocialImage(id: string): Promise<{ id: string; mime: ImageMime; bytes: Buffer } | null> {
  if (!SOCIAL_IMAGE_ID.test(id)) return null;
  let hit = cache.get(id);
  if (!hit) {
    const row = await prisma.socialImage.findUnique({ where: { id }, select: { mime: true, bytes: true } });
    if (!row || (row.mime !== 'image/jpeg' && row.mime !== 'image/png')) return null;
    hit = { mime: row.mime, bytes: Buffer.from(row.bytes) };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(id, hit);
  }
  return { id, ...hit };
}

/** The public route's lookup: a sha256 name whose extension matches the stored type, else null. */
export async function readSocialImageFile(file: string): Promise<{ mime: ImageMime; bytes: Buffer } | null> {
  const m = SOCIAL_IMAGE_FILE.exec(file);
  if (!m) return null;
  const img = await loadSocialImage(m[1]);
  return img && EXT_OF[img.mime] === m[2] ? img : null;
}

/**
 * The picture a social worker should use for this campaign: null when the setting is off, the campaign has none, or the stored
 * picture is gone (e.g. after a restore). `enabled` defaults to SOCIAL_PICTURE_ENABLED (tests pass it).
 */
export async function campaignPicture(
  c: { socialImageId?: string | null },
  enabled: boolean = env.social.pictureEnabled,
): Promise<{ id: string; mime: ImageMime; bytes: Buffer } | null> {
  if (!enabled || !c.socialImageId) return null;
  return loadSocialImage(c.socialImageId);
}
