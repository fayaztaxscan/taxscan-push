import { env } from '../../lib/env';
import { withSocialUtm } from '../social/utm';
import { cachedAccessToken, tokenPageOf } from './token';

/**
 * LinkedIn pages, keyed by name (briefs 2026-11-02-linkedin-page-posting, 2026-11-04-linkedin-academy-page, 2026-11-09-linkedin-shopscan-page).
 * `LinkedInPost.page` is a plain string: a page is its env variables plus a place in `portalPages()`; no schema change.
 *  - `taxscan` has its own org URN + token (`env.linkedin.pages`).
 *  - `academy` and `shopscan` post with the Taxscan page's token and their own org URN + go-live time (`env.linkedin.sharedPages`),
 *    and each exists ONLY while both of its LINKEDIN_<PAGE>_* variables are valid. Shopscan posts EVERY push from its go-live.
 */
export const PAGE_TAXSCAN = 'taxscan';
export const PAGE_ACADEMY = 'academy';
export const PAGE_SHOPSCAN = 'shopscan';
/** The pages that borrow the Taxscan token, in the order a tick handles them after Taxscan. */
export const SHARED_PAGES = [PAGE_ACADEMY, PAGE_SHOPSCAN] as const;

/** A portal → its page(s): one page name or a list. Callers (tests) may inject either shape. */
export type PortalMap = Readonly<Record<string, string | readonly string[]>>;
/** The go-live time: one time for every page (the old shape), or one per page. */
export type PostFromInput = Date | null | Readonly<Record<string, Date | null>> | undefined;

const sharedActive = (page: string): boolean => Object.prototype.hasOwnProperty.call(env.linkedin.sharedPages, page);
export const academyActive = (): boolean => sharedActive(PAGE_ACADEMY);
export const shopscanActive = (): boolean => sharedActive(PAGE_SHOPSCAN);

/**
 * Campaign.portal → the LinkedIn pages its articles are posted to, Taxscan FIRST, then Academy, then Shopscan (a tick handles them in
 * that order, so a busy Taxscan page only delays the others). Read at call time: a shared page appears only while it is active;
 * with neither, this is exactly the old map.
 */
export function portalPages(): Record<string, string[]> {
  return { taxscan: [PAGE_TAXSCAN, ...SHARED_PAGES.filter(sharedActive)] };
}

/** One list of page names per portal (no duplicates, order kept). */
export function normalizePortals(m: PortalMap): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [portal, v] of Object.entries(m)) out[portal] = [...new Set(typeof v === 'string' ? [v] : v)];
  return out;
}
/** Every page the map posts to, once each, in the order the map lists them. */
export const pagesOf = (m: Readonly<Record<string, readonly string[]>>): string[] => [...new Set(Object.values(m).flat())];
/** The portals whose articles go to `page`. */
export const portalsOfPage = (m: Readonly<Record<string, readonly string[]>>, page: string): string[] => Object.keys(m).filter((p) => m[p].includes(page));

/** A page's own go-live: a shared page (Academy) has its own, every other page uses LINKEDIN_POST_FROM. */
export const pagePostFrom = (page: string): Date | null => env.linkedin.sharedPages[page]?.postFrom ?? env.linkedin.postFrom;
/**
 * The go-live time to use for `page`: an injected single time (every page), an injected per-page record (a page missing from it
 * uses its own configured one), or, with nothing injected, the page's own configured one.
 */
export function resolvePostFrom(input: PostFromInput, page: string): Date | null {
  return pickTime(input, page, pagePostFrom);
}
function pickTime(input: PostFromInput, page: string, own: (page: string) => Date | null): Date | null {
  if (input === undefined) return own(page);
  if (input === null || typeof (input as Date).getTime === 'function') return input as Date | null;
  const v = (input as Readonly<Record<string, Date | null>>)[page];
  return v === undefined ? own(page) : v;
}

/**
 * The time from which `page` posts EVERY push, one post per push (brief 2026-11-04-academy-store-posts): the page's own variable, or
 * null = the page stays on today's rule (one post per article). A push before it follows today's rule for good; a push at or after it
 * follows the new one. Academy's counts only while the Academy page is active (both its LINKEDIN_ACADEMY_* variables valid).
 * Shopscan (brief 2026-11-09-linkedin-shopscan-page) is an every-push page from its first day: its go-live IS its all-pushes time (no
 * variable of its own), and only while it is active.
 */
export const pageAllPushesFrom = (page: string): Date | null => {
  if (page === PAGE_SHOPSCAN) return env.linkedin.sharedPages[PAGE_SHOPSCAN]?.postFrom ?? null;
  return page === PAGE_ACADEMY && !academyActive() ? null : env.linkedin.allPushesFrom[page] ?? null;
};
/** The all-pushes time to use for `page`: an injected single time (every page), an injected per-page record, or the page's own. */
export function resolveAllPushesFrom(input: PostFromInput, page: string): Date | null {
  return pickTime(input, page, pageAllPushesFrom);
}

/**
 * Today's quota threshold for `page` (the daily LinkedIn guard, see LINKEDIN_HEADROOM_VARS in env.ts): at or above that many create
 * attempts today, across ALL pages, the page holds itself. null = never held (Taxscan, and any page without a number).
 */
export const pageHeadroom = (page: string): number | null => env.linkedin.dailyHeadroom[page] ?? null;

/** The go-live variable that governs `page`, for the "missing or not a valid ISO time" startup message. */
export const postFromVarOf = (page: string): string =>
  page === PAGE_ACADEMY ? 'LINKEDIN_ACADEMY_POST_FROM' : page === PAGE_SHOPSCAN ? 'LINKEDIN_SHOPSCAN_POST_FROM' : 'LINKEDIN_POST_FROM';

export const LI_UTM_SOURCE = 'taxscan-linkedin';
export const LI_UTM_MEDIUM = 'social';
export const liUtmCampaign = (page: string): string => `linkedin-${page}`;

/** The article URL with the LinkedIn UTMs (the shared helper: SET, never duplicate). */
export function withLinkedInUtm(url: string, page: string, content: string): string {
  return withSocialUtm(url, { source: LI_UTM_SOURCE, medium: LI_UTM_MEDIUM, campaign: liUtmCampaign(page), content });
}

export type PageConfig = { orgUrn: string; accessToken: string };
/**
 * The page's org URN and the access token IN USE: the renewed (stored) one while it matches the env token, else the env token
 * (see `activeAccessToken` in token.ts; the worker resolves it at the start of each tick). A page that shares a token (Academy)
 * has its own org URN and the token of the page it shares with: the posts AND the picture uploads of each page are made under
 * that page's own org URN.
 */
export function pageConfig(page: string): PageConfig | null {
  const shared = env.linkedin.sharedPages[page];
  const owner = env.linkedin.pages[tokenPageOf(page)];
  const orgUrn = shared ? shared.orgUrn : owner?.orgUrn;
  return owner && orgUrn && owner.accessToken ? { orgUrn, accessToken: cachedAccessToken(page) ?? owner.accessToken } : null;
}
