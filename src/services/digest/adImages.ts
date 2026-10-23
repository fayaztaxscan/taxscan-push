import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * Ad creatives for the email digest (docs/EMAIL_DIGEST_DESIGN.md §3
 * `DigestAdImage`, §6 `/ad-images` + `/email-assets`, §12: validated, not
 * resized). Zero dependencies: the type and the pixel size are read straight
 * from the file header.
 *
 *  - type   = from the BYTES (magic numbers), JPEG or PNG only. A declared
 *             Content-Type or file name that disagrees with the bytes is
 *             refused (a renamed GIF/HTML/SVG never becomes an "image").
 *  - width  ≤ MAX_IMAGE_WIDTH (1200 px; shown at ≤ 552 px in the email)
 *  - height ≤ 2 × width (MAX_HEIGHT_TO_WIDTH), and ≤ 65,535 px
 *  - size   ≤ MAX_IMAGE_BYTES (150 KB)
 *  - id     = sha256 of the bytes: an identical upload is the same row.
 */

export const MAX_IMAGE_BYTES = 150 * 1024;
export const MAX_IMAGE_WIDTH = 1200;
/** The route's body limit (express.raw) sits above MAX_IMAGE_BYTES so a too-big file gets our message, not a bare 413. */
export const UPLOAD_LIMIT = '200kb';

export type ImageMime = 'image/jpeg' | 'image/png';
export const EXT_OF: Record<ImageMime, 'jpg' | 'png'> = { 'image/jpeg': 'jpg', 'image/png': 'png' };

export type ImageProblem = 'empty' | 'too_big' | 'wrong_type' | 'type_mismatch' | 'unreadable' | 'too_wide' | 'too_tall' | 'too_tall_for_width';
/** The tallest image accepted: JPEG's own maximum. A PNG header can claim up to 2^32-1, which overflows the Int column (500). */
export const MAX_IMAGE_HEIGHT = 65_535;
/**
 * Height at most this many times the width (owner, 2026-10-23): 1200 wide → at
 * most 2400 tall. A taller creative fills several phone screens between two
 * stories. On top of the absolute limits above.
 */
export const MAX_HEIGHT_TO_WIDTH = 2;

export class ImageRejected extends Error {
  constructor(
    readonly code: ImageProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejected';
  }
}

export type ImageInfo = { mime: ImageMime; width: number; height: number };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The real type from the first bytes, or null for anything that is not JPEG/PNG. */
export function sniffMime(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** PNG: the first chunk must be IHDR; width/height are its first two big-endian uint32s. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** JPEG: walk the marker segments to the first SOFn frame header (not DHT C4, JPG C8, DAC CC). */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before a frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers, no length
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Declared type from a Content-Type header ('' / octet-stream = not declared). */
function declaredMime(contentType: string | undefined): ImageMime | 'other' | null {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!t || t === 'application/octet-stream') return null;
  if (t === 'image/png') return 'image/png';
  if (t === 'image/jpeg' || t === 'image/jpg' || t === 'image/pjpeg') return 'image/jpeg';
  return 'other';
}

/** Type implied by a file name's extension, when one is given. */
function extMime(filename: string | undefined): ImageMime | 'other' | null {
  const m = /\.([a-z0-9]{1,8})$/i.exec((filename ?? '').trim());
  if (!m) return null;
  const e = m[1].toLowerCase();
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg' || e === 'jpe') return 'image/jpeg';
  return 'other';
}

const LABEL: Record<ImageMime, string> = { 'image/jpeg': 'JPEG', 'image/png': 'PNG' };

/**
 * Validates an upload. Throws ImageRejected with a plain-words message the
 * Ads screen shows as is. Pure.
 */
export function validateImage(buf: Buffer, declared: { contentType?: string; filename?: string } = {}): ImageInfo {
  if (!buf || buf.length === 0) throw new ImageRejected('empty', 'The file is empty.');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ImageRejected('too_big', `The image is ${Math.ceil(buf.length / 1024)} KB; the limit is ${MAX_IMAGE_BYTES / 1024} KB. Export it smaller (JPEG quality ~75 usually does it).`);
  }
  const mime = sniffMime(buf);
  if (!mime) throw new ImageRejected('wrong_type', 'Only JPEG or PNG images are accepted.');
  for (const claimed of [declaredMime(declared.contentType), extMime(declared.filename)]) {
    if (claimed === null) continue;
    if (claimed !== mime) {
      throw new ImageRejected('type_mismatch', `The file is really a ${LABEL[mime]}, but its name or type says otherwise. Rename it to .${EXT_OF[mime]} and upload again.`);
    }
  }
  const size = mime === 'image/png' ? pngSize(buf) : jpegSize(buf);
  if (!size || size.width <= 0 || size.height <= 0) throw new ImageRejected('unreadable', 'The image header could not be read; re-export the file.');
  if (size.width > MAX_IMAGE_WIDTH) {
    throw new ImageRejected('too_wide', `The image is ${size.width} px wide; the limit is ${MAX_IMAGE_WIDTH} px. It shows at up to 552 px, so 1200 px is plenty.`);
  }
  if (size.height > MAX_IMAGE_HEIGHT) {
    throw new ImageRejected('too_tall', `The image is ${size.height} px tall; the limit is ${MAX_IMAGE_HEIGHT} px. Re-export it at its real size.`);
  }
  if (size.height > size.width * MAX_HEIGHT_TO_WIDTH) {
    throw new ImageRejected(
      'too_tall_for_width',
      `The image is ${size.width} × ${size.height} px; it may be at most ${MAX_HEIGHT_TO_WIDTH}× as tall as it is wide (${size.width * MAX_HEIGHT_TO_WIDTH} px for this width). Crop it or use a wider layout.`,
    );
  }
  return { mime, ...size };
}

export function imageId(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type StoredImage = { id: string; mime: ImageMime; width: number; height: number; size: number; ext: 'jpg' | 'png'; deduped: boolean };

/**
 * Validates and stores an upload. An identical file (same sha256) returns the
 * existing row (`deduped: true`); a concurrent identical upload loses on the
 * primary key and also returns the stored row.
 */
export async function storeImage(buf: Buffer, declared: { contentType?: string; filename?: string } = {}): Promise<StoredImage> {
  const info = validateImage(buf, declared);
  const id = imageId(buf);
  const out = (deduped: boolean): StoredImage => ({ id, ...info, size: buf.length, ext: EXT_OF[info.mime], deduped });
  if (await prisma.digestAdImage.findUnique({ where: { id }, select: { id: true } })) return out(true);
  try {
    await prisma.digestAdImage.create({ data: { id, mime: info.mime, width: info.width, height: info.height, size: buf.length, bytes: new Uint8Array(buf) } });
    return out(false);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return out(true);
    throw err;
  }
}

/** `<base>/email-assets/<sha>.<ext>` — the only form an ad image URL takes. */
export function assetUrl(base: string, img: { id: string; mime: string }): string {
  return `${base}/email-assets/${img.id}.${EXT_OF[img.mime as ImageMime] ?? 'bin'}`;
}

/** The public route's filename pattern: a sha256 and a jpg/png extension, nothing else. */
export const ASSET_FILE = /^([a-f0-9]{64})\.(jpg|png)$/;

/**
 * Bytes for the public route, from a small in-process cache (images are
 * immutable by id, so a cached copy is never stale). Null when the name is
 * not a stored image or its extension does not match the stored type.
 */
const cache = new Map<string, { mime: ImageMime; bytes: Buffer }>();
const CACHE_MAX = 32;
export async function readAsset(file: string): Promise<{ mime: ImageMime; bytes: Buffer } | null> {
  const m = ASSET_FILE.exec(file);
  if (!m) return null;
  const [, id, ext] = m;
  let hit = cache.get(id);
  if (!hit) {
    const row = await prisma.digestAdImage.findUnique({ where: { id }, select: { mime: true, bytes: true } });
    if (!row || (row.mime !== 'image/jpeg' && row.mime !== 'image/png')) return null;
    hit = { mime: row.mime, bytes: Buffer.from(row.bytes) };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(id, hit);
  }
  return EXT_OF[hit.mime] === ext ? hit : null;
}
