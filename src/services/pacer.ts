import cron from 'node-cron';
import type { Campaign } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { isQuietHours, startOfTodayIST } from '../lib/quietHours';
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
 * authority tier, then recency); if none pending, top FALLBACK (most-recent
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
};

export type PacerReason = 'sent' | 'quiet_hours' | 'spacing' | 'ceiling' | 'empty' | 'error';

export type PacerResult = {
  released: 'QUALIFIED' | 'FALLBACK' | null;
  campaignId: string | null;
  reason: PacerReason;
  /** Channel-level pushes already sent today (IST), before this tick. */
  sentToday: number;
};

/** IST-calendar-day key for a timestamp (newer day = larger number). */
function dayKey(d: Date): number {
  return startOfTodayIST(d).getTime();
}

/**
 * Pick the single best pending article for a slot. QUALIFIED first
 * (today-before-older → authority tier → recency), else most-recent FALLBACK.
 */
async function selectNext(portal: string): Promise<Campaign | null> {
  const qualified = await prisma.campaign.findMany({
    where: { portal, status: 'DRAFT', sendQueue: 'QUALIFIED' },
  });
  if (qualified.length > 0) {
    qualified.sort((a, b) => {
      const dk = dayKey(b.createdAt) - dayKey(a.createdAt); // newer IST day first
      if (dk !== 0) return dk;
      const ta = authorityTier(a.authority);
      const tb = authorityTier(b.authority);
      if (ta !== tb) return ta - tb; // lower tier = higher priority
      return b.createdAt.getTime() - a.createdAt.getTime(); // newer first
    });
    return qualified[0];
  }
  // Fallback filler — only reached when nothing qualified is pending.
  return prisma.campaign.findFirst({
    where: { portal, status: 'DRAFT', sendQueue: 'FALLBACK' },
    orderBy: { createdAt: 'desc' },
  });
}

export async function runPacerTick(deps: PacerDeps = {}): Promise<PacerResult> {
  const now = deps.now ?? new Date();
  const spacingMs = (deps.spacingMinutes ?? env.pacer.spacingMinutes) * 60_000;
  const ceiling = deps.dailyCeiling ?? env.pacer.dailyCeiling;
  const quietStart = deps.quietStart ?? env.send.quietStart;
  const quietEnd = deps.quietEnd ?? env.send.quietEnd;
  const portal = deps.portal ?? env.rss.portal;
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
    return { released: null, campaignId: null, reason: 'quiet_hours', sentToday };
  }
  if (sentToday >= ceiling) {
    return { released: null, campaignId: null, reason: 'ceiling', sentToday };
  }

  // Spacing: time since the last push of any kind (most recent SENT event).
  const lastSent = await prisma.event.findFirst({
    where: { type: 'SENT', campaign: { portal } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (lastSent && now.getTime() - lastSent.createdAt.getTime() < spacingMs) {
    return { released: null, campaignId: null, reason: 'spacing', sentToday };
  }

  const campaign = await selectNext(portal);
  if (!campaign) {
    return { released: null, campaignId: null, reason: 'empty', sentToday };
  }

  // Atomic claim: only proceed while still DRAFT, guarding against a concurrent
  // tick (or a manual send) racing on the same row.
  const claim = await prisma.campaign.updateMany({
    where: { id: campaign.id, status: 'DRAFT' },
    data: { status: 'SCHEDULED' },
  });
  if (claim.count === 0) {
    return { released: null, campaignId: null, reason: 'empty', sentToday };
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
    };
  } catch (err) {
    // executeCampaign already flips the campaign to FAILED on throw.
    // eslint-disable-next-line no-console
    console.error('[pacer] executeCampaign threw', { campaignId: campaign.id, err });
    return { released: null, campaignId: campaign.id, reason: 'error', sentToday };
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
            `[pacer] released ${r.released} campaign=${r.campaignId} (sentToday now ${r.sentToday + 1}/${env.pacer.dailyCeiling})`,
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
