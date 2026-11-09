import { env, type TelegramConfig } from '../../lib/env';
import { withSocialUtm } from '../social/utm';

/**
 * The Telegram channel, keyed by page name like the Facebook and LinkedIn pages (brief 2026-11-09-telegram-channel). Only `taxscan` is
 * configured; the code keys by page so a second channel would be its own variables plus an entry here, with no schema change
 * (`TelegramPost.page` is a plain string).
 */
export const PAGE_TAXSCAN = 'taxscan';
/** Campaign.portal → Telegram page. Nothing else is mapped. */
export const PORTAL_TO_PAGE: Readonly<Record<string, string>> = { taxscan: PAGE_TAXSCAN };

/** The tags every Telegram link carries (the shared helper SETS them, never duplicates; `medium=social` = GA4's Organic Social). */
export const TG_UTM_SOURCE = 'taxscan-telegram';
export const TG_UTM_MEDIUM = 'social';
export const TG_UTM_CAMPAIGN = 'telegram-channel';

export function withTelegramUtm(url: string, content: string): string {
  return withSocialUtm(url, { source: TG_UTM_SOURCE, medium: TG_UTM_MEDIUM, campaign: TG_UTM_CAMPAIGN, content });
}

/** The channel's token, chat id and go-live, or null while the channel is off or any of its four variables is missing or invalid. */
export function telegramConfig(page: string = PAGE_TAXSCAN): TelegramConfig | null {
  return page === PAGE_TAXSCAN && env.telegram.enabled ? env.telegram.config : null;
}

/** True when the channel is switched on AND fully configured. The one test behind the menu, the Compose list and the Channels mark. */
export const telegramActive = (): boolean => telegramConfig() !== null;

/** The link to a posted message, or null when it cannot be built: `@name` is public; a `-100…` id links for members only. */
export function messageUrlOf(channel: string, messageId: number): string | null {
  if (!Number.isInteger(messageId)) return null;
  if (channel.startsWith('@')) return `https://t.me/${channel.slice(1)}/${messageId}`;
  const m = /^-100(\d+)$/.exec(channel);
  return m ? `https://t.me/c/${m[1]}/${messageId}` : null;
}
