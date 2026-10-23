import { env } from '../../lib/env';
import { assetUrl } from './adImages';
import { loadAdPool, pickAds, type Placement } from './ads';
import { resolveTemplate } from './templates';
import {
  RenderError,
  assertReplyAddresses,
  renderDigest,
  renderableMainCount,
  slotsForMainCount,
  type BuildContent,
  type RenderAd,
} from './renderer';

/**
 * The runner's default `buildContent` (docs/EMAIL_DIGEST_DESIGN.md §2 data
 * flow: builder → ads → renderer). Picks one ad per slot the digest will draw
 * (`pickAds`, which throws `AdSlotError` when a slot cannot be filled — the
 * runner turns that into `config_invalid`, fail closed), renders the frozen
 * items with them, and returns the placements for the freeze to record.
 *
 * The layout is `resolveTemplate(audience, at)` (task 10); its id is frozen
 * with the send (`DigestSend.templateId`, null = the built-in template).
 *
 * Refuses (throws) without items — the build then fails loud (BUILD_FAILED +
 * alert) rather than freezing an empty digest. Logs size and image-weight
 * warnings (bytes only; never an address or a full URL).
 */
export const renderDigestContent: BuildContent = async ({ runDate, audience, items, cfg, portal, at }) => {
  const c = cfg ?? env.digest;
  if (!items) throw new RenderError('no_main_items', 'no frozen items (the builder did not run)');
  assertReplyAddresses(c.mailercloud);

  const slots = slotsForMainCount(renderableMainCount(items));
  const pool = await loadAdPool(portal ?? env.rss.portal);
  const placements = pickAds({ slots, audience, items, at: at ?? new Date(), pool });
  const ads = placements.map((p) => toRenderAd(p, c.assetBaseUrl));

  // Task 10: the layout comes from resolveTemplate() — an override in its window, else the
  // ACTIVE template, else the built-in one — judged at the build instant like the ads.
  const template = await resolveTemplate(audience, at ?? new Date(), { portal: portal ?? env.rss.portal });
  const r = renderDigest({ items, audience, runDate, cfg: c, ads, template: { html: template.html }, assetBaseUrl: c.assetBaseUrl });
  if (r.sizeWarning) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] ${audience} html is ${r.budgetBytes} bytes incl. tracking allowance (warn at ${c.htmlWarnKb} KB, limit ${c.maxHtmlKb} KB)`);
  }
  // Only the slots this email actually draws (slot 2 is not drawn on a short digest — QA L7).
  const drawn = placements.filter((p) => r.renderedSlots.includes(p.slot));
  const weight = imageWeight(placements, r.renderedSlots);
  if (weight > c.maxImageKb * 1024) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] ${audience} ad images weigh ${Math.ceil(weight / 1024)} KB (budget ${c.maxImageKb} KB per email)`);
  }
  return {
    subject: r.subject,
    preheader: r.preheader,
    html: r.html,
    text: r.text,
    placements: drawn.map((p) => ({ adId: p.ad.id, slot: p.slot, utmContent: p.utmContent })),
    templateId: template.id,
  };
};

/** What the renderer draws for a placement. */
export function toRenderAd(p: Placement, assetBase: string): RenderAd {
  const a = p.ad;
  return {
    slot: p.slot,
    adId: a.id,
    kind: a.kind,
    headline: a.headline,
    body: a.body,
    ctaText: a.ctaText,
    linkUrl: a.linkUrl,
    altText: a.altText,
    image: a.image ? { url: assetUrl(assetBase, a.image), width: a.image.width, height: a.image.height } : null,
  };
}

/**
 * Bytes of the distinct images in one email (an image used twice downloads
 * once). With `renderedSlots`, only the ads in slots the email actually draws
 * count (slot 2 is not drawn on a short digest — QA L7).
 */
export function imageWeight(placements: Placement[], renderedSlots?: readonly number[]): number {
  const seen = new Map<string, number>();
  for (const p of placements) {
    if (renderedSlots && !renderedSlots.includes(p.slot)) continue;
    if (p.ad.image) seen.set(p.ad.image.id, p.ad.image.size);
  }
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

