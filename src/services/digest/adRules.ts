import type { DigestAudience } from '@prisma/client';

/**
 * The digest's SUBSCRIPTION guard in one place, with no imports of its own so
 * the picker (`ads.ts`), the renderer and the runner's freeze check can all
 * use it without an import cycle (docs/EMAIL_DIGEST_DESIGN.md §1 #12, §4).
 *
 * A SUBSCRIPTION ad never reaches a PREMIUM reader, whatever its `audience`.
 * The kind is compared case-insensitively (fail closed for a row written
 * outside the validated save path, e.g. by hand or a seed).
 */
export function forbiddenForAudience(kind: string, audience: DigestAudience): boolean {
  return audience === 'PREMIUM' && String(kind ?? '').trim().toUpperCase() === 'SUBSCRIPTION';
}

/** The `utm_content` of an ad placement: `ad-<id>-slot<N>`. */
export function adUtmContent(adId: string, slot: number): string {
  return `ad-${adId}-slot${slot}`;
}
