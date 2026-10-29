import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type ReadsEnv } from '../../lib/env';
import { redactText } from '../../lib/redact';
import { safeErrorLog } from '../../lib/httpErrors';
import { istDateKey } from '../reports';
import { raiseAudienceAlert, sendAudienceAlerts, type AudienceAlertDeps } from '../audience/alerts';
import { CmsPullError } from '../audience/cmsClient';
import { createViewsClient, type CmsViewsClient, type ViewRow } from './client';

/**
 * The Feed 2 sync (brief 2026-10-29-cms-reads): mirrors the CMS's per-article, per-IST-day views into
 * `CmsArticleView`. Same invariant as the GA reads: crons fill Postgres, REQUESTS read Postgres, and a CMS
 * outage only means staleness. Behind CMS_VIEWS_ENABLED.
 *
 * A routine run asks for `from = today − 2` … `to = today` (IST), with NO `published_since` (the Reports need old
 * articles too), all pages. It is all-or-nothing: the rows go in one transaction only after EVERY page arrived and
 * every row parsed, so a failed page, a repeating cursor or one bad row writes NOTHING (staleness, never a partial
 * day — the rule GA reads has had since PR #74). The write is a pure upsert: a day the CMS returned no rows for
 * deletes nothing. A failure raises one alert per IST day through the audience alert path. Logs counts only.
 */

export const ROUTINE_LOOKBACK_DAYS = 2;
const UPSERT_CHUNK = 500;
const DAY_MS = 86_400_000;

export type ViewsSyncResult = {
  ok: boolean;
  rows: number;
  pages: number;
  inserted: number;
  from: string;
  to: string;
  asOf: string | null;
  ms: number;
  error?: string;
};

export type ViewsSyncDeps = {
  client?: CmsViewsClient;
  now?: Date;
  portal?: string;
  /** Explicit IST dates (the backfill); default = the routine window. */
  from?: string;
  to?: string;
  /** Alerts on failure (default true). */
  alerts?: boolean;
  alertDeps?: AudienceAlertDeps;
  cfg?: ReadsEnv;
  log?: (line: string) => void;
  /** The caller already holds the lock (`acquireViewsLock`, the backfill's chunk loop): skip the busy check and don't release. */
  lockHeld?: boolean;
};

/** The routine window (IST): `today − 2` … `today`. */
export function routineWindow(now: Date): { from: string; to: string } {
  return { to: istDateKey(now), from: istDateKey(new Date(now.getTime() - ROUTINE_LOOKBACK_DAYS * DAY_MS)) };
}

/** Day-key arithmetic on `YYYY-MM-DD` (UTC math on the key, no timezone involved). */
export function addDays(key: string, n: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** [from, to] split into ranges the CMS accepts (`to − from ≤ 30`), oldest first. */
export function chunkRanges(from: string, to: string, maxSpanDays = 30): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let start = from; start <= to; ) {
    const end = addDays(start, maxSpanDays) < to ? addDays(start, maxSpanDays) : to;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return out;
}

let running = false;

/** True while a sync pass or a backfill holds the one-at-a-time lock. */
export const isViewsSyncRunning = (): boolean => running;
/** Takes the lock for a multi-chunk run (the backfill); false if it is taken. Pair with `releaseViewsLock`. */
export function acquireViewsLock(): boolean {
  if (running) return false;
  running = true;
  return true;
}
export function releaseViewsLock(): void {
  running = false;
}

/** Upserts the rows in ONE transaction (all or nothing). Returns how many were new. */
export async function writeViews(rows: ViewRow[], portal: string, now: Date): Promise<number> {
  if (rows.length === 0) return 0;
  const stamp = now.toISOString();
  return prisma.$transaction(
    async (tx) => {
      let inserted = 0;
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const values = Prisma.join(
          rows.slice(i, i + UPSERT_CHUNK).map(
            (r) =>
              Prisma.sql`(${randomUUID()}, ${portal}, ${r.articleId}, ${r.canonicalPath}, ${r.externalId}, ${r.date}::date, ${r.views}, ${r.pushViews}, ${r.digestViews}, (${r.cmsUpdatedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'), (${stamp}::timestamptz AT TIME ZONE 'UTC'))`,
          ),
        );
        const res = await tx.$queryRaw<{ inserted: boolean }[]>`
          INSERT INTO "CmsArticleView" (id, portal, "articleId", "canonicalPath", "externalId", date, views, "pushViews", "digestViews", "cmsUpdatedAt", "fetchedAt")
          VALUES ${values}
          ON CONFLICT (portal, "articleId", date) DO UPDATE SET
            "canonicalPath" = EXCLUDED."canonicalPath", "externalId" = EXCLUDED."externalId", views = EXCLUDED.views,
            "pushViews" = EXCLUDED."pushViews", "digestViews" = EXCLUDED."digestViews",
            "cmsUpdatedAt" = EXCLUDED."cmsUpdatedAt", "fetchedAt" = EXCLUDED."fetchedAt"
          RETURNING (xmax = 0) AS inserted`;
        inserted += res.filter((r) => r.inserted).length;
      }
      return inserted;
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
}

/** One sync pass. Never throws: a failure is returned (and alerted), with nothing written. */
export async function runViewsSync(deps: ViewsSyncDeps = {}): Promise<ViewsSyncResult> {
  const started = Date.now();
  const now = deps.now ?? new Date();
  const win = deps.from && deps.to ? { from: deps.from, to: deps.to } : routineWindow(now);
  const portal = deps.portal ?? env.rss.portal;
  const cfg = deps.cfg ?? env.cmsViews;
  const log = deps.log ?? ((line: string) => console.log(line)); // eslint-disable-line no-console
  const base = { rows: 0, pages: 0, inserted: 0, from: win.from, to: win.to, asOf: null as string | null };
  if (!deps.lockHeld) {
    if (running) return { ...base, ok: false, ms: 0, error: 'busy' };
    running = true;
  }
  try {
    const client = deps.client ?? createViewsClient();
    const { rows, pages, asOf } = await client.fetchRange(win);
    const inserted = await writeViews(rows, portal, now);
    const result: ViewsSyncResult = { ok: true, rows: rows.length, pages, inserted, from: win.from, to: win.to, asOf: asOf.toISOString(), ms: Date.now() - started };
    log(`[cms-views] synced rows=${result.rows} pages=${pages} new=${inserted} ms=${result.ms} as_of=${result.asOf} range=${win.from}..${win.to}`);
    return result;
  } catch (err) {
    const text = redactText(err instanceof CmsPullError ? err.message : 'cms views: unexpected failure', [cfg.secret].filter(Boolean)).slice(0, 160);
    const result: ViewsSyncResult = { ...base, ok: false, ms: Date.now() - started, error: text };
    // eslint-disable-next-line no-console
    console.error('[cms-views] sync failed (nothing written; the last good numbers stay in place)', safeErrorLog(err));
    if (deps.alerts !== false) {
      await raiseAudienceAlert(portal, 'cms_views_failed', { reason: text }, now);
      await sendAudienceAlerts(portal, { ...(deps.alertDeps ?? {}), now });
    }
    return result;
  } finally {
    if (!deps.lockHeld) running = false;
  }
}

let started = false;

/** Boot: `[cms-views] disabled …` while off; the 2-hourly cron (IST) when on. */
export function startCmsViewsSync(cfg: ReadsEnv = env.cmsViews, schedule: typeof cron.schedule = cron.schedule): void {
  if (!cfg.enabled) {
    // eslint-disable-next-line no-console
    console.log('[cms-views] disabled (set CMS_VIEWS_ENABLED=true to start)');
    if (cfg.problems.length > 0) console.warn(`[cms-views] config problems (sync is off): ${cfg.problems.join('; ')}`); // eslint-disable-line no-console
    return;
  }
  const problems = [...cfg.problems];
  if (!cfg.secret) problems.push('CMS_FEED_VIEWS_SECRET is unset');
  if (!env.audience.cms.baseUrl) problems.push('CMS_FEED_BASE_URL is unset or invalid');
  if (!cron.validate(cfg.cron)) problems.push('CMS_VIEWS_CRON is not a valid cron expression');
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[cms-views] config_invalid — not started: ${problems.join('; ')}`);
    return;
  }
  if (started) return;
  started = true;
  schedule(cfg.cron, () => void runViewsSync().catch(() => undefined), { timezone: env.rss.tz });
  // eslint-disable-next-line no-console
  console.log(`[cms-views] scheduled cron="${cfg.cron}" tz=${env.rss.tz} window=today-${ROUTINE_LOOKBACK_DAYS}..today reads=${cfg.source}`);
}
