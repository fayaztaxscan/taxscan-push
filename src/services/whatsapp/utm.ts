/**
 * UTMs for links posted to the WhatsApp channel (brief 2026-11-02-whatsapp-channel-queue). One place for the constants.
 *
 * - `medium=social` puts the visits in GA4's Organic Social channel group.
 * - `source=taxscan-whatsapp` (house pattern `taxscan-<channel>`, like `taxscan-push` / `taxscan-digest`) separates our
 *   channel from readers forwarding links in their own chats, which arrive as `whatsapp` / `l.wl.co` referrals.
 */
export const WA_UTM_SOURCE = 'taxscan-whatsapp';
export const WA_UTM_MEDIUM = 'social';
export const WA_UTM_CAMPAIGN = 'whatsapp-channel';

/**
 * The article URL with our UTMs SET, never duplicated: any existing utm_* (the push's own, a stale copy) is dropped
 * first, other query params and the fragment survive. `content` is `utm_content`: the trailing taxscan id, else the slug.
 */
export function withWhatsAppUtm(url: string, content: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith('utm_')) u.searchParams.delete(k);
  u.searchParams.set('utm_source', WA_UTM_SOURCE);
  u.searchParams.set('utm_medium', WA_UTM_MEDIUM);
  u.searchParams.set('utm_campaign', WA_UTM_CAMPAIGN);
  u.searchParams.set('utm_content', content);
  return u.toString();
}
