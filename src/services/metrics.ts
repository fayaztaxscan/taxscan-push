import { prisma } from '../lib/prisma';
import { env } from '../lib/env';

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
  /** When the push actually fired (earliest SENT event); null until sent. */
  sentAt: string | null;
  scheduledAt: string | null;
  createdByUserId: string | null;
  createdBy: CampaignCreator;
  /**
   * Article pageviews from ArticleReadStat (GA, all traffic) summed over the
   * synced days, joined by taxscan.in URL path. null = no data (non-taxscan
   * URL, or the article predates read tracking) — distinct from a real 0.
   * Only set by listCampaigns (the /campaigns page); absent on the dashboard.
   */
  reads?: number | null;
  /** The subset of reads whose session GA attributes to our push UTM. */
  pushReads?: number | null;
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

// Shared select for the campaign-row shape both buildMetrics (dashboard
// "Recent campaigns") and listCampaigns (the /campaigns page) return.
const campaignSelect = {
  id: true,
  title: true,
  url: true,
  status: true,
  createdAt: true,
  scheduledAt: true,
  createdByUserId: true,
  createdBy: { select: { id: true, email: true, role: true } },
} as const;

// ---- Per-campaign stats: rolled-up + live ----
//
// The retention sweeper (src/sweepers/eventRetention.ts) folds old Event rows
// into Campaign.rolled* and deletes them. So a campaign's sent/clicked/failed
// is ALWAYS `rolled + a live count of whatever rows remain`, and sentAt is the
// earlier of the rolled first-sent and the live minimum. Recent campaigns have
// rolled = 0 and are entirely live; old ones are entirely rolled; the maths is
// the same either way. This is the single place that rule is implemented —
// both the Dashboard and the Campaigns list call it.
export type CampaignCounts = { sent: number; clicked: number; failed: number; sentAt: Date | null };

export async function campaignStats(ids: string[]): Promise<Map<string, CampaignCounts>> {
  const out = new Map<string, CampaignCounts>();
  if (ids.length === 0) return out;

  const [rolled, live] = await Promise.all([
    prisma.campaign.findMany({
      where: { id: { in: ids } },
      select: { id: true, rolledSent: true, rolledClicked: true, rolledFailed: true, rolledFirstSentAt: true },
    }),
    prisma.event.groupBy({
      by: ['campaignId', 'type'],
      where: { campaignId: { in: ids }, type: { in: ['SENT', 'CLICKED', 'FAILED'] } },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
  ]);

  for (const c of rolled) {
    out.set(c.id, { sent: c.rolledSent, clicked: c.rolledClicked, failed: c.rolledFailed, sentAt: c.rolledFirstSentAt });
  }
  for (const row of live) {
    if (!row.campaignId) continue;
    const c = out.get(row.campaignId) ?? { sent: 0, clicked: 0, failed: 0, sentAt: null };
    if (row.type === 'SENT') {
      c.sent += row._count._all;
      const liveMin = row._min.createdAt;
      if (liveMin && (!c.sentAt || liveMin < c.sentAt)) c.sentAt = liveMin;
    } else if (row.type === 'CLICKED') c.clicked += row._count._all;
    else if (row.type === 'FAILED') c.failed += row._count._all;
    out.set(row.campaignId, c);
  }
  return out;
}

// ---- Lifetime aggregates, refreshed in the background ----
//
// Two of the dashboard's numbers need EVERY row of Event: the lifetime
// sent/clicked/failed/prompt counts (a groupBy on type) and subscribers-by-
// source (a JSONB scan over SUBSCRIBED). Event is 6.4M rows and grows ~75k a
// day, Postgres has a 128 MB buffer cache, and the nightly jobs evict the
// index — so the first Dashboard load each morning read 58 MB from disk and
// took 6-7 s, while the same scan warm took 370 ms (measured 2026-09-22).
//
// These totals change slowly and are read as round numbers, so they are
// computed here on a timer and served from memory. The request path never
// waits for them once the first refresh has landed — the same invariant the
// GA and Search Console syncs follow: crons do the expensive work, requests
// read the result. Everything that must be live (active subscribers, growth,
// recent campaigns) stays on the request path; all of it is indexed and cheap.
//
// Single-instance (in-memory), like the metrics cache below. Under NODE_ENV=test
// the warmer is never started, so tests always compute inline and see fresh
// counts.
export type HeavyAggregates = {
  byType: Map<string, number>;
  bySource: Map<string, number>;
  computedAt: Date;
};

let heavyCache: HeavyAggregates | null = null;
let heavyInFlight: Promise<HeavyAggregates> | null = null;
let heavyTimer: NodeJS.Timeout | null = null;

async function computeHeavyAggregates(): Promise<HeavyAggregates> {
  const [eventTypeCounts, rollups, subscribedBySource] = await Promise.all([
    prisma.event.groupBy({ by: ['type'], _count: { _all: true } }),
    // Rows the retention sweeper has already deleted. Lifetime = these + live.
    prisma.eventRollup.findMany({ select: { type: true, count: true } }),
    // One grouped scan replaces five separate JSONB event.count queries.
    // Static SQL, no user input — not an injection surface. COUNT(*) comes
    // back as bigint, so coerce with Number() below.
    prisma.$queryRaw<Array<{ source: string | null; count: bigint }>>`
      SELECT meta->>'source' AS source, COUNT(*)::bigint AS count
      FROM "Event"
      WHERE type = 'SUBSCRIBED'
      GROUP BY meta->>'source'
    `,
  ]);
  const byType = new Map<string, number>();
  for (const row of eventTypeCounts) byType.set(row.type, row._count._all);
  for (const r of rollups) byType.set(r.type, (byType.get(r.type) ?? 0) + r.count);
  const bySource = new Map<string, number>();
  for (const row of subscribedBySource) bySource.set(row.source ?? '', Number(row.count));
  return { byType, bySource, computedAt: new Date() };
}

/** Recomputes and stores; concurrent callers share the one in-flight run. */
async function refreshHeavyAggregates(): Promise<HeavyAggregates> {
  if (heavyInFlight) return heavyInFlight;
  heavyInFlight = computeHeavyAggregates()
    .then((h) => {
      heavyCache = h;
      return h;
    })
    .finally(() => {
      heavyInFlight = null;
    });
  return heavyInFlight;
}

/**
 * The cached aggregates when the warmer has produced them; otherwise the
 * in-flight refresh if one is running; otherwise an inline computation. Only
 * the warmer writes the cache, so a process that never starts it (tests, a
 * one-off script) behaves exactly as before: fresh numbers, every call.
 */
async function getHeavyAggregates(): Promise<HeavyAggregates> {
  if (heavyCache) return heavyCache;
  if (heavyInFlight) return heavyInFlight;
  return computeHeavyAggregates();
}

function heavyRefreshMs(): number {
  const raw = process.env.METRICS_HEAVY_REFRESH_MS;
  if (raw !== undefined && raw !== '') return Number(raw);
  return 5 * 60 * 1000;
}

/**
 * Starts the background refresh: one pass immediately (so the first Dashboard
 * load after a deploy is fast, not merely the second) and then every
 * METRICS_HEAVY_REFRESH_MS (default 5 min; 0 disables and every request
 * computes inline, i.e. the pre-2026-09-22 behaviour).
 */
export function startMetricsWarmer(): void {
  const every = heavyRefreshMs();
  if (every <= 0) {
    // eslint-disable-next-line no-console
    console.log('[metrics] warmer disabled (METRICS_HEAVY_REFRESH_MS=0) — totals computed per request');
    return;
  }
  if (heavyTimer) return;
  const run = () =>
    refreshHeavyAggregates().catch((e) => {
      // Keep serving the last good numbers; a failed refresh must never take
      // the Dashboard down, and the next tick retries.
      // eslint-disable-next-line no-console
      console.error('[metrics] lifetime aggregate refresh failed (serving previous values)', e);
    });
  void run();
  heavyTimer = setInterval(run, every);
  heavyTimer.unref();
  // eslint-disable-next-line no-console
  console.log(`[metrics] warmer scheduled every ${Math.round(every / 1000)}s`);
}

/** Test hook — drops cached aggregates and stops the timer. */
export function __resetHeavyAggregates(): void {
  heavyCache = null;
  heavyInFlight = null;
  if (heavyTimer) {
    clearInterval(heavyTimer);
    heavyTimer = null;
  }
}

export async function buildMetrics(now: Date = new Date()): Promise<Metrics> {
  const today = startOfDayIST(now);
  const windowStart = new Date(today.getTime() - 29 * MS_PER_DAY);
  // "Recent campaigns" on the dashboard is sorted by PUSH time, but a query
  // ordered by CAPTURE time (createdAt) misses campaigns pushed recently yet
  // captured earlier — which is routine here: the pacer sends oldest-published
  // first, and morning backfill + manual Push-now replay older drafts, while
  // captures (~30-50/day) outpace sends (<=20/day). So alongside the newest
  // captures we also pull the most-recently-pushed campaigns and union them in
  // below. Bound the SENT scan to the last 7 days — older isn't "recent".
  const pushedSince = new Date(today.getTime() - 7 * MS_PER_DAY);

  // Wave 1: the LIVE queries, in parallel. Every one of these is bounded and
  // indexed (a status groupBy on ~10k subscribers, a 30-day window, the newest
  // 20 captures, SENT events from the last 7 days). The two whole-of-Event
  // aggregates that used to sit in this list are served from the background
  // warmer above — see the note there for the 6-second morning load that
  // moved them out.
  const [
    subscriberStatusCounts,
    recentSubs,
    heavy,
    recentlyCaptured,
    recentlyPushedGroups,
  ] = await Promise.all([
      prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.subscriber.findMany({
        where: { createdAt: { gte: windowStart } },
        select: { createdAt: true },
      }),
      getHeavyAggregates(),
      prisma.campaign.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: campaignSelect,
      }),
      // The most-recently-pushed campaigns (latest SENT event per campaign),
      // newest first. Unioned with the newest captures below so push-ordered
      // "Recent campaigns" never drops a recently-sent-but-older-captured item.
      prisma.event.groupBy({
        by: ['campaignId'],
        where: { type: 'SENT', campaignId: { not: null }, createdAt: { gte: pushedSince } },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: 'desc' } },
        take: 10,
      }),
    ]);

  // Union: newest captures (keeps not-yet-sent drafts visible) + the
  // most-recently-pushed campaigns that fell outside that capture window.
  const capturedIds = new Set(recentlyCaptured.map((c) => c.id));
  const missingPushedIds = recentlyPushedGroups
    .map((g) => g.campaignId)
    .filter((id): id is string => id !== null && !capturedIds.has(id));
  const extraPushed = missingPushedIds.length
    ? await prisma.campaign.findMany({
        where: { id: { in: missingPushedIds } },
        select: campaignSelect,
      })
    : [];
  const recentCampaigns = [...recentlyCaptured, ...extraPushed];

  const statusCount = new Map<string, number>();
  for (const row of subscriberStatusCounts) statusCount.set(row.status, row._count._all);
  const activeSubscribers = statusCount.get('ACTIVE') ?? 0;
  const expiredSubscribers = statusCount.get('EXPIRED') ?? 0;

  // Per-source SUBSCRIBED counts. Funnel `subscribed` is scoped to the
  // soft-prompt path so it lines up with PROMPT_SHOWN / PROMPT_ACCEPTED;
  // recapture / pushsubscriptionchange SUBSCRIBED events never see the prompt.
  const sourceCount = heavy.bySource;
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

  const byType = heavy.byType;
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

  // Per-campaign sent/clicked/failed — rolled-up + live, see campaignStats().
  const stats = await campaignStats(recentCampaigns.map((c) => c.id));

  const campaigns: CampaignStat[] = recentCampaigns.map((c) => {
    const { sent, clicked, failed, sentAt } = stats.get(c.id) ?? { sent: 0, clicked: 0, failed: 0, sentAt: null };
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
      sentAt: sentAt?.toISOString() ?? null,
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

const TAXSCAN_HOSTS = new Set(['taxscan.in', 'www.taxscan.in']);

/**
 * The ArticleReadStat join key for a campaign URL: the taxscan.in path with
 * any trailing slash dropped. null for non-taxscan URLs (academy/shop) — GA
 * read data only exists for the taxscan.in property.
 */
export function readsPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (!TAXSCAN_HOSTS.has(u.hostname.toLowerCase())) return null;
    return u.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/**
 * Sum ArticleReadStat (totalViews/pushViews) per taxscan URL path. GA may
 * report the path with or without a trailing slash, so both spellings are
 * queried and folded onto the normalized key.
 */
async function readsByPath(
  paths: string[],
): Promise<Map<string, { reads: number; pushReads: number }>> {
  const out = new Map<string, { reads: number; pushReads: number }>();
  if (paths.length === 0) return out;
  const rows = await prisma.articleReadStat.groupBy({
    by: ['pagePath'],
    where: {
      portal: env.rss.portal,
      pagePath: { in: [...paths, ...paths.map((p) => `${p}/`)] },
    },
    _sum: { totalViews: true, pushViews: true },
  });
  for (const r of rows) {
    const key = r.pagePath.replace(/\/+$/, '') || '/';
    const e = out.get(key) ?? { reads: 0, pushReads: 0 };
    e.reads += r._sum.totalViews ?? 0;
    e.pushReads += r._sum.pushViews ?? 0;
    out.set(key, e);
  }
  return out;
}

export async function listCampaigns(
  limit = 50,
  opts: { createdByUserId?: string } = {},
): Promise<CampaignStat[]> {
  const userFilter = opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {};
  const captured = await prisma.campaign.findMany({
    where: opts.createdByUserId ? userFilter : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: campaignSelect,
  });

  // Same capture-vs-push fix as the dashboard: a campaign pushed recently but
  // captured outside the newest-`limit` window (a long-deferred draft, or a
  // manual Push-now of an older item) would otherwise be absent from this
  // push-sortable list. Union in the most-recently-pushed campaigns (last 14
  // days). The extra fetch carries the same "mine" filter, so the scoped view
  // stays scoped. (Single-user views are usually fully covered by the window
  // already; this matters most for the unfiltered, pacer-dominated list.)
  const capturedIds = new Set(captured.map((c) => c.id));
  const pushedSince = new Date(Date.now() - 14 * MS_PER_DAY);
  const recentlyPushed = await prisma.event.groupBy({
    by: ['campaignId'],
    where: { type: 'SENT', campaignId: { not: null }, createdAt: { gte: pushedSince } },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: 50,
  });
  const missingPushedIds = recentlyPushed
    .map((g) => g.campaignId)
    .filter((id): id is string => id !== null && !capturedIds.has(id));
  const extra = missingPushedIds.length
    ? await prisma.campaign.findMany({
        where: { id: { in: missingPushedIds }, ...userFilter },
        select: campaignSelect,
      })
    : [];
  const campaigns = [...captured, ...extra];
  if (campaigns.length === 0) return [];

  const ids = campaigns.map((c) => c.id);
  const pathByCampaign = new Map<string, string | null>(
    campaigns.map((c) => [c.id, readsPath(c.url)]),
  );
  const uniquePaths = [
    ...new Set([...pathByCampaign.values()].filter((p): p is string => p !== null)),
  ];
  // Per-campaign sent/clicked/failed — rolled-up + live, see campaignStats().
  const [stats, reads] = await Promise.all([campaignStats(ids), readsByPath(uniquePaths)]);
  return campaigns.map((c) => {
    const { sent, clicked, failed, sentAt } = stats.get(c.id) ?? { sent: 0, clicked: 0, failed: 0, sentAt: null };
    const path = pathByCampaign.get(c.id);
    const r = path ? reads.get(path) : undefined;
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
      sentAt: sentAt?.toISOString() ?? null,
      scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
      createdByUserId: c.createdByUserId,
      createdBy: c.createdBy
        ? { id: c.createdBy.id, email: c.createdBy.email, role: c.createdBy.role }
        : null,
      reads: r ? r.reads : null,
      pushReads: r ? r.pushReads : null,
    };
  });
}
