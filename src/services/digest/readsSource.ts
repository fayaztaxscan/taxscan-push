import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';
import { readsByPath } from '../metrics';

/**
 * Where the digest builder gets per-article ORGANIC read counts for its
 * within-tier ranking (docs/EMAIL_DIGEST_DESIGN.md §4.1, owner 2026-10-22).
 *
 * The seam exists because taxscan.in's CMS may later expose its own view
 * counts (GA4 sees ~1 in 10 readers since the 2026-09-29 consent banner).
 * Articles are identified by BOTH `articleKey()` (a CMS would key by the
 * trailing taxscan id) and their URL paths (GA keys by path). A source only
 * counts; `rankDigest` never knows which source it was.
 *
 * Project invariant: a source reads Postgres only. GA is mirrored into
 * `ArticleReadStat` by the gaReads cron; nothing here ever calls Google.
 */

export type ReadsArticle = {
  /** `articleKey()` of the article. */
  key: string;
  /** Normalised taxscan URL paths (`readsPath()`), one per captured row of this key. */
  paths: string[];
  capturedAt: Date;
};

export type ReadsResult = {
  /** False = the data cannot be trusted for this build; the builder ranks newest-first. */
  fresh: boolean;
  /** Why not fresh (shown on the run): `ga_reads_disabled`, `no_recent_sync`, … */
  reason?: string;
  /** Organic reads per article key, clamped ≥ 0. A key absent here had NO rows for any path (not the same as 0). */
  byKey: Map<string, number>;
};

export type ReadsSource = {
  name: 'ga' | 'cms';
  organicReads(articles: ReadsArticle[], now: Date): Promise<ReadsResult>;
};

const HOUR = 3_600_000;

/** `ArticleReadStat` rows rewritten within this many hours count as a live sync. */
export const GA_FRESH_HOURS = 6;

/**
 * When the gaReads cron last wrote rows. Each sync pass deletes and re-creates
 * every row of the dates it fetched (a rolling `GA_READS_LOOKBACK_DAYS` window
 * ending today), so `fetchedAt` on recent dates IS the last successful sync.
 * Restricted to the last few dates so the `date` index bounds the scan.
 */
export async function gaLastSyncAt(portal: string, now: Date): Promise<Date | null> {
  const since = new Date(now.getTime() - 4 * 24 * HOUR);
  const r = await prisma.articleReadStat.aggregate({
    where: { portal, date: { gte: new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())) } },
    _max: { fetchedAt: true },
  });
  return r._max.fetchedAt ?? null;
}

export type GaSourceOpts = {
  enabled?: boolean;
  portal?: string;
  /** Override the freshness probe (tests). */
  lastSyncAt?: (portal: string, now: Date) => Promise<Date | null>;
};

/** GA4 via `ArticleReadStat`: organic = Σ(totalViews − pushViews) over all dates and paths, clamped ≥ 0. */
export function gaReadsSource(opts: GaSourceOpts = {}): ReadsSource {
  const enabled = opts.enabled ?? env.gaReads.enabled;
  const portal = opts.portal ?? env.rss.portal;
  const probe = opts.lastSyncAt ?? gaLastSyncAt;
  return {
    name: 'ga',
    async organicReads(articles, now) {
      const byKey = new Map<string, number>();
      if (!enabled) return { fresh: false, reason: 'ga_reads_disabled', byKey };
      const last = await probe(portal, now);
      if (!last) return { fresh: false, reason: 'no_read_data', byKey };
      if (now.getTime() - last.getTime() > GA_FRESH_HOURS * HOUR) {
        return { fresh: false, reason: `stale_since_${last.toISOString()}`, byKey };
      }
      const paths = [...new Set(articles.flatMap((a) => a.paths))];
      const sums = await readsByPath(paths, portal);
      for (const a of articles) {
        let organic = 0;
        let seen = false;
        for (const p of new Set(a.paths)) {
          const s = sums.get(p);
          if (s) {
            seen = true;
            organic += s.reads - s.pushReads;
          }
        }
        // No rows for any path → left out, so the builder can tell "no data yet" from 0.
        if (seen) byKey.set(a.key, Math.max(0, organic));
      }
      return { fresh: true, byKey };
    },
  };
}

/** The read-count source for this build. Today always GA; a CMS source plugs in here. */
export function resolveReadsSource(): ReadsSource {
  return gaReadsSource();
}
