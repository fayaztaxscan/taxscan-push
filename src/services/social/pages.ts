import { env } from '../../lib/env';
import { portalPages } from '../linkedin/pages';
import { PORTAL_TO_PAGE, pageConfig as facebookPageConfig } from '../facebook/pages';

/**
 * The social destinations a Compose send can untick for ONE push (brief 2026-11-09-compose-skip-pages). ONE list, built from what is
 * ACTIVE at the moment it is asked for and never hard-coded anywhere else (the Compose screen only renders what
 * `GET /api/social/pages` returns), so a page switched on later (a Facebook Academy / Shopscan page, say) joins the list with no change
 * to Compose:
 *
 *   linkedin:<page>   every page of `portalPages()` (Taxscan, Academy, Shopscan; the last two only while their variables are valid),
 *                     only while LINKEDIN_POSTING_ENABLED is on;
 *   facebook:<page>   every Facebook page with a valid id and token, only while FACEBOOK_POSTING_ENABLED is on;
 *   whatsapp          the WhatsApp channel queue, only while WHATSAPP_QUEUE_ENABLED is on.
 *
 * `Campaign.socialSkip` stores the keys the sender unticked. Each worker (LinkedIn, Facebook) and the WhatsApp queue read it and treat a
 * campaign that names their key as deliberately skipped: no call, a SKIPPED row, reason `compose_skip`. Nothing else ever sets it: the
 * pacer, Push now, Breaking and the morning backfill all leave it empty and post everywhere.
 */

/** The reason a worker writes on the SKIPPED row of a push the sender unticked (and the screens' `skipReason`). */
export const COMPOSE_SKIP = 'compose_skip';
export const WHATSAPP_SKIP_KEY = 'whatsapp';
export const linkedinSkipKey = (page: string): string => `linkedin:${page}`;
export const facebookSkipKey = (page: string): string => `facebook:${page}`;

export type SocialPage = { key: string; label: string };

const capitalised = (k: string): string => k.charAt(0).toUpperCase() + k.slice(1);

/** The active destinations, in display order: LinkedIn pages (Taxscan first), Facebook pages, WhatsApp. Read at call time. */
export function activeSocialPages(): SocialPage[] {
  const out: SocialPage[] = [];
  if (env.linkedin.enabled) {
    const pages = [...new Set(Object.values(portalPages()).flat())];
    for (const p of pages) out.push({ key: linkedinSkipKey(p), label: `LinkedIn · ${capitalised(p)}` });
  }
  if (env.facebook.enabled) {
    for (const p of new Set(Object.values(PORTAL_TO_PAGE))) if (facebookPageConfig(p)) out.push({ key: facebookSkipKey(p), label: `Facebook · ${capitalised(p)}` });
  }
  if (env.whatsapp.queueEnabled) out.push({ key: WHATSAPP_SKIP_KEY, label: 'WhatsApp channel' });
  return out;
}

/** The keys in `keys` that are not an active destination right now (empty = all fine). Each name once, in the order given. */
export function unknownSocialKeys(keys: readonly string[], pages: readonly SocialPage[] = activeSocialPages()): string[] {
  const known = new Set(pages.map((p) => p.key));
  return [...new Set(keys)].filter((k) => !known.has(k));
}

/** True when the campaign's sender unticked `key` on Compose. A campaign that never had the choice (an RSS capture, a clone) is never skipped. */
export const isComposeSkipped = (c: { socialSkip?: readonly string[] | null }, key: string): boolean => !!c.socialSkip && c.socialSkip.includes(key);
