import { env } from '../../lib/env';
import { assetUrl } from './adImages';
import { loadAdPool, pickAds, type Placement } from './ads';
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

  const r = renderDigest({ items, audience, runDate, cfg: c, ads });
  if (r.sizeWarning) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] ${audience} html is ${r.budgetBytes} bytes incl. tracking allowance (warn at ${c.htmlWarnKb} KB, limit ${c.maxHtmlKb} KB)`);
  }
  const weight = imageWeight(placements);
  if (weight > c.maxImageKb * 1024) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] ${audience} ad images weigh ${Math.ceil(weight / 1024)} KB (budget ${c.maxImageKb} KB per email)`);
  }
  return {
    subject: r.subject,
    preheader: r.preheader,
    html: r.html,
    text: r.text,
    placements: placements.filter((p) => r.renderedSlots.includes(p.slot)).map((p) => ({ adId: p.ad.id, slot: p.slot, utmContent: p.utmContent })),
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

/** Bytes of the distinct images in one email (an image used twice downloads once). */
export function imageWeight(placements: Placement[]): number {
  const seen = new Map<string, number>();
  for (const p of placements) if (p.ad.image) seen.set(p.ad.image.id, p.ad.image.size);
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

