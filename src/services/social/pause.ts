import { prisma } from '../../lib/prisma';

/**
 * The per-page PAUSE switch (brief 2026-11-09-social-page-alerts-pause). An ADMIN pauses ONE automatic social page (a LinkedIn page, the
 * Facebook page, the Telegram channel) from its Social screen, with no Railway change. Stored in `DigestSetting` under
 * `social:pause:<channel>:<page>` (no new table): who, when and an optional note. Survives restarts; never touches the env go-live times.
 *
 * WHILE PAUSED the page's worker makes NO API call: every push for that page gets its row SKIPPED with the reason `page_paused` (a manual
 * immediate push included), and rows already waiting for a retry are skipped too. They are NEVER posted later (a late post of an old
 * push is worse than none: the same rule as `compose_skip` / `quota_headroom`). Resume posts from the next push; nothing is backfilled.
 */

export type SocialChannel = 'linkedin' | 'facebook' | 'telegram';
export const SOCIAL_CHANNELS: readonly SocialChannel[] = ['linkedin', 'facebook', 'telegram'];

/** The reason on a row a paused page SKIPPED. The screens turn it into words. */
export const PAGE_PAUSED = 'page_paused';
export const NOTE_MAX = 200;

export const pauseKey = (channel: SocialChannel, page: string): string => `social:pause:${channel}:${page}`;

export type PauseState = {
  /** Who paused it, as the screen shows it (the part of their email before the @). */
  by: string;
  byUserId: string | null;
  /** ISO time. */
  at: string;
  note: string | null;
};

/** The note an admin typed: whitespace collapsed, empty = none. The route refuses a note over NOTE_MAX before it gets here. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/** "anagha" for anagha@taxscan.in: a name for the banner without printing a whole address on every screen. */
export const labelOfEmail = (email: string): string => email.split('@')[0] || email;

export async function getPause(channel: SocialChannel, page: string): Promise<PauseState | null> {
  const row = await prisma.digestSetting.findUnique({ where: { key: pauseKey(channel, page) } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<PauseState>;
    if (typeof v.at !== 'string') return null;
    return { by: typeof v.by === 'string' ? v.by : 'an administrator', byUserId: typeof v.byUserId === 'string' ? v.byUserId : null, at: v.at, note: typeof v.note === 'string' ? v.note : null };
  } catch {
    return null;
  }
}

/** Pause `page`. False when it is already paused (the first pause keeps its who / when). */
export async function setPause(channel: SocialChannel, page: string, p: { byUserId: string | null; by: string; note: string | null; now: Date }): Promise<boolean> {
  if (await getPause(channel, page)) return false;
  const key = pauseKey(channel, page);
  const value = JSON.stringify({ by: p.by, byUserId: p.byUserId, at: p.now.toISOString(), note: p.note } satisfies PauseState);
  await prisma.digestSetting.upsert({ where: { key }, create: { key, value, updatedByUserId: p.byUserId }, update: { value, updatedByUserId: p.byUserId } });
  return true;
}

/** Resume `page`. False when it was not paused. */
export async function clearPause(channel: SocialChannel, page: string): Promise<boolean> {
  const r = await prisma.digestSetting.deleteMany({ where: { key: pauseKey(channel, page) } });
  return r.count > 0;
}

/** Is `page` paused right now? One indexed read: the workers ask it once per page per tick. */
export async function isPaused(channel: SocialChannel, page: string): Promise<boolean> {
  return (await getPause(channel, page)) !== null;
}
