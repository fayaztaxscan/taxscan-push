import dotenv from 'dotenv';
import { canonicalIp } from './clientIp';

dotenv.config();

const parsedPort = Number(process.env.PORT);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Reads RSS feeds from prefixed env vars: `RSS_FEED_<TOPIC_UPPER>=<url>`.
 * The topic slug is the suffix lowercased with underscores → hyphens, e.g.
 * `RSS_FEED_INCOME_TAX` → topic `income-tax`. If no prefixed vars are set,
 * falls back to the four taxscan.in section feeds. `RSS_FEED_URL` (legacy
 * single-feed var) is ignored with a one-line deprecation warning.
 */
function parseRssFeeds(): { topic: string; url: string }[] {
  if (process.env.RSS_FEED_URL) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] RSS_FEED_URL is deprecated and ignored. Use RSS_FEED_<TOPIC>=<url> per section.',
    );
  }
  const out: { topic: string; url: string }[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^RSS_FEED_([A-Z][A-Z0-9_]*)$/.exec(key);
    if (!match) continue;
    if (match[1] === 'URL') continue; // legacy var, handled above
    if (!value) continue;
    const topic = match[1].toLowerCase().replace(/_/g, '-');
    out.push({ topic, url: value.trim() });
  }
  if (out.length > 0) return out;
  return [
    { topic: 'corporate', url: 'https://www.taxscan.in/corporate-laws/feed' },
    { topic: 'gst', url: 'https://www.taxscan.in/cst-vat-gst/feed' },
    { topic: 'income-tax', url: 'https://www.taxscan.in/income-tax/feed' },
    { topic: 'customs', url: 'https://www.taxscan.in/excise-customs/feed' },
  ];
}

const parsedCap = Number(process.env.FREQ_CAP_PER_DAY);
const parsedConcurrency = Number(process.env.SEND_CONCURRENCY);

const allowedPushHosts = (
  process.env.ALLOWED_PUSH_HOSTS ??
  'taxscan.in,www.taxscan.in,academy.taxscan.in,shop.taxscan.in'
)
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Like intEnv but allows 0 (used where 0 is a meaningful "disabled" value, e.g.
// the per-subscriber cooldown). Empty/invalid falls back; negatives fall back.
function nonNegIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Comma-separated list → trimmed, non-empty entries (Mailercloud list/segment/tag ids). */
function listEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Positive integer from `src[name]`, else `fallback` (intEnv for an explicit source). */
function intFrom(src: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(src[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Positive finite number from `src[name]` (decimals allowed), else `fallback`. */
function posNumFrom(src: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = src[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Automatic daily email digest (docs/EMAIL_DIGEST_DESIGN.md §5). Every flag
 * defaults OFF except DIGEST_APPROVAL_REQUIRED, which defaults ON (an editor
 * approves each send unless it is switched off deliberately). Times are IST
 * HH:MM strings, validated by the digest scheduler at boot — a send time
 * inside quiet hours or at/after the cut-off stops the scheduler, it does not
 * crash the app. Takes the source as a parameter so the defaults are testable.
 */
export function parseDigestEnv(src: NodeJS.ProcessEnv) {
  return {
    enabled: src.DIGEST_ENABLED === 'true',
    // Off = the run stops at CREATED ("preview only"); nothing reaches an audience.
    sendLive: src.DIGEST_SEND_LIVE === 'true',
    approvalRequired: src.DIGEST_APPROVAL_REQUIRED !== 'false',
    webhooksEnabled: src.DIGEST_WEBHOOKS_ENABLED === 'true',
    sendAt: (src.DIGEST_SEND_AT ?? '07:30').trim(),
    buildLeadMinutes: intFrom(src, 'DIGEST_BUILD_LEAD_MINUTES', 60),
    cutoff: (src.DIGEST_CUTOFF ?? '17:00').trim(),
    maxItems: intFrom(src, 'DIGEST_MAX_ITEMS', 12),
    minItems: intFrom(src, 'DIGEST_MIN_ITEMS', 5),
    rollforwardItems: intFrom(src, 'DIGEST_ROLLFORWARD_ITEMS', 3),
    sanityMaxCandidates: intFrom(src, 'DIGEST_SANITY_MAX_CANDIDATES', 150),
    maxHtmlKb: intFrom(src, 'DIGEST_MAX_HTML_KB', 90),
    htmlWarnKb: intFrom(src, 'DIGEST_HTML_WARN_KB', 75),
    // Task 9: the per-email weight of distinct ad images; above it the build logs a warning.
    maxImageKb: intFrom(src, 'DIGEST_MAX_IMAGE_KB', 600),
    // Task 9: where ad images are served from (public /email-assets route). https only; no trailing slash.
    assetBaseUrl: (src.DIGEST_ASSET_BASE_URL ?? 'https://push.taxscan.in').trim().replace(/\/+$/, ''),
    htmlRetentionDays: intFrom(src, 'DIGEST_HTML_RETENTION_DAYS', 30),
    emailEventRetentionDays: intFrom(src, 'EMAIL_EVENT_RETENTION_DAYS', 90),
    // Task 13 (design §8): a previous send's spam-complaint rate (complaints / delivered, in %)
    // ABOVE this holds the next day's run for an editor's approval even when approval is off.
    // An unknown rate (no webhook proof) never holds; it is shown on the banner instead.
    complaintHoldPct: posNumFrom(src, 'DIGEST_COMPLAINT_HOLD_PCT', 0.3),
    // Required at build time (later task); the build fails closed when empty.
    postalAddress: (src.DIGEST_POSTAL_ADDRESS ?? '').trim(),
    // Internal addresses allowed for test sends, besides active app users. Never logged.
    testRecipients: listEnv(src.DIGEST_TEST_RECIPIENTS).map((e) => e.toLowerCase()),
    audiences: {
      // Fail closed (later task): the Free campaign is never created without a premium exclude.
      free: {
        listIds: listEnv(src.DIGEST_FREE_LIST_IDS),
        excludeListIds: listEnv(src.DIGEST_FREE_EXCLUDE_LIST_IDS),
        excludeTagIds: listEnv(src.DIGEST_FREE_EXCLUDE_TAG_IDS),
      },
      premium: {
        listIds: listEnv(src.DIGEST_PREMIUM_LIST_IDS),
        segmentIds: listEnv(src.DIGEST_PREMIUM_SEGMENT_IDS),
        tagIds: listEnv(src.DIGEST_PREMIUM_TAG_IDS),
      },
    },
    // Railway secrets. Never logged, never put into an error message.
    mailercloud: {
      apiKey: src.MAILERCLOUD_API_KEY ?? '',
      webhookToken: (src.MAILERCLOUD_WEBHOOK_TOKEN ?? '').trim(),
      // Rotation only: the old token, still accepted until Mailercloud's webhook URL is updated.
      // Default empty (= only the current token is accepted). Never logged.
      webhookTokenPrevious: (src.MAILERCLOUD_WEBHOOK_TOKEN_PREVIOUS ?? '').trim(),
      senderName: src.MAILERCLOUD_SENDER_NAME ?? '',
      senderEmail: src.MAILERCLOUD_SENDER_EMAIL ?? '',
      replyEmail: src.MAILERCLOUD_REPLY_EMAIL ?? '',
      // Task 13, optional: the id of our webhook in Mailercloud. Set → health.ts reads its status
      // once a day (GET /v1/webhooks/detail/{id}); unset → only the liveness check watches it.
      webhookId: (src.MAILERCLOUD_WEBHOOK_ID ?? '').trim(),
    },
  };
}

export type DigestEnv = ReturnType<typeof parseDigestEnv>;

/** A shared secret shorter than this is treated as UNSET (design §10.1; the CMS issues 64 hex chars). */
export const AUDIENCE_SECRET_MIN_LENGTH = 32;

/**
 * A secret from `src[name]`: trimmed; shorter than AUDIENCE_SECRET_MIN_LENGTH → '' and a
 * problem naming the variable (never its value or length).
 */
function secretFrom(src: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const v = (src[name] ?? '').trim();
  if (v === '') return '';
  if (v.length < AUDIENCE_SECRET_MIN_LENGTH) {
    problems.push(`${name} is shorter than ${AUDIENCE_SECRET_MIN_LENGTH} characters (treated as unset)`);
    return '';
  }
  return v;
}

/**
 * The CMS list base URL: https only, no credentials / query / fragment, host on the allow-list.
 * Anything else → '' and a problem (the URL is not secret, but it is still not echoed).
 */
function cmsBaseUrlFrom(src: NodeJS.ProcessEnv, allowedHosts: string[], problems: string[]): string {
  const raw = (src.CMS_FEED_BASE_URL ?? 'https://api.taxscan.in').trim();
  if (raw === '') return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    problems.push('CMS_FEED_BASE_URL is not a valid URL');
    return '';
  }
  if (u.protocol !== 'https:') {
    problems.push('CMS_FEED_BASE_URL must be https');
    return '';
  }
  if (u.username || u.password || u.search || u.hash) {
    problems.push('CMS_FEED_BASE_URL must not carry credentials, a query or a fragment');
    return '';
  }
  // `new URL` drops the scheme's default port, so `u.port` is set only for a NON-default one.
  // A signed request to an odd port is refused unless explicitly allowed (fail closed).
  if (u.port !== '' && src.CMS_FEED_ALLOW_CUSTOM_PORT !== 'true') {
    problems.push('CMS_FEED_BASE_URL has a non-default port (set CMS_FEED_ALLOW_CUSTOM_PORT=true to allow it)');
    return '';
  }
  if (!allowedHosts.includes(u.hostname.toLowerCase())) {
    problems.push('CMS_FEED_BASE_URL host is not in CMS_FEED_ALLOWED_HOSTS');
    return '';
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Valid IP literals from CMS_FEED_ALLOWED_IPS in CANONICAL form (`canonicalIp`: IPv6 compressed +
 * lower-case, IPv4-mapped → IPv4); invalid entries (ranges, zone ids, names) are dropped + reported.
 */
function cmsAllowedIpsFrom(src: NodeJS.ProcessEnv, problems: string[]): string[] {
  const out: string[] = [];
  let bad = 0;
  for (const entry of listEnv(src.CMS_FEED_ALLOWED_IPS)) {
    const ip = canonicalIp(entry);
    if (ip === null) bad += 1;
    else if (!out.includes(ip)) out.push(ip);
  }
  if (bad > 0) problems.push(`CMS_FEED_ALLOWED_IPS has ${bad} invalid entr${bad === 1 ? 'y' : 'ies'} (ignored; plain IPs only, no ranges)`);
  return out;
}

/** Percent (0 < p ≤ 100) from `src[name]`, else `fallback`. */
function pctFrom(src: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = posNumFrom(src, name, fallback);
  return n <= 100 ? n : fallback;
}

/**
 * CMS audience sync (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5, §8, §10.1; CMS push-feed contract v1.2).
 * Every behaviour flag defaults OFF. `problems` lists config faults by variable NAME only — never
 * a value — and the boot line prints them; a fault never crashes the app.
 *
 * Fail-closed rules pinned here:
 *  - a secret under 32 characters counts as unset;
 *  - CMS_FEED_BASE_URL must be https, on CMS_FEED_ALLOWED_HOSTS (default api.taxscan.in, the
 *    contract's door L host), on the default port unless CMS_FEED_ALLOW_CUSTOM_PORT=true;
 *  - CMS_FEED_ALLOWED_IPS entries are compared in canonical form (`canonicalIp`);
 *  - an EMPTY CMS_FEED_ALLOWED_IPS rejects every webhook (it never means "allow all");
 *  - the webhook (door W) and list (door L) secrets must differ: one secret per door.
 */
export function parseAudienceEnv(src: NodeJS.ProcessEnv) {
  const problems: string[] = [];
  const allowedHosts = listEnv(src.CMS_FEED_ALLOWED_HOSTS ?? 'api.taxscan.in').map((h) => h.toLowerCase());
  const inboundSecret = secretFrom(src, 'CMS_FEED_INBOUND_SECRET', problems);
  const inboundSecretPrevious = secretFrom(src, 'CMS_FEED_INBOUND_SECRET_PREVIOUS', problems);
  const pullSecret = secretFrom(src, 'CMS_FEED_PULL_SECRET', problems);
  if (pullSecret && (pullSecret === inboundSecret || pullSecret === inboundSecretPrevious)) {
    problems.push('CMS_FEED_PULL_SECRET must differ from the webhook secrets (one secret per door)');
  }
  const consentRaw = (src.AUDIENCE_CONSENT_RULE ?? 'exclude_false').trim();
  if (consentRaw !== 'exclude_false') problems.push('AUDIENCE_CONSENT_RULE must be exclude_false (the only rule built)');
  const digestFromCms = src.DIGEST_AUDIENCE_FROM_CMS === 'true';
  // Design §7.1: two constants for one fact is how PR #50 happened — set one, not both.
  if (digestFromCms && (listEnv(src.DIGEST_PREMIUM_TAG_IDS).length > 0 || listEnv(src.DIGEST_FREE_EXCLUDE_TAG_IDS).length > 0)) {
    problems.push('DIGEST_AUDIENCE_FROM_CMS derives the tag ids: unset DIGEST_PREMIUM_TAG_IDS / DIGEST_FREE_EXCLUDE_TAG_IDS (set one, not both)');
  }
  const allowedIps = cmsAllowedIpsFrom(src, problems);
  const baseUrl = cmsBaseUrlFrom(src, allowedHosts, problems);
  return {
    // Webhook route + pulls write Postgres only. Off: the route answers 401 (contract v1.2) and boot logs `[audience] disabled …`.
    enabled: src.AUDIENCE_SYNC_ENABLED === 'true',
    // Off: the Mailercloud writer runs dry (counts only).
    writeMailercloud: src.AUDIENCE_SYNC_WRITE_MAILERCLOUD === 'true',
    // Derived digest targets + the send guard.
    digestFromCms,
    // The §6.3 contact_type=active lift path.
    resubscribeWrites: src.AUDIENCE_RESUBSCRIBE_WRITES === 'true',
    // AUDIENCE_ERASE_IN_MAILERCLOUD was REMOVED (owner, 24 Oct; contract v1.3): the CMS deletes the
    // Mailercloud contact itself on an erasure and we never call a Mailercloud delete. The variable
    // is ignored if set (a boot warning says so).
    erasePathRemovedButSet: src.AUDIENCE_ERASE_IN_MAILERCLOUD !== undefined && src.AUDIENCE_ERASE_IN_MAILERCLOUD.trim() !== '',
    // Settings (not behaviour switches): owner Q1 / Q2 defaults.
    formerToFree: src.AUDIENCE_FORMER_TO_FREE !== 'false',
    consentRule: 'exclude_false' as const,
    thresholds: {
      maxStaleHours: intFrom(src, 'AUDIENCE_MAX_STALE_HOURS', 26),
      premiumDeviationPct: pctFrom(src, 'AUDIENCE_PREMIUM_DEVIATION_PCT', 2),
      maxChangePct: pctFrom(src, 'AUDIENCE_MAX_CHANGE_PCT', 5),
      maxErasuresPerDay: intFrom(src, 'AUDIENCE_MAX_ERASURES_PER_DAY', 20),
      writeRps: intFrom(src, 'AUDIENCE_WRITE_RPS', 5),
    },
    cms: {
      // Door W (CMS → us). Two active during a rotation: current, then the previous one.
      inboundSecret,
      inboundSecretPrevious,
      // Door L (us → CMS). We sign with one secret; the CMS accepts two during its rotation.
      pullSecret,
      baseUrl,
      allowedHosts,
      // Empty = REJECT every webhook (fail closed), never allow-all.
      allowedIps,
    },
    mailercloud: {
      // A separate key from MAILERCLOUD_API_KEY, used only by the contact client (design §8.2).
      syncApiKey: secretFrom(src, 'MAILERCLOUD_SYNC_API_KEY', problems),
      listId: (src.AUDIENCE_MC_LIST_ID ?? '').trim(),
      tagPremium: (src.AUDIENCE_MC_TAG_PREMIUM ?? '').trim(),
      tagFormer: (src.AUDIENCE_MC_TAG_FORMER ?? '').trim(),
      tagNoMarketing: (src.AUDIENCE_MC_TAG_NO_MARKETING ?? '').trim(),
    },
    problems,
  };
}

export type AudienceEnv = ReturnType<typeof parseAudienceEnv>;

/**
 * The webhook IP fence (design §5.1 step 2). Both sides in canonical form (`canonicalIp`), so
 * `::ffff:1.2.3.4` matches `1.2.3.4` and `2001:DB8::0:1` matches `2001:db8::1`. An EMPTY
 * allow-list, no IP, or an IP that does not parse is a rejection (fail closed).
 */
export function isCmsIpAllowed(ip: string | undefined | null, allowedIps: readonly string[]): boolean {
  if (allowedIps.length === 0) return false;
  const candidate = canonicalIp(ip);
  if (candidate === null) return false;
  return allowedIps.some((entry) => canonicalIp(entry) === candidate);
}

/**
 * The audience secrets, by variable name. `logSecrets()` masks their RAW values too, including a
 * value too short to be accepted (it counts as unset, but it is still somebody's secret).
 */
export const AUDIENCE_SECRET_NAMES = [
  'CMS_FEED_INBOUND_SECRET',
  'CMS_FEED_INBOUND_SECRET_PREVIOUS',
  'CMS_FEED_PULL_SECRET',
  'MAILERCLOUD_SYNC_API_KEY',
] as const;

export const env = {
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  allowedOrigins,
  adminToken: process.env.ADMIN_TOKEN ?? '',
  sessionCookieSecret: process.env.SESSION_COOKIE_SECRET ?? '',
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? '',
  },
  send: {
    freqCapPerDay: Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : 4,
    concurrency: Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 10,
    quietStart: process.env.QUIET_HOURS_START ?? '23:00',
    quietEnd: process.env.QUIET_HOURS_END ?? '07:00',
    // SEND_MODE: 'capture_only' (default) keeps the RSS poller storing items
    // as DRAFT campaigns without dispatching, so iZooto and our system can
    // run in parallel without double-sending. Flip to 'live' to take over.
    mode: process.env.SEND_MODE === 'live' ? ('live' as const) : ('capture_only' as const),
    // Minimum minutes between two notifications to the SAME subscriber. Guards
    // against burst fatigue (and the unsubscribes it causes) when several
    // articles publish close together: a subscriber who got a push inside this
    // window is skipped for the next campaign. Complements the daily freq cap
    // (which limits volume, not spacing). 0 disables the cooldown.
    minGapMinutes: nonNegIntEnv('MIN_GAP_MINUTES', 30),
  },
  rss: {
    enabled: process.env.RSS_ENABLED === 'true',
    feeds: parseRssFeeds(),
    cron: process.env.RSS_POLL_CRON ?? '*/5 * * * *',
    tz: 'Asia/Kolkata',
    portal: 'taxscan',
    // Editorial classifier (SEND_PACING_PLAN.md Stage 1). When true, the poller
    // classifies each article by title and, in `live` mode, dispatches only
    // QUALIFIED (allow-list) items; FALLBACK (ITAT/CESTAT/NCLAT/NCLT) and REVIEW
    // (unclassified) items are captured as DRAFT and held, not sent. Default
    // false = legacy "send everything" behaviour, so the code can ship dark and
    // be switched on deliberately. Classification is recorded on every item
    // regardless of this flag; only the hold/route behaviour is gated.
    editorialFilter: process.env.RSS_EDITORIAL_FILTER === 'true',
  },
  // Duplicate-title guard. taxscan occasionally publishes the SAME story twice
  // as two posts with different ids/slugs; GUID dedupe can't see that (different
  // guid = new article), so the second copy classifies and pushes as fresh news.
  // Observed 2026-07-28: subscribers got one headline 3× in 23h, and when the
  // desk later deleted one of the two posts the notification pointing at it
  // dead-ended on a 404. When ON, an article whose normalised title was already
  // captured within `windowHours` is routed to REVIEW instead of the auto queue —
  // defer-not-drop, so an editor decides (same treatment job posts already get).
  // Default off; a legitimately recurring headline (e.g. the weekly Round-Up)
  // lands in Review rather than being suppressed.
  duplicateTitleGuard: {
    enabled: process.env.DUPLICATE_TITLE_GUARD_ENABLED === 'true',
    windowHours: intEnv('DUPLICATE_TITLE_WINDOW_HOURS', 72),
  },
  // Pre-push link check. The pacer HEADs the article URL immediately before
  // dispatch and archives (EXPIRED) anything the CMS has already deleted, so a
  // post pulled between capture and its send slot never goes out as a dead link.
  // FAIL-OPEN by design: only an explicit 404/410 counts as dead — timeouts,
  // network errors and 5xx all send as normal, because a flaky check must never
  // block the channel. Default off.
  /**
   * Soft-prompt v2 (2026-10-15): a yes/no ask with no topic chips that may also
   * appear on a reader's first page, after real engagement. Off = the original
   * prompt. Served to the SDK via /api/config.
   */
  softPrompt: {
    v2: process.env.SOFT_PROMPT_V2 === 'true',
  },
  linkCheck: {
    enabled: process.env.LINK_CHECK_ENABLED === 'true',
    timeoutMs: intEnv('LINK_CHECK_TIMEOUT_MS', 5000),
  },
  sweeper: {
    enabled: process.env.SWEEPER_ENABLED === 'true',
    cron: process.env.SWEEPER_CRON ?? '* * * * *',
  },
  // Editorial pacer (SEND_PACING_PLAN.md Stage 2). Releases one queued article
  // per global spacing slot, best-first, up to a daily ceiling. Requires the
  // editorial filter (RSS_EDITORIAL_FILTER) — when the pacer is on the poller
  // QUEUES qualified articles as DRAFT instead of sending them immediately, and
  // the pacer dispatches them on the slot schedule. Default off = no pacing
  // (Stage-1 behaviour: qualified sends immediately on capture).
  pacer: {
    enabled: process.env.PACER_ENABLED === 'true',
    cron: process.env.PACER_CRON ?? '* * * * *',
    spacingMinutes: nonNegIntEnv('SEND_SPACING_MINUTES', 45),
    dailyCeiling: nonNegIntEnv('DAILY_SEND_CEILING', 20),
  },
  // Morning backfill (SEND_PACING_PLAN.md §5a). When ON, otherwise-empty morning
  // slots (after quiet hours, before MORNING_BACKFILL_UNTIL, and only while today
  // has produced NO qualified article yet) are filled from YESTERDAY's articles:
  // re-send yesterday's SC → Bombay HC → other HC first, else yesterday's unsent
  // other-category items, else yesterday's best-clicked other-category items.
  // Each yesterday article is re-used at most once per day. Default off.
  backfill: {
    enabled: process.env.MORNING_BACKFILL_ENABLED === 'true',
    until: process.env.MORNING_BACKFILL_UNTIL ?? '12:00',
  },
  // Weekly/monthly coverage report emails (internal). Default off; needs email
  // configured. Crons are IST (env.rss.tz): Monday 07:00 weekly, 1st 07:00 monthly.
  reports: {
    enabled: process.env.REPORTS_ENABLED === 'true',
    weeklyCron: process.env.REPORT_WEEKLY_CRON ?? '0 7 * * 1',
    monthlyCron: process.env.REPORT_MONTHLY_CRON ?? '0 7 1 * *',
  },
  // Per-article read counts synced from the GA4 Data API into ArticleReadStat
  // (src/services/gaReads.ts). Default off. Credentials: GA_SERVICE_ACCOUNT_JSON
  // holds the service-account key JSON inline (Railway), else the key is read
  // from GA_SERVICE_ACCOUNT_FILE on disk (local dev; gitignored). The sync
  // re-fetches a rolling lookback window because GA settles late (24-48h).
  gaReads: {
    enabled: process.env.GA_READS_ENABLED === 'true',
    cron: process.env.GA_READS_CRON ?? '15 */2 * * *',
    propertyId: process.env.GA_PROPERTY_ID ?? '258445828',
    lookbackDays: intEnv('GA_READS_LOOKBACK_DAYS', 3),
    // Daily build of the cached "Reads" report (bench/category × trailing
    // windows). IST, after the nightly sweepers.
    reportCron: process.env.GA_READS_REPORT_CRON ?? '45 5 * * *',
    serviceAccountJson: process.env.GA_SERVICE_ACCOUNT_JSON ?? '',
    serviceAccountFile: process.env.GA_SERVICE_ACCOUNT_FILE ?? 'ga-service-account.json',
  },
  // Google Discover / Google News pickup, synced from the Search Console Search
  // Analytics API into ArticleSurfaceStat (src/services/searchSurfaces.ts).
  // Default off. Reuses the GA service-account key, but Search Console does NOT
  // inherit GA permissions — the service account must ALSO be added under
  // Search Console → Settings → Users and permissions (Restricted is enough),
  // and the Search Console API enabled in the same GCP project.
  //
  // `siteUrl` must match how the property is registered, and the two spellings
  // are not interchangeable: a domain property is `sc-domain:taxscan.in`, a
  // URL-prefix property is `https://www.taxscan.in/` (trailing slash included).
  // Lookback defaults to 7 days — longer than the GA sync's 3, because Search
  // Console settles 2-3 days late and back-fills as it does.
  searchConsole: {
    enabled: process.env.SEARCH_CONSOLE_ENABLED === 'true',
    siteUrl: process.env.SEARCH_CONSOLE_SITE_URL ?? '',
    cron: process.env.SEARCH_CONSOLE_CRON ?? '40 */6 * * *',
    lookbackDays: intEnv('SEARCH_CONSOLE_LOOKBACK_DAYS', 7),
  },
  // Off-platform disaster copy. Exports the irreplaceable tables as gzipped
  // NDJSON to S3-compatible object storage (Cloudflare R2) — see docs/BACKUPS.md.
  //
  // WHY THIS EXISTS SEPARATELY FROM RAILWAY'S VOLUME BACKUPS: those are
  // copy-on-write snapshots that share blocks with the live volume, "wiping a
  // volume deletes all backups", and they can only be restored back into the
  // same Railway project. They cover a bad migration; they cover nothing about
  // losing Railway itself — which happened for 2.5 days on 2026-09-01, with the
  // data intact and completely unreachable.
  //
  // Default off. `endpoint` is derived from the account id when left empty.
  backup: {
    enabled: process.env.BACKUP_ENABLED === 'true',
    // 02:20 IST daily — quiet hours, before the morning traffic. Daily rather
    // than weekly because each copy is ~3 MB: with a short retention window,
    // frequency is what gives you usable recovery points, and it costs nothing.
    cron: process.env.BACKUP_CRON ?? '20 2 * * *',
    bucket: process.env.R2_BUCKET ?? '',
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    endpoint: process.env.R2_ENDPOINT ?? '',
    prefix: process.env.BACKUP_PREFIX ?? 'taxscan-push',
    // Objects older than this are deleted after a successful upload. R2's free
    // tier is 10 GB and one export is ~3 MB, so this is about tidiness, not cost.
    keepDays: intEnv('BACKUP_KEEP_DAYS', 180),
  },
  // No-miss backstop: periodically reconcile against taxscan's complete daily
  // sitemap and capture any article the RSS feeds missed (feeds only show the
  // latest ~11 per poll). Default off.
  reconciler: {
    enabled: process.env.RECONCILER_ENABLED === 'true',
    cron: process.env.RECONCILER_CRON ?? '*/20 * * * *',
    sitemapUrl: process.env.RECONCILER_SITEMAP ?? 'https://www.taxscan.in/news-sitemap-daily.xml',
  },
  // Retention: auto-archive (status EXPIRED) DRAFT articles never sent within
  // RETENTION_DAYS, so the Queue/Review backlog stays bounded. 0 = disabled.
  retention: {
    days: intEnv('RETENTION_DAYS', 0),
    cron: process.env.RETENTION_CRON ?? '30 3 * * *',
  },
  // Event retention (src/sweepers/eventRetention.ts). Bounds the delivery log
  // to a rolling window by folding old SENT/CLICKED/FAILED rows into per-
  // campaign and lifetime roll-ups and deleting them; DISMISSED goes at any
  // age (no reader). Nothing reads a SENT row older than 7 days except to
  // count it, so 30 is generous. Default OFF: it deletes rows, so it is
  // switched on deliberately — dry-run first with `npm run event-retention`.
  eventRetention: {
    enabled: process.env.EVENT_RETENTION_ENABLED === 'true',
    cron: process.env.EVENT_RETENTION_CRON ?? '30 3 * * *', // 03:30 IST, after the audit sweep
    days: intEnv('EVENT_RETENTION_DAYS', 30),
    batchSize: intEnv('EVENT_RETENTION_BATCH', 5000),
    // Batches per nightly run. 0 = until the backlog is clear. The default
    // caps a run at 2M rows so a first pass over a large backlog is bounded;
    // the next night continues from where it stopped.
    maxBatches: nonNegIntEnv('EVENT_RETENTION_MAX_BATCHES', 400),
  },
  // Digest retention (src/sweepers/digestRetention.ts, design task 11). Folds EmailEvent
  // rows older than EMAIL_EVENT_RETENTION_DAYS (90) into DigestSend.rolled* and deletes
  // them; nulls DigestSend.html/text older than DIGEST_HTML_RETENTION_DAYS (30).
  // EmailSuppression is never touched. Default OFF: it deletes rows — dry-run first
  // with `npm run digest-retention`. 03:45 IST: after the audit sweep (03:00) and the
  // event/feed retention (03:30), clear of the reconciler (:00/:20/:40) and the backup (02:20).
  digestRetention: {
    enabled: process.env.DIGEST_RETENTION_ENABLED === 'true',
    cron: process.env.DIGEST_RETENTION_CRON ?? '45 3 * * *',
    batchSize: intEnv('DIGEST_RETENTION_BATCH', 1000),
    // Batches per nightly run; 0 = until clear. ~50 events/day, so 50 × 1,000 is ample.
    maxBatches: nonNegIntEnv('DIGEST_RETENTION_MAX_BATCHES', 50),
  },
  audit: {
    // Default ON so a deploy without the env var still gets retention
    // sweeping. Set AUDIT_LOG_SWEEPER_ENABLED=false to disable.
    sweeperEnabled: process.env.AUDIT_LOG_SWEEPER_ENABLED !== 'false',
    sweeperCron: process.env.AUDIT_LOG_SWEEPER_CRON ?? '0 3 * * *', // 03:00 IST daily
    retentionDays: intEnv('AUDIT_LOG_RETENTION_DAYS', 90),
    failedLoginRetentionDays: intEnv(
      'AUDIT_LOG_FAILED_LOGIN_RETENTION_DAYS',
      30,
    ),
  },
  // Automatic daily email digest — see parseDigestEnv above. Default off.
  digest: parseDigestEnv(process.env),
  // CMS audience sync — see parseAudienceEnv above. Every flag default off.
  audience: parseAudienceEnv(process.env),
  // Digest task 14: staff push notifications for digest approval. A KILL-SWITCH,
  // default ON: nothing is ever sent unless DIGEST_ENABLED is on too (the push rides
  // on the digest's own editor alerts) AND a staff member tapped "Notify me on this
  // device". Set DIGEST_STAFF_PUSH_ENABLED=false to stop the pushes (email unaffected).
  staffPush: {
    enabled: process.env.DIGEST_STAFF_PUSH_ENABLED !== 'false',
  },
  // Absolute origin the admin SPA is reachable at — used to build invite
  // links (`<appBaseUrl>/admin/accept-invite?token=…`). Falls back to the
  // request origin at call time when unset (dev / preview).
  appBaseUrl: (process.env.APP_BASE_URL ?? '').replace(/\/+$/, ''),
  email: {
    // ElasticEmail transactional API. Optional: when apiKey or from is
    // absent the invite flow degrades to handing the admin a copyable link
    // instead of sending mail. See src/lib/email.ts.
    apiKey: process.env.ELASTICEMAIL_API_KEY ?? '',
    from: process.env.EMAIL_FROM ?? '',
    fromName: process.env.EMAIL_FROM_NAME ?? 'Taxscan Push',
  },
  invite: {
    ttlHours: intEnv('INVITE_TTL_HOURS', 72),
  },
  testSegmentTopic: process.env.TEST_SEGMENT_TOPIC ?? 'test',
  allowedPushHosts,
  rateLimit: {
    // Per-minute caps. Defaults are conservative — burst legitimate traffic
    // shouldn't hit them, but bot subscribe/track spam does.
    publicPerMin: intEnv('RATE_LIMIT_PUBLIC_PER_MIN', 60),
    loginPerMin: intEnv('RATE_LIMIT_LOGIN_PER_MIN', 5),
  },
  analytics: {
    // UTM tags appended to the push click URL so Google Analytics attributes
    // the click to this channel (mirrors how iZooto tagged its pushes as
    // `izooto / push_notifications`). Without this, notification-click traffic
    // has no referrer and GA lumps it into `(direct) / (none)`. Default medium
    // matches iZooto's so the new `taxscan-push / push_notifications` row is
    // directly comparable in the same Traffic-acquisition report. Set either to
    // an empty string to disable that tag. `??` keeps the default only when the
    // var is unset, so `UTM_SOURCE=` (empty) intentionally turns it off.
    utm: {
      source: process.env.UTM_SOURCE ?? 'taxscan-push',
      medium: process.env.UTM_MEDIUM ?? 'push_notifications',
    },
  },
};
