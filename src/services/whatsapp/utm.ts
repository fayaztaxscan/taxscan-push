import { withSocialUtm } from '../social/utm';

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
 * The article URL with our UTMs SET, never duplicated (the shared helper does it; WhatsApp and LinkedIn build links the
 * same way). `content` is `utm_content`: the trailing taxscan id, else the slug.
 */
export function withWhatsAppUtm(url: string, content: string): string {
  return withSocialUtm(url, { source: WA_UTM_SOURCE, medium: WA_UTM_MEDIUM, campaign: WA_UTM_CAMPAIGN, content });
}
