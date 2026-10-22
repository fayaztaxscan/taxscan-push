import { env, type DigestEnv } from '../../lib/env';
import { isQuietHours } from '../../lib/quietHours';
import { senderAddressProblems } from './renderer';

/**
 * Daily email digest scheduler (docs/EMAIL_DIGEST_DESIGN.md §4, §5).
 *
 * TASK 1 SKELETON: this only validates the configuration and logs what it
 * would do. It starts no cron, calls no provider and sends nothing. Later
 * tasks add the 1-minute tick that hands each run to `runner.advanceRun()`.
 *
 * The `[digest] disabled …` line exists only in builds that contain this
 * file, so it is the marker that proves a backend-only deploy went out.
 */

/** Which of the boot paths was taken. Returned for tests and, later, the status banner. */
export type DigestBootState = 'disabled' | 'config_invalid' | 'not_configured' | 'ready';

/** The resolved IST day plan for one digest, as HH:MM strings. */
export type DigestSchedule = { buildAt: string; sendAt: string; cutoff: string };

type ScheduleCheck = { ok: true; schedule: DigestSchedule } | { ok: false; reason: string };

const IST_OFFSET_MIN = 5 * 60 + 30;

/** "07:30" → 450, or null when it is not a valid HH:MM. */
function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 450 → "07:30". */
function minutesToHhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** An instant whose IST wall-clock time is `minutes` after midnight (date is arbitrary). */
function istInstantAt(minutes: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes) - IST_OFFSET_MIN * 60 * 1000);
}

/**
 * Checks the digest's day plan against the push quiet hours. Refuses a send
 * time inside quiet hours (same rule and same function the pacer uses), a send
 * time at or after the cut-off, and a build lead that would start the build
 * on the previous day. Pure: the caller decides what a refusal means.
 */
export function validateDigestSchedule(
  cfg: Pick<DigestEnv, 'sendAt' | 'cutoff' | 'buildLeadMinutes'>,
  quiet: { start: string; end: string } = { start: env.send.quietStart, end: env.send.quietEnd },
): ScheduleCheck {
  const send = hhmmToMinutes(cfg.sendAt);
  if (send === null) return { ok: false, reason: `DIGEST_SEND_AT "${cfg.sendAt}" is not HH:MM` };
  const cutoff = hhmmToMinutes(cfg.cutoff);
  if (cutoff === null) return { ok: false, reason: `DIGEST_CUTOFF "${cfg.cutoff}" is not HH:MM` };
  if (isQuietHours(istInstantAt(send), quiet.start, quiet.end)) {
    return {
      ok: false,
      reason: `DIGEST_SEND_AT ${cfg.sendAt} IST is inside quiet hours (${quiet.start}–${quiet.end})`,
    };
  }
  if (send >= cutoff) {
    return { ok: false, reason: `DIGEST_SEND_AT ${cfg.sendAt} IST is not before the cut-off ${cfg.cutoff}` };
  }
  const build = send - cfg.buildLeadMinutes;
  if (build < 0) {
    return { ok: false, reason: `DIGEST_BUILD_LEAD_MINUTES ${cfg.buildLeadMinutes} starts the build before midnight` };
  }
  return {
    ok: true,
    schedule: { buildAt: minutesToHhmm(build), sendAt: minutesToHhmm(send), cutoff: minutesToHhmm(cutoff) },
  };
}

/** True once the provider credential is present. The key itself is never logged. */
function isProviderConfigured(cfg: DigestEnv): boolean {
  return cfg.mailercloud.apiKey.trim() !== '';
}

/**
 * Boot entry point, called from src/index.ts next to the other crons. Never
 * throws: a bad digest config must not take push down with it. A refused
 * schedule (e.g. a send time inside quiet hours) leaves the scheduler stopped.
 */
export function startDigestScheduler(
  cfg: DigestEnv = env.digest,
  quiet: { start: string; end: string } = { start: env.send.quietStart, end: env.send.quietEnd },
): DigestBootState {
  if (!cfg.enabled) {
    // eslint-disable-next-line no-console
    console.log('[digest] disabled (set DIGEST_ENABLED=true to start)');
    return 'disabled';
  }
  // isQuietHours throws on a malformed QUIET_HOURS_* value. This runs inside
  // app.listen's callback, so an escaping throw would crash-loop push too.
  let check: ScheduleCheck;
  try {
    check = validateDigestSchedule(cfg, quiet);
  } catch (err) {
    check = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  // A no-reply From/Reply-To is refused at boot too (design §1 #9); the address is never logged.
  const addr = senderAddressProblems(cfg.mailercloud);
  if (check.ok && addr.length > 0) check = { ok: false, reason: addr.join('; ') };
  if (!check.ok) {
    // eslint-disable-next-line no-console
    console.error(`[digest] config_invalid — not started: ${check.reason}`);
    return 'config_invalid';
  }
  if (!isProviderConfigured(cfg)) {
    // eslint-disable-next-line no-console
    console.warn('[digest] not configured (MAILERCLOUD_API_KEY is unset) — not started');
    return 'not_configured';
  }
  const s = check.schedule;
  // eslint-disable-next-line no-console
  console.log(
    `[digest] ready (skeleton; no work scheduled yet) build=${s.buildAt} send=${s.sendAt} cutoff=${s.cutoff} IST` +
      ` approval=${cfg.approvalRequired ? 'required' : 'off'} sendLive=${cfg.sendLive ? 'on' : 'off'}` +
      ` webhooks=${cfg.webhooksEnabled ? 'on' : 'off'}`,
  );
  return 'ready';
}
