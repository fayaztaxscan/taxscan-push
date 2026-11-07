import { env, parseAllPushesFrom, WHATSAPP_ALL_PUSHES_FROM_VAR } from '../../lib/env';
import { prisma } from '../../lib/prisma';
import { articleKey } from '../reports';
import { buildPostText } from './postText';
import { buildPushPostText, pushKindOf } from './pushText';
import { isPublicArticleCampaign } from '../social/publicCampaign';
import { isAllPushesCampaign, PUSH_KEY_PREFIX, pushKey } from '../social/allPushes';

/**
 * EVERY PUSH GETS A ROW (brief 2026-11-05-whatsapp-every-push). Once WHATSAPP_ALL_PUSHES_FROM is set, a push at or after that time is
 * its own row: an article, an academy course or a shop product, repeats included, on the IST day of THAT push, keyed
 * `push:<campaign id>:<send time ms>` (the same key LinkedIn and Facebook use). A push BEFORE the time follows today's rule (one row per
 * article, on the day of its first push) for good, so switching on never lists the past. Unset or invalid = today's rule for everything.
 * The tests inject the time; production reads `env.whatsapp.allPushesFrom`.
 */
export type QueueOpts = { allPushesFrom?: Date | null };
const fromOf = (o: QueueOpts): Date | null => (o.allPushesFrom !== undefined ? o.allPushesFrom : env.whatsapp.allPushesFrom);

/** The one boot line: the all-pushes rule is on (with its time) or off and why, in fixed words naming the variable, never its value. */
export function logWhatsAppAllPushes(): void {
  if (!env.whatsapp.queueEnabled) return;
  const at = env.whatsapp.allPushesFrom;
  // eslint-disable-next-line no-console
  console.log(
    at
      ? `[whatsapp] all pushes on for ${WHATSAPP_ALL_PUSHES_FROM_VAR} (from ${at.toISOString()})`
      : `[whatsapp] all pushes off: ${parseAllPushesFrom(process.env, WHATSAPP_ALL_PUSHES_FROM_VAR).off ?? `${WHATSAPP_ALL_PUSHES_FROM_VAR} is not set`} (today's rule: one row per article)`,
  );
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the list can be opened, and how far back an earlier push of the same article is looked for. */
export const MAX_DAYS_BACK = 14;

export type QueueStatus = 'TODO' | 'POSTED' | 'SKIPPED';

export type QueueRow = {
  campaignId: string;
  articleKey: string;
  pushedAt: string;
  /** "HH:MM" IST of the first push, and of the latest later push (backfill clone / manual re-push) if any. */
  pushedTime: string;
  pushedAgainAt: string | null;
  pushedAgainTime: string | null;
  headline: string;
  authority: string | null;
  category: string | null;
  status: QueueStatus;
  actedBy: { id: string; email: string } | null;
  actedAt: string | null;
  text: string;
  /** Only on a row of the all-pushes rule: what was pushed. Absent on today's article rows (their output is unchanged). */
  kind?: 'article' | 'course' | 'product' | 'page';
  /** Only on a row of the all-pushes rule: this row is ONE push (its `articleKey` is `push:<id>:<ms>`), never grouped with a repeat. */
  rule?: 'push';
};

export type QueueResult = {
  date: string;
  rows: QueueRow[];
  counts: { todo: number; posted: number; skipped: number; all: number };
};

/** "2026-11-02" for an instant, in IST. */
export function istDay(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export function istTime(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}
/** The UTC instants of 00:00 IST on `day` and of the next day. */
export function istDayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** null when `day` is fine for `now`; otherwise why not. */
export function dayProblem(day: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) {
    return 'date must be YYYY-MM-DD';
  }
  const today = istDay(now);
  if (day > today) return 'that date is in the future';
  if (istDayBounds(day).start.getTime() < istDayBounds(today).start.getTime() - MAX_DAYS_BACK * DAY_MS) return `the list goes back ${MAX_DAYS_BACK} days`;
  return null;
}

/**
 * Every taxscan.in article the push system sent whose FIRST push fell in the IST day `day`, in the order it was pushed
 * (`lastSentAt` ascending; the pacer's priority is already baked in). One row per ARTICLE: a later push of the same
 * article (the morning-backfill clone, a manual re-push) never adds a row, it only sets "pushed again". An article
 * first pushed on an earlier day stays on that day's list. Reads Campaign + WhatsAppPost only (never Event).
 */
export async function getQueue(portal: string, day: string, opts: QueueOpts = {}): Promise<QueueResult> {
  const from = fromOf(opts);
  const { start, end } = istDayBounds(day);
  const since = new Date(start.getTime() - MAX_DAYS_BACK * DAY_MS);
  const sent = await prisma.campaign.findMany({
    where: { portal, status: 'SENT', lastSentAt: { gte: since }, url: { startsWith: 'http' } },
    select: { id: true, title: true, body: true, url: true, target: true, authority: true, categories: true, lastSentAt: true },
    orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
  });
  type C = (typeof sent)[number];
  const byKey = new Map<string, { first: C; later: C | null; ids: string[] }>();
  const pushes: C[] = []; // the all-pushes rule: this day's pushes at or after the time, one row each
  for (const c of sent) {
    if (!c.lastSentAt) continue;
    if (from && c.lastSentAt >= from) {
      // THE NEW RULE. Who sent it never matters; a repeat is its own push. Only this day's pushes list here.
      if (c.lastSentAt >= start && c.lastSentAt < end && isAllPushesCampaign(c)) pushes.push(c);
      continue;
    }
    if (!isPublicArticleCampaign(c)) continue;
    const k = articleKey(c);
    const e = byKey.get(k);
    if (!e) byKey.set(k, { first: c, later: null, ids: [c.id] });
    else {
      e.later = c; // ascending, so the last one wins = the latest push
      e.ids.push(c.id);
    }
  }
  const inDay = [...byKey.entries()].filter(([, e]) => e.first.lastSentAt! >= start && e.first.lastSentAt! < end);
  const pushKeys = pushes.map((c) => pushKey({ id: c.id, lastSentAt: c.lastSentAt! }));
  const keys = [...inDay.map(([k]) => k), ...pushKeys];
  const marks = keys.length
    ? await prisma.whatsAppPost.findMany({
        where: { portal, articleKey: { in: keys } },
        include: { actedBy: { select: { id: true, email: true } } },
      })
    : [];
  const markOf = new Map(marks.map((m) => [m.articleKey, m]));
  // Follow-up care (as the LinkedIn / Facebook workers): an article any of whose pushes was marked under the all-pushes rule was HANDLED
  // there. If the time is later removed or moved on, today's rule must not list it as waiting again: such a row shows that mark.
  const groupIds = inDay.flatMap(([, e]) => e.ids);
  const viaPush = groupIds.length
    ? await prisma.whatsAppPost.findMany({
        where: { portal, articleKey: { startsWith: PUSH_KEY_PREFIX }, campaignId: { in: groupIds } },
        include: { actedBy: { select: { id: true, email: true } } },
      })
    : [];

  const rows: QueueRow[] = [];
  for (const [k, e] of inDay) {
    const text = buildPostText(e.first);
    if (!text) continue; // an off-allowlist link never gets a post
    const m = markOf.get(k) ?? latestMark(viaPush.filter((x) => e.ids.includes(x.campaignId)));
    rows.push({
      campaignId: e.first.id,
      articleKey: k,
      pushedAt: e.first.lastSentAt!.toISOString(),
      pushedTime: istTime(e.first.lastSentAt!),
      pushedAgainAt: e.later?.lastSentAt ? e.later.lastSentAt.toISOString() : null,
      pushedAgainTime: e.later?.lastSentAt ? istTime(e.later.lastSentAt) : null,
      headline: e.first.title,
      authority: e.first.authority ?? null,
      category: e.first.categories[0] ?? null,
      status: m ? m.status : 'TODO',
      actedBy: m?.actedBy ?? null,
      actedAt: m ? m.actedAt.toISOString() : null,
      text,
    });
  }
  for (const c of pushes) {
    const text = buildPushPostText(c);
    const kind = pushKindOf(c.url);
    if (!text || !kind) continue;
    const k = pushKey({ id: c.id, lastSentAt: c.lastSentAt! });
    const m = markOf.get(k);
    rows.push({
      campaignId: c.id,
      articleKey: k,
      pushedAt: c.lastSentAt!.toISOString(),
      pushedTime: istTime(c.lastSentAt!),
      pushedAgainAt: null,
      pushedAgainTime: null,
      headline: c.title,
      authority: c.authority ?? null,
      category: c.categories[0] ?? null,
      status: m ? m.status : 'TODO',
      actedBy: m?.actedBy ?? null,
      actedAt: m ? m.actedAt.toISOString() : null,
      text,
      kind,
      rule: 'push',
    });
  }
  // One list, in the order things were pushed. Only sorted when there are new-rule rows: with the switch off the order is exactly today's.
  if (pushes.length > 0) rows.sort((a, b) => (a.pushedAt === b.pushedAt ? (a.campaignId < b.campaignId ? -1 : 1) : a.pushedAt < b.pushedAt ? -1 : 1));
  const n = (s: QueueStatus) => rows.filter((r) => r.status === s).length;
  return { date: day, rows, counts: { todo: n('TODO'), posted: n('POSTED'), skipped: n('SKIPPED'), all: rows.length } };
}

/** The most recently acted mark of a list, or undefined. */
function latestMark<T extends { actedAt: Date }>(list: T[]): T | undefined {
  return list.reduce<T | undefined>((best, m) => (!best || m.actedAt > best.actedAt ? m : best), undefined);
}

export type MarkResult = { ok: true; status: QueueStatus } | { ok: false; reason: 'not_found' };

/**
 * Marks ONE row Posted / Skipped, or undoes it (TODO deletes the mark).
 *  - A push at or after WHATSAPP_ALL_PUSHES_FROM is its own row: the mark is stored under THAT push's key (`push:<id>:<ms>`), so marking
 *    a repeat never marks another push. When the caller names the row it saw (`key`), the key must be this push's current one.
 *  - Anything else follows today's rule: stored per ARTICLE, so marking any push of it (the first or a re-push) is the same mark.
 * A campaign that is eligible under neither rule (or a key that is not its push's) is `not_found`.
 */
export async function markArticle(
  portal: string,
  campaignId: string,
  status: QueueStatus,
  userId: string | null,
  now: Date,
  o: QueueOpts & { key?: string } = {},
): Promise<MarkResult> {
  const from = fromOf(o);
  const c = await prisma.campaign.findFirst({
    where: { id: campaignId, portal, status: 'SENT' },
    select: { id: true, url: true, title: true, body: true, target: true, lastSentAt: true },
  });
  if (!c) return { ok: false, reason: 'not_found' };
  let key: string;
  if (from && c.lastSentAt && c.lastSentAt >= from) {
    if (!isAllPushesCampaign(c)) return { ok: false, reason: 'not_found' };
    key = pushKey({ id: c.id, lastSentAt: c.lastSentAt });
    if (o.key !== undefined && o.key !== key) return { ok: false, reason: 'not_found' };
  } else {
    if (o.key !== undefined || !isPublicArticleCampaign(c)) return { ok: false, reason: 'not_found' };
    key = articleKey(c);
  }
  if (status === 'TODO') {
    await prisma.whatsAppPost.deleteMany({ where: { portal, articleKey: key } });
    // Today's rule shows a mark made under the all-pushes rule when the article has no mark of its own (see getQueue): undo clears those too.
    if (!key.startsWith(PUSH_KEY_PREFIX)) await clearPushMarksOfArticle(portal, key, now);
    return { ok: true, status };
  }
  await prisma.whatsAppPost.upsert({
    where: { portal_articleKey: { portal, articleKey: key } },
    create: { portal, articleKey: key, campaignId: c.id, status, actedByUserId: userId, actedAt: now },
    update: { status, actedByUserId: userId, actedAt: now },
  });
  return { ok: true, status };
}

/** Deletes the all-pushes-rule marks of the pushes of one article (undo on a row of today's rule). Recent pushes only, like the list. */
async function clearPushMarksOfArticle(portal: string, aKey: string, now: Date): Promise<void> {
  const recent = await prisma.campaign.findMany({
    where: { portal, status: 'SENT', lastSentAt: { gte: new Date(now.getTime() - 2 * MAX_DAYS_BACK * DAY_MS) }, url: { startsWith: 'http' } },
    select: { id: true, url: true },
  });
  const ids = recent.filter((r) => articleKey(r) === aKey).map((r) => r.id);
  if (ids.length) await prisma.whatsAppPost.deleteMany({ where: { portal, articleKey: { startsWith: PUSH_KEY_PREFIX }, campaignId: { in: ids } } });
}
