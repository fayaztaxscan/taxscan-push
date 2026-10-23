import cron from 'node-cron';
import { Prisma, type DigestRun } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { isQuietHours } from '../../lib/quietHours';
import { safeErrorLog } from '../../lib/httpErrors';
import { senderAddressProblems, type BuildContent } from './renderer';
import { TERMINAL_ERRORS, advanceRun, awaitDigestAlerts, ensureRun, type AdvanceDeps, type AdvanceResult, type SelectItems } from './runner';
import { selectDigest } from './builder';
import { createMailercloudSender } from './mailercloud';
import { redactError, type DigestSender } from './sender';
import { istDateOf, istInstant, isPastCutoff, runDateKey } from './retryPolicy';
import { digestRunState } from './runState';
import { recordRunAlert } from './runAlerts';
import { sendDigestAlerts } from './alerts';
import { awaitingOwnApproval, runNeedsApproval, type ComplaintCheck } from './holds';
import { digestSendStats } from './stats';
import { healthSlots, runHealthChecks } from './health';

/**
 * Daily email digest scheduler (docs/EMAIL_DIGEST_DESIGN.md §4, §5).
 *
 * Boot (`startDigestScheduler`, called from src/index.ts next to the other
 * crons): validates the configuration and, when it is ready, starts a node-cron
 * tick every minute (IST), the same pattern as the pacer: an in-process
 * single-flight guard so ticks never overlap. The `[digest] disabled …` line
 * exists only in builds that contain this file, so it is the marker that proves
 * a backend-only deploy went out.
 *
 * TASK 13 — the tick (`digestTick`), per portal. Every time comes from the §5
 * schedule table and the env (T = DIGEST_SEND_AT):
 *
 *   T−75 (06:15)  today's run is created (`ensureRun`), the previous send's
 *                 complaint rate is checked once (hold above
 *                 DIGEST_COMPLAINT_HOLD_PCT), first health check (+ the daily
 *                 webhook status read when MAILERCLOUD_WEBHOOK_ID is set)
 *   T−60 (06:30)  from here every tick hands the run to `advanceRun(run,'cron')`:
 *                 the build freezes and both drafts are created; failures retry
 *                 on `retryPolicy` (build backoff, the pending-variant render)
 *   T−15 (07:15)  second health check; hourly while a FATAL error is open,
 *                 resuming a FATAL-failed variant when it passes (`health.ts`)
 *   T    (07:30)  schedule — once approved, or when approval is not required
 *                 (the runner's gates: quiet hours re-checked on a fresh clock)
 *   T+10/+30/+60, then hourly   verification polls (`nextVerifyAt`)
 *   T+60 (08:30)  "not approved yet" email, once, while approval is pending
 *   cut-off (17:00)  every tick from now on runs the runner's cut-off sweep
 *
 * Days before today that are still open (the app was down at 17:00) are swept
 * too: `advanceRun` on a past day only ever runs the cut-off sweep.
 *
 * Nothing here calls `schedule()`, `createDraft()` or decides a gate: the runner
 * (`advanceRun`) is the only door and enforces every rule; its step claims and
 * stale-claim takeover keep a second replica or an overlapping tick from acting
 * twice, and its write-ahead markers make a restart mid-step resume correctly.
 *
 * Logging: ONE compact line per run state change (build, approval, variant
 * states, attempts, health), never per idle tick. Ids and states only.
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

/* ------------------------------------------------------------------ */
/* The day plan                                                        */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
/** Design §8 "Not approved by T": the email goes out at T + 60 min. */
export const NOT_APPROVED_EMAIL_AFTER_MIN = 60;
/** How far back the tick looks for an earlier day left open (the app was down at its cut-off). */
const STALE_RUN_LOOKBACK_DAYS = 7;
/** How far back the complaint check looks for the previous send. */
const COMPLAINT_LOOKBACK_DAYS = 7;

/** Every instant of one IST day's plan (§5 timeline), from the config. */
export type DigestDayPlan = {
  /** When the run row is created: the first health check, or the build if that is earlier. */
  openAt: Date;
  healthAt: Date[];
  buildAt: Date;
  sendAt: Date;
  notApprovedEmailAt: Date;
  cutoffAt: Date;
};

export function digestDayPlan(runDate: Date, cfg: Pick<DigestEnv, 'sendAt' | 'cutoff' | 'buildLeadMinutes'>): DigestDayPlan {
  const sendAt = istInstant(runDate, cfg.sendAt);
  const buildAt = new Date(sendAt.getTime() - cfg.buildLeadMinutes * MINUTE);
  const healthAt = healthSlots(runDate, cfg);
  return {
    openAt: new Date(Math.min(buildAt.getTime(), healthAt[0].getTime())),
    healthAt,
    buildAt,
    sendAt,
    notApprovedEmailAt: new Date(sendAt.getTime() + NOT_APPROVED_EMAIL_AFTER_MIN * MINUTE),
    cutoffAt: istInstant(runDate, cfg.cutoff),
  };
}

/* ------------------------------------------------------------------ */
/* The tick                                                            */
/* ------------------------------------------------------------------ */

export type TickDeps = {
  sender: DigestSender;
  cfg?: DigestEnv;
  quiet?: { start: string; end: string };
  /** The tick instant (default: the wall clock). */
  now?: Date;
  /** The live clock the runner re-reads right before schedule() (default: the wall clock, or `now` in tests). */
  clock?: () => Date;
  /** Default: the configured portal (`RSS_PORTAL`, "taxscan"). */
  portals?: string[];
  /** Default: the builder (`selectDigest`). */
  selectItems?: SelectItems;
  buildContent?: BuildContent;
  /** Passed to `advanceRun` (`false` = no alert emails; tests). Also used for the pre-build alert pass. */
  alerts?: AdvanceDeps['alerts'];
  awaitAlerts?: boolean;
  claimStaleMinutes?: number;
  /** Where the compact state-change lines go (default: console.log). */
  log?: (line: string) => void;
};

export type TickReport = {
  /** Set when an earlier tick of THIS ticker was still running. */
  skipped?: 'in_flight';
  portals: { portal: string; runId: string | null; did: string[]; advance: AdvanceResult | null; error?: string }[];
};

/** Run id → the last state signature logged, so an unchanged minute prints nothing. */
const lastLogged = new Map<string, string>();

/** For tests: forget what was logged (a "restart"). */
export function resetDigestTickLogForTests(): void {
  lastLogged.clear();
}

/** Step names that are a pause, not a change — never worth a line on their own. */
const IDLE_STEP = /(^|:)(wait:|waiting_retry|claimed_elsewhere|failed:waiting_for_human|failed:terminal|skipped:)/;

/**
 * One tick: for each portal, sweep any earlier open day, then move today's run
 * along the day plan. Never throws: an error is logged (no values) and the next
 * minute tries again.
 */
export async function digestTick(deps: TickDeps): Promise<TickReport> {
  const cfg = deps.cfg ?? env.digest;
  const report: TickReport = { portals: [] };
  if (!cfg.enabled) return report;
  for (const portal of deps.portals ?? [env.rss.portal]) {
    const entry: TickReport['portals'][number] = { portal, runId: null, did: [], advance: null };
    report.portals.push(entry);
    try {
      await portalTick(portal, deps, cfg, entry);
    } catch (err) {
      entry.error = err instanceof Error ? err.name : 'error';
      // eslint-disable-next-line no-console
      console.error(`[digest] tick failed portal=${portal}`, safeErrorLog(err, { stack: true }));
    }
  }
  if (deps.awaitAlerts) await awaitDigestAlerts();
  return report;
}

async function portalTick(portal: string, deps: TickDeps, cfg: DigestEnv, entry: TickReport['portals'][number]): Promise<void> {
  const now = deps.now ?? new Date();
  const today = istDateOf(now);
  const advanceDeps = (): AdvanceDeps => ({
    sender: deps.sender,
    now,
    clock: deps.clock ?? (deps.now ? () => now : () => new Date()),
    cfg,
    ...(deps.quiet ? { quiet: deps.quiet } : {}),
    ...(deps.buildContent ? { buildContent: deps.buildContent } : {}),
    selectItems: deps.selectItems ?? ((run, at) => selectDigest(run, at, { cfg })),
    ...(deps.alerts !== undefined ? { alerts: deps.alerts } : {}),
    ...(deps.awaitAlerts ? { awaitAlerts: true } : {}),
    ...(deps.claimStaleMinutes !== undefined ? { claimStaleMinutes: deps.claimStaleMinutes } : {}),
    log: () => undefined, // the tick prints one compact line per change instead
  });

  // 1. An earlier day still open (the app was down at its cut-off): the runner sweeps it.
  for (const old of await openEarlierRuns(portal, today)) {
    const r = await advanceRun(old.id, 'cron', advanceDeps());
    await logChange(old.id, r.steps, deps);
  }

  // 2. Today, along the plan.
  const plan = digestDayPlan(today, cfg);
  if (now.getTime() < plan.openAt.getTime()) return;
  let run = await prisma.digestRun.findUnique({ where: { portal_runDate: { portal, runDate: today } } });
  if (!run) {
    // A day that never opened before its cut-off (switched on late, or down all day) is not
    // created afterwards: nothing could be sent, and the next build's window covers its stories.
    if (isPastCutoff(now, today, cfg.cutoff)) return;
    run = await ensureRun({ portal, now, cfg });
    entry.did.push('run:created');
  }
  entry.runId = run.id;
  const steps: string[] = [];

  if (await complaintCheckOnce(run, now, cfg)) steps.push('complaint:checked');

  const health = await runHealthChecks(run.id, { sender: deps.sender, cfg, now, advance: advanceDeps() });
  if (health.checked) steps.push(`health:${health.ok ? 'ok' : 'failed'}`);
  if (health.recovered) steps.push('health:recovered');
  if (health.webhook) steps.push(`webhook:${health.webhook}`);
  if (health.resumed) steps.push(...health.resumed.steps.map((x) => `health>${x}`));

  if (now.getTime() >= plan.buildAt.getTime()) {
    if (await notApprovedYetOnce(run.id, now, cfg, plan)) steps.push('not_approved_yet');
    entry.advance = await advanceRun(run.id, 'cron', advanceDeps());
    steps.push(...entry.advance.steps);
  } else {
    // Before the build nothing else runs, but a health failure or a complaint hold is mailed now.
    await alertPass(run.id, deps, cfg, now);
  }
  entry.did.push(...steps);
  await logChange(run.id, steps, deps);
}

/** Earlier days (≤ 7) that are not final yet: an unbuilt run, or a variant that could still change. */
async function openEarlierRuns(portal: string, today: Date): Promise<{ id: string }[]> {
  const notTerminal: Prisma.DigestSendWhereInput = {
    OR: [{ lastError: null }, { AND: TERMINAL_ERRORS.map((e) => ({ NOT: { lastError: { startsWith: e } } })) }],
  };
  return prisma.digestRun.findMany({
    where: {
      portal,
      runDate: { lt: today, gte: new Date(today.getTime() - STALE_RUN_LOOKBACK_DAYS * DAY_MS) },
      OR: [
        { build: { in: ['BUILDING', 'BUILD_FAILED'] } },
        { sends: { some: { state: { in: ['PENDING', 'CREATED', 'SCHEDULED'] } } } },
        { sends: { some: { AND: [{ state: 'FAILED' }, notTerminal] } } },
      ],
    },
    orderBy: { runDate: 'asc' },
    select: { id: true },
  });
}

/** The alert pass on its own (before the build no `advanceRun` runs to start it). */
async function alertPass(runId: string, deps: TickDeps, cfg: DigestEnv, now: Date): Promise<void> {
  if (deps.alerts === false) return;
  try {
    if (deps.alerts) await deps.alerts(runId);
    else await sendDigestAlerts(runId, { cfg, now });
  } catch {
    // sendDigestAlerts never throws; an injected hook's failure is not the tick's.
  }
}

/* ------------------------------------------------------------------ */
/* The complaint-rate hold (design §8 last row)                        */
/* ------------------------------------------------------------------ */

/**
 * The previous send's spam-complaint rate, judged once per run when the run
 * opens. Per variant of the most recent earlier run that went out (SENT or
 * PARTIALLY_SENT, within 7 days): rate = complaints / delivered, with complaints
 * from `digestSendStats()` (rolled + live, the single implementation) and
 * delivered = Mailercloud's `reached`.
 *
 * UNKNOWN is not 0: a send with no webhook proof (or webhooks off, or no
 * delivered count) has `ratePct` null. It never holds — a hold on missing data
 * would stop every digest whenever the webhook is down — but the banner says the
 * rate is unknown while sending is live, so the gap is visible.
 *
 * held (any known rate ABOVE DIGEST_COMPLAINT_HOLD_PCT) → the run needs an
 * editor's approval whatever DIGEST_APPROVAL_REQUIRED says (`holds.ts`), the
 * run's approval becomes PENDING, and a `complaint_hold` alert names the rate.
 * Returns true when THIS call recorded the check.
 */
export async function complaintCheckOnce(run: DigestRun, now: Date, cfg: DigestEnv): Promise<boolean> {
  if (run.complaintCheck !== null) return false;
  const check = await judgeComplaints(run, now, cfg);
  const won = await prisma.digestRun.updateMany({
    where: { id: run.id, complaintCheck: { equals: Prisma.DbNull } },
    data: { complaintCheck: check as unknown as Prisma.InputJsonValue },
  });
  if (won.count !== 1) return false;
  if (check.held) {
    await prisma.digestRun.updateMany({ where: { id: run.id, approval: 'NOT_REQUIRED' }, data: { approval: 'PENDING' } });
    const worst = [...check.sends].filter((x) => x.ratePct !== null).sort((a, b) => (b.ratePct ?? 0) - (a.ratePct ?? 0))[0];
    await recordRunAlert(run.id, 'complaint_hold', now, {
      audience: worst.audience,
      ratePct: worst.ratePct,
      complaints: worst.complaints,
      delivered: worst.delivered,
      thresholdPct: check.thresholdPct,
      previousRunDate: check.previousRunDate,
    });
  }
  return true;
}

/**
 * The sends a complaint check looks at: those that went out (SENT, PARTIALLY_SENT) and
 * — owner, 2026-10-23 — those still unconfirmed at the cut-off (FAILED
 * `not_confirmed_by_cutoff`): they may have gone out, so they are judged too, always
 * as UNKNOWN (no delivered count), which shows the "rate unknown" banner and never holds.
 */
const JUDGED_SENDS: Prisma.DigestSendWhereInput = {
  OR: [{ state: { in: ['SENT', 'PARTIALLY_SENT'] } }, { state: 'FAILED', lastError: { startsWith: 'not_confirmed_by_cutoff' } }],
};

export async function judgeComplaints(run: Pick<DigestRun, 'portal' | 'runDate'>, now: Date, cfg: DigestEnv): Promise<ComplaintCheck> {
  const base = { checkedAt: now.toISOString(), thresholdPct: cfg.complaintHoldPct };
  const prev = await prisma.digestRun.findFirst({
    where: {
      portal: run.portal,
      runDate: { lt: run.runDate, gte: new Date(run.runDate.getTime() - COMPLAINT_LOOKBACK_DAYS * DAY_MS) },
      sends: { some: JUDGED_SENDS },
    },
    orderBy: { runDate: 'desc' },
    select: { runDate: true, sends: { where: JUDGED_SENDS, select: { id: true, audience: true, reached: true, state: true } } },
  });
  if (!prev) return { ...base, held: false, previousRunDate: null, sends: [] };
  const stats = cfg.webhooksEnabled ? await digestSendStats(prev.sends.map((x) => x.id)) : new Map();
  const sends = prev.sends.map((x) => {
    const complaints: number | null = stats.get(x.id)?.complaints ?? null;
    const unconfirmed = x.state === 'FAILED';
    const delivered = !unconfirmed && x.reached !== null && x.reached > 0 ? x.reached : null;
    const ratePct = complaints !== null && delivered !== null ? Math.round((complaints / delivered) * 100 * 10_000) / 10_000 : null;
    return { audience: x.audience as string, complaints, delivered, ratePct, ...(unconfirmed ? { unconfirmed: true } : {}) };
  });
  const held = sends.some((x) => x.ratePct !== null && x.ratePct > cfg.complaintHoldPct);
  return { ...base, held, previousRunDate: runDateKey(prev.runDate), sends };
}

/* ------------------------------------------------------------------ */
/* "Not approved yet" (design §8 "Not approved by T": email at T+60)   */
/* ------------------------------------------------------------------ */

/**
 * Raises `not_approved_yet` (an email to editors) once per run, from T+60 until
 * the cut-off, only while sending is live and an approval is still what stands
 * between a built variant and its send: the run's approval is PENDING (a HELD run
 * is an editor's decision, not forgotten), or a variant waits for its own.
 * Returns true when THIS call raised it.
 */
async function notApprovedYetOnce(runId: string, now: Date, cfg: DigestEnv, plan: DigestDayPlan): Promise<boolean> {
  if (!cfg.sendLive) return false;
  if (now.getTime() < plan.notApprovedEmailAt.getTime() || now.getTime() >= plan.cutoffAt.getTime()) return false;
  const run = await prisma.digestRun.findUnique({
    where: { id: runId },
    include: { sends: { select: { audience: true, state: true, html: true, contentPendingAt: true, ownApprovalRequired: true, approvedAt: true, adoptedDraftAt: true } } },
  });
  if (!run || run.build !== 'BUILT') return false;
  const open = run.sends.filter((x) => (x.state === 'PENDING' || x.state === 'CREATED') && x.contentPendingAt === null && x.html !== null);
  if (open.length === 0) return false;
  const runPending = runNeedsApproval(cfg, run) && run.approval === 'PENDING';
  const variants = open.filter((x) => awaitingOwnApproval(cfg, run, x)).map((x) => x.audience);
  if (!runPending && variants.length === 0) return false;
  return recordRunAlert(runId, 'not_approved_yet', now, variants.length && !runPending ? { audiences: variants } : {});
}

/* ------------------------------------------------------------------ */
/* One compact line per change                                         */
/* ------------------------------------------------------------------ */

async function logChange(runId: string, steps: string[], deps: TickDeps): Promise<void> {
  const run = await prisma.digestRun.findUnique({
    where: { id: runId },
    include: { sends: { orderBy: { audience: 'asc' }, select: { audience: true, state: true, attempts: true, lastErrorKind: true, mcCampaignId: true, approvedAt: true } } },
  });
  if (!run) return;
  const sig = JSON.stringify([
    run.build,
    run.approval,
    run.skipReason,
    run.buildAttempts,
    run.healthOk,
    run.webhookActive,
    run.sends.map((x) => [x.audience, x.state, x.attempts, x.lastErrorKind, Boolean(x.mcCampaignId), Boolean(x.approvedAt)]),
  ]);
  if (lastLogged.get(runId) === sig) return;
  lastLogged.set(runId, sig);
  const variants = run.sends.map((x) => `${x.audience}=${x.state}${x.attempts ? `/${x.attempts}` : ''}`).join(' ');
  const did = steps.filter((x) => !IDLE_STEP.test(x));
  const line =
    `[digest] ${runDateKey(run.runDate)} run=${run.id} ${digestRunState(run, run.sends)} build=${run.build} approval=${run.approval}` +
    `${run.healthOk === null ? '' : ` health=${run.healthOk ? 'ok' : 'failed'}`}${variants ? ` ${variants}` : ''}` +
    `${run.skipReason ? ` skip=${run.skipReason}` : ''}${did.length ? ` — ${did.join(', ')}` : ''}`;
  (deps.log ?? consoleLog)(line);
}

// eslint-disable-next-line no-console
const consoleLog = (line: string): void => console.log(line);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/**
 * A ticker with an in-process single-flight guard: a tick that starts while the
 * previous one is still running is skipped (like the pacer). Across processes
 * (two replicas, a deploy overlap) the runner's step claims are the guard.
 */
export function createDigestTicker(deps: Omit<TickDeps, 'now'> & { now?: () => Date }): { tick: () => Promise<TickReport> } {
  let running = false;
  return {
    async tick(): Promise<TickReport> {
      if (running) {
        // eslint-disable-next-line no-console
        console.log('[digest] previous tick still running, skipping');
        return { skipped: 'in_flight', portals: [] };
      }
      running = true;
      try {
        // The tick instant is fixed for the tick, but the runner's re-check right before
        // schedule() (quiet hours / cut-off) must read a LIVE clock: a slow step must not
        // schedule on the strength of the minute it started. Only a test that pins `now`
        // (and gives no clock) gets a frozen one.
        const clock = deps.clock ?? (deps.now ? undefined : () => new Date());
        return await digestTick({ ...deps, now: deps.now ? deps.now() : new Date(), ...(clock ? { clock } : {}) });
      } finally {
        running = false;
      }
    },
  };
}

/** How the cron is started (injectable so tests never start a real one). */
export type CronStarter = (expression: string, fn: () => void, timezone: string) => { stop: () => void };

const nodeCronStarter: CronStarter = (expression, fn, timezone) => cron.schedule(expression, fn, { timezone });

export type StartOptions = {
  /** Default: the Mailercloud client (E2E_MOCK_SENDER passes its in-memory stand-in). */
  sender?: DigestSender;
  /** Default: node-cron. */
  startCron?: CronStarter;
};

/**
 * Boot entry point, called from src/index.ts next to the other crons. Never
 * throws: a bad digest config must not take push down with it. A refused
 * schedule (e.g. a send time inside quiet hours) leaves the scheduler stopped.
 */
export function startDigestScheduler(
  cfg: DigestEnv = env.digest,
  quiet: { start: string; end: string } = { start: env.send.quietStart, end: env.send.quietEnd },
  opts: StartOptions = {},
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
    // Our own message about the malformed QUIET_HOURS_* value (no secret can be in it), redacted anyway.
    check = { ok: false, reason: redactError(err) };
  }
  // A no-reply From/Reply-To is refused at boot too (design §1 #9); the address is never logged.
  const addr = senderAddressProblems(cfg.mailercloud);
  if (check.ok && addr.length > 0) check = { ok: false, reason: addr.join('; ') };
  if (!check.ok) {
    // eslint-disable-next-line no-console
    console.error(`[digest] config_invalid — not started: ${check.reason}`);
    return 'config_invalid';
  }
  if (!opts.sender && !isProviderConfigured(cfg)) {
    // eslint-disable-next-line no-console
    console.warn('[digest] not configured (MAILERCLOUD_API_KEY is unset) — not started');
    return 'not_configured';
  }
  const sender = opts.sender ?? createMailercloudSender(cfg);
  const ticker = createDigestTicker({ sender, cfg, quiet });
  (opts.startCron ?? nodeCronStarter)(
    '* * * * *',
    () => {
      void ticker.tick();
    },
    'Asia/Kolkata',
  );
  const s = check.schedule;
  // eslint-disable-next-line no-console
  console.log(
    `[digest] ready (tick every minute) build=${s.buildAt} send=${s.sendAt} cutoff=${s.cutoff} IST` +
      ` approval=${cfg.approvalRequired ? 'required' : 'off'} sendLive=${cfg.sendLive ? 'on' : 'off'}` +
      ` webhooks=${cfg.webhooksEnabled ? 'on' : 'off'}` +
      ` webhookStatus=${cfg.webhooksEnabled && cfg.mailercloud.webhookId ? 'daily' : 'liveness-only'}`,
  );
  return 'ready';
}
