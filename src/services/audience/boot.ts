import cron from 'node-cron';
import { env, type AudienceEnv } from '../../lib/env';
import { runPull, type PullDeps, type PullMode } from './pull';
import { driftCheck, flushPending, type WriterDeps } from './writer';

/**
 * CMS audience sync boot line (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.1, task 1).
 *
 * `[audience] disabled (set AUDIENCE_SYNC_ENABLED=true to start)` is the MARKER for a
 * backend-only deploy: it proves the build with this code is running while every audience
 * flag is off. Enabled: the webhook ingests (task 4) and, with the door-L secret + base URL set,
 * the pull crons start (task 5: hourly incremental at :10 IST, full at 04:30 IST, single-flight), and
 * the writer tick (every minute) + drift check (05:30 IST) start (task 6; dry-run unless AUDIENCE_SYNC_WRITE_MAILERCLOUD).
 *
 * Never throws (a bad audience config must not take push down) and never prints a value:
 * problems name variables only — and they are printed while the sync is OFF too, so a bad
 * variable is seen before the flag is switched on. An empty CMS_FEED_ALLOWED_IPS is warned about, because it
 * rejects every webhook by design.
 */
export type AudienceBootState = 'disabled' | 'config_invalid' | 'enabled';

/**
 * Whether the CMS webhook may accept anything: the flag on, no config problem, a webhook secret
 * set. The route answers 401 to everything otherwise (contract v1.2 §3), the same as a bad
 * signature. One definition, shared by the boot line and the route.
 */
export function audienceIngestReady(cfg: AudienceEnv = env.audience): boolean {
  return cfg.enabled && cfg.problems.length === 0 && cfg.cms.inboundSecret !== '';
}

/** How a cron is started (injectable so tests never start a real one). */
export type CronStarter = (expression: string, fn: () => void, timezone: string) => { stop: () => void };

const nodeCronStarter: CronStarter = (expression, fn, timezone) => cron.schedule(expression, fn, { timezone });

export type AudienceStartOptions = {
  startCron?: CronStarter;
  pullDeps?: PullDeps;
  writerDeps?: WriterDeps;
};

/** Hourly incremental at :10 IST — except 04:10, which would race the 04:30 full load. */
export const INCREMENTAL_CRON = '10 0-3,5-23 * * *';
/** The nightly full load, 04:30 IST (design §5.2: before the backup has aged and before the 06:30 build). */
export const FULL_CRON = '30 4 * * *';
/** The writer tick: every minute (due members only; single-flight; dry unless AUDIENCE_SYNC_WRITE_MAILERCLOUD). */
export const WRITER_CRON = '* * * * *';
/** The drift check, 05:30 IST: after the 04:30 full load (it skips itself while a pull runs). */
export const DRIFT_CRON = '30 5 * * *';
/** A full load that finds another pull running waits a minute and tries again, up to this many times. */
export const FULL_BUSY_RETRIES = 30;

/** Run a pull from cron; a full load that meets a running pull retries every minute (never skipped silently). */
export function cronPull(mode: PullMode, deps: PullDeps = {}, attempt = 0, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  return runPull(mode, deps).then(async (r) => {
    if (r.skipped === 'busy' && mode === 'full' && attempt < FULL_BUSY_RETRIES) {
      await wait(60_000);
      await cronPull(mode, deps, attempt + 1, wait);
    }
  });
}

export function startAudienceSync(cfg: AudienceEnv = env.audience, opts: AudienceStartOptions = {}): AudienceBootState {
  /* eslint-disable no-console */
  if (cfg.erasePathRemovedButSet) {
    console.warn('[audience] AUDIENCE_ERASE_IN_MAILERCLOUD is set but was removed (the CMS erases in Mailercloud) — ignored; unset it');
  }
  if (!cfg.enabled) {
    console.log('[audience] disabled (set AUDIENCE_SYNC_ENABLED=true to start)');
    // Shown while off too, so a bad variable is fixed BEFORE the flag goes on (names only).
    if (cfg.problems.length > 0) console.warn(`[audience] config problems (sync is off): ${cfg.problems.join('; ')}`);
    return 'disabled';
  }
  const problems = [...cfg.problems];
  if (!cfg.cms.inboundSecret) problems.push('CMS_FEED_INBOUND_SECRET is unset');
  if (problems.length > 0) {
    console.error(`[audience] config_invalid — not started: ${problems.join('; ')}`);
    return 'config_invalid';
  }
  if (cfg.cms.allowedIps.length === 0) {
    console.warn('[audience] CMS_FEED_ALLOWED_IPS is empty — every CMS webhook will be rejected (fail closed)');
  }
  // Pulls (task 5) need the door-L secret and base URL; without them the webhook still ingests.
  const pullsReady = cfg.cms.pullSecret !== '' && cfg.cms.baseUrl !== '';
  const starter = opts.startCron ?? (process.env.NODE_ENV === 'test' ? null : nodeCronStarter);
  if (pullsReady && starter) {
    starter(INCREMENTAL_CRON, () => void cronPull('incremental', opts.pullDeps).catch(() => undefined), 'Asia/Kolkata');
    starter(FULL_CRON, () => void cronPull('full', opts.pullDeps).catch(() => undefined), 'Asia/Kolkata');
  }
  // The writer (task 6): flushPending and driftCheck never throw and are single-flight.
  if (starter) {
    starter(WRITER_CRON, () => void flushPending(opts.writerDeps).catch(() => undefined), 'Asia/Kolkata');
    starter(DRIFT_CRON, () => void driftCheck(opts.writerDeps).catch(() => undefined), 'Asia/Kolkata');
  }
  console.log(
    `[audience] enabled — CMS webhook ingest on; pulls ${pullsReady ? 'on (incremental hourly at :10, full 04:30 IST)' : 'off (CMS_FEED_PULL_SECRET / CMS_FEED_BASE_URL unset)'}` +
      `; Mailercloud writer ${cfg.writeMailercloud ? 'LIVE (tags written, drift check 05:30 IST)' : 'dry-run (counts only)'}`,
  );
  return 'enabled';
  /* eslint-enable no-console */
}
