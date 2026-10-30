import { prisma } from '../../lib/prisma';
import { assetUrl, storeImage, type StoredImage } from './adImages';

/**
 * The digest's "default story picture" (brief digest-polish-old-look, decision A): one 1600 x 840 JPEG/PNG,
 * shown for any main story that has no picture of its own. Bytes live in DigestAdImage (same upload, dedupe
 * and `/email-assets/<sha>.<ext>` serving as ad images); the CHOICE is one DigestSetting row per portal,
 * key `<portal>:defaultStoryImage`, value = the image id. No row = none set (the renderer draws the brand block).
 *
 * Frozen at the build: `renderDigestContent` resolves it once, when the run is built, and the rendered html is
 * stored with the send — a later upload or removal never changes a built run.
 */
export const defaultStoryKey = (portal: string): string => `${portal}:defaultStoryImage`;

export type DefaultStoryImage = { id: string; url: string; width: number; height: number; size: number; mime: string; updatedAt: Date };

/** The current default picture, or null when none is set (or its image row is gone). */
export async function getDefaultStoryImage(portal: string, assetBaseUrl: string): Promise<DefaultStoryImage | null> {
  const s = await prisma.digestSetting.findUnique({ where: { key: defaultStoryKey(portal) } });
  if (!s) return null;
  const img = await prisma.digestAdImage.findUnique({ where: { id: s.value }, select: { id: true, mime: true, width: true, height: true, size: true } });
  if (!img) return null;
  return { ...img, url: assetUrl(assetBaseUrl, img), updatedAt: s.updatedAt };
}

/** The URL the renderer takes (`RenderInput.defaultStoryImageUrl`): null = none set. */
export async function resolveDefaultStoryImageUrl(portal: string, assetBaseUrl: string): Promise<string | null> {
  return (await getDefaultStoryImage(portal, assetBaseUrl))?.url ?? null;
}

/** Validates (exactly 1600 x 840, <= 250 KB, JPEG/PNG), stores the bytes and points the setting at them. Throws ImageRejected. */
export async function setDefaultStoryImage(
  portal: string,
  buf: Buffer,
  declared: { contentType?: string; filename?: string },
  userId: string | null,
): Promise<{ stored: StoredImage; previousId: string | null }> {
  const stored = await storeImage(buf, declared, 'story');
  const key = defaultStoryKey(portal);
  const prev = await prisma.digestSetting.findUnique({ where: { key } });
  await prisma.digestSetting.upsert({
    where: { key },
    create: { key, value: stored.id, updatedByUserId: userId },
    update: { value: stored.id, updatedByUserId: userId },
  });
  return { stored, previousId: prev?.value ?? null };
}

/** Clears the setting (the image row stays: past builds' html may still link to it). Returns the removed image id, or null if none was set. */
export async function clearDefaultStoryImage(portal: string): Promise<string | null> {
  const key = defaultStoryKey(portal);
  const prev = await prisma.digestSetting.findUnique({ where: { key } });
  if (!prev) return null;
  await prisma.digestSetting.delete({ where: { key } });
  return prev.value;
}
