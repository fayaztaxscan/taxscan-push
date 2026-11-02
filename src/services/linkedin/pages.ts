import { env } from '../../lib/env';
import { withSocialUtm } from '../social/utm';

/**
 * LinkedIn pages, keyed by name (brief 2026-11-02-linkedin-page-posting). Adding the Shopscan / Academy page later =
 * its env vars + an entry in PORTAL_TO_PAGE; no schema change (`LinkedInPost.page` is a plain string).
 */
export const PAGE_TAXSCAN = 'taxscan';
/** Campaign.portal → LinkedIn page. Nothing else is mapped yet. */
export const PORTAL_TO_PAGE: Readonly<Record<string, string>> = { taxscan: PAGE_TAXSCAN };

export const LI_UTM_SOURCE = 'taxscan-linkedin';
export const LI_UTM_MEDIUM = 'social';
export const liUtmCampaign = (page: string): string => `linkedin-${page}`;

/** The article URL with the LinkedIn UTMs (the shared helper: SET, never duplicate). */
export function withLinkedInUtm(url: string, page: string, content: string): string {
  return withSocialUtm(url, { source: LI_UTM_SOURCE, medium: LI_UTM_MEDIUM, campaign: liUtmCampaign(page), content });
}

export type PageConfig = { orgUrn: string; accessToken: string };
export function pageConfig(page: string): PageConfig | null {
  const c = env.linkedin.pages[page];
  return c && c.orgUrn && c.accessToken ? c : null;
}
