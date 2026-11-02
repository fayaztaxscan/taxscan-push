/**
 * The one way a social channel (WhatsApp, LinkedIn, later others) tags an article link. UTMs are SET, never
 * duplicated: every existing `utm_*` (the push's own, a stale copy) is dropped first; other query params and the
 * fragment survive. `medium=social` puts the visits in GA4's Organic Social channel group.
 */
export type SocialUtm = { source: string; medium: string; campaign: string; content: string };

export function withSocialUtm(url: string, utm: SocialUtm): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith('utm_')) u.searchParams.delete(k);
  u.searchParams.set('utm_source', utm.source);
  u.searchParams.set('utm_medium', utm.medium);
  u.searchParams.set('utm_campaign', utm.campaign);
  u.searchParams.set('utm_content', utm.content);
  return u.toString();
}
