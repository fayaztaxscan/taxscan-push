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
export type CampaignCreator = {
  id: string;
  email: string;
  role: 'ADMIN' | 'PUBLISHER';
} | null;
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
  createdByUserId: string | null;
  createdBy: CampaignCreator;
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

  // Wave 1: five queries in parallel (was thirteen). Consolidations:
  //  - subscriber ACTIVE/EXPIRED counts → one groupBy on status.
  //  - PROMPT_*/SUBSCRIBED/UNSUBSCRIBED/SENT/CLICKED/FAILED counts → one
  //    groupBy on event type (we read the buckets we need off the result).
  //  - the soft-prompt funnel count + the four per-source counts (five JSONB
  //    event.count queries) → one grouped raw scan on meta->>'source'.
  // Fewer round-trips is the win: data volume is tiny, so per-query latency to
  // Postgres dominated the old 13-query fan-out.
  const [subscriberStatusCounts, recentSubs, eventTypeCounts, subscribedBySource, recentCampaigns] =
    await Promise.all([
      prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.subscriber.findMany({
        where: { createdAt: { gte: windowStart } },
        select: { createdAt: true },
      }),
      prisma.event.groupBy({ by: ['type'], _count: { _all: true } }),
      // One grouped scan replaces five separate JSONB event.count queries.
      // Static SQL, no user input — not an injection surface. COUNT(*) comes
      // back as bigint, so coerce with Number() below.
      prisma.$queryRaw<Array<{ source: string | null; count: bigint }>>`
        SELECT meta->>'source' AS source, COUNT(*)::bigint AS count
        FROM "Event"
        WHERE type = 'SUBSCRIBED'
        GROUP BY meta->>'source'
      `,
      prisma.campaign.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          scheduledAt: true,
          createdByUserId: true,
          createdBy: { select: { id: true, email: true, role: true } },
        },
      }),
    ]);

  const statusCount = new Map<string, number>();
  for (const row of subscriberStatusCounts) statusCount.set(row.status, row._count._all);
  const activeSubscribers = statusCount.get('ACTIVE') ?? 0;
  const expiredSubscribers = statusCount.get('EXPIRED') ?? 0;

  // Per-source SUBSCRIBED counts. Funnel `subscribed` is scoped to the
  // soft-prompt path so it lines up with PROMPT_SHOWN / PROMPT_ACCEPTED;
  // recapture / pushsubscriptionchange SUBSCRIBED events never see the prompt.
  const sourceCount = new Map<string, number>();
  for (const row of subscribedBySource) sourceCount.set(row.source ?? '', Number(row.count));
  const softPromptSubscribed = sourceCount.get('soft-prompt') ?? 0;

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
  const sentEventCount = byType.get('SENT') ?? 0;
  const clickedEventCount = byType.get('CLICKED') ?? 0;
  const failedEventCount = byType.get('FAILED') ?? 0;
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
      createdByUserId: c.createdByUserId,
      createdBy: c.createdBy
        ? { id: c.createdBy.id, email: c.createdBy.email, role: c.createdBy.role }
        : null,
    };
  });

  const optInRate = promptShown > 0 ? promptAccepted / promptShown : null;
  const deliveryRate =
    sentEventCount + failedEventCount > 0
      ? sentEventCount / (sentEventCount + failedEventCount)
      : null;

  const subscribersBySource = Object.fromEntries(
    KNOWN_SOURCES.map((s) => [s, sourceCount.get(s) ?? 0]),
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

// ---- Short-TTL cache for /api/metrics ----
//
// The dashboard polls /api/metrics on open and on every "refresh" click; the
// data does not need to be fresh to the second. A small in-process cache makes
// repeat loads instant and shields Postgres from redundant aggregation —
// important post-go-live, when the Event table (a row per SENT/CLICKED/FAILED)
// grows fast. Single-instance only (in-memory); revisit if we scale out.
//
// TTL is read per-call from METRICS_CACHE_TTL_MS (default 20s; 0 disables).
// It defaults to 0 under NODE_ENV=test so suites that assert on /api/metrics
// always see freshly-computed values.
let metricsCache: { at: number; data: Metrics } | null = null;

function defaultMetricsTtlMs(): number {
  const raw = process.env.METRICS_CACHE_TTL_MS;
  if (raw !== undefined && raw !== '') return Number(raw);
  return process.env.NODE_ENV === 'test' ? 0 : 20_000;
}

/** Test hook — clears the in-process metrics cache. */
export function __resetMetricsCache(): void {
  metricsCache = null;
}

/**
 * Cached wrapper around buildMetrics. Returns the cached payload when it is
 * younger than the TTL, otherwise recomputes and refreshes the cache. The
 * route handler uses this; call buildMetrics directly for an uncached read.
 */
export async function getMetrics(
  now: Date = new Date(),
  opts: { ttlMs?: number; builder?: (now: Date) => Promise<Metrics> } = {},
): Promise<Metrics> {
  const ttlMs = opts.ttlMs ?? defaultMetricsTtlMs();
  const build = opts.builder ?? buildMetrics;
  if (ttlMs <= 0) return build(now);

  const t = now.getTime();
  if (metricsCache && t - metricsCache.at < ttlMs) {
    return metricsCache.data;
  }
  const data = await build(now);
  metricsCache = { at: t, data };
  return data;
}

export async function listCampaigns(
  limit = 50,
  opts: { createdByUserId?: string } = {},
): Promise<CampaignStat[]> {
  const campaigns = await prisma.campaign.findMany({
    where: opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      scheduledAt: true,
      createdByUserId: true,
      createdBy: { select: { id: true, email: true, role: true } },
    },
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
      createdByUserId: c.createdByUserId,
      createdBy: c.createdBy
        ? { id: c.createdBy.id, email: c.createdBy.email, role: c.createdBy.role }
        : null,
    };
  });
}
