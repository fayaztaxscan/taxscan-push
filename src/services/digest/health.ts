import type { DigestRun } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { errorKind, redactError, type DigestSender } from './sender';
import { isPastCutoff, istInstant } from './retryPolicy';
import { recordRunAlert } from './runAlerts';
import { addRecoveryMarker, HEALTH_PROBLEM_KINDS } from './alerts';
import { TERMINAL_ERRORS, advanceRun, type AdvanceDeps, type AdvanceResult } from './runner';

/**
 * Mailercloud health checks (docs/EMAIL_DIGEST_DESIGN.md §2.1 "Health-check
 * recovery", §4 `health.ts`, §5 timeline, §8 first and "401, 400, 9002" rows).
 *
 * Called by the scheduler tick (`scheduler.ts`) for today's run, once it exists:
 *
 *  - `sender.health()` (Mailercloud `GET /v1/client/plan`) at **T−75** and
 *    **T−15** (06:15 and 07:15 for a 07:30 send), then **hourly while a FATAL
 *    error is open** — the last check failed FATAL (a rejected key, an exhausted
 *    plan), or a variant is FAILED with a FATAL provider error. Never at or after
 *    the cut-off. A slot already covered by a later check is not repeated, so a
 *    restart or a second replica does not add calls; the check is claimed on
 *    `DigestRun.healthCheckedAt` with a conditional update, so two replicas
 *    cannot both make it.
 *  - Result on the run (`healthOk`, `healthCheckedAt`, `healthError` = "<KIND>:
 *    <redacted message>"). A failure raises `health_failed` once per run (email to
 *    admins + the Dashboard/Digests banner, which reads `healthOk`). The digest
 *    carries on: the send attempt decides (§8).
 *  - Recovery: a passing check after a failed one clears the banner (healthOk
 *    true) and writes `health_recovered` (emailed only if `health_failed` was).
 *    A passing check while a variant is FAILED with a FATAL provider error calls
 *    `advanceRun(run, 'health')` before the cut-off — the runner resumes FATAL
 *    failures only (`failedBlock`), never a provider-FAILED campaign (terminal),
 *    and every step still asks the provider first when its write-ahead marker is
 *    set, so the invariants are the runner's, unchanged.
 *  - Daily webhook status (only with `MAILERCLOUD_WEBHOOK_ID` and a sender that
 *    can read it): `GET /v1/webhooks/detail/{id}` once per run from the first
 *    slot on (an unreadable answer is retried at the next slot, never taken as
 *    "off"). Inactive → `webhookActive` false + `webhook_disabled` alert and
 *    banner. Without an id the liveness check (`webhookLiveness.ts`) is the watch.
 *
 * No address and no secret is ever logged; the result line has states only.
 */

const MINUTE = 60_000;
/** Health slots, minutes before the send time T (design §4: T−75 and T−15). */
export const HEALTH_SLOTS_BEFORE_SEND_MIN = [75, 15] as const;
/** While a FATAL error is open, the check repeats this often (design §4: hourly). */
export const HEALTH_FATAL_RECHECK_MIN = 60;

/** The two daily health instants for a run (T−75, T−15), earliest first. */
export function healthSlots(runDate: Date, cfg: Pick<DigestEnv, 'sendAt'>): Date[] {
  const t = istInstant(runDate, cfg.sendAt).getTime();
  return HEALTH_SLOTS_BEFORE_SEND_MIN.map((m) => new Date(t - m * MINUTE));
}

type SendLite = { state: string; lastError: string | null; lastErrorKind: string | null };

/** A FAILED variant with a FATAL provider error that a passing health check may resume. */
export function isResumableFatal(s: SendLite): boolean {
  return s.state === 'FAILED' && s.lastErrorKind === 'FATAL' && !TERMINAL_ERRORS.some((e) => s.lastError?.startsWith(e));
}

/** True while the last check failed FATAL, or a variant is FAILED with a FATAL error. */
export function fatalOpen(run: Pick<DigestRun, 'healthOk' | 'healthError'>, sends: readonly SendLite[]): boolean {
  return (run.healthOk === false && Boolean(run.healthError?.startsWith('FATAL'))) || sends.some(isResumableFatal);
}

/**
 * The instant before which a previous check makes a new one due, or null when no
 * check is due now. Pure: the slot rule plus the hourly rule while FATAL is open.
 */
export function healthDueSince(
  now: Date,
  run: Pick<DigestRun, 'runDate' | 'healthOk' | 'healthError' | 'healthCheckedAt'>,
  sends: readonly SendLite[],
  cfg: Pick<DigestEnv, 'sendAt' | 'cutoff'>,
): Date | null {
  if (isPastCutoff(now, run.runDate, cfg.cutoff)) return null;
  const passed = healthSlots(run.runDate, cfg).filter((s) => s.getTime() <= now.getTime());
  let since: Date | null = passed.length ? passed[passed.length - 1] : null;
  if (fatalOpen(run, sends) && run.healthCheckedAt) {
    // A check made 60 min ago or more is due again (+1 ms: "before `since`" is strict).
    const hourly = new Date(now.getTime() - HEALTH_FATAL_RECHECK_MIN * MINUTE + 1);
    if (!since || hourly.getTime() > since.getTime()) since = hourly;
  }
  if (!since) return null;
  if (run.healthCheckedAt && run.healthCheckedAt.getTime() >= since.getTime()) return null;
  return since;
}

export type HealthDeps = {
  sender: DigestSender;
  cfg?: DigestEnv;
  now?: Date;
  /** Passed through to `advanceRun(…, 'health')` on recovery (clock, quiet, alerts, log …). */
  advance?: Omit<AdvanceDeps, 'sender' | 'now' | 'cfg'>;
};

export type HealthOutcome = {
  checked: boolean;
  ok?: boolean;
  /** The previous check had failed and this one passed. */
  recovered?: boolean;
  /** The FATAL-failed variants were handed back to the runner. */
  resumed?: AdvanceResult;
  webhook?: 'active' | 'inactive' | 'unreadable';
};

/**
 * Runs whatever health work is due for this run now. Never throws (a failure is
 * the check's result, and a DB error is logged without values).
 */
export async function runHealthChecks(runId: string, deps: HealthDeps): Promise<HealthOutcome> {
  const cfg = deps.cfg ?? env.digest;
  const now = deps.now ?? new Date();
  const out: HealthOutcome = { checked: false };
  try {
    const run = await prisma.digestRun.findUnique({ where: { id: runId } });
    if (!run) return out;
    const sends = await prisma.digestSend.findMany({ where: { runId }, select: { state: true, lastError: true, lastErrorKind: true } });
    const since = healthDueSince(now, run, sends, cfg);
    if (since) await providerCheck(run, sends, since, now, cfg, deps, out);
    await webhookCheck(run, now, cfg, deps.sender, out);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] run=${runId} health check could not run: ${redactError(err)}`);
  }
  return out;
}

async function providerCheck(
  run: DigestRun,
  sends: readonly SendLite[],
  since: Date,
  now: Date,
  cfg: DigestEnv,
  deps: HealthDeps,
  out: HealthOutcome,
): Promise<void> {
  // Claim the check: of two replicas (or an overlapping tick) only one makes it.
  const claimed = await prisma.digestRun.updateMany({
    where: { id: run.id, OR: [{ healthCheckedAt: null }, { healthCheckedAt: { lt: since } }] },
    data: { healthCheckedAt: now },
  });
  if (claimed.count !== 1) return;
  out.checked = true;
  const wasFailing = run.healthOk === false;
  try {
    await deps.sender.health();
  } catch (err) {
    const kind = errorKind(err);
    const error = redactError(err);
    out.ok = false;
    await prisma.digestRun.updateMany({ where: { id: run.id }, data: { healthOk: false, healthError: `${kind}: ${error}`.slice(0, 300) } });
    await recordRunAlert(run.id, 'health_failed', now, { kind, error });
    return;
  }
  out.ok = true;
  await prisma.digestRun.updateMany({ where: { id: run.id }, data: { healthOk: true, healthError: null } });
  const resumable = sends.some(isResumableFatal);
  if (resumable && !isPastCutoff(now, run.runDate, cfg.cutoff)) {
    out.resumed = await advanceRun(run.id, 'health', { ...deps.advance, sender: deps.sender, now, cfg });
  }
  if (wasFailing) {
    out.recovered = true;
    await addRecoveryMarker(run.id, now, 'health_recovered', HEALTH_PROBLEM_KINDS, { resumed: Boolean(out.resumed) });
  }
}

async function webhookCheck(run: DigestRun, now: Date, cfg: DigestEnv, sender: DigestSender, out: HealthOutcome): Promise<void> {
  const id = cfg.mailercloud.webhookId;
  if (!cfg.webhooksEnabled || !id || !sender.webhookStatus) return;
  if (isPastCutoff(now, run.runDate, cfg.cutoff)) return;
  const slots = healthSlots(run.runDate, cfg).filter((s) => s.getTime() <= now.getTime());
  if (slots.length === 0 || run.webhookActive !== null) return;
  const latest = slots[slots.length - 1];
  // Once per slot until an answer is read (claimed like the health check).
  const claimed = await prisma.digestRun.updateMany({
    where: { id: run.id, webhookActive: null, OR: [{ webhookCheckedAt: null }, { webhookCheckedAt: { lt: latest } }] },
    data: { webhookCheckedAt: now },
  });
  if (claimed.count !== 1) return;
  let active: boolean;
  try {
    ({ active } = await sender.webhookStatus(id));
  } catch {
    out.webhook = 'unreadable';
    return;
  }
  out.webhook = active ? 'active' : 'inactive';
  await prisma.digestRun.updateMany({ where: { id: run.id }, data: { webhookActive: active } });
  if (!active) await recordRunAlert(run.id, 'webhook_disabled', now);
}
