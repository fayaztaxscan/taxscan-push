import dotenv from 'dotenv';

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
  process.env.ALLOWED_PUSH_HOSTS ?? 'taxscan.in,www.taxscan.in'
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
  sweeper: {
    enabled: process.env.SWEEPER_ENABLED === 'true',
    cron: process.env.SWEEPER_CRON ?? '* * * * *',
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
