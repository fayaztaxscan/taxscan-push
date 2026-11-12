import { env } from '../../lib/env';
import { prisma } from '../../lib/prisma';
import { istDay, istTime } from '../whatsapp/queue';
import { portalPages } from '../linkedin/pages';
import { orgHoldOf, ORG_DAILY_LIMIT } from '../linkedin/orgHold';
import { portalPages as fbPortalPages, pageConfig as fbPageConfig } from '../facebook/pages';
import { telegramConfig, PORTAL_TO_PAGE as TG_PORTAL_TO_PAGE } from '../telegram/pages';
import { getPause, PAGE_PAUSED, type SocialChannel } from './pause';

/**
 * THE one definition of "is this social page posting?" (brief 2026-11-09-social-page-alerts-pause). The workers, the screens' banners and
 * the alert emails all read it. For every automatic page (LinkedIn taxscan / academy / shopscan, the Facebook page, the Telegram channel):
 *
 *   ok       nothing to say
 *   paused   an ADMIN paused it (`social:pause:<channel>:<page>`): nothing is posted, every push is SKIPPED `page_paused`
 *   stopped  the existing login / policy / channel stops (LinkedIn 401/403, Facebook 368 or auth, Telegram 401/403/chat not found): their
 *            own banners, alerts and Resume are untouched; this only says so
 *   held     LinkedIn's own daily limit for the page (`org_daily_limit`), until its resume time. NOT `quota_headroom`: that is expected
 *   failing  the page's last 2 finished posts are FAILED, with no POSTED after them (an "already posted" duplicate is not a failure)
 *
 * When several are true the one that explains why nothing posts wins: paused, then stopped, then held, then failing. Each status carries a
 * fixed reason code, a since-time and, when known, a resumes-at time, and `message` is the banner's sentence in words (the same words the
 * alert email uses). NOTHING provider-written is ever kept in it: a failure is reduced to a short reason code (`HTTP 422`).
 */

export type PageStatusKind = 'ok' | 'paused' | 'stopped' | 'held' | 'failing';
export type PageStatus = {
  channel: SocialChannel;
  page: string;
  status: PageStatusKind;
  /** A fixed code: `page_paused`, `login_rejected`, `policy_block`, `channel_refused`, `org_daily_limit`, `recent_posts_failed`; null when ok. */
  reason: string | null;
  /** ISO time the condition began. */
  since: string | null;
  /** ISO time it ends by itself, when that is known (held only). */
  resumesAt: string | null;
  /** paused only: who and the optional note. */
  by: string | null;
  note: string | null;
  /** failing: the short reason code of the latest failure (`HTTP 422`); stopped (Telegram): the channel's code. */
  detail: string | null;
  /** failing: how many finished posts in a row failed. */
  failures: number;
  /** The sentence for the banner and the email; null when ok. */
  message: string | null;
};

/** How many failures in a row make a page `failing`. */
export const FAILING_AT = 2;
/** How many finished posts are looked at to count the streak. */
const LOOK_AT = 10;

// The existing stop markers, by key (their own workers write them; tests pin these to the workers' own key functions).
export const linkedinAuthKey = (page: string): string => `linkedin:auth:${page}`;
export const facebookAuthKey = (page: string): string => `facebook:auth:${page}`;
export const facebookPolicyKey = (page: string): string => `facebook:policy:${page}`;
export const telegramStopKey = (page: string): string => `telegram:stop:${page}`;

const CHANNEL_NAME: Record<SocialChannel, string> = { linkedin: 'LinkedIn', facebook: 'Facebook', telegram: 'Telegram' };
export const channelName = (c: SocialChannel): string => CHANNEL_NAME[c];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** "LinkedIn · Shopscan", "Facebook · Taxscan", "Telegram · Taxscan". */
export const pageLabel = (channel: SocialChannel, page: string): string => `${CHANNEL_NAME[channel]} · ${cap(page)}`;

/** "05:30 IST" today, "05:30 IST tomorrow" the next IST day, otherwise "05:30 IST on 2026-11-26". */
export function istClock(d: Date, now: Date = new Date()): string {
  const time = `${istTime(d)} IST`;
  const days = Math.round((Date.parse(istDay(d)) - Date.parse(istDay(now))) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} on ${istDay(d)}`;
}

/**
 * A provider's error text reduced to a SHORT REASON CODE for a banner or an email: `HTTP 422`, `HTTP 400 code 100`, a Telegram fixed code,
 * `network error`, `timeout`, `outcome unknown`. Never the provider's own words (they could carry anything).
 */
export function shortReason(error: string | null | undefined): string {
  const e = String(error ?? '').trim();
  const tg = /^(telegram_\d{3}(?:_[a-z_]+)?)$/.exec(e);
  if (tg) return tg[1];
  const http = /^HTTP (\d{3})(?: code (\d{1,6}))?/.exec(e);
  if (http) return `HTTP ${http[1]}${http[2] ? ` code ${http[2]}` : ''}`;
  if (/^unknown/i.test(e)) return 'outcome unknown';
  if (/^timeout$/i.test(e)) return 'timeout';
  if (/network error/i.test(e)) return 'network error';
  return 'an error shown on the screen';
}

/** An exact repeat LinkedIn / Facebook refuses as already posted: nothing is broken, so it is neither a failure nor a success. */
const isDuplicate = (error: string | null): boolean => /already posted/i.test(error ?? '');

type Finished = { status: 'POSTED' | 'FAILED'; error: string | null; updatedAt: Date };

/** The page's last finished posts (POSTED or FAILED), newest first. SKIPPED and in-flight rows are not finished posts. */
async function finishedPosts(channel: SocialChannel, page: string): Promise<Finished[]> {
  const args = { where: { page, status: { in: ['POSTED', 'FAILED'] } }, orderBy: { updatedAt: 'desc' }, take: LOOK_AT, select: { status: true, error: true, updatedAt: true } } as const;
  const rows =
    channel === 'linkedin'
      ? await prisma.linkedInPost.findMany(args as never)
      : channel === 'facebook'
        ? await prisma.facebookPost.findMany(args as never)
        : await prisma.telegramPost.findMany(args as never);
  return rows as unknown as Finished[];
}

/** Pure: the failing streak at the top of `rows` (newest first), or null when it is shorter than FAILING_AT. */
export function failingStreak(rows: readonly Finished[]): { count: number; since: Date; latestError: string | null } | null {
  let count = 0;
  let since: Date | null = null;
  let latest: string | null = null;
  for (const r of rows) {
    if (r.status === 'FAILED' && isDuplicate(r.error)) continue; // neutral: neither a failure nor a recovery
    if (r.status === 'POSTED') break;
    count += 1;
    since = r.updatedAt;
    if (count === 1) latest = r.error;
  }
  return count >= FAILING_AT && since ? { count, since, latestError: latest } : null;
}

async function readJson<T>(key: string): Promise<T | null> {
  const row = await prisma.digestSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

type Stop = { reason: string; since: string; detail: string | null };
async function stopOf(channel: SocialChannel, page: string): Promise<Stop | null> {
  if (channel === 'linkedin') {
    const s = await readJson<{ stoppedAt?: string; status?: number | null }>(linkedinAuthKey(page));
    return s?.stoppedAt ? { reason: 'login_rejected', since: s.stoppedAt, detail: s.status ? `HTTP ${s.status}` : null } : null;
  }
  if (channel === 'facebook') {
    const policy = await readJson<{ stoppedAt?: string; status?: number | null; code?: number | null }>(facebookPolicyKey(page));
    if (policy?.stoppedAt) return { reason: 'policy_block', since: policy.stoppedAt, detail: policy.status ? `HTTP ${policy.status}${policy.code ? ` code ${policy.code}` : ''}` : null };
    const auth = await readJson<{ stoppedAt?: string; status?: number | null }>(facebookAuthKey(page));
    return auth?.stoppedAt ? { reason: 'login_rejected', since: auth.stoppedAt, detail: auth.status ? `HTTP ${auth.status}` : null } : null;
  }
  const t = await readJson<{ stoppedAt?: string; error?: string }>(telegramStopKey(page));
  return t?.stoppedAt ? { reason: 'channel_refused', since: t.stoppedAt, detail: shortReason(t.error) } : null;
}

const STOP_WORDS: Record<string, string> = {
  login_rejected: `the access token was rejected`,
  policy_block: `the platform blocked a post as spam or restricted`,
  channel_refused: `the platform refused the channel (the bot was removed, is not an admin, or its token was withdrawn)`,
};

/** The sentence for a status (pure). `now` only decides whether a time needs its date. */
export function describeStatus(s: Omit<PageStatus, 'message'>, now: Date = new Date()): string | null {
  const at = (iso: string | null): string => (iso ? istClock(new Date(iso), now) : '');
  if (s.status === 'paused') return `Paused by ${s.by ?? 'an administrator'} at ${at(s.since)}${s.note ? ` — ${s.note}` : ''}`;
  if (s.status === 'held') return `Held by LinkedIn's daily limit for this page${s.resumesAt ? ` until ${at(s.resumesAt)}` : ''}`;
  if (s.status === 'failing') return `Last ${s.failures} posts failed — ${s.detail ?? 'see the failed rows'}`;
  if (s.status === 'stopped') return `Posting stopped — ${STOP_WORDS[s.reason ?? ''] ?? 'see the banner'}`;
  return null;
}

const base = (channel: SocialChannel, page: string): Omit<PageStatus, 'message'> => ({ channel, page, status: 'ok', reason: null, since: null, resumesAt: null, by: null, note: null, detail: null, failures: 0 });

/** The status of ONE page. Read-only; the request path may call it (a few small reads). */
export async function getPageStatus(channel: SocialChannel, page: string, now: Date = new Date()): Promise<PageStatus> {
  const b = base(channel, page);
  const pause = await getPause(channel, page);
  if (pause) return { ...b, status: 'paused', reason: PAGE_PAUSED, since: pause.at, by: pause.by, note: pause.note, message: describeStatus({ ...b, status: 'paused', reason: PAGE_PAUSED, since: pause.at, by: pause.by, note: pause.note }, now) };
  const stop = await stopOf(channel, page);
  if (stop) {
    const s = { ...b, status: 'stopped' as const, reason: stop.reason, since: stop.since, detail: stop.detail };
    return { ...s, message: describeStatus(s, now) };
  }
  const hold = channel === 'linkedin' ? orgHoldOf(page, now) : null;
  if (hold) {
    const s = { ...b, status: 'held' as const, reason: ORG_DAILY_LIMIT, since: hold.since.toISOString(), resumesAt: hold.until.toISOString() };
    return { ...s, message: describeStatus(s, now) };
  }
  const streak = failingStreak(await finishedPosts(channel, page));
  if (streak) {
    const s = { ...b, status: 'failing' as const, reason: 'recent_posts_failed', since: streak.since.toISOString(), detail: shortReason(streak.latestError), failures: streak.count };
    return { ...s, message: describeStatus(s, now) };
  }
  return { ...b, message: null };
}

/** Every ACTIVE automatic page, in display order (LinkedIn pages, Facebook, Telegram). Read at call time. */
export function activePages(): { channel: SocialChannel; page: string }[] {
  const out: { channel: SocialChannel; page: string }[] = [];
  if (env.linkedin.enabled) for (const p of new Set(Object.values(portalPages()).flat())) out.push({ channel: 'linkedin', page: p });
  if (env.facebook.enabled) for (const p of new Set(Object.values(fbPortalPages()).flat())) if (fbPageConfig(p)) out.push({ channel: 'facebook', page: p });
  for (const p of new Set(Object.values(TG_PORTAL_TO_PAGE))) if (telegramConfig(p)) out.push({ channel: 'telegram', page: p });
  return out;
}

/** The status of every active page. */
export async function listPageStatuses(now: Date = new Date()): Promise<PageStatus[]> {
  return Promise.all(activePages().map((p) => getPageStatus(p.channel, p.page, now)));
}
