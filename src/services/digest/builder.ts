import type { DigestAudience, Prisma, SendQueue } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { authorityTier } from '../classify';
import { articleKey, isTaxscanArticleUrl, reportCategory } from '../reports';
import { readsPath } from '../metrics';
import { isUrlDeadDefault } from '../pacer';
import { istDateOf } from './retryPolicy';
import { resolveReadsSource, type ReadsSource } from './readsSource';
import { fetchArticleImages, isAllowedArticleImage } from './articleImage';

/**
 * Digest builder: selection, ranking, freeze (docs/EMAIL_DIGEST_DESIGN.md §4.1,
 * owner-approved 2026-10-22). Reads Postgres only; never calls Google or the
 * provider. The runner calls `selectDigest` inside its build step and writes
 * the result with `writeDigestItems` in the SAME transaction that freezes the
 * run, so the items, `builtAt` and the frozen html appear together or not at all.
 *
 *  1. Window  = (previous built run's builtAt, now], capped at 72 h; first run 24 h.
 *  2. Candidates: one Campaign query — portal, window, sendQueue QUALIFIED|FALLBACK
 *     (REVIEW only once approved, which moves it to QUALIFIED), status
 *     DRAFT|SENT|EXPIRED; then taxscan.in article URLs only.
 *  3. Dedupe by articleKey(); drop RE-CAPTURES (a key first captured before the
 *     window start, looking back 90 days — the coverage reports' rule); drop
 *     keys in a SENT/PARTIALLY_SENT digest for that audience in the last 90 days.
 *  4. rankDigest: queue → authorityTier() → organic read rate → newest.
 *  5. Roll-forward ("In case you missed it", ≤ 3, inside the 12 cap).
 *  6. Link check (fail-open; only 404/410 drop).
 *  7. Guards: < 5 MAIN → too_little_news; > 150 candidates → sanity hold.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const WINDOW_CAP_HOURS = 72;
export const FIRST_WINDOW_HOURS = 24;
export const SENT_LOOKBACK_DAYS = 90;
/**
 * How far back a capture marks an article as already seen (same 90 days as the
 * coverage reports' RECAPTURE_LOOKBACK_DAYS): a re-GUID or re-capture of an
 * older article is not news, and would otherwise be credited with its lifetime
 * reads over a few in-window hours.
 */
export const RECAPTURE_LOOKBACK_DAYS = 90;
/** Younger than this at build time = too fresh to judge by reads. */
export const READ_RATE_MIN_AGE_HOURS = 2;
/**
 * An article with NO read rows at all (any path) younger than this is UNRATED,
 * not unread: GA4's processing lag plus the ~2 h gaReads sync mean a story a few
 * hours old often has no rows yet although people read it. Older than this,
 * no rows = genuinely unread as far as GA can tell → 0 reads.
 */
export const NO_READ_DATA_GRACE_HOURS = 8;
const EXCERPT_MAX = 280;
const AUDIENCES: DigestAudience[] = ['FREE', 'PREMIUM'];

export type DigestSection = 'MAIN' | 'ICYMI';

/** One frozen story as stored in DigestItem and handed to the renderer. */
export type FrozenItem = {
  rank: number;
  section: DigestSection;
  articleKey: string;
  campaignId: string | null;
  title: string;
  url: string;
  authority: string | null;
  category: string;
  excerpt: string | null;
  capturedAt: Date;
  readRate: number | null;
  /** The story's picture (og:image read at the build; documents.taxscan.in only). null/absent = text-only. */
  imageUrl?: string | null;
};

/** A DigestItem row to write: `audience` null = identical in both variants. */
export type DigestItemRow = FrozenItem & { audience: DigestAudience | null };

export type DigestSelection = {
  windowStart: Date;
  windowEnd: Date;
  /**
   * Distinct article keys captured in the window, BEFORE the re-capture and
   * 90-day exclusions: the sanity-guard figure, so a re-platform storm of
   * re-captures still holds the run for an editor.
   */
  candidateCount: number;
  outcome: 'ok' | 'too_little_news' | 'sanity_hold';
  perAudience: Record<DigestAudience, FrozenItem[]>;
  mainCounts: Record<DigestAudience, number>;
  rows: DigestItemRow[];
  reads: { used: boolean; source: string; note: string | null };
  droppedDead: number;
};

export type SelectDeps = {
  cfg?: DigestEnv;
  linkCheck?: boolean;
  isUrlDead?: (url: string) => Promise<boolean>;
  readsSource?: ReadsSource;
  /** The picture step (design: brief 2026-10-29-digest-lookalike). Default: the real, fail-open og:image fetch. */
  articleImages?: (articleUrls: string[]) => Promise<Map<string, string | null>>;
};

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

/** `(start, now]`: previous builtAt capped at 72 h; first-ever run = the last 24 h. */
export function digestWindow(prevBuiltAt: Date | null, now: Date): { start: Date; end: Date } {
  const end = now;
  if (!prevBuiltAt) return { start: new Date(now.getTime() - FIRST_WINDOW_HOURS * HOUR), end };
  const cap = new Date(now.getTime() - WINDOW_CAP_HOURS * HOUR);
  let start = prevBuiltAt.getTime() < cap.getTime() ? cap : prevBuiltAt;
  if (start.getTime() > end.getTime()) start = end; // clock skew: empty window, never a negative one
  return { start, end };
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

export type RankInput = {
  id: string;
  sendQueue: SendQueue;
  authority: string | null;
  createdAt: Date;
  /** Organic reads (null = reads not used for this build). */
  organicReads: number | null;
  /** True when the reads source had no rows at all for the article (see NO_READ_DATA_GRACE_HOURS). */
  noReadData?: boolean;
};

export type Ranked<T> = T & {
  /** The rate stored on DigestItem: null when too fresh, or reads not used. */
  readRate: number | null;
  /** The value actually sorted on inside the tier (a fresh item gets its group's median). */
  sortRate: number | null;
};

const queueOrder = (q: SendQueue): number => (q === 'QUALIFIED' ? 0 : 1);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The digest order. Do NOT reuse the pacer's `rankQualified`: its first key
 * (today before yesterday) is a pacing rule and would push yesterday evening's
 * Supreme Court ruling below a 06:00 regulatory note.
 *
 *  1. QUALIFIED before FALLBACK.
 *  2. `authorityTier()` ascending (the single definition in classify.ts).
 *     Reads can never move an item across a queue or a tier.
 *  3. Within one queue+tier, organic reads per hour since capture, descending.
 *     An item younger than 2 h has no rate ("too fresh to judge"), nor does
 *     one with no read rows yet that is younger than 8 h (GA lag); both sort
 *     as if they had the MEDIAN rate of their group's rated items — neither
 *     buried nor boosted. No rows at ≥ 8 h = 0 reads. A group with no rated
 *     item falls through to step 4.
 *  4. Newest capture first (also every tie, and the whole within-tier order
 *     when reads are not used); id as the last, deterministic key.
 *
 * SEAM: an engagement signal (e.g. digest click rate) would be one more
 * within-tier key here, between 3 and 4 — never above step 2.
 */
export function rankDigest<T extends RankInput>(items: T[], now: Date): Ranked<T>[] {
  const groupKey = (x: T) => `${queueOrder(x.sendQueue)}:${authorityTier(x.authority)}`;
  const withRate = items.map((x) => {
    const ageH = (now.getTime() - x.createdAt.getTime()) / HOUR;
    const unrated =
      x.organicReads === null || ageH < READ_RATE_MIN_AGE_HOURS || (x.noReadData === true && ageH < NO_READ_DATA_GRACE_HOURS);
    const readRate = unrated ? null : Math.max(0, x.organicReads ?? 0) / ageH;
    return { ...x, readRate, sortRate: readRate };
  });
  const medians = new Map<string, number>();
  const rated = new Map<string, number[]>();
  for (const x of withRate) {
    if (x.readRate === null) continue;
    const k = groupKey(x);
    rated.set(k, [...(rated.get(k) ?? []), x.readRate]);
  }
  for (const [k, rates] of rated) medians.set(k, median(rates));
  for (const x of withRate) {
    if (x.organicReads !== null && x.readRate === null) x.sortRate = medians.get(groupKey(x)) ?? null;
  }
  return withRate.sort(
    (a, b) =>
      queueOrder(a.sendQueue) - queueOrder(b.sendQueue) ||
      authorityTier(a.authority) - authorityTier(b.authority) ||
      (b.sortRate ?? 0) - (a.sortRate ?? 0) ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/** Columns the candidate query reads (kept narrow: no `target`, no body beyond the excerpt). */
const CANDIDATE_SELECT = {
  id: true,
  title: true,
  body: true,
  url: true,
  authority: true,
  categories: true,
  sendQueue: true,
  createdAt: true,
} satisfies Prisma.CampaignSelect;

/**
 * The ONE candidate query per build. Exported so its SQL can be EXPLAINed
 * (docs/EMAIL_DIGEST_DESIGN.md §3 "Query cost").
 */
export function candidateQuery(portal: string, start: Date, end: Date) {
  return prisma.campaign.findMany({
    where: {
      portal,
      createdAt: { gt: start, lte: end },
      sendQueue: { in: ['QUALIFIED', 'FALLBACK'] },
      status: { in: ['DRAFT', 'SENT', 'EXPIRED'] },
    },
    select: CANDIDATE_SELECT,
  });
}

type CandidateRow = Prisma.CampaignGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/**
 * The second (and last) Campaign query per build: every capture of the portal
 * in (start − 90 d, end], any queue or status, three narrow columns. Gives
 * each articleKey its FIRST capture time (re-capture test, read-rate age) and
 * all its paths. Same plan shape as the candidate query (portal + createdAt
 * range; prod Campaign is ~4.4k rows, so a seq scan of a few ms).
 */
export function captureHistoryQuery(portal: string, start: Date, end: Date) {
  return prisma.campaign.findMany({
    where: { portal, createdAt: { gt: new Date(start.getTime() - RECAPTURE_LOOKBACK_DAYS * DAY), lte: end } },
    select: { id: true, url: true, createdAt: true },
  });
}

type KeyHistory = { firstSeen: Date; paths: Set<string> };

function historyByKey(rows: { id: string; url: string; createdAt: Date }[]): Map<string, KeyHistory> {
  const out = new Map<string, KeyHistory>();
  for (const r of rows) {
    const key = articleKey(r);
    const path = readsPath(r.url);
    const h = out.get(key);
    if (!h) out.set(key, { firstSeen: r.createdAt, paths: new Set(path ? [path] : []) });
    else {
      if (r.createdAt.getTime() < h.firstSeen.getTime()) h.firstSeen = r.createdAt;
      if (path) h.paths.add(path);
    }
  }
  return out;
}

type Group = RankInput & {
  key: string;
  row: CandidateRow;
  paths: string[];
};

/**
 * Collapse rows sharing an articleKey (backfill clones, re-GUID re-captures)
 * into one: best queue, then best tier, then the EARLIEST capture (the
 * original), whose title/url/excerpt are shown. All rows' paths are kept so
 * reads recorded under an older URL still count.
 */
function dedupe(rows: CandidateRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (!isTaxscanArticleUrl(row.url)) continue;
    const key = articleKey(row);
    const path = readsPath(row.url);
    const existing = groups.get(key);
    // < 0 = this row represents the article better than the one kept so far.
    const cmp = existing
      ? queueOrder(row.sendQueue as SendQueue) - queueOrder(existing.sendQueue) ||
        authorityTier(row.authority) - authorityTier(existing.authority) ||
        row.createdAt.getTime() - existing.createdAt.getTime()
      : -1;
    const paths = [...(existing?.paths ?? []), ...(path ? [path] : [])];
    if (!existing || cmp < 0) {
      groups.set(key, {
        key,
        row,
        paths,
        id: row.id,
        sendQueue: row.sendQueue as SendQueue,
        authority: row.authority,
        createdAt: row.createdAt,
        organicReads: null,
      });
    } else {
      existing.paths = paths;
    }
  }
  return [...groups.values()];
}

function excerptOf(body: string): string | null {
  const t = body.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : t;
}

/**
 * Keys already in a SENT or PARTIALLY_SENT digest, per audience, within 90
 * days — with the run they were sent in, so roll-forward can ignore its own
 * source run (a partial send's unreached readers get its ICYMI).
 */
async function sentKeys(portal: string, runId: string, now: Date): Promise<Record<DigestAudience, Map<string, Set<string>>>> {
  const since = new Date(istDateOf(now).getTime() - SENT_LOOKBACK_DAYS * DAY);
  const items = await prisma.digestItem.findMany({
    where: {
      run: { portal, id: { not: runId }, runDate: { gte: since }, sends: { some: { state: { in: ['SENT', 'PARTIALLY_SENT'] } } } },
    },
    select: {
      articleKey: true,
      audience: true,
      runId: true,
      run: { select: { sends: { where: { state: { in: ['SENT', 'PARTIALLY_SENT'] } }, select: { audience: true } } } },
    },
  });
  const out: Record<DigestAudience, Map<string, Set<string>>> = { FREE: new Map(), PREMIUM: new Map() };
  for (const it of items) {
    for (const s of it.run.sends) {
      if (it.audience !== null && it.audience !== s.audience) continue;
      const m = out[s.audience];
      m.set(it.articleKey, (m.get(it.articleKey) ?? new Set()).add(it.runId));
    }
  }
  return out;
}

/** Previous run's state per audience: does it roll forward to this one? */
function rollsForward(prev: { build: string; sends: { audience: DigestAudience; state: string }[] }, a: DigestAudience): boolean {
  if (prev.build === 'SKIPPED') return true;
  const s = prev.sends.find((x) => x.audience === a);
  return !!s && (s.state === 'PARTIALLY_SENT' || s.state === 'FAILED' || s.state === 'SKIPPED');
}

/** Checks URLs at most once each, fail-open: only an explicit dead answer drops. */
function makeLiveCheck(enabled: boolean, isDead: (u: string) => Promise<boolean>) {
  const cache = new Map<string, Promise<boolean>>();
  return (url: string): Promise<boolean> => {
    if (!enabled) return Promise.resolve(true);
    let p = cache.get(url);
    if (!p) {
      p = isDead(url).then(
        (dead) => !dead,
        () => true,
      );
      cache.set(url, p);
    }
    return p;
  };
}

/** The first `n` live entries of `list`, in order, checking only as many as needed (batched). */
async function takeLive<T extends { url: string }>(list: T[], n: number, isLive: (u: string) => Promise<boolean>, dead: Set<string>): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  while (out.length < n && i < list.length) {
    const batch = list.slice(i, i + (n - out.length));
    i += batch.length;
    const live = await Promise.all(batch.map((x) => isLive(x.url)));
    batch.forEach((x, j) => {
      if (live[j]) out.push(x);
      else dead.add(x.url);
    });
  }
  return out;
}

/**
 * Selects and ranks one run's items. Pure with respect to the run: it reads,
 * never writes — the runner freezes the result.
 */
export async function selectDigest(
  run: { id: string; portal: string; runDate: Date },
  now: Date,
  deps: SelectDeps = {},
): Promise<DigestSelection> {
  const cfg = deps.cfg ?? env.digest;
  const isLive = makeLiveCheck(
    deps.linkCheck ?? env.linkCheck.enabled,
    deps.isUrlDead ?? ((u: string) => isUrlDeadDefault(u, env.linkCheck.timeoutMs)),
  );

  // 1. Window, from the latest earlier run that froze (whatever it ended as).
  const prevBuilt = await prisma.digestRun.findFirst({
    where: { portal: run.portal, runDate: { lt: run.runDate }, builtAt: { not: null } },
    orderBy: { runDate: 'desc' },
    select: { builtAt: true },
  });
  const { start, end } = digestWindow(prevBuilt?.builtAt ?? null, now);

  // 2–3. One candidate query, then article-URL filter + articleKey dedupe.
  const deduped = dedupe(await candidateQuery(run.portal, start, end));
  // Re-captures: first captured at/before the window start → not new, not MAIN.
  // Kept items are dated (rank + read-rate age) from their FIRST capture.
  const history = historyByKey(await captureHistoryQuery(run.portal, start, end));
  const groups: Group[] = [];
  for (const g of deduped) {
    const h = history.get(g.key);
    if (h && h.firstSeen.getTime() <= start.getTime()) continue;
    if (h) {
      if (h.firstSeen.getTime() < g.createdAt.getTime()) g.createdAt = h.firstSeen;
      g.paths = [...new Set([...g.paths, ...h.paths])];
    }
    groups.push(g);
  }
  const sent = await sentKeys(run.portal, run.id, now);

  // 4. Reads (Postgres only), then rank.
  const source = deps.readsSource ?? resolveReadsSource();
  const reads = await source.organicReads(
    groups.map((g) => ({ key: g.key, paths: g.paths, capturedAt: g.createdAt })),
    now,
  );
  if (reads.fresh) {
    for (const g of groups) {
      const r = reads.byKey.get(g.key);
      g.organicReads = r ?? 0;
      g.noReadData = r === undefined;
    }
  }
  const ranked = rankDigest(groups, now);

  // 5. Roll-forward source: the immediately previous run, if recent and it fell short.
  const prev = await prisma.digestRun.findFirst({
    where: { portal: run.portal, runDate: { lt: run.runDate } },
    orderBy: { runDate: 'desc' },
    select: {
      id: true,
      build: true,
      builtAt: true,
      sends: { select: { audience: true, state: true } },
      items: { orderBy: [{ section: 'desc' }, { rank: 'asc' }] }, // MAIN before ICYMI
    },
  });
  const prevRecent = !!prev?.builtAt && now.getTime() - prev.builtAt.getTime() <= WINDOW_CAP_HOURS * HOUR;

  const dead = new Set<string>();
  const perAudience = {} as Record<DigestAudience, FrozenItem[]>;
  const mainCounts = {} as Record<DigestAudience, number>;
  for (const a of AUDIENCES) {
    const sentA = sent[a];
    const eligible = ranked.filter((g) => !sentA.has(g.key));
    const todayKeys = new Set(eligible.map((g) => g.key));

    let icymi: FrozenItem[] = [];
    if (prev && prevRecent && rollsForward(prev, a)) {
      const seen = new Set<string>();
      const pool = prev.items.filter((it) => {
        if (it.audience !== null && it.audience !== a) return false;
        if (seen.has(it.articleKey) || todayKeys.has(it.articleKey)) return false;
        const sentIn = sentA.get(it.articleKey);
        if (sentIn && [...sentIn].some((r) => r !== prev.id)) return false;
        seen.add(it.articleKey);
        return true;
      });
      const live = await takeLive(pool, Math.min(cfg.rollforwardItems, cfg.maxItems), isLive, dead);
      icymi = live.map((it) => ({
        rank: 0,
        section: 'ICYMI' as const,
        articleKey: it.articleKey,
        campaignId: it.campaignId,
        title: it.title,
        url: it.url,
        authority: it.authority,
        category: it.category,
        excerpt: it.excerpt,
        capturedAt: it.capturedAt,
        readRate: null,
        imageUrl: it.imageUrl,
      }));
    }

    const mainLive = await takeLive(eligible.map((g) => ({ ...g, url: g.row.url })), Math.max(0, cfg.maxItems - icymi.length), isLive, dead);
    const main: FrozenItem[] = mainLive.map((g) => ({
      rank: 0,
      section: 'MAIN' as const,
      articleKey: g.key,
      campaignId: g.row.id,
      title: g.row.title,
      url: g.row.url,
      authority: g.row.authority,
      category: reportCategory(g.row.categories, g.row.title),
      excerpt: excerptOf(g.row.body),
      capturedAt: g.createdAt,
      readRate: g.readRate,
    }));
    perAudience[a] = [...main, ...icymi].map((it, i) => ({ ...it, rank: i + 1 }));
    mainCounts[a] = main.length;
  }

  // 6b. The pictures: once per distinct article page, fail-open (a story without one stays text-only).
  await attachImages(perAudience, deps.articleImages ?? defaultArticleImages);

  // 7. Guards. The minimum applies to every variant: no digest goes out short.
  const short = AUDIENCES.some((a) => mainCounts[a] < cfg.minItems);
  const outcome: DigestSelection['outcome'] = short
    ? 'too_little_news'
    : deduped.length > cfg.sanityMaxCandidates
      ? 'sanity_hold'
      : 'ok';

  return {
    windowStart: start,
    windowEnd: end,
    candidateCount: deduped.length,
    outcome,
    perAudience,
    mainCounts,
    rows: collapseRows(perAudience),
    reads: { used: reads.fresh, source: source.name, note: reads.fresh ? null : (reads.reason ?? 'unavailable') },
    droppedDead: dead.size,
  };
}

/** The real picture step. Tests never touch the network: they pass their own, or get none. */
async function defaultArticleImages(urls: string[]): Promise<Map<string, string | null>> {
  if (process.env.NODE_ENV === 'test') return new Map();
  return fetchArticleImages(urls);
}

/** Fills `imageUrl` on every frozen item that has none yet. Never throws; never adds more than the 30 s cap. */
export async function attachImages(
  perAudience: Record<DigestAudience, FrozenItem[]>,
  fetchImages: (urls: string[]) => Promise<Map<string, string | null>>,
): Promise<void> {
  const need = new Set<string>();
  for (const a of AUDIENCES) for (const it of perAudience[a]) if (!it.imageUrl) need.add(it.url);
  if (need.size === 0) return;
  let found = new Map<string, string | null>();
  try {
    found = await fetchImages([...need]);
  } catch {
    // fail-open: text-only
  }
  for (const a of AUDIENCES) {
    for (const it of perAudience[a]) {
      const url = it.imageUrl || found.get(it.url) || null;
      it.imageUrl = isAllowedArticleImage(url) ? url : null;
    }
  }
}

/** One row per item when both variants agree on it (same section and rank); else one per audience. */
export function collapseRows(perAudience: Record<DigestAudience, FrozenItem[]>): DigestItemRow[] {
  const rows: DigestItemRow[] = [];
  const premium = new Map(perAudience.PREMIUM.map((it) => [it.articleKey, it]));
  const shared = new Set<string>();
  for (const it of perAudience.FREE) {
    const p = premium.get(it.articleKey);
    if (p && p.section === it.section && p.rank === it.rank) {
      rows.push({ ...it, audience: null });
      shared.add(it.articleKey);
    } else {
      rows.push({ ...it, audience: 'FREE' });
    }
  }
  for (const it of perAudience.PREMIUM) if (!shared.has(it.articleKey)) rows.push({ ...it, audience: 'PREMIUM' });
  return rows;
}

/** Freeze: writes the run's DigestItem rows. Call inside the transaction that sets `builtAt`. */
export async function writeDigestItems(tx: Prisma.TransactionClient, runId: string, rows: DigestItemRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.digestItem.createMany({
    data: rows.map((r) => ({
      runId,
      rank: r.rank,
      section: r.section,
      audience: r.audience,
      articleKey: r.articleKey,
      campaignId: r.campaignId,
      title: r.title,
      url: r.url,
      authority: r.authority,
      category: r.category,
      excerpt: r.excerpt,
      capturedAt: r.capturedAt,
      readRate: r.readRate,
      imageUrl: r.imageUrl ?? null,
    })),
  });
}
