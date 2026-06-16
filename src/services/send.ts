import type { Campaign, Subscriber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { sendToSubscriber, type PushPayload, type SendOutcome } from '../lib/push';
import { isQuietHours, nextAllowedAt } from '../lib/quietHours';
import { filterByCap } from '../lib/cap';
import { recordAudit } from '../lib/audit';
import { isAllowedPushUrl } from '../lib/urlAllowlist';
import type { SendQueue } from './classify';

/**
 * Thrown when a campaign's click URL points at a host outside
 * `ALLOWED_PUSH_HOSTS`. The manual `/api/send` route already rejects such URLs
 * in its zod SendSchema, but the RSS poller and the sweeper reach the dispatch
 * code without that check — this error closes those paths so the allowlist is
 * enforced on EVERY send, not just the admin one.
 */
export class DisallowedPushUrlError extends Error {
  constructor(url: string) {
    super(`push url host not allowed: ${hostOf(url)}`);
    this.name = 'DisallowedPushUrlError';
  }
}

/** Hostname for logging/audit — never echo the full URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Append UTM params to the push click URL so Google Analytics attributes the
 * click to this channel (e.g. `taxscan-push / push_notifications`). Applied only
 * to the outbound payload URL, NOT to the stored Campaign.url — the stored value
 * stays the clean article link, and the allowlist check (M1) runs on that clean
 * URL. The host is unchanged here, so a UTM-tagged URL still satisfies the
 * allowlist. Existing query params (and any UTM already present) are preserved.
 */
function appendUtm(rawUrl: string): string {
  const { source, medium } = env.analytics.utm;
  if (!source && !medium) return rawUrl; // tagging disabled
  try {
    const u = new URL(rawUrl);
    if (source && !u.searchParams.has('utm_source')) u.searchParams.set('utm_source', source);
    if (medium && !u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', medium);
    return u.toString();
  } catch {
    return rawUrl; // unparseable — leave as-is (the allowlist would have rejected it)
  }
}

// Phase 1 fallback for the notification icon + badge when a campaign
// doesn't specify its own. Points at taxscan.in's existing PWA brand
// icon (declared in its manifest.json icons array). Without this we'd
// fall through to the SW's old /icon-192.png path which 404s on
// taxscan.in and shows a generic browser icon on subscribers' devices.
// Phase 2 (academy/shop portals) should make this per-portal — either an
// env-var map keyed by portal slug, or a Portal model column.
const DEFAULT_NOTIFICATION_ICON =
  'https://www.taxscan.in/images/icons/icon-192x192.png';

export type Target = { type: 'all' } | { type: 'topics'; topics: string[] };

export type CampaignInput = {
  portal: string;
  title: string;
  body: string;
  url: string;
  icon?: string | null;
  target: Target;
  breaking?: boolean;
  /**
   * Set by the /api/send route handler when the call came from a cookie-
   * authenticated user (Phase 4+). Null when the call came via bearer
   * token (RSS poller, cron, external curl) — those calls have no
   * `req.user` to attribute to.
   */
  createdByUserId?: string | null;
  /**
   * Manual full-reach override. When true, this dispatch bypasses BOTH
   * frequency throttles — the daily volume cap (`FREQ_CAP_PER_DAY`) and the
   * per-subscriber cooldown (`MIN_GAP_MINUTES`) — so the campaign reaches every
   * eligible ACTIVE subscriber. Intended for hand-picked important articles
   * sent from the admin Compose screen; the RSS poller never sets it. Distinct
   * from `breaking` (which only bypasses quiet hours, not the cap/cooldown).
   */
  force?: boolean;
  /**
   * Editorial classification, stamped by the RSS poller (SEND_PACING_PLAN.md).
   * Persisted on the Campaign for ranking/analytics. Null for manual /api/send.
   */
  sendQueue?: SendQueue | null;
  authority?: string | null;
};

export type Sender = (sub: Subscriber, payload: PushPayload) => Promise<SendOutcome>;

export type DispatchResult = {
  campaignId: string;
  status: 'SENT' | 'SCHEDULED' | 'FAILED';
  sent: number;
  capped: number;
  /** Skipped because they were within the per-subscriber cooldown window. */
  cooled: number;
  expiredPruned: number;
  failed: number;
  deferred?: { scheduledAt: string };
};

export type DispatchDeps = {
  sender?: Sender;
  now?: Date;
  cap?: number;
  concurrency?: number;
  quietStart?: string;
  quietEnd?: string;
  minGapMinutes?: number;
};

export type ExecuteDeps = {
  sender?: Sender;
  now?: Date;
  cap?: number;
  concurrency?: number;
  minGapMinutes?: number;
};

export type ExecuteResult = {
  campaignId: string;
  sent: number;
  capped: number;
  cooled: number;
  expiredPruned: number;
  failed: number;
};

async function resolveTargets(portal: string, target: Target): Promise<Subscriber[]> {
  if (target.type === 'all') {
    return prisma.subscriber.findMany({ where: { portal, status: 'ACTIVE' } });
  }
  // Topic-targeted dispatches also reach subscribers who chose the "All news"
  // option. Folding 'all' into the hasSome filter keeps the topic-table simple
  // and avoids a second query.
  const topics = Array.from(new Set([...target.topics, 'all']));
  return prisma.subscriber.findMany({
    where: { portal, status: 'ACTIVE', topics: { hasSome: topics } },
  });
}

async function workerPool<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: lanes }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await work(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run the send loop for an existing Campaign row. Used by dispatchCampaign
 * (after the quiet-hours check passes) and by the sweeper (when a SCHEDULED
 * campaign comes due).
 */
export async function executeCampaign(
  campaign: Campaign,
  deps: ExecuteDeps = {},
): Promise<ExecuteResult> {
  const now = deps.now ?? new Date();
  const sender = deps.sender ?? sendToSubscriber;
  const cap = deps.cap ?? env.send.freqCapPerDay;
  const concurrency = deps.concurrency ?? env.send.concurrency;
  const minGapMinutes = deps.minGapMinutes ?? env.send.minGapMinutes;
  const minGapMs = Math.max(0, minGapMinutes) * 60 * 1000;

  const target = campaign.target as unknown as Target;

  try {
    // Last-line allowlist enforcement. Covers BOTH the immediate dispatch and
    // the sweeper's deferred (SCHEDULED → due) path, since both run the send
    // loop through here. dispatchCampaign rejects earlier (before persisting),
    // but a SCHEDULED campaign comes due via the sweeper without re-running it.
    if (!isAllowedPushUrl(campaign.url)) {
      throw new DisallowedPushUrlError(campaign.url);
    }
    const candidates = await resolveTargets(campaign.portal, target);
    const { kept, capped, cooled } = await filterByCap(candidates, cap, now, minGapMs);

    const icon = campaign.icon ?? DEFAULT_NOTIFICATION_ICON;
    const payload: PushPayload = {
      title: campaign.title,
      body: campaign.body,
      // UTM-tag the click URL for GA attribution; stored campaign.url stays clean.
      url: appendUtm(campaign.url),
      icon,
      // Same URL as the badge for Phase 1: rendering the brand icon
      // (Android desaturates it for the status-bar badge) is better than
      // letting the SW fall back to its 404'd /icon-192.png. Phase 2 can
      // ship a dedicated monochrome badge URL.
      badge: icon,
      campaignId: campaign.id,
    };

    // Per-item try/catch isolates failures: a sender that throws (custom or
    // web-push's synchronous validation throw on bad keys) becomes a `failed`
    // outcome for that one subscriber instead of aborting the whole batch.
    const outcomes = await workerPool(kept, concurrency, async (sub) => {
      try {
        return await sender(sub, payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          expired: false,
          failed: true,
          error: message,
        } satisfies SendOutcome;
      }
    });

    let sent = 0;
    let expiredPruned = 0;
    let failed = 0;
    for (let i = 0; i < kept.length; i++) {
      const outcome = outcomes[i];
      const sub = kept[i];
      if (outcome.ok) {
        sent++;
        await prisma.event.create({
          data: { type: 'SENT', campaignId: campaign.id, subscriberId: sub.id },
        });
      } else if (outcome.expired) {
        // 404/410: the subscription is dead. sendToSubscriber has already
        // flipped the subscriber to EXPIRED; record the FAILED event so the
        // delivery-rate metric counts it as a non-delivery.
        expiredPruned++;
        await prisma.event.create({
          data: {
            type: 'FAILED',
            campaignId: campaign.id,
            subscriberId: sub.id,
            meta: { reason: 'expired', statusCode: outcome.statusCode },
          },
        });
      } else {
        failed++;
        await prisma.event.create({
          data: {
            type: 'FAILED',
            campaignId: campaign.id,
            subscriberId: sub.id,
            meta: {
              reason: 'error',
              statusCode: outcome.statusCode ?? null,
              message: outcome.error ?? null,
            },
          },
        });
        // eslint-disable-next-line no-console
        console.warn(
          `push failed for subscriber ${sub.id}: ${outcome.statusCode} ${outcome.error}`,
        );
      }
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'SENT' },
    });

    return {
      campaignId: campaign.id,
      sent,
      capped: capped.length,
      cooled: cooled.length,
      expiredPruned,
      failed,
    };
  } catch (err) {
    await prisma.campaign
      .update({ where: { id: campaign.id }, data: { status: 'FAILED' } })
      .catch(() => undefined);
    throw err;
  }
}

export async function dispatchCampaign(
  input: CampaignInput,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const now = deps.now ?? new Date();
  const quietStart = deps.quietStart ?? env.send.quietStart;
  const quietEnd = deps.quietEnd ?? env.send.quietEnd;

  // Primary chokepoint for the RSS-poller path: item.link is trusted-but-not-
  // controlled (a poisoned/edited feed item or an open-redirect on taxscan.in
  // could point subscribers off-site). Reject BEFORE persisting a doomed
  // Campaign row. executeCampaign re-checks as defense-in-depth for the sweeper.
  if (!isAllowedPushUrl(input.url)) {
    await recordAudit({
      userId: input.createdByUserId ?? null,
      action: 'CAMPAIGN_DISPATCH_FAILED',
      resourceType: 'campaign',
      metadata: {
        portal: input.portal,
        reason: 'url_not_allowed',
        host: hostOf(input.url),
      },
    });
    throw new DisallowedPushUrlError(input.url);
  }

  const campaign = await prisma.campaign.create({
    data: {
      portal: input.portal,
      title: input.title,
      body: input.body,
      url: input.url,
      icon: input.icon ?? null,
      target: input.target as object,
      status: 'DRAFT',
      createdByUserId: input.createdByUserId ?? null,
      sendQueue: input.sendQueue ?? null,
      authority: input.authority ?? null,
    },
  });

  if (!input.breaking && isQuietHours(now, quietStart, quietEnd)) {
    const scheduledAt = nextAllowedAt(now, quietStart, quietEnd);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'SCHEDULED', scheduledAt },
    });
    return {
      campaignId: campaign.id,
      status: 'SCHEDULED',
      sent: 0,
      capped: 0,
      cooled: 0,
      expiredPruned: 0,
      failed: 0,
      deferred: { scheduledAt: scheduledAt.toISOString() },
    };
  }

  try {
    // `force` lifts both throttles for this dispatch: cap → Infinity (nobody
    // over the daily cap) and minGapMinutes → 0 (cooldown disabled), so the
    // send reaches every eligible subscriber. It overrides any cap/minGap in
    // deps — full reach means full reach. `sender`/`now`/`concurrency` are kept.
    const effectiveDeps: ExecuteDeps = input.force
      ? { ...deps, cap: Infinity, minGapMinutes: 0 }
      : deps;
    const result = await executeCampaign(campaign, effectiveDeps);
    await recordAudit({
      userId: input.createdByUserId ?? null,
      action: 'CAMPAIGN_DISPATCHED',
      resourceType: 'campaign',
      resourceId: campaign.id,
      metadata: {
        campaignId: campaign.id,
        portal: campaign.portal,
        target: input.target,
        force: input.force ?? false,
        sent: result.sent,
        capped: result.capped,
        cooled: result.cooled,
        expiredPruned: result.expiredPruned,
        failed: result.failed,
        status: 'SENT',
      },
    });
    return { ...result, status: 'SENT' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAudit({
      userId: input.createdByUserId ?? null,
      action: 'CAMPAIGN_DISPATCH_FAILED',
      resourceType: 'campaign',
      resourceId: campaign.id,
      metadata: {
        campaignId: campaign.id,
        portal: campaign.portal,
        target: input.target,
        error: message,
      },
    });
    throw err;
  }
}
