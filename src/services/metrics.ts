import { prisma } from '../lib/prisma';

const IST_OFFSET_MIN = 5 * 60 + 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function istDateString(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDayIST(d: Date): Date {
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60 * 1000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MIN * 60 * 1000);
}

export type GrowthPoint = { date: string; newSubscribers: number };
export type CampaignStat = {
  id: string;
  title: string;
  status: string;
  sent: number;
  clicked: number;
  failed: number;
  ctr: number | null;
  deliveryRate: number | null;
  createdAt: string;
  scheduledAt: string | null;
};

export type SubscriberSource =
  | 'soft-prompt'
  | 'recapture'
  | 'pushsubscriptionchange'
  | 'import';

export type Metrics = {
  activeSubscribers: number;
  growth: GrowthPoint[];
  funnel: { promptShown: number; promptAccepted: number; subscribed: number };
  unsubscribeRate: number | null;
  optInRate: number | null;
  deliveryRate: number | null;
  totals: { sent: number; clicked: number; expired: number; failed: number };
  subscribersBySource: Record<SubscriberSource, number>;
  campaigns: CampaignStat[];
};

const KNOWN_SOURCES: SubscriberSource[] = [
  'soft-prompt',
  'recapture',
  'pushsubscriptionchange',
  'import',
];

export async function buildMetrics(now: Date = new Date()): Promise<Metrics> {
  const today = startOfDayIST(now);
  const windowStart = new Date(today.getTime() - 29 * MS_PER_DAY);

  const [
    activeSubscribers,
    expiredSubscribers,
    recentSubs,
    eventTypeCounts,
    softPromptSubscribed,
    sentEventCount,
    clickedEventCount,
    failedEventCount,
    bySourceCounts,
    recentCampaigns,
  ] = await Promise.all([
    prisma.subscriber.count({ where: { status: 'ACTIVE' } }),
    prisma.subscriber.count({ where: { status: 'EXPIRED' } }),
    prisma.subscriber.findMany({
      where: { createdAt: { gte: windowStart } },
      select: { createdAt: true },
    }),
    prisma.event.groupBy({
      by: ['type'],
      _count: { _all: true },
      where: { type: { in: ['PROMPT_SHOWN', 'PROMPT_ACCEPTED', 'SUBSCRIBED', 'UNSUBSCRIBED'] } },
    }),
    // Funnel `subscribed` is scoped to the soft-prompt path so it lines up with
    // PROMPT_SHOWN / PROMPT_ACCEPTED. Recapture and pushsubscriptionchange
    // SUBSCRIBED events inflate the raw type count but never see the prompt.
    prisma.event.count({
      where: { type: 'SUBSCRIBED', meta: { path: ['source'], equals: 'soft-prompt' } },
    }),
    prisma.event.count({ where: { type: 'SENT' } }),
    prisma.event.count({ where: { type: 'CLICKED' } }),
    prisma.event.count({ where: { type: 'FAILED' } }),
    Promise.all(
      KNOWN_SOURCES.map((s) =>
        prisma.event.count({
          where: { type: 'SUBSCRIBED', meta: { path: ['source'], equals: s } },
        }),
      ),
    ),
    prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        scheduledAt: true,
      },
    }),
  ]);

  // 30-day growth bucketed by IST date.
  const buckets = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * MS_PER_DAY);
    buckets.set(istDateString(d), 0);
  }
  for (const s of recentSubs) {
    const key = istDateString(s.createdAt);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const growth: GrowthPoint[] = Array.from(buckets, ([date, newSubscribers]) => ({
    date,
    newSubscribers,
  }));

  const byType = new Map<string, number>();
  for (const row of eventTypeCounts) byType.set(row.type, row._count._all);
  const promptShown = byType.get('PROMPT_SHOWN') ?? 0;
  const promptAccepted = byType.get('PROMPT_ACCEPTED') ?? 0;
  const totalSubscribed = byType.get('SUBSCRIBED') ?? 0;
  const unsubscribed = byType.get('UNSUBSCRIBED') ?? 0;
  // Unsubscribe rate uses the total subscribed denominator (any user, any source,
  // can unsubscribe — the rate is a measure of churn against the whole base).
  const unsubscribeRate = totalSubscribed > 0 ? unsubscribed / totalSubscribed : null;

  // Per-campaign sent/clicked/failed. One groupBy keyed by campaignId + type.
  const campaignIds = recentCampaigns.map((c) => c.id);
  const perCampaign = await prisma.event.groupBy({
    by: ['campaignId', 'type'],
    where: {
      campaignId: { in: campaignIds },
      type: { in: ['SENT', 'CLICKED', 'FAILED'] },
    },
    _count: { _all: true },
  });
  const byCampaign = {
    SENT: new Map<string, number>(),
    CLICKED: new Map<string, number>(),
    FAILED: new Map<string, number>(),
  };
  for (const row of perCampaign) {
    if (!row.campaignId) continue;
    byCampaign[row.type as keyof typeof byCampaign]?.set(row.campaignId, row._count._all);
  }

  const campaigns: CampaignStat[] = recentCampaigns.map((c) => {
    const sent = byCampaign.SENT.get(c.id) ?? 0;
    const clicked = byCampaign.CLICKED.get(c.id) ?? 0;
    const failed = byCampaign.FAILED.get(c.id) ?? 0;
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      sent,
      clicked,
      failed,
      ctr: sent > 0 ? clicked / sent : null,
      deliveryRate: sent + failed > 0 ? sent / (sent + failed) : null,
      createdAt: c.createdAt.toISOString(),
      scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
    };
  });

  const optInRate = promptShown > 0 ? promptAccepted / promptShown : null;
  const deliveryRate =
    sentEventCount + failedEventCount > 0
      ? sentEventCount / (sentEventCount + failedEventCount)
      : null;

  const subscribersBySource = Object.fromEntries(
    KNOWN_SOURCES.map((s, i) => [s, bySourceCounts[i]]),
  ) as Record<SubscriberSource, number>;

  return {
    activeSubscribers,
    growth,
    funnel: { promptShown, promptAccepted, subscribed: softPromptSubscribed },
    unsubscribeRate,
    optInRate,
    deliveryRate,
    totals: {
      sent: sentEventCount,
      clicked: clickedEventCount,
      expired: expiredSubscribers,
      failed: failedEventCount,
    },
    subscribersBySource,
    campaigns,
  };
}

export async function listCampaigns(limit = 50): Promise<CampaignStat[]> {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, title: true, status: true, createdAt: true, scheduledAt: true },
  });
  if (campaigns.length === 0) return [];

  const ids = campaigns.map((c) => c.id);
  const events = await prisma.event.groupBy({
    by: ['campaignId', 'type'],
    where: { campaignId: { in: ids }, type: { in: ['SENT', 'CLICKED', 'FAILED'] } },
    _count: { _all: true },
  });
  const byCampaign = {
    SENT: new Map<string, number>(),
    CLICKED: new Map<string, number>(),
    FAILED: new Map<string, number>(),
  };
  for (const row of events) {
    if (!row.campaignId) continue;
    byCampaign[row.type as keyof typeof byCampaign]?.set(row.campaignId, row._count._all);
  }
  return campaigns.map((c) => {
    const sent = byCampaign.SENT.get(c.id) ?? 0;
    const clicked = byCampaign.CLICKED.get(c.id) ?? 0;
    const failed = byCampaign.FAILED.get(c.id) ?? 0;
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      sent,
      clicked,
      failed,
      ctr: sent > 0 ? clicked / sent : null,
      deliveryRate: sent + failed > 0 ? sent / (sent + failed) : null,
      createdAt: c.createdAt.toISOString(),
      scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
    };
  });
}
