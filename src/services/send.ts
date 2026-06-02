import type { Campaign, Subscriber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { sendToSubscriber, type PushPayload, type SendOutcome } from '../lib/push';
import { isQuietHours, nextAllowedAt } from '../lib/quietHours';
import { filterByCap } from '../lib/cap';

export type Target = { type: 'all' } | { type: 'topics'; topics: string[] };

export type CampaignInput = {
  portal: string;
  title: string;
  body: string;
  url: string;
  icon?: string | null;
  target: Target;
  breaking?: boolean;
};

export type Sender = (sub: Subscriber, payload: PushPayload) => Promise<SendOutcome>;

export type DispatchResult = {
  campaignId: string;
  status: 'SENT' | 'SCHEDULED' | 'FAILED';
  sent: number;
  capped: number;
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
};

export type ExecuteDeps = {
  sender?: Sender;
  now?: Date;
  cap?: number;
  concurrency?: number;
};

export type ExecuteResult = {
  campaignId: string;
  sent: number;
  capped: number;
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

  const target = campaign.target as unknown as Target;

  try {
    const candidates = await resolveTargets(campaign.portal, target);
    const { kept, capped } = await filterByCap(candidates, cap, now);

    const payload: PushPayload = {
      title: campaign.title,
      body: campaign.body,
      url: campaign.url,
      icon: campaign.icon ?? undefined,
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

    return { campaignId: campaign.id, sent, capped: capped.length, expiredPruned, failed };
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

  const campaign = await prisma.campaign.create({
    data: {
      portal: input.portal,
      title: input.title,
      body: input.body,
      url: input.url,
      icon: input.icon ?? null,
      target: input.target as object,
      status: 'DRAFT',
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
      expiredPruned: 0,
      failed: 0,
      deferred: { scheduledAt: scheduledAt.toISOString() },
    };
  }

  const result = await executeCampaign(campaign, deps);
  return { ...result, status: 'SENT' };
}
