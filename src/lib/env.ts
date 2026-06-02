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

export const env = {
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  allowedOrigins,
  adminToken: process.env.ADMIN_TOKEN ?? '',
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
  },
  rss: {
    enabled: process.env.RSS_ENABLED === 'true',
    feeds: parseRssFeeds(),
    cron: process.env.RSS_POLL_CRON ?? '*/5 * * * *',
    tz: 'Asia/Kolkata',
    portal: 'taxscan',
  },
  sweeper: {
    enabled: process.env.SWEEPER_ENABLED === 'true',
    cron: process.env.SWEEPER_CRON ?? '* * * * *',
  },
  admin: {
    password: process.env.ADMIN_PASSWORD ?? '',
  },
  testSegmentTopic: process.env.TEST_SEGMENT_TOPIC ?? 'test',
};
