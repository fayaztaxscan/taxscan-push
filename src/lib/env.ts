import dotenv from 'dotenv';

dotenv.config();

const parsedPort = Number(process.env.PORT);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

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
    feedUrl: process.env.RSS_FEED_URL ?? 'https://www.taxscan.in/feed',
    cron: process.env.RSS_POLL_CRON ?? '*/5 * * * *',
    tz: 'Asia/Kolkata',
    portal: 'taxscan',
  },
  sweeper: {
    enabled: process.env.SWEEPER_ENABLED === 'true',
    cron: process.env.SWEEPER_CRON ?? '* * * * *',
  },
};
