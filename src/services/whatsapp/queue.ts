import { prisma } from '../../lib/prisma';
import { articleKey } from '../reports';
import { buildPostText, articleIdOf } from './postText';

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
export async function getQueue(portal: string, day: string): Promise<QueueResult> {
  const { start, end } = istDayBounds(day);
  const since = new Date(start.getTime() - MAX_DAYS_BACK * DAY_MS);
  const sent = await prisma.campaign.findMany({
    where: { portal, status: 'SENT', lastSentAt: { gte: since }, url: { startsWith: 'http' } },
    select: { id: true, title: true, body: true, url: true, authority: true, categories: true, lastSentAt: true },
    orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
  });
  type C = (typeof sent)[number];
  const byKey = new Map<string, { first: C; later: C | null }>();
  for (const c of sent) {
    if (!c.lastSentAt || !articleIdOf(c)) continue;
    const k = articleKey(c);
    const e = byKey.get(k);
    if (!e) byKey.set(k, { first: c, later: null });
    else e.later = c; // ascending, so the last one wins = the latest push
  }
  const inDay = [...byKey.entries()].filter(([, e]) => e.first.lastSentAt! >= start && e.first.lastSentAt! < end);
  const marks = inDay.length
    ? await prisma.whatsAppPost.findMany({
        where: { portal, articleKey: { in: inDay.map(([k]) => k) } },
        include: { actedBy: { select: { id: true, email: true } } },
      })
    : [];
  const markOf = new Map(marks.map((m) => [m.articleKey, m]));

  const rows: QueueRow[] = [];
  for (const [k, e] of inDay) {
    const text = buildPostText(e.first);
    if (!text) continue; // an off-allowlist link never gets a post
    const m = markOf.get(k);
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
  const n = (s: QueueStatus) => rows.filter((r) => r.status === s).length;
  return { date: day, rows, counts: { todo: n('TODO'), posted: n('POSTED'), skipped: n('SKIPPED'), all: rows.length } };
}

export type MarkResult = { ok: true; status: QueueStatus } | { ok: false; reason: 'not_found' };

/**
 * Marks the article behind `campaignId` Posted / Skipped, or undoes it (TODO deletes the row). Stored per ARTICLE, so
 * marking any push of it (the first or a re-push) is the same mark.
 */
export async function markArticle(portal: string, campaignId: string, status: QueueStatus, userId: string | null, now: Date): Promise<MarkResult> {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, portal, status: 'SENT' }, select: { id: true, url: true, title: true, body: true } });
  if (!c || !articleIdOf(c)) return { ok: false, reason: 'not_found' };
  const key = articleKey(c);
  if (status === 'TODO') {
    await prisma.whatsAppPost.deleteMany({ where: { portal, articleKey: key } });
    return { ok: true, status };
  }
  await prisma.whatsAppPost.upsert({
    where: { portal_articleKey: { portal, articleKey: key } },
    create: { portal, articleKey: key, campaignId: c.id, status, actedByUserId: userId, actedAt: now },
    update: { status, actedByUserId: userId, actedAt: now },
  });
  return { ok: true, status };
}
