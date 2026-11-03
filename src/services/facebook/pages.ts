import { env } from '../../lib/env';
import { withSocialUtm } from '../social/utm';

/**
 * Facebook pages, keyed by name (brief 2026-11-03-facebook-page-posting). A later Shopscan / Academy page = its env vars + an
 * entry in PORTAL_TO_PAGE; no schema change (`FacebookPost.page` is a plain string).
 */
export const PAGE_TAXSCAN = 'taxscan';
/** Campaign.portal → Facebook page. Nothing else is mapped yet. */
export const PORTAL_TO_PAGE: Readonly<Record<string, string>> = { taxscan: PAGE_TAXSCAN };

export const FB_UTM_SOURCE = 'taxscan-facebook';
export const FB_UTM_MEDIUM = 'social';
export const fbUtmCampaign = (page: string): string => `facebook-${page}`;

/** The article URL with the Facebook UTMs (the shared helper: SET, never duplicate). */
export function withFacebookUtm(url: string, page: string, content: string): string {
  return withSocialUtm(url, { source: FB_UTM_SOURCE, medium: FB_UTM_MEDIUM, campaign: fbUtmCampaign(page), content });
}

export type PageConfig = { pageId: string; accessToken: string };
const PAGE_ID = /^\d{5,25}$/;
const TOKEN = /^[\x21-\x7e]{20,}$/; // printable, no whitespace; real page tokens are 100+ characters

/** The page id and token, or null when either is missing or malformed (the id goes into a URL path, so digits only). */
export function pageConfig(page: string): PageConfig | null {
  const c = env.facebook.pages[page];
  return c && PAGE_ID.test(c.pageId) && TOKEN.test(c.accessToken) ? { pageId: c.pageId, accessToken: c.accessToken } : null;
}

/** The link to a posted item (Graph returns `<pageid>_<postid>`). */
export const postUrlOf = (facebookPostId: string): string => `https://www.facebook.com/${encodeURIComponent(facebookPostId)}`;
