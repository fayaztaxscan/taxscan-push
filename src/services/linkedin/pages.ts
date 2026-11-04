import { env } from '../../lib/env';
import { withSocialUtm } from '../social/utm';
import { cachedAccessToken, tokenPageOf } from './token';

/**
 * LinkedIn pages, keyed by name (briefs 2026-11-02-linkedin-page-posting, 2026-11-04-linkedin-academy-page). `LinkedInPost.page` is a
 * plain string: a page is its env variables plus a place in `portalPages()`; no schema change.
 *  - `taxscan` has its own org URN + token (`env.linkedin.pages`).
 *  - `academy` posts the same articles with the Taxscan page's token and its own org URN + go-live time (`env.linkedin.sharedPages`),
 *    and exists ONLY while both LINKEDIN_ACADEMY_* variables are valid.
 */
export const PAGE_TAXSCAN = 'taxscan';
export const PAGE_ACADEMY = 'academy';

/** A portal → its page(s): one page name or a list. Callers (tests) may inject either shape. */
export type PortalMap = Readonly<Record<string, string | readonly string[]>>;
/** The go-live time: one time for every page (the old shape), or one per page. */
export type PostFromInput = Date | null | Readonly<Record<string, Date | null>> | undefined;

export const academyActive = (): boolean => Object.prototype.hasOwnProperty.call(env.linkedin.sharedPages, PAGE_ACADEMY);

/**
 * Campaign.portal → the LinkedIn pages its articles are posted to, Taxscan FIRST (it is handled first in a tick, so a busy Taxscan
 * page only delays Academy). Read at call time: `academy` appears only while it is active; otherwise this is exactly the old map.
 */
export function portalPages(): Record<string, string[]> {
  return { taxscan: academyActive() ? [PAGE_TAXSCAN, PAGE_ACADEMY] : [PAGE_TAXSCAN] };
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
  if (input === undefined) return pagePostFrom(page);
  if (input === null || typeof (input as Date).getTime === 'function') return input as Date | null;
  const v = (input as Readonly<Record<string, Date | null>>)[page];
  return v === undefined ? pagePostFrom(page) : v;
}

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
