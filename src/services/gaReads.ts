import fs from 'fs';
import crypto from 'crypto';
import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';

/**
 * Per-article read counts from the GA4 Data API (NEXT_STEP.md item 10, Phase B).
 *
 * A flag-gated cron (~2h) makes ONE batched Data API call — pageviews by
 * (date, pagePath), once unfiltered and once filtered to our push UTM
 * (sessionSource = taxscan-push) — over a rolling lookback window (GA settles
 * late, up to 24-48h), and mirrors the result into ArticleReadStat. The request
 * path (reports/campaigns) reads Postgres only and NEVER calls GA: on GA
 * failure the last-synced counts simply stay in place, stale but serving.
 *
 * Auth is a plain service-account JWT exchange (RS256 via node:crypto) against
 * the REST endpoint — deliberately no @google-analytics/data dependency: the
 * surface we use is one endpoint, and keeping package-lock.json untouched
 * avoids the Railway/Nixpacks build-cache footgun (see project notes).
 */

export type GaCredentials = { client_email: string; private_key: string };

export type GaReadRow = {
  date: Date;
  pagePath: string;
  totalViews: number;
  pushViews: number;
};

/** Minimal shape of one report inside a batchRunReports response. */
export type GaReport = {
  rowCount?: number;
  rows?: {
    dimensionValues: { value: string }[];
    metricValues: { value: string }[];
  }[];
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/**
 * Inline JSON (GA_SERVICE_ACCOUNT_JSON — Railway) wins over the key file on
 * disk (GA_SERVICE_ACCOUNT_FILE — local dev). Null when neither is configured.
 */
export function loadGaCredentials(): GaCredentials | null {
  let raw = env.gaReads.serviceAccountJson;
  if (!raw && env.gaReads.serviceAccountFile && fs.existsSync(env.gaReads.serviceAccountFile)) {
    raw = fs.readFileSync(env.gaReads.serviceAccountFile, 'utf8');
  }
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<GaCredentials>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GA service-account JSON is missing client_email/private_key');
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Service-account JWT → access token. Cached until shortly before expiry. */
let tokenCache: { token: string; expiresAtMs: number } | null = null;

export async function getGaAccessToken(
  creds: GaCredentials,
  fetchImpl: FetchLike,
  now: Date,
): Promise<string> {
  if (tokenCache && tokenCache.expiresAtMs - 60_000 > now.getTime()) return tokenCache.token;
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(creds.private_key))}`;

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) {
    throw new Error(`GA token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }
  tokenCache = { token: body.access_token, expiresAtMs: now.getTime() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

/** GA `date` dimension value (YYYYMMDD, property timezone) → UTC-midnight Date. */
export function parseGaDate(s: string): Date {
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
}

/**
 * Merge the two batched reports (same dimensions: date, pagePath) into one row
 * set. Paths present only in the unfiltered report get pushViews 0; a push row
 * without a totals row (shouldn't happen — push views are a subset) still
 * yields a row so nothing is dropped.
 */
export function mergeGaReports(totals: GaReport, push: GaReport): GaReadRow[] {
  const key = (date: string, path: string) => `${date}|${path}`;
  const out = new Map<string, GaReadRow>();
  for (const r of totals.rows ?? []) {
    const [date, pagePath] = [r.dimensionValues[0].value, r.dimensionValues[1].value];
    out.set(key(date, pagePath), {
      date: parseGaDate(date),
      pagePath,
      totalViews: Number(r.metricValues[0].value) || 0,
      pushViews: 0,
    });
  }
  for (const r of push.rows ?? []) {
    const [date, pagePath] = [r.dimensionValues[0].value, r.dimensionValues[1].value];
    const views = Number(r.metricValues[0].value) || 0;
    const existing = out.get(key(date, pagePath));
    if (existing) existing.pushViews = views;
    else out.set(key(date, pagePath), { date: parseGaDate(date), pagePath, totalViews: views, pushViews: views });
  }
  return [...out.values()];
}

/** One batched Data API call: totals + push-attributed, by (date, pagePath). */
export async function fetchGaReads(opts: {
  creds: GaCredentials;
  fetchImpl?: FetchLike;
  now?: Date;
  lookbackDays?: number;
}): Promise<GaReadRow[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? env.gaReads.lookbackDays;
  const token = await getGaAccessToken(opts.creds, fetchImpl, now);

  const base = {
    dateRanges: [{ startDate: `${lookbackDays}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'date' }, { name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }],
    limit: 250000,
  };
  const res = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${env.gaReads.propertyId}:batchRunReports`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          base,
          {
            ...base,
            dimensionFilter: {
              filter: {
                fieldName: 'sessionSource',
                stringFilter: { value: env.analytics.utm.source || 'taxscan-push' },
              },
            },
          },
        ],
      }),
    },
  );
  const body = (await res.json()) as { reports?: GaReport[]; error?: unknown };
  if (!res.ok || !body.reports || body.reports.length !== 2) {
    throw new Error(`GA batchRunReports failed (${res.status}): ${JSON.stringify(body.error ?? body)}`);
  }
  const [totals, push] = body.reports;
  for (const [label, report] of [['totals', totals], ['push', push]] as const) {
    const returned = report.rows?.length ?? 0;
    if ((report.rowCount ?? 0) > returned) {
      // eslint-disable-next-line no-console
      console.warn(`[ga-reads] ${label} report truncated: rowCount=${report.rowCount} returned=${returned}`);
    }
  }
  return mergeGaReports(totals, push);
}

/**
 * One sync pass: fetch the window from GA and mirror it into ArticleReadStat.
 * For each date GA returned rows for, that date's rows are replaced wholesale
 * (delete + createMany in one transaction) so the table exactly mirrors GA's
 * latest numbers; dates GA returned nothing for keep their last-synced rows.
 */
export async function syncGaReads(
  deps: { fetchImpl?: FetchLike; now?: Date; creds?: GaCredentials; portal?: string } = {},
): Promise<{ rows: number; dates: number }> {
  const creds = deps.creds ?? loadGaCredentials();
  if (!creds) throw new Error('GA credentials not configured (GA_SERVICE_ACCOUNT_JSON or key file)');
  const portal = deps.portal ?? env.rss.portal;

  const rows = await fetchGaReads({ creds, fetchImpl: deps.fetchImpl, now: deps.now });
  const dates = [...new Set(rows.map((r) => r.date.getTime()))].map((t) => new Date(t));

  const CHUNK = 1000;
  const writes = [
    prisma.articleReadStat.deleteMany({ where: { portal, date: { in: dates } } }),
  ];
  for (let i = 0; i < rows.length; i += CHUNK) {
    writes.push(
      prisma.articleReadStat.createMany({
        data: rows.slice(i, i + CHUNK).map((r) => ({ ...r, portal })),
      }),
    );
  }
  await prisma.$transaction(writes);
  return { rows: rows.length, dates: dates.length };
}

let started = false;

export function startGaReadsSync(): void {
  if (!env.gaReads.enabled) {
    // eslint-disable-next-line no-console
    console.log('[ga-reads] disabled (set GA_READS_ENABLED=true to start)');
    return;
  }
  if (!loadGaCredentials()) {
    // eslint-disable-next-line no-console
    console.warn('[ga-reads] no credentials (GA_SERVICE_ACCOUNT_JSON or key file) — sync not started');
    return;
  }
  if (!cron.validate(env.gaReads.cron)) throw new Error(`Invalid GA_READS_CRON: ${env.gaReads.cron}`);
  if (started) return;
  started = true;

  const run = async () => {
    try {
      const r = await syncGaReads();
      // eslint-disable-next-line no-console
      console.log(`[ga-reads] synced rows=${r.rows} dates=${r.dates}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[ga-reads] sync failed (last-synced counts stay in place)', e);
    }
  };

  cron.schedule(env.gaReads.cron, () => void run(), { timezone: env.rss.tz });
  // One pass shortly after boot so an enable/redeploy is verifiable without
  // waiting for the next cron slot. Delayed to let the deploy settle.
  setTimeout(() => void run(), 15_000).unref();
  // eslint-disable-next-line no-console
  console.log(
    `[ga-reads] scheduled cron="${env.gaReads.cron}" property=${env.gaReads.propertyId} lookback=${env.gaReads.lookbackDays}d`,
  );
}
