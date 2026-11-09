/**
 * What every social screen shares about a page's state (brief 2026-11-09-social-page-alerts-pause): the shape of `pageStatus` that
 * `GET /api/<channel>/posts` now carries, the words for a page's name, and the one reason code a paused page leaves on a row.
 * The SPA draws what the server says: `message` is already the banner's sentence, nothing here rebuilds it.
 */

export type SocialChannel = 'linkedin' | 'facebook' | 'telegram';
export type PageStatusKind = 'ok' | 'paused' | 'stopped' | 'held' | 'failing';
export type PageStatus = {
  channel: SocialChannel;
  page: string;
  status: PageStatusKind;
  /** A fixed code (`page_paused`, `org_daily_limit`, `recent_posts_failed`, …); null when ok. Never shown. */
  reason: string | null;
  since: string | null;
  resumesAt: string | null;
  by: string | null;
  note: string | null;
  detail: string | null;
  failures: number;
  /** The banner's headline, in words; null when ok. */
  message: string | null;
};

/** The reason on a row a paused page skipped (LinkedIn, Facebook, Telegram rows and the Campaigns marks). Never shown as a code. */
export const PAGE_PAUSED = 'page_paused';
/** What a row skipped by a pause says, on every screen. */
export const PAGE_PAUSED_TEXT = 'Skipped — page paused';

/** The longest note an administrator can leave when pausing (the server refuses more with 400 `note_too_long`). */
export const PAUSE_NOTE_MAX = 200;

const CHANNEL_NAME: Record<SocialChannel, string> = { linkedin: 'LinkedIn', facebook: 'Facebook', telegram: 'Telegram' };
const capitalised = (k: string): string => k.charAt(0).toUpperCase() + k.slice(1);

/**
 * A page as an editor says it: "the Shopscan LinkedIn page", "the Taxscan Facebook page", "the Taxscan Telegram channel". Any page key
 * added later is just capitalised, so no page name needs to be known here.
 */
export function socialPageName(channel: SocialChannel, page: string): string {
  return `the ${capitalised(page)} ${CHANNEL_NAME[channel]} ${channel === 'telegram' ? 'channel' : 'page'}`;
}

/** The three kinds the banner draws. `stopped` is the existing login / policy / channel stop: those screens keep their own banner. */
export type BannerKind = 'paused' | 'held' | 'failing';
export function bannerKind(s: PageStatus | null | undefined): BannerKind | null {
  return s && s.message && (s.status === 'paused' || s.status === 'held' || s.status === 'failing') ? s.status : null;
}
