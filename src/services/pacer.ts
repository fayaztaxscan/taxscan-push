import cron from 'node-cron';
import type { Campaign } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { isQuietHours, startOfTodayIST, isBeforeIST } from '../lib/quietHours';
import { executeCampaign, type Sender } from './send';
import { authorityTier } from './classify';

/**
 * The editorial pacer (SEND_PACING_PLAN.md §4–§5). Replaces "send each article
 * immediately, drop cooled subscribers" with the iZooto-style cadence the team
 * ran by hand: ONE push per global ~45-min slot, each to its full targeted
 * audience, best-article-first, deferring (never dropping) the rest.
 *
 * Each tick releases at most one slot, and only when ALL hold:
 *   - outside quiet hours,
 *   - ≥ SEND_SPACING_MINUTES since the last push of ANY kind (auto OR manual —
 *     so a manual force send resets the clock; decision D1/§7),
 *   - today's channel-level push count < DAILY_SEND_CEILING (hard-stops the
 *     automated pacer; manual force via /api/send is NOT gated here and may
 *     exceed it — decision D1),
 *   - a pending article exists.
 *
 * Selection (decision D2/D3, §5): top QUALIFIED (today-before-older, then
 * authority tier, then oldest-published-first); if none pending, top FALLBACK (most-recent
 * ITAT/CESTAT/NCLAT/NCLT) so the channel never sits idle. REVIEW items are NOT
 * auto-sent — an editor approves them into QUALIFIED first (Stage 3).
 *
 * All queries are scoped to one portal (Phase 1 = "taxscan"); the per-subscriber
 * cap/cooldown are bypassed here (cap=Infinity, minGap=0) because the channel
 * spacing + daily ceiling ARE the volume control now.
 */

export type PacerDeps = {
  sender?: Sender;
  now?: Date;
  spacingMinutes?: number;
  dailyCeiling?: number;
  quietStart?: string;
  quietEnd?: string;
  portal?: string;
  backfillEnabled?: boolean;
  morningUntil?: string;
};

export type PacerReason = 'sent' | 'quiet_hours' | 'spacing' | 'ceiling' | 'empty' | 'error';

export type PacerResult = {
  released: 'QUALIFIED' | 'FALLBACK' | null;
  campaignId: string | null;
  reason: PacerReason;
  /** Channel-level pushes already sent today (IST), before this tick. */
  sentToday: number;
  /** True when this slot was filled by the morning backfill (§5a). */
  backfill: boolean;
};

/** IST-calendar-day key for a timestamp (newer day = larger number). */
function dayKey(d: Date): number {
  return startOfTodayIST(d).getTime();
}

/**
 * Rank two pending QUALIFIED articles for slot selection (lower sorts first):
 *   1. Newer IST calendar day first — today's news before older backlog (D3).
 *   2. Authority tier — Supreme Court → High Court → regulatory/approved (§5).
 *   3. Publish time — OLDEST first, so a cluster of same-day, same-tier articles
 *      goes out in the order it was published (decision D3, revised 2026-06-18:
 *      was newest-first; the first-published ruling should not send last).
 */
export function rankQualified(a: Campaign, b: Campaign): number {
  const dk = dayKey(b.createdAt) - dayKey(a.createdAt); // newer IST day first
  if (dk !== 0) return dk;
  const ta = authorityTier(a.authority);
  const tb = authorityTier(b.authority);
  if (ta !== tb) return ta - tb; // lower tier = higher priority
  return a.createdAt.getTime() - b.createdAt.getTime(); // oldest published first
}

/**
 * The full pending auto-queue, in the exact order the pacer will release it:
 * all QUALIFIED (ranked by `rankQualified`) ahead of all FALLBACK (most-recent
 * first — filler that only sends once nothing qualified is left, decision D2).
 * Backs the admin Queue screen and its "Push now" action.
 */
export async function pendingQueue(portal: string): Promise<Campaign[]> {
  const qualified = await prisma.campaign.findMany({
    where: { portal, status: 'DRAFT', sendQueue: 'QUALIFIED' },
  });
  qualified.sort(rankQualified);
  const fallback = await prisma.campaign.findMany({
    where: { portal, status: 'DRAFT', sendQueue: 'FALLBACK' },
    orderBy: { createdAt: 'desc' },
  });
  return [...qualified, ...fallback];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** CLICKED-event counts for the given campaign ids. */
async function clicksByCampaign(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.event.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: ids }, type: 'CLICKED' },
    _count: { _all: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) if (r.campaignId) m.set(r.campaignId, r._count._all);
  return m;
}

/**
 * Clone an already-sent campaign into a fresh DRAFT for re-sending, so the
 * original's stats stay intact. The clone keeps the original's createdAt (so it
 * is NOT mistaken for today's fresh content) but gets its own SENT events today.
 */
async function cloneForResend(c: Campaign): Promise<Campaign> {
  return prisma.campaign.create({
    data: {
      portal: c.portal,
      title: c.title,
      body: c.body,
      url: c.url,
      icon: c.icon ?? null,
      target: c.target as object,
      status: 'DRAFT',
      sendQueue: c.sendQueue,
      authority: c.authority,
      createdAt: c.createdAt,
    },
  });
}

/**
 * Morning backfill (SEND_PACING_PLAN.md §5a). Fill an otherwise-empty morning
 * slot from YESTERDAY's articles, in priority order:
 *   1) court rulings — SC → Bombay HC → other HC (re-send allowed);
 *   2) else UNSENT other-category items (regulatory/approved before tribunal);
 *   3) else other-category items by most clicks (re-send the best performers).
 * Each yesterday URL is used at most once per day (deduped against today's sends,
 * so the pacer rotates down the list). Returns a ready-to-send DRAFT — a fresh
 * clone when re-sending an already-sent item — or null when nothing is left.
 */
async function backfillSelect(portal: string, now: Date): Promise<Campaign | null> {
  const todayStart = startOfTodayIST(now);
  const yStart = new Date(todayStart.getTime() - DAY_MS);

  // Rotation: never re-send a URL that already went out today.
  const sentTodayRows = await prisma.campaign.findMany({
    where: { portal, events: { some: { type: 'SENT', createdAt: { gte: todayStart } } } },
    select: { url: true },
  });
  const sentUrlsToday = new Set(sentTodayRows.map((c) => c.url));

  const yesterday = await prisma.campaign.findMany({
    where: {
      portal,
      sendQueue: { in: ['QUALIFIED', 'FALLBACK'] },
      createdAt: { gte: yStart, lt: todayStart },
    },
  });
  const fresh = yesterday.filter((c) => !sentUrlsToday.has(c.url));
  if (fresh.length === 0) return null;

  const clicks = await clicksByCampaign(fresh.map((c) => c.id));
  const clk = (c: Campaign): number => clicks.get(c.id) ?? 0;
  const isCourt = (c: Campaign): boolean =>
    c.sendQueue === 'QUALIFIED' && authorityTier(c.authority) <= 3;

  // Tier 1 — court rulings: SC → Bombay HC → other HC, then most clicks, then recency.
  const court = fresh
    .filter(isCourt)
    .sort(
      (a, b) =>
        authorityTier(a.authority) - authorityTier(b.authority) ||
        clk(b) - clk(a) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  // Tier 2 — unsent other-category (regulatory/approved ahead of tribunal filler).
  const otherUnsent = fresh
    .filter((c) => !isCourt(c) && c.status === 'DRAFT')
    .sort(
      (a, b) =>
        (a.sendQueue === 'QUALIFIED' ? 0 : 1) - (b.sendQueue === 'QUALIFIED' ? 0 : 1) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  // Tier 3 — already-sent other-category by most clicks.
  const otherByClicks = fresh
    .filter((c) => !isCourt(c) && c.status !== 'DRAFT')
    .sort((a, b) => clk(b) - clk(a) || b.createdAt.getTime() - a.createdAt.getTime());

  const pick = court[0] ?? otherUnsent[0] ?? otherByClicks[0] ?? null;
  if (!pick) return null;
  // A never-sent pick can be dispatched directly; an already-sent one is cloned.
  return pick.status === 'DRAFT' ? pick : cloneForResend(pick);
}

/**
 * Pick the single best pending article for a slot. Today's fresh QUALIFIED wins;
 * else (when enabled, in the morning window, and today has produced no qualified
 * article yet) the morning backfill from yesterday; else the normal carryover —
 * any pending QUALIFIED (`rankQualified`) then most-recent FALLBACK filler.
 */
async function selectNext(
  portal: string,
  now: Date,
  backfill: { enabled: boolean; until: string },
): Promise<{ campaign: Campaign | null; viaBackfill: boolean }> {
  const todayStart = startOfTodayIST(now);

  // Today's fresh qualified always wins.
  const todayQ = await prisma.campaign.findMany({
    where: { portal, status: 'DRAFT', sendQueue: 'QUALIFIED', createdAt: { gte: todayStart } },
  });
  if (todayQ.length > 0) {
    todayQ.sort(rankQualified);
    return { campaign: todayQ[0], viaBackfill: false };
  }

  // Morning backfill — only while today has produced NO qualified article yet
  // (sent or pending) and we're inside the morning window. Clones keep their
  // original (yesterday) createdAt, so they don't count as "today's qualified".
  if (backfill.enabled && isBeforeIST(now, backfill.until)) {
    const todayQualified = await prisma.campaign.count({
      where: { portal, sendQueue: 'QUALIFIED', createdAt: { gte: todayStart } },
    });
    if (todayQualified === 0) {
      const pick = await backfillSelect(portal, now);
      if (pick) return { campaign: pick, viaBackfill: true };
    }
  }

  // Normal carryover: any pending qualified (older days first-drained), else filler.
  const qualified = await prisma.campaign.findMany({
    where: { portal, status: 'DRAFT', sendQueue: 'QUALIFIED' },
  });
  if (qualified.length > 0) {
    qualified.sort(rankQualified);
    return { campaign: qualified[0], viaBackfill: false };
  }
  const fb = await prisma.campaign.findFirst({
    where: { portal, status: 'DRAFT', sendQueue: 'FALLBACK' },
    orderBy: { createdAt: 'desc' },
  });
  return { campaign: fb, viaBackfill: false };
}

export async function runPacerTick(deps: PacerDeps = {}): Promise<PacerResult> {
  const now = deps.now ?? new Date();
  const spacingMs = (deps.spacingMinutes ?? env.pacer.spacingMinutes) * 60_000;
  const ceiling = deps.dailyCeiling ?? env.pacer.dailyCeiling;
  const quietStart = deps.quietStart ?? env.send.quietStart;
  const quietEnd = deps.quietEnd ?? env.send.quietEnd;
  const portal = deps.portal ?? env.rss.portal;
  const backfillEnabled = deps.backfillEnabled ?? env.backfill.enabled;
  const morningUntil = deps.morningUntil ?? env.backfill.until;
  const todayStart = startOfTodayIST(now);

  // Channel-level count of pushes sent today: distinct campaigns with a SENT
  // event since IST midnight, this portal. Manual force sends are included, so
  // they bring the automated pacer to its ceiling sooner.
  const sentTodayRows = await prisma.event.findMany({
    where: { type: 'SENT', createdAt: { gte: todayStart }, campaign: { portal } },
    select: { campaignId: true },
    distinct: ['campaignId'],
  });
  const sentToday = sentTodayRows.filter((r) => r.campaignId).length;

  if (isQuietHours(now, quietStart, quietEnd)) {
    return { released: null, campaignId: null, reason: 'quiet_hours', sentToday, backfill: false };
  }
  if (sentToday >= ceiling) {
    return { released: null, campaignId: null, reason: 'ceiling', sentToday, backfill: false };
  }

  // Spacing: time since the last push of any kind (most recent SENT event).
  const lastSent = await prisma.event.findFirst({
    where: { type: 'SENT', campaign: { portal } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (lastSent && now.getTime() - lastSent.createdAt.getTime() < spacingMs) {
    return { released: null, campaignId: null, reason: 'spacing', sentToday, backfill: false };
  }

  const { campaign, viaBackfill } = await selectNext(portal, now, {
    enabled: backfillEnabled,
    until: morningUntil,
  });
  if (!campaign) {
    return { released: null, campaignId: null, reason: 'empty', sentToday, backfill: false };
  }

  // Atomic claim: only proceed while still DRAFT, guarding against a concurrent
  // tick (or a manual send) racing on the same row.
  const claim = await prisma.campaign.updateMany({
    where: { id: campaign.id, status: 'DRAFT' },
    data: { status: 'SCHEDULED' },
  });
  if (claim.count === 0) {
    return { released: null, campaignId: null, reason: 'empty', sentToday, backfill: false };
  }

  try {
    // Full reach — the channel spacing + ceiling are the volume control, so the
    // per-subscriber cap/cooldown are bypassed here.
    await executeCampaign(campaign, { sender: deps.sender, now, cap: Infinity, minGapMinutes: 0 });
    return {
      released: campaign.sendQueue as 'QUALIFIED' | 'FALLBACK',
      campaignId: campaign.id,
      reason: 'sent',
      sentToday,
      backfill: viaBackfill,
    };
  } catch (err) {
    // executeCampaign already flips the campaign to FAILED on throw.
    // eslint-disable-next-line no-console
    console.error('[pacer] executeCampaign threw', { campaignId: campaign.id, err });
    return { released: null, campaignId: campaign.id, reason: 'error', sentToday, backfill: viaBackfill };
  }
}

let isPacing = false;

export function startPacer(): void {
  if (!env.pacer.enabled) {
    // eslint-disable-next-line no-console
    console.log('[pacer] disabled (set PACER_ENABLED=true to start)');
    return;
  }
  if (!cron.validate(env.pacer.cron)) {
    throw new Error(`Invalid PACER_CRON: ${env.pacer.cron}`);
  }
  cron.schedule(
    env.pacer.cron,
    async () => {
      if (isPacing) {
        // eslint-disable-next-line no-console
        console.log('[pacer] previous tick still running, skipping');
        return;
      }
      isPacing = true;
      try {
        const r = await runPacerTick();
        if (r.reason === 'sent') {
          // eslint-disable-next-line no-console
          console.log(
            `[pacer] released ${r.released}${r.backfill ? ' (morning backfill)' : ''} campaign=${r.campaignId} (sentToday now ${r.sentToday + 1}/${env.pacer.dailyCeiling})`,
          );
        }
      } finally {
        isPacing = false;
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(
    `[pacer] scheduled cron="${env.pacer.cron}" spacing=${env.pacer.spacingMinutes}m ceiling=${env.pacer.dailyCeiling}/day tz=${env.rss.tz}`,
  );
}
