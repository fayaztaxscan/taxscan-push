import { env, FACEBOOK_PAGE_ID_SHAPE, FACEBOOK_TOKEN_SHAPE } from '../../lib/env';
import { withSocialUtm } from '../social/utm';

/**
 * Facebook pages, keyed by name (briefs 2026-11-03-facebook-page-posting, 2026-11-12-facebook-shopscan-page). `FacebookPost.page` is a
 * plain string: a page is its env variables plus a place in `portalPages()`; no schema change.
 *  - `taxscan` is the portal's own page (`env.facebook.pages`, one entry per page, `PORTAL_TO_PAGE`). The worker refuses to start without it.
 *  - `shopscan` is a SHARED page (`env.facebook.sharedPages`): it receives the `taxscan` portal's pushes too, with a page id, token and
 *    go-live of its own, and exists ONLY while all three of its FACEBOOK_SHOPSCAN_* variables are valid. It posts EVERY push from its go-live.
 */
export const PAGE_TAXSCAN = 'taxscan';
export const PAGE_SHOPSCAN = 'shopscan';
/** Campaign.portal → the portal's OWN Facebook page. A shared page is not in it (see `portalPages`). */
export const PORTAL_TO_PAGE: Readonly<Record<string, string>> = { taxscan: PAGE_TAXSCAN };
/** The shared pages, in the order a tick handles them after Taxscan. */
export const SHARED_PAGES = [PAGE_SHOPSCAN] as const;

const sharedActive = (page: string): boolean => Object.prototype.hasOwnProperty.call(env.facebook.sharedPages, page);
export const shopscanActive = (): boolean => sharedActive(PAGE_SHOPSCAN);
/** A shared page: optional by definition (it never stops the worker from starting; it is skipped while it has no valid config). */
export const isSharedPage = (page: string): boolean => (SHARED_PAGES as readonly string[]).includes(page) || sharedActive(page);

/**
 * Campaign.portal → the Facebook pages its pushes are posted to, Taxscan FIRST, then Shopscan (a tick handles them in that order, so a
 * busy Taxscan page only delays the other). Read at call time: a shared page appears only while it is active; with none, this is exactly
 * the old one-page-per-portal map. EVERY reader of the page list (the worker, the screen's API, Compose "Post to", the page status) uses
 * this one function, so Shopscan appears everywhere at once and nowhere while it is off.
 */
export function portalPages(): Record<string, string[]> {
  return { taxscan: [PAGE_TAXSCAN, ...SHARED_PAGES.filter(sharedActive)] };
}

/** A page's own go-live: a shared page has its own, the Taxscan page uses FACEBOOK_POST_FROM. */
export const pagePostFrom = (page: string): Date | null => env.facebook.sharedPages[page]?.postFrom ?? env.facebook.postFrom;

/**
 * The time from which `page` posts EVERY push, one post per push (brief 2026-11-04-academy-store-posts): the Taxscan page's own variable
 * (null = it stays on today's rule, one post per article); a shared page's go-live IS its all-pushes time (it has no variable of its own),
 * so everything it posts follows the new rule and nothing before its go-live is ever a candidate.
 */
export const pageAllPushesFrom = (page: string): Date | null => env.facebook.sharedPages[page]?.postFrom ?? env.facebook.allPushesFrom;

/** One time for every page (the old shape: tests and routes pass it), or one per page. */
export type TimeInput = Date | null | Readonly<Record<string, Date | null>> | undefined;
function pickTime(input: TimeInput, page: string, own: (page: string) => Date | null): Date | null {
  if (input === undefined) return own(page);
  if (input === null || typeof (input as Date).getTime === 'function') return input as Date | null;
  const v = (input as Readonly<Record<string, Date | null>>)[page];
  return v === undefined ? own(page) : v;
}
/** The go-live to use for `page`: an injected single time (every page), an injected per-page record, or the page's own configured one. */
export const resolvePostFrom = (input: TimeInput, page: string): Date | null => pickTime(input, page, pagePostFrom);
/** The all-pushes time to use for `page`: an injected single time (every page), an injected per-page record, or the page's own. */
export const resolveAllPushesFrom = (input: TimeInput, page: string): Date | null => pickTime(input, page, pageAllPushesFrom);

export const FB_UTM_SOURCE = 'taxscan-facebook';
export const FB_UTM_MEDIUM = 'social';
export const fbUtmCampaign = (page: string): string => `facebook-${page}`;

/** The article URL with the Facebook UTMs (the shared helper: SET, never duplicate). */
export function withFacebookUtm(url: string, page: string, content: string): string {
  return withSocialUtm(url, { source: FB_UTM_SOURCE, medium: FB_UTM_MEDIUM, campaign: fbUtmCampaign(page), content });
}

export type PageConfig = { pageId: string; accessToken: string };

/** The page id and token, or null when either is missing or malformed (the id goes into a URL path, so digits only). */
export function pageConfig(page: string): PageConfig | null {
  const c = env.facebook.pages[page] ?? env.facebook.sharedPages[page];
  return c && FACEBOOK_PAGE_ID_SHAPE.test(c.pageId) && FACEBOOK_TOKEN_SHAPE.test(c.accessToken) ? { pageId: c.pageId, accessToken: c.accessToken } : null;
}

/** The link to a posted item (Graph returns `<pageid>_<postid>`). */
export const postUrlOf = (facebookPostId: string): string => `https://www.facebook.com/${encodeURIComponent(facebookPostId)}`;
