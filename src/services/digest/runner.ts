import type { DigestAudience, DigestRun, DigestSend, Prisma, SenderErrorKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { isQuietHours } from '../../lib/quietHours';
import { recordAudit } from '../../lib/audit';
import {
  SenderError,
  errorKind,
  redactError,
  type AudienceTarget,
  type CampaignStatus,
  type DigestSender,
} from './sender';
import { isPastCutoff, istDateOf, istInstant, nextAttemptAt, runDateKey } from './retryPolicy';
import { digestRunState, type DigestRunState } from './runState';
import { senderAddressProblems, type AdPlacementRecord, type BuildContent, type TemplateFallback } from './renderer';
import { renderDigestContent } from './content';
import { AdSlotError, assertPlacementsAllowed } from './ads';
import { writeDigestItems, type DigestSelection, type FrozenItem } from './builder';
import { sendDigestAlerts } from './alerts';
import { recordRunAlert } from './runAlerts';
import { checkWebhookLiveness } from './webhookLiveness';
import { awaitingOwnApproval as variantAwaitingOwnApproval, isComplaintHeld, runNeedsApproval } from './holds';
import { isDuplicateNameError } from './sender';

/**
 * The digest state machine and the ONLY door a digest leaves through
 * (docs/EMAIL_DIGEST_DESIGN.md §2.1, §4, §8).
 *
 * `advanceRun(runId, trigger)` moves a run as far forward as its gates allow:
 *
 *   build (freeze content) → createDraft (per variant) → schedule('now') → verify
 *
 * GOVERNING PRINCIPLE: `schedule()` / `createDraft()` are called only when we
 * can PROVE they were not already called for that variant. Proof is a
 * write-ahead marker (`scheduleAttemptedAt` / `createAttemptedAt`) that is
 * still null inside the atomic claim update which sets it, BEFORE the provider
 * call. A set marker (ambiguous reply, crashed container, stale takeover,
 * Retry now, Send now) means "ask the provider first" (`status()` /
 * `findCampaignByName`); if the provider cannot say, stop and alert. A missed
 * digest rolls forward; a double send cannot be undone.
 *
 * Every gate lives in here, so every door (cron tick, Retry now, Send now,
 * health recovery, bearer curl) gets the same rules:
 *
 *  - flag:        DIGEST_ENABLED off → nothing at all; DIGEST_SEND_LIVE off →
 *                 drafts only, schedule() is never called ("preview only").
 *  - cut-off:     at/after 17:00 IST on the run's date (or any later day) the
 *                 run is swept; re-checked on a fresh clock right before schedule().
 *  - quiet hours: schedule() is never called inside 23:00–07:00 IST (same re-check).
 *  - approval:    with DIGEST_APPROVAL_REQUIRED, schedule() waits for APPROVED;
 *                 HELD always waits. Still waiting at the cut-off → skipped.
 *  - one per day: unique (portal, runDate) + the write-ahead marker above.
 *  - frozen:      content is written once, at build; every later step sends the
 *                 stored html. Nothing re-renders after the freeze.
 *  - audience:    a variant whose list config is incomplete (Free without a
 *                 premium exclude) is never created — FATAL, alert.
 *
 * Every decision is taken from a row re-read AFTER winning its claim, never
 * from a snapshot read earlier in the run.
 *
 * TASK 3: the state machine; no cron calls this yet.
 * TASK 4: with `selectItems` (the builder, `selectDigest`) the build step
 * selects + ranks the stories and freezes them as DigestItem rows in the same
 * transaction as `builtAt`; too little news skips the run (items still roll
 * forward), > DIGEST_SANITY_MAX_CANDIDATES holds it for an editor.
 * TASK 5: content comes from the renderer (`renderer.ts`) and is frozen here
 * once; a render refusal (no address, off-allowlist link, over the size limit,
 * no-reply sender) fails the build loud (BUILD_FAILED + build_failed alert).
 * Without `selectItems` there are no items, so the build fails the same way.
 * TASK 9: the default content also picks one house ad per drawn slot. A slot
 * no ad can fill (`AdSlotError`) fails the build CLOSED with `config_invalid`:
 * nothing is frozen or created, the run stays BUILD_FAILED so a fix on the
 * Ads screen before the cut-off lets the next attempt build, and the cut-off
 * skips it as `config_invalid`. At freeze the placements are checked once
 * more (no SUBSCRIPTION ad in PREMIUM, allowlisted link, no ad twice) against
 * the ad rows as they are NOW, and recorded as DigestAdPlacement per send.
 * TASK 9 FOLLOW-UPS (owner, 2026-10-23):
 *  - Per-audience ad failure. When only ONE audience's slots cannot be filled,
 *    the run still freezes (stories, the other audience's content) and the
 *    broken variant is written FAILED with `contentPendingAt` set and
 *    `lastError "ads_unfillable: …"`: no html, so no draft can exist. Every
 *    later door renders it from the FROZEN stories once ads are fixed
 *    (`renderPendingStep`, on the retry policy), then it goes through the same
 *    create → schedule gates as any variant; still pending at the cut-off it
 *    is SKIPPED `config_invalid`. Both audiences broken → BUILD_FAILED as before.
 *  - A failed build retries on the retry policy (`buildNextAttemptAt`), not
 *    every tick; Retry now skips the wait. The cut-off is unchanged.
 *  - The run records the CURRENT build failure (`buildFailure`, `buildError`),
 *    which the cut-off reason and the banner read; the once-per-run alert
 *    markers are history, not current state.
 * TASK 13 (2026-10-23): the scheduler tick (`scheduler.ts`) is the cron door;
 * health recovery (`health.ts`) the 'health' door. New here:
 *  - the complaint hold (`holds.ts`): a run whose previous send's spam rate was
 *    above DIGEST_COMPLAINT_HOLD_PCT waits for an editor's approval in any mode;
 *  - owner decision A: a variant that ADOPTS a Mailercloud DRAFT (or a campaign
 *    whose status cannot be read) needs a person's approval of its own before it
 *    is scheduled, in any mode, and raises `adopted_existing` (the draft may hold
 *    content from before a database restore) — only when this database never tried
 *    to create it (no earlier `createSentAt` — the stamp written just before the
 *    createDraft() call; owner, narrowed 2026-10-23);
 *  - a lookup that finds two campaigns with the exact name is its own problem
 *    (`duplicate_name: …`, alert `duplicate_name`), retried on the policy so the
 *    variant carries on once a person deletes the extra campaign;
 *  - in approval mode the build raises `ready_for_approval` (an email to editors);
 *  - `deps.log` lets the tick collect the step lines instead of printing each one.
 */

/** The builder as the runner sees it (default none = task-3 behaviour, no items). */
export type SelectItems = (run: { id: string; portal: string; runDate: Date }, now: Date) => Promise<DigestSelection>;

export type DigestTrigger = 'cron' | 'retry' | 'send_now' | 'health';

export type AdvanceDeps = {
  sender: DigestSender;
  /** The instant stamped on rows and used for the gates (default: now). */
  now?: Date;
  /** Read again right before schedule() for the quiet-hours / cut-off re-check (default: () => now). */
  clock?: () => Date;
  cfg?: DigestEnv;
  quiet?: { start: string; end: string };
  /** Default: the renderer (`renderDigestContent`, task 5). Tests may inject a stub. */
  buildContent?: BuildContent;
  /**
   * The builder (task 4): `(run, now) => selectDigest(run, now)`. Injected, not
   * defaulted, so a caller decides when real stories are frozen; the scheduler
   * wiring (later task) passes it. Without it there are no items: the
   * default renderer refuses and the build fails loud (a stub `buildContent`,
   * as in the state-machine tests, can still freeze without items).
   */
  selectItems?: SelectItems;
  /** A step claim older than this is considered abandoned (crashed container). */
  claimStaleMinutes?: number;
  /**
   * Runs after every advance (task 6): emails the run's new alert markers.
   * Default: `sendDigestAlerts` with the real ElasticEmail sender. `false`
   * turns it off. It is started after the state machine has finished and is
   * NOT awaited — a slow mailer never holds up a tick, Retry now or Send now —
   * and a throw is swallowed. Await it with `awaitDigestAlerts()`.
   */
  alerts?: ((runId: string) => Promise<unknown>) | false;
  /** Tests: wait for the alert pass before returning (default false: fire-and-forget). */
  awaitAlerts?: boolean;
  /**
   * Where each step line goes (default: `console.log`). The scheduler tick passes
   * a collector so an idle minute prints nothing and a change prints ONE line.
   * Lines carry ids and states only — never an address, a key or a full URL.
   */
  log?: (line: string) => void;
};

export type AdvanceResult = {
  runId: string;
  outcome: 'disabled' | 'not_found' | 'refused' | 'advanced';
  /** Why a Retry now / Send now was refused, in plain words. */
  reason?: string;
  /** Human-readable trail of what happened, e.g. "FREE:create:ok", "PREMIUM:wait:quiet_hours". */
  steps: string[];
  state: DigestRunState | null;
};

/** Alert kinds recorded on `DigestRun.alerts`; `alerts.ts` emails each once per run (task 6). */
export type DigestAlertKind =
  | 'fatal'
  | 'config_invalid'
  | 'ambiguous_create'
  | 'schedule_unconfirmed'
  | 'orphan_draft'
  | 'adopted_existing'
  | 'retrying'
  | 'skipped'
  | 'partial_send'
  | 'provider_failed'
  | 'not_confirmed_by_cutoff'
  | 'build_failed'
  | 'sanity_hold'
  | 'webhook_silent'
  | 'template_fallback'
  // Task 13
  | 'duplicate_name'
  | 'ready_for_approval'
  | 'not_approved_yet'
  | 'health_failed'
  | 'health_recovered'
  | 'complaint_hold'
  | 'webhook_disabled';

/**
 * `lastError` prefixes that end a FAILED variant for the day: no door resumes
 * it. Re-scheduling a campaign the provider reported FAILED waits for the
 * design's open question 3 (is a second schedule a no-op?).
 */
export const TERMINAL_ERRORS = ['provider_failed', 'not_confirmed_by_cutoff', 'frozen_html_missing'] as const;

const AUDIENCES: DigestAudience[] = ['FREE', 'PREMIUM'];
const MINUTE = 60_000;
/** Verification polls after schedule: +10 m, +30 m, +60 m, then hourly. */
const VERIFY_OFFSETS_MIN = [10, 30, 60];

type Ctx = {
  run: DigestRun;
  trigger: DigestTrigger;
  sender: DigestSender;
  now: Date;
  clock: () => Date;
  cfg: DigestEnv;
  quiet: { start: string; end: string };
  cutoffAt: Date;
  staleMs: number;
  steps: string[];
  refusals: string[];
  buildContent: BuildContent;
  emit: (line: string) => void;
};

/* ------------------------------------------------------------------ */
/* Run creation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Today's run, created once. The unique (portal, runDate) IS the "one digest
 * per day" rule: a concurrent second create loses on the constraint and gets
 * the existing row back.
 */
export async function ensureRun(
  opts: { portal?: string; now?: Date; cfg?: DigestEnv } = {},
): Promise<DigestRun> {
  const portal = opts.portal ?? env.rss.portal;
  const now = opts.now ?? new Date();
  const cfg = opts.cfg ?? env.digest;
  const runDate = istDateOf(now);
  const existing = await prisma.digestRun.findUnique({ where: { portal_runDate: { portal, runDate } } });
  if (existing) return existing;
  const prev = await prisma.digestRun.findFirst({
    where: { portal, runDate: { lt: runDate }, builtAt: { not: null } },
    orderBy: { runDate: 'desc' },
    select: { builtAt: true },
  });
  try {
    return await prisma.digestRun.create({
      data: {
        portal,
        runDate,
        // Builder (task 4) owns the real window rule (§4.1); this is its fallback.
        windowStart: prev?.builtAt ?? new Date(now.getTime() - 24 * 60 * MINUTE),
        approval: cfg.approvalRequired ? 'PENDING' : 'NOT_REQUIRED',
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return prisma.digestRun.findUniqueOrThrow({ where: { portal_runDate: { portal, runDate } } });
    }
    throw err;
  }
}

/** The portal whose campaign names carry no portal part (the schema default). */
const DEFAULT_PORTAL = 'taxscan';

/**
 * The provider campaign name of a variant: `TS-DIGEST-<yyyy-mm-dd>-<AUDIENCE>`
 * (IST date), with the portal after the prefix for any portal but taxscan
 * (`TS-DIGEST-academy-2026-10-23-FREE`).
 *
 * Deterministic per (portal, run date, audience) and deliberately WITHOUT the
 * run id (2026-10-23, QA O1): a database restored from the 02:20 backup holds
 * no run for today, so `ensureRun` makes a NEW run — and only a name that the
 * new run computes identically lets `findCampaignByName` find the campaign the
 * lost run already sent this morning. The provider becomes the source of truth
 * for "already done today" (see `lookupThenCreate`). Names stored in the older
 * `…-<AUDIENCE>-<runId>` form stay valid: the webhook links by the stored name.
 */
export function digestProviderCampaignName(portal: string, runDate: Date, audience: DigestAudience): string {
  const portalPart = portal === DEFAULT_PORTAL ? '' : `${portal}-`;
  return `TS-DIGEST-${portalPart}${runDateKey(runDate)}-${audience}`;
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/**
 * The provider target for a variant, or why it may not be created. Fails
 * closed: Free needs a list AND a premium exclude; Premium needs a list,
 * segment or tag.
 */
export function audienceTarget(
  cfg: DigestEnv,
  audience: DigestAudience,
): { ok: true; target: AudienceTarget } | { ok: false; reason: string } {
  if (audience === 'FREE') {
    const a = cfg.audiences.free;
    if (a.listIds.length === 0) return { ok: false, reason: 'DIGEST_FREE_LIST_IDS is empty' };
    if (a.excludeListIds.length === 0 && a.excludeTagIds.length === 0) {
      return { ok: false, reason: 'Free has no premium exclude (DIGEST_FREE_EXCLUDE_LIST_IDS / _TAG_IDS)' };
    }
    return {
      ok: true,
      target: { listIds: a.listIds, segmentIds: [], tagIds: [], excludeListIds: a.excludeListIds, excludeTagIds: a.excludeTagIds },
    };
  }
  const p = cfg.audiences.premium;
  if (p.listIds.length === 0 && p.segmentIds.length === 0 && p.tagIds.length === 0) {
    return { ok: false, reason: 'Premium has no list, segment or tag (DIGEST_PREMIUM_*_IDS)' };
  }
  return {
    ok: true,
    target: { listIds: p.listIds, segmentIds: p.segmentIds, tagIds: p.tagIds, excludeListIds: [], excludeTagIds: [] },
  };
}

/** Problems that stop the build itself (§5: the build fails closed without a postal address). */
function buildConfigProblems(cfg: DigestEnv): string[] {
  const problems: string[] = [];
  if (!cfg.postalAddress) problems.push('DIGEST_POSTAL_ADDRESS is empty');
  problems.push(...senderAddressProblems(cfg.mailercloud));
  for (const a of AUDIENCES) {
    const t = audienceTarget(cfg, a);
    if (!t.ok) problems.push(t.reason);
  }
  return problems;
}


/* ------------------------------------------------------------------ */
/* Small DB helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Atomic step claim, the same pattern as `Campaign.claimedAt`: only one runner
 * (e.g. two containers mid-deploy) wins the conditional update. `where` adds
 * the conditions that make the step legal — evaluated by the database under
 * the row lock, not on a snapshot. `extra` is written in the SAME update (the
 * write-ahead marker). Returns the claim instant, which fences the step's
 * final write, or null when the claim was not won.
 *
 * The claim is stamped from the LIVE clock (`ctx.clock()`), not the tick's
 * instant (QA of task 13): a step reached late in a slow tick (the name lookup
 * alone may take ~8 min with its retries) must not look minutes old — and so
 * "abandoned" after 10 — to another process the moment it is taken. Tests that
 * pin `now` without a clock get `now`, as before.
 */
async function claimStep(
  sendId: string,
  where: Prisma.DigestSendWhereInput,
  ctx: Ctx,
  extra: Prisma.DigestSendUpdateManyMutationInput = {},
): Promise<Date | null> {
  const claimAt = ctx.clock();
  const r = await prisma.digestSend.updateMany({
    where: {
      AND: [
        { id: sendId },
        where,
        { OR: [{ stepClaimedAt: null }, { stepClaimedAt: { lt: new Date(claimAt.getTime() - ctx.staleMs) } }] },
      ],
    },
    data: { ...extra, stepClaimedAt: claimAt },
  });
  return r.count === 1 ? claimAt : null;
}

/** Writes while still holding the claim (the claim is kept). False when it was taken over. */
async function writeClaimed(sendId: string, claimAt: Date, data: Prisma.DigestSendUpdateManyMutationInput): Promise<boolean> {
  const r = await prisma.digestSend.updateMany({ where: { id: sendId, stepClaimedAt: claimAt }, data });
  return r.count === 1;
}

/** Writes a step's outcome only if our claim still stands; always releases it. */
function finishStep(sendId: string, claimAt: Date, data: Prisma.DigestSendUpdateManyMutationInput): Promise<boolean> {
  return writeClaimed(sendId, claimAt, { ...data, stepClaimedAt: null });
}

function fresh(sendId: string): Promise<DigestSend> {
  return prisma.digestSend.findUniqueOrThrow({ where: { id: sendId } });
}

function isTerminal(s: Pick<DigestSend, 'state' | 'lastError'>): boolean {
  return s.state === 'FAILED' && TERMINAL_ERRORS.some((e) => s.lastError?.startsWith(e));
}

/**
 * Records an alert-needed marker, at most once per kind per run (§3
 * `alerts {kind: …}`). `alerts.ts` emails it and stamps `emailedAt`. Atomic in
 * SQL so two runners cannot both raise it. Never throws.
 */
async function raiseAlert(ctx: Ctx, kind: DigestAlertKind, detail: Record<string, unknown> = {}): Promise<void> {
  await recordRunAlert(ctx.run.id, kind, ctx.now, detail);
}

/** Sets the run's skip reason the first time a variant is skipped. */
async function setRunSkipReason(ctx: Ctx, reason: string): Promise<void> {
  await prisma.digestRun.updateMany({ where: { id: ctx.run.id, skipReason: null }, data: { skipReason: reason } });
}

function log(ctx: Ctx, audience: DigestAudience | null, what: string): void {
  ctx.steps.push(audience ? `${audience}:${what}` : what);
  // Ids and states only — never an address, a key or a full URL.
  ctx.emit(`[digest] run=${ctx.run.id}${audience ? ` ${audience}` : ''} ${what} (${ctx.trigger})`);
}

// eslint-disable-next-line no-console
const consoleLog = (line: string): void => console.log(line);

/* ------------------------------------------------------------------ */
/* The door                                                            */
/* ------------------------------------------------------------------ */

/**
 * Moves one run forward as far as its gates allow (see the file header), then
 * starts the alert mailer without waiting for it. The mailer runs after the
 * state machine is done — even when a step threw — and can neither throw
 * into it, delay it, nor change its result.
 */
export async function advanceRun(runId: string, trigger: DigestTrigger, deps: AdvanceDeps): Promise<AdvanceResult> {
  const cfg = deps.cfg ?? env.digest;
  if (!cfg.enabled) return { runId, outcome: 'disabled', steps: [], state: null };
  let found = true;
  try {
    const r = await advanceRunInner(runId, trigger, deps, cfg);
    found = r.outcome !== 'not_found';
    return r;
  } finally {
    if (found) {
      // Task 8: a send confirmed by polling with no campaign webhook after 2 h
      // raises `webhook_silent`. Read-only apart from the marker; never throws.
      await checkWebhookLiveness(runId, { now: deps.now ?? new Date(), cfg });
      const pass = afterAdvance(runId, deps, cfg);
      inFlightAlerts.add(pass);
      void pass.finally(() => inFlightAlerts.delete(pass));
      if (deps.awaitAlerts) await pass;
    }
  }
}

/** Alert passes started by `advanceRun` and not finished yet. */
const inFlightAlerts = new Set<Promise<void>>();

/** Resolves when every alert pass started so far has finished (tests, graceful shutdown). Never rejects. */
export async function awaitDigestAlerts(): Promise<void> {
  while (inFlightAlerts.size > 0) await Promise.all([...inFlightAlerts]);
}

async function afterAdvance(runId: string, deps: AdvanceDeps, cfg: DigestEnv): Promise<void> {
  if (deps.alerts === false) return;
  const hook = deps.alerts ?? ((id: string) => sendDigestAlerts(id, { cfg, ...(deps.now ? { now: deps.now } : {}) }));
  try {
    await hook(runId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] run=${runId} alert hook failed: ${redactError(err)}`);
  }
}

async function advanceRunInner(runId: string, trigger: DigestTrigger, deps: AdvanceDeps, cfg: DigestEnv): Promise<AdvanceResult> {
  const run = await prisma.digestRun.findUnique({ where: { id: runId } });
  if (!run) return { runId, outcome: 'not_found', steps: [], state: null };

  const now = deps.now ?? new Date();
  const ctx: Ctx = {
    run,
    trigger,
    sender: deps.sender,
    now,
    clock: deps.clock ?? (deps.now ? () => now : () => new Date()),
    cfg,
    quiet: deps.quiet ?? { start: env.send.quietStart, end: env.send.quietEnd },
    cutoffAt: istInstant(run.runDate, cfg.cutoff),
    staleMs: (deps.claimStaleMinutes ?? 10) * MINUTE,
    steps: [],
    refusals: [],
    buildContent: deps.buildContent ?? renderDigestContent,
    emit: deps.log ?? consoleLog,
  };

  if (isPastCutoff(now, run.runDate, cfg.cutoff)) {
    await cutoffSweep(ctx);
    return finish(ctx, 'advanced');
  }

  if (trigger === 'send_now') {
    const refused = await applySendNow(ctx);
    if (refused) return finish(ctx, 'refused', 'a variant is already scheduled, sent or skipped');
  }

  if (run.build === 'BUILDING' || run.build === 'BUILD_FAILED') {
    // A failed build waits for its retry slot on the cron tick (the other doors skip the wait).
    if (trigger === 'cron' && run.build === 'BUILD_FAILED' && run.buildNextAttemptAt && run.buildNextAttemptAt.getTime() > now.getTime()) {
      log(ctx, null, 'build:waiting_retry');
      return finish(ctx, 'advanced');
    }
    const built = await buildStep(ctx, ctx.buildContent, deps.selectItems);
    if (!built) return finish(ctx, 'advanced');
  } else if (run.build === 'SKIPPED') {
    log(ctx, null, `skipped:${run.skipReason ?? 'unknown'}`);
    return finish(ctx, 'advanced');
  }

  // Re-read the run too: approval may have changed since the first read.
  ctx.run = await prisma.digestRun.findUniqueOrThrow({ where: { id: runId } });
  for (const audience of AUDIENCES) {
    const send = await prisma.digestSend.findUnique({ where: { runId_audience: { runId, audience } }, select: { id: true } });
    if (send) await advanceSend(ctx, send.id);
  }

  if ((trigger === 'retry' || trigger === 'send_now') && ctx.refusals.length > 0) {
    const after = await prisma.digestSend.findMany({ where: { runId }, select: { state: true, lastError: true, contentPendingAt: true } });
    // A variant still waiting for its ads is not progress a press can make.
    const actionable = after.some(
      (s) =>
        s.contentPendingAt === null &&
        (s.state === 'PENDING' || s.state === 'CREATED' || s.state === 'SCHEDULED' || (s.state === 'FAILED' && !isTerminal(s))),
    );
    if (!actionable) return finish(ctx, 'refused', ctx.refusals.join('; '));
  }
  return finish(ctx, 'advanced');
}

async function finish(ctx: Ctx, outcome: AdvanceResult['outcome'], reason?: string): Promise<AdvanceResult> {
  const run = await prisma.digestRun.findUniqueOrThrow({ where: { id: ctx.run.id } });
  const sends = await prisma.digestSend.findMany({ where: { runId: run.id }, select: { state: true } });
  return { runId: run.id, outcome, ...(reason ? { reason } : {}), steps: ctx.steps, state: digestRunState(run, sends) };
}


/**
 * Send now moves the planned send instant earlier — nothing else. Refused
 * once any variant is SCHEDULED, SENT, PARTIALLY_SENT or SKIPPED (§2.1).
 * Returns true when refused.
 */
async function applySendNow(ctx: Ctx): Promise<boolean> {
  const done = await prisma.digestSend.count({
    where: { runId: ctx.run.id, state: { in: ['SCHEDULED', 'SENT', 'PARTIALLY_SENT', 'SKIPPED'] } },
  });
  if (done > 0) {
    log(ctx, null, 'send_now:refused');
    return true;
  }
  await prisma.digestSend.updateMany({
    where: { runId: ctx.run.id, state: { in: ['PENDING', 'CREATED', 'FAILED'] }, sendAfter: { gt: ctx.now } },
    data: { sendAfter: ctx.now },
  });
  return false;
}

/* ------------------------------------------------------------------ */
/* Build (freeze)                                                      */
/* ------------------------------------------------------------------ */

/**
 * Freezes the run once. The run moves BUILDING → BUILT in the same transaction
 * that writes the stories and the variant rows, guarded by a conditional
 * update, so two runners cannot build twice and a BUILT run is never
 * re-rendered. Returns false when the run did not reach BUILT.
 *
 * Ads are judged per audience (task 9 follow-ups): a variant whose slots
 * cannot be filled is frozen WITHOUT content (FAILED, `contentPendingAt`,
 * `ads_unfillable: …`) while the other variant is frozen as normal; only when
 * no audience can be filled does the build fail (BUILD_FAILED, as before).
 * Any other failure fails the whole build and is retried on the retry policy.
 */
async function buildStep(ctx: Ctx, buildContent: BuildContent, selectItems?: SelectItems): Promise<boolean> {
  const problems = buildConfigProblems(ctx.cfg);
  if (problems.length > 0) {
    await prisma.digestRun.updateMany({
      where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
      data: { build: 'SKIPPED', skipReason: 'config_invalid', buildNextAttemptAt: null },
    });
    await raiseAlert(ctx, 'config_invalid', { problems });
    await recordAudit({
      action: 'DIGEST_SKIPPED',
      resourceType: 'DigestRun',
      resourceId: ctx.run.id,
      metadata: { reason: 'config_invalid' },
    });
    log(ctx, null, 'build:config_invalid');
    return false;
  }

  let contents: VariantContent[];
  let blocked: { audience: DigestAudience; problems: string[] }[];
  let selection: DigestSelection | null = null;
  try {
    // The window is recomputed on every build attempt (§8: a retried build sees `now`).
    if (selectItems) selection = await selectItems(ctx.run, ctx.now);
    if (selection?.outcome === 'too_little_news') return await skipTooLittleNews(ctx, selection);
    const sel = selection;
    ({ contents, blocked } = await allContents(ctx, buildContent, (a) => sel?.perAudience[a]));
  } catch (err) {
    await recordBuildFailure(ctx, 'build_error', redactError(err));
    await raiseAlert(ctx, 'build_failed', { error: redactError(err) });
    log(ctx, null, 'build:failed');
    return false;
  }

  if (contents.length === 0) {
    // No audience can be filled: fail closed, recoverable the same day. Nothing frozen, nothing created.
    const all = blocked.flatMap((b) => b.problems);
    await recordBuildFailure(ctx, 'ads_unfillable', all.join('; '));
    await raiseAlert(ctx, 'config_invalid', { problems: all, source: 'ads', audiences: blocked.map((b) => b.audience) });
    log(ctx, null, 'build:config_invalid:ads');
    return false;
  }

  const sendAfter = istInstant(ctx.run.runDate, ctx.cfg.sendAt);
  const firstRetry = nextAttemptAt(ctx.now, 1, ctx.cutoffAt) ?? ctx.cutoffAt;
  const built = await prisma.$transaction(async (tx) => {
    const claimed = await tx.digestRun.updateMany({
      where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
      data: {
        build: 'BUILT',
        builtAt: ctx.now,
        buildFailure: null,
        buildError: null,
        buildNextAttemptAt: null,
        ...(selection ? selectionRunFields(selection) : {}),
      },
    });
    if (claimed.count !== 1) return false;
    if (selection) {
      await writeDigestItems(tx, ctx.run.id, selection.rows);
      // Sanity hold: an editor must approve even when approval is off (the gate
      // reads candidateCount; PENDING is set so the screen shows it as waiting).
      if (selection.outcome === 'sanity_hold') {
        await tx.digestRun.updateMany({ where: { id: ctx.run.id, approval: 'NOT_REQUIRED' }, data: { approval: 'PENDING' } });
      }
    }
    const name = (a: DigestAudience) => digestProviderCampaignName(ctx.run.portal, ctx.run.runDate, a);
    const sends = await tx.digestSend.createManyAndReturn({
      select: { id: true, audience: true },
      data: [
        ...contents.map((c) => ({
          runId: ctx.run.id,
          audience: c.audience,
          subject: c.subject,
          preheader: c.preheader,
          html: c.html,
          text: c.text,
          htmlBytes: Buffer.byteLength(c.html, 'utf8'),
          mcCampaignName: name(c.audience),
          sendAfter,
          templateId: c.templateId ?? null,
          templateFallbackFromId: c.templateFallback?.fromId ?? null,
          templateFallbackReason: c.templateFallback?.reason ?? null,
        })),
        // The broken audience: no content, so nothing can be created for it until
        // its ads are fixed and it is rendered from the stories frozen above.
        ...blocked.map((b) => ({
          runId: ctx.run.id,
          audience: b.audience,
          state: 'FAILED' as const,
          subject: '',
          preheader: '',
          html: null,
          text: null,
          htmlBytes: 0,
          mcCampaignName: name(b.audience),
          sendAfter,
          contentPendingAt: ctx.now,
          lastError: adsUnfillableError(b.problems),
          attempts: 1,
          firstFailureAt: ctx.now,
          stepAttempts: 1,
          stepFirstFailureAt: ctx.now,
          nextAttemptAt: firstRetry,
        })),
      ],
    });
    const placements = contents.flatMap((c) => {
      const sendId = sends.find((x) => x.audience === c.audience)?.id;
      return sendId ? (c.placements ?? []).map((p) => ({ sendId, adId: p.adId, slot: p.slot, utmContent: p.utmContent, createdAt: ctx.now })) : [];
    });
    if (placements.length > 0) await tx.digestAdPlacement.createMany({ data: placements });
    return true;
  });
  if (built && blocked.length > 0) {
    const problems = blocked.flatMap((b) => b.problems);
    await raiseAlert(ctx, 'config_invalid', {
      problems,
      source: 'ads',
      audiences: blocked.map((b) => b.audience),
      ...(blocked.length === 1 ? { audience: blocked[0].audience } : {}),
    });
    for (const b of blocked) log(ctx, b.audience, 'build:ads_unfillable:content_pending');
  }
  if (built) await raiseTemplateFallback(ctx, contents);
  if (built && selection?.outcome === 'sanity_hold') {
    await raiseAlert(ctx, 'sanity_hold', { candidates: selection.candidateCount, max: ctx.cfg.sanityMaxCandidates });
    log(ctx, null, `build:sanity_hold:${selection.candidateCount}`);
  }
  // Re-read the run: the freeze transaction set candidateCount (and a sanity hold's approval).
  if (built) ctx.run = await prisma.digestRun.findUniqueOrThrow({ where: { id: ctx.run.id } });
  if (built && approvalNeeded(ctx)) {
    // Task 13 (design §5 06:30 row): editors hear that today's version is ready to approve.
    await raiseAlert(ctx, 'ready_for_approval', {
      audiences: contents.map((c) => c.audience),
      ...(blocked.length ? { pending: blocked.map((b) => b.audience) } : {}),
      reason: holdReasonOf(ctx, selection),
      preview: !ctx.cfg.sendLive,
    });
  }
  if (built && selection) log(ctx, null, `build:items:${selection.rows.length}:reads=${selection.reads.used ? selection.reads.source : 'off'}`);
  log(ctx, null, built ? 'build:frozen' : 'build:claimed_elsewhere');
  return built;
}

/**
 * One alert (email + banner) when a variant was rendered with the built-in template
 * because its custom template failed (owner, 2026-10-23). Once per run, like every kind:
 * a second fallback later the same day (a pending variant) is still visible on the
 * variant row and the banner, which read `templateFallbackFromId`.
 */
async function raiseTemplateFallback(ctx: Ctx, contents: VariantContent[]): Promise<void> {
  const fell = contents.filter((c) => c.templateFallback);
  if (fell.length === 0) return;
  await raiseAlert(ctx, 'template_fallback', {
    audiences: fell.map((c) => c.audience),
    ...(fell.length === 1 ? { audience: fell[0].audience } : {}),
    templates: fell.map((c) => ({ audience: c.audience, id: c.templateFallback!.fromId, name: c.templateFallback!.fromName })),
    templateName: fell[0].templateFallback!.fromName,
    reason: fell[0].templateFallback!.reason,
  });
  for (const c of fell) log(ctx, c.audience, `build:template_fallback:${c.templateFallback!.fromId}`);
}

/** The `lastError` of a variant waiting for its ads (plain words: slot and audience, no URL). */
function adsUnfillableError(problems: string[]): string {
  const text = `ads_unfillable: ${problems.join('; ')}`;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * Records a failed build attempt and when the cron may try again: the retry
 * policy from the FIRST failure (+1, +5, +15, then +75, +135 … min). Past the
 * last slot before the cut-off, the wait runs to the cut-off, where the sweep
 * skips the run. `buildFailure` is the CURRENT cause (the cut-off reason and the
 * banner read it), overwritten on every attempt.
 */
async function recordBuildFailure(ctx: Ctx, cause: 'ads_unfillable' | 'build_error', detail: string): Promise<void> {
  const cur = await prisma.digestRun.findUniqueOrThrow({
    where: { id: ctx.run.id },
    select: { build: true, buildAttempts: true, buildFirstFailureAt: true },
  });
  if (cur.build !== 'BUILDING' && cur.build !== 'BUILD_FAILED') return;
  const attempts = cur.buildAttempts + 1;
  const first = cur.buildFirstFailureAt ?? ctx.now;
  const next = nextAttemptAt(first, attempts, ctx.cutoffAt) ?? ctx.cutoffAt;
  await prisma.digestRun.updateMany({
    where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
    data: {
      build: 'BUILD_FAILED',
      buildAttempts: attempts,
      buildFirstFailureAt: first,
      buildNextAttemptAt: next,
      buildFailure: cause,
      buildError: detail.length > 500 ? `${detail.slice(0, 497)}...` : detail,
    },
  });
  log(ctx, null, `build:retry_at:${next.toISOString()}`);
}

type VariantContent = {
  audience: DigestAudience;
  subject: string;
  preheader: string;
  html: string;
  text: string;
  placements?: AdPlacementRecord[];
  templateId?: string | null;
  templateFallback?: TemplateFallback;
};

/**
 * Every audience's content, judged one audience at a time. An ad problem
 * (`AdSlotError` from the picker or from the freeze guard) blocks only its own
 * audience and names its slots; any other failure is rethrown as is (the whole
 * build fails, as before).
 */
async function allContents(
  ctx: Ctx,
  buildContent: BuildContent,
  itemsFor: (a: DigestAudience) => FrozenItem[] | undefined,
): Promise<{ contents: VariantContent[]; blocked: { audience: DigestAudience; problems: string[] }[] }> {
  const settled = await Promise.allSettled(AUDIENCES.map((audience) => variantContent(ctx, buildContent, audience, itemsFor(audience))));
  const other = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected' && !(r.reason instanceof AdSlotError));
  if (other) throw other.reason;
  const contents: VariantContent[] = [];
  const blocked: { audience: DigestAudience; problems: string[] }[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') contents.push(r.value);
    else blocked.push({ audience: AUDIENCES[i], problems: (r.reason as AdSlotError).problems });
  });
  return { contents, blocked };
}

/** One audience's content, with the freeze guard applied to its placements. Throws AdSlotError. */
async function variantContent(ctx: Ctx, buildContent: BuildContent, audience: DigestAudience, items: FrozenItem[] | undefined): Promise<VariantContent> {
  const c = await buildContent({
    runId: ctx.run.id,
    runDate: ctx.run.runDate,
    audience,
    items,
    cfg: ctx.cfg,
    portal: ctx.run.portal,
    at: ctx.now,
  });
  await assertPlacementsAtFreeze(audience, c.placements ?? []);
  return { audience, ...c };
}

/**
 * The guard once more, at freeze, against the ad rows as they are now (an ad
 * edited to SUBSCRIPTION or to an off-allowlist link after it was picked, or a
 * custom `buildContent`, still cannot reach readers). Throws AdSlotError.
 */
async function assertPlacementsAtFreeze(audience: DigestAudience, placements: AdPlacementRecord[]): Promise<void> {
  if (placements.length === 0) return;
  const ads = await prisma.digestAd.findMany({ where: { id: { in: placements.map((p) => p.adId) } }, select: { id: true, kind: true, linkUrl: true } });
  const byId = new Map(ads.map((a) => [a.id, a]));
  const missing = placements.filter((p) => !byId.has(p.adId));
  if (missing.length > 0) throw new AdSlotError(missing.map((p) => `Slot ${p.slot}: the placed ad no longer exists`));
  assertPlacementsAllowed(
    audience,
    placements.map((p) => ({ slot: p.slot, adId: p.adId, kind: byId.get(p.adId)!.kind, linkUrl: byId.get(p.adId)!.linkUrl })),
  );
}

/** Run columns the builder fills at freeze. */
function selectionRunFields(sel: DigestSelection): Prisma.DigestRunUpdateManyMutationInput {
  return {
    windowStart: sel.windowStart,
    candidateCount: sel.candidateCount,
    readsUsed: sel.reads.used,
    readsSource: sel.reads.source,
    readsNote: sel.reads.note,
  };
}

/**
 * Fewer than DIGEST_MIN_ITEMS MAIN stories: the run is SKIPPED, but its items
 * are still frozen (with `builtAt`) so tomorrow's build rolls the top ones
 * forward and starts its window here. Not an error: audit only, no alert.
 */
async function skipTooLittleNews(ctx: Ctx, sel: DigestSelection): Promise<boolean> {
  const skipped = await prisma.$transaction(async (tx) => {
    const r = await tx.digestRun.updateMany({
      where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
      data: {
        build: 'SKIPPED',
        skipReason: 'too_little_news',
        builtAt: ctx.now,
        buildFailure: null,
        buildError: null,
        buildNextAttemptAt: null,
        ...selectionRunFields(sel),
      },
    });
    if (r.count !== 1) return false;
    await writeDigestItems(tx, ctx.run.id, sel.rows);
    return true;
  });
  if (skipped) {
    await recordAudit({
      action: 'DIGEST_SKIPPED',
      resourceType: 'DigestRun',
      resourceId: ctx.run.id,
      metadata: { reason: 'too_little_news', free: sel.mainCounts.FREE, premium: sel.mainCounts.PREMIUM },
    });
  }
  log(ctx, null, skipped ? 'build:skipped:too_little_news' : 'build:claimed_elsewhere');
  return false;
}

/** Whether this run needs an editor's approval at all (approval mode, sanity hold or complaint hold — `holds.ts`). */
function approvalNeeded(ctx: Ctx): boolean {
  return runNeedsApproval(ctx.cfg, ctx.run);
}

/** Why the run needs approval, for the "ready for approval" email: the strongest reason. */
function holdReasonOf(ctx: Ctx, selection: DigestSelection | null): string {
  if (isComplaintHeld(ctx.run)) return 'complaint_hold';
  if (selection?.outcome === 'sanity_hold' || ctx.run.candidateCount > ctx.cfg.sanityMaxCandidates) return 'sanity_hold';
  return 'approval_required';
}

/**
 * A variant whose approval is its own and not given yet (`holds.ts`): rendered
 * after the build in approval mode (owner, 2026-10-23), or an adopted Mailercloud
 * draft in any mode (owner decision A, 2026-10-23).
 */
function awaitingOwnApproval(ctx: Ctx, send: Pick<DigestSend, 'ownApprovalRequired' | 'approvedAt' | 'adoptedDraftAt'>): boolean {
  return variantAwaitingOwnApproval(ctx.cfg, ctx.run, send);
}

/** True while a run over the sanity limit has not been approved by an editor. */
function sanityHeld(ctx: Ctx): boolean {
  return ctx.run.candidateCount > ctx.cfg.sanityMaxCandidates && ctx.run.approval !== 'APPROVED';
}


/* ------------------------------------------------------------------ */
/* Per-variant steps                                                   */
/* ------------------------------------------------------------------ */

/** Moves one variant forward. Always starts from a fresh read of the row. */
async function advanceSend(ctx: Ctx, sendId: string): Promise<void> {
  let s = await fresh(sendId);
  if (s.state === 'SENT' || s.state === 'PARTIALLY_SENT' || s.state === 'SKIPPED') return;

  if (s.contentPendingAt !== null) {
    // Frozen without content (its ad slots could not be filled): render it first.
    if (s.state !== 'FAILED') return;
    const next = await renderPendingStep(ctx, s);
    if (!next) return;
    s = next;
  } else if (s.state === 'FAILED') {
    const block = failedBlock(ctx.trigger, s);
    if (block) {
      if (block.startsWith('terminal:')) ctx.refusals.push(`${s.audience}: ${block.slice('terminal:'.length)} (final for today)`);
      log(ctx, s.audience, `failed:${block}`);
      return;
    }
    log(ctx, s.audience, 'failed:resuming');
  }

  if (!s.mcCampaignId) {
    const next = await createStep(ctx, s);
    if (!next) return;
    s = next;
  }
  if (s.state === 'CREATED' || s.state === 'FAILED') {
    const next = await scheduleStep(ctx, s);
    if (!next) return;
    s = next;
  }
  if (s.state === 'SCHEDULED') await verifyStep(ctx, s);
}

/**
 * Step 0, only for a variant frozen without content (`contentPendingAt`): the
 * other audience's ads filled at the build, this one's did not. Renders it
 * from the run's FROZEN stories (never re-selected) with the ads as they are
 * now, applies the freeze guard, and stores html + placements in one
 * transaction fenced on "still pending" — two runners cannot both store it,
 * and a variant the cut-off already skipped is never filled in. On success the
 * variant is PENDING and continues to create → schedule through the usual
 * gates; still unfillable → stays FAILED and is tried again on the retry
 * policy (the cron waits; Retry now does not).
 */
async function renderPendingStep(ctx: Ctx, send: DigestSend): Promise<DigestSend | null> {
  const a = send.audience;
  if (retryWaitPending(ctx, send)) {
    log(ctx, a, 'render:waiting_retry');
    return null;
  }
  const rows = await prisma.digestItem.findMany({
    where: { runId: ctx.run.id, OR: [{ audience: null }, { audience: a }] },
    orderBy: { rank: 'asc' },
  });
  const items: FrozenItem[] = rows.map((r) => ({
    rank: r.rank,
    section: r.section === 'ICYMI' ? 'ICYMI' : 'MAIN',
    articleKey: r.articleKey,
    campaignId: r.campaignId,
    title: r.title,
    url: r.url,
    authority: r.authority,
    category: r.category,
    excerpt: r.excerpt,
    capturedAt: r.capturedAt,
    readRate: r.readRate,
  }));
  let c: VariantContent;
  try {
    c = await variantContent(ctx, ctx.buildContent, a, rows.length > 0 ? items : undefined);
  } catch (err) {
    const problems = err instanceof AdSlotError ? err.problems : null;
    const attempts = send.stepAttempts + 1;
    const first = send.stepFirstFailureAt ?? ctx.now;
    await prisma.digestSend.updateMany({
      where: { id: send.id, state: 'FAILED', contentPendingAt: { not: null } },
      data: {
        lastError: problems ? adsUnfillableError(problems) : `render_failed: ${redactError(err)}`,
        attempts: send.attempts + 1,
        stepAttempts: attempts,
        stepFirstFailureAt: first,
        nextAttemptAt: nextAttemptAt(first, attempts, ctx.cutoffAt) ?? ctx.cutoffAt,
      },
    });
    if (problems) ctx.refusals.push(`the ${a === 'FREE' ? 'Free' : 'Premium'} digest still has an ad slot no ad can fill (${problems.join('; ')})`);
    log(ctx, a, problems ? 'render:ads_unfillable' : 'render:failed');
    return null;
  }
  const stored = await prisma.$transaction(async (tx) => {
    const r = await tx.digestSend.updateMany({
      where: { id: send.id, state: 'FAILED', contentPendingAt: { not: null }, html: null, mcCampaignId: null },
      data: {
        state: 'PENDING',
        subject: c.subject,
        preheader: c.preheader,
        html: c.html,
        text: c.text,
        htmlBytes: Buffer.byteLength(c.html, 'utf8'),
        templateId: c.templateId ?? null,
        templateFallbackFromId: c.templateFallback?.fromId ?? null,
        templateFallbackReason: c.templateFallback?.reason ?? null,
        // Owner, 2026-10-23: content that did not exist when the run was approved is not
        // covered by that approval. In approval mode it waits for its own (approvedAt),
        // whatever the run's approval says now — set in the same fenced write as the html,
        // so no approval taken before this instant can ever count for it.
        ownApprovalRequired: true,
        approvedAt: null,
        approvedByUserId: null,
        contentPendingAt: null,
        lastError: null,
        lastErrorKind: null,
        stepAttempts: 0,
        stepFirstFailureAt: null,
        nextAttemptAt: null,
      },
    });
    if (r.count !== 1) return false;
    const placements = (c.placements ?? []).map((p) => ({ sendId: send.id, adId: p.adId, slot: p.slot, utmContent: p.utmContent, createdAt: ctx.now }));
    if (placements.length > 0) await tx.digestAdPlacement.createMany({ data: placements });
    return true;
  });
  log(ctx, a, stored ? 'render:frozen' : 'render:claimed_elsewhere');
  if (stored) await raiseTemplateFallback(ctx, [c]);
  return stored ? fresh(send.id) : null;
}

/**
 * Why a FAILED variant may not resume on this trigger, or null when it may.
 * Terminal failures never resume. The cron tick never resumes (FATAL = no
 * retry). Health recovery resumes FATAL only. A human (Retry now / Send now)
 * resumes the rest — and every resumed step still asks the provider first
 * when its write-ahead marker is set.
 */
function failedBlock(trigger: DigestTrigger, s: DigestSend): string | null {
  const terminal = TERMINAL_ERRORS.find((e) => s.lastError?.startsWith(e));
  if (terminal) return `terminal:${terminal}`;
  if (trigger === 'retry' || trigger === 'send_now') return null;
  if (trigger === 'health' && s.lastErrorKind === 'FATAL') return null;
  return 'waiting_for_human';
}

/** True when the cron tick must still wait for the retry schedule. Doors other than cron skip the wait. */
function retryWaitPending(ctx: Ctx, send: DigestSend): boolean {
  return ctx.trigger === 'cron' && send.nextAttemptAt !== null && send.nextAttemptAt.getTime() > ctx.now.getTime();
}

/**
 * True only when the provider provably did NOT act on a call: it rejected it
 * (FATAL: 400/401/quota), rate-limited it (429), or the sender reports the
 * request never left (`notSent`). A missing HTTP status alone proves nothing —
 * a timeout after the body was sent has no status but may have been applied —
 * and neither does a 5xx, an AMBIGUOUS timeout or any non-SenderError.
 */
function provablyNotApplied(err: unknown): boolean {
  if (!(err instanceof SenderError)) return false;
  if (err.kind === 'FATAL') return true;
  return err.kind === 'RETRYABLE' && (err.notSent || err.http === 429);
}

/**
 * Step 1: create the draft (cannot send by itself).
 *
 *  - Marker null → claim and set `createAttemptedAt` in one update. With a
 *    lookup (`findCampaignByName`, which Mailercloud has), the provider is
 *    asked FIRST, every time (2026-10-23, QA O1): our own marker only proves
 *    THIS database never created the variant, and a database restored from
 *    the 02:20 backup has never heard of the run that sent at 07:30. The name
 *    is deterministic per portal + date + audience, so a found campaign is
 *    today's: it is adopted, and its provider status decides the variant
 *    (`adoptExisting`). Only "the provider has no such campaign" leads to a
 *    create. Without a lookup, createDraft is called (this database's marker
 *    is the only proof there is).
 *  - Marker set, no saved id → a create may have reached the provider. Look the
 *    draft up by its unique name and adopt it; if the provider confirms there
 *    is none, create. Without a lookup, stop for a human (FAILED +
 *    ambiguous_create). Only Retry now / Send now on that FAILED variant
 *    creates again; the worst case is an inert orphan draft, because only the
 *    SAVED id is ever scheduled.
 *  - Every createDraft() call is preceded by a second stamp, `createSentAt`
 *    (`issueCreate`). It alone decides whether a draft found by name is our
 *    own lost create or one this database never made (decision A).
 */
async function createStep(ctx: Ctx, send: DigestSend): Promise<DigestSend | null> {
  const a = send.audience;
  const target = audienceTarget(ctx.cfg, a);
  if (!target.ok) {
    await prisma.digestSend.updateMany({
      where: { id: send.id, mcCampaignId: null, state: { in: ['PENDING', 'FAILED'] } },
      data: { state: 'FAILED', lastErrorKind: 'FATAL', lastError: `config_invalid: ${target.reason}`, nextAttemptAt: null },
    });
    await raiseAlert(ctx, 'config_invalid', { audience: a, problems: [target.reason] });
    log(ctx, a, 'create:config_invalid');
    return null;
  }
  if (retryWaitPending(ctx, send)) {
    log(ctx, a, 'create:waiting_retry');
    return null;
  }
  if (send.html === null) {
    // Frozen content is gone (retention). Never rebuild — this send is over.
    await prisma.digestSend.updateMany({
      where: { id: send.id, mcCampaignId: null },
      data: { state: 'FAILED', lastErrorKind: 'FATAL', lastError: 'frozen_html_missing' },
    });
    log(ctx, a, 'create:frozen_html_missing');
    return null;
  }

  const legal: Prisma.DigestSendWhereInput = { state: { in: ['PENDING', 'FAILED'] }, mcCampaignId: null };

  if (send.createAttemptedAt === null) {
    const claimAt = await claimStep(send.id, { ...legal, createAttemptedAt: null }, ctx, { createAttemptedAt: ctx.now });
    if (!claimAt) {
      log(ctx, a, 'create:claimed_elsewhere');
      return null;
    }
    const first = await fresh(send.id);
    if (ctx.sender.findCampaignByName) return lookupThenCreate(ctx, first, claimAt, target.target);
    return issueCreate(ctx, first, claimAt, target.target);
  }

  const claimAt = await claimStep(send.id, legal, ctx);
  if (!claimAt) {
    log(ctx, a, 'create:claimed_elsewhere');
    return null;
  }
  const s = await fresh(send.id);

  if (ctx.sender.findCampaignByName) return lookupThenCreate(ctx, s, claimAt, target.target);

  if ((ctx.trigger === 'retry' || ctx.trigger === 'send_now') && s.state === 'FAILED') {
    log(ctx, a, 'create:human_override'); // issueCreate re-stamps both markers before the call
    return issueCreate(ctx, s, claimAt, target.target);
  }

  await finishStep(s.id, claimAt, {
    state: 'FAILED',
    lastErrorKind: 'AMBIGUOUS',
    lastError: s.lastError ?? 'create_unconfirmed: a create may have reached the provider',
    nextAttemptAt: null,
  });
  await raiseAlert(ctx, 'ambiguous_create', { audience: a, campaignName: s.mcCampaignName });
  log(ctx, a, 'create:ambiguous_needs_human');
  return null;
}

/**
 * Asks the provider for the variant's campaign by its exact name, then adopts
 * it or — only when the provider answers "none" — creates it. A lookup that
 * fails proves nothing: the retry policy applies (a missed digest rolls
 * forward; a double send cannot be undone).
 *
 * Whether a found draft is OURS (owner decision A, narrowed) is read from
 * `createSentAt` on the row re-read after the claim — set only by an earlier
 * attempt that actually reached `createDraft()` — never from
 * `createAttemptedAt`, which a claim writes before the lookup and which a
 * crash (or a failed lookup) can leave behind without any create having been
 * issued (2026-10-23, closing the crash window left by bc70aaa).
 */
async function lookupThenCreate(
  ctx: Ctx,
  s: DigestSend,
  claimAt: Date,
  target: AudienceTarget,
): Promise<DigestSend | null> {
  let found: { campaignId: string } | null;
  try {
    found = await (ctx.sender.findCampaignByName as NonNullable<DigestSender['findCampaignByName']>)(s.mcCampaignName);
  } catch (err) {
    // Nothing was created by this attempt; `createSentAt` is untouched, so a draft a
    // later attempt finds is judged by whether an EARLIER attempt really called create.
    await recordFailure(ctx, s, claimAt, err, 'create', { keepMarker: true });
    return null;
  }
  // `createSentAt` = this database called createDraft() for the variant earlier today (its
  // write-ahead stamp predates this attempt), so a draft found now is that create.
  if (found) return adoptExisting(ctx, s, claimAt, found.campaignId, s.createSentAt !== null);
  // The provider confirms no such campaign: a create is safe.
  return issueCreate(ctx, s, claimAt, target);
}

/**
 * The provider already has this variant's campaign (an ambiguous create that
 * went through, a crashed earlier attempt, or — after a database restore —
 * the campaign a lost run created or SENT this morning). The id is saved and
 * the provider's status, read now, decides the variant; schedule() is never
 * called here:
 *
 *  - SCHEDULED / SENDING / SENT / PARTIALLY_SENT → SCHEDULED, verified at once
 *    by `verifyStep` (status() again; SENT is final). Nothing is sent again.
 *  - FAILED → `markProviderFailed`: terminal for the day (or PARTIALLY_SENT
 *    when some readers were reached).
 *  - DRAFT, or status unreadable → CREATED with `scheduleAttemptedAt` set, so
 *    the schedule step asks status() once more right before it would call
 *    schedule() (someone may schedule the draft in Mailercloud meanwhile), and
 *    the cut-off sweep asks before calling it skipped.
 *
 * Owner decision A, narrowed 2026-10-23: `ownCreateMarker` says THIS database
 * had already CALLED create for the variant (its write-ahead `createSentAt`
 * predates this attempt), so a DRAFT (or unreadable status) found now is our own
 * create whose reply was lost (a timeout, a 2xx without an id, a 5xx that went
 * through): adopted and carried on normally, the run's usual approval rules only.
 * Without that marker (a restore, or a campaign made by hand under our name) a
 * DRAFT / unreadable campaign needs its own approval in every mode
 * (`adoptedDraftAt` + `ownApprovalRequired`, `holds.ts`) and raises
 * `adopted_existing`. A campaign further along than this database knew
 * (SCHEDULED / SENDING / SENT / FAILED) raises `adopted_existing` in both cases.
 */
async function adoptExisting(ctx: Ctx, s: DigestSend, claimAt: Date, campaignId: string, ownCreateMarker: boolean): Promise<DigestSend | null> {
  const a = s.audience;
  let st: CampaignStatus | null;
  try {
    st = await ctx.sender.status(campaignId);
  } catch {
    st = null;
  }
  const ahead = st !== null && st.state !== 'DRAFT';
  const foreignDraft = !ahead && !ownCreateMarker;
  const kept = await persistCreated(ctx, s, campaignId, `create:adopted_existing:${st ? st.state.toLowerCase() : 'status_unknown'}`, {
    extra: {
      scheduleAttemptedAt: s.scheduleAttemptedAt ?? ctx.now,
      // Owner decision A (narrowed 2026-10-23): a draft this database never tried to
      // create may hold other content (a restore, a hand-made campaign). It is never
      // scheduled until a person approves it — its own approval, in every mode (`holds.ts`).
      ...(foreignDraft ? { adoptedDraftAt: ctx.now, ownApprovalRequired: true, approvedAt: null, approvedByUserId: null } : {}),
    },
    keepClaim: ahead,
  });
  if (!kept) {
    if (ahead) await finishStep(s.id, claimAt, {}); // another runner saved an id first; let go of the claim
    return null;
  }
  if (!ahead && !foreignDraft) {
    // Our own lost create: carry on. scheduleAttemptedAt makes the schedule step read the
    // status again before it would schedule (an unreadable status is asked again there).
    log(ctx, a, `create:adopted_own_draft:${st ? 'draft' : 'status_unknown'}`);
    return kept;
  }
  if (!ahead || !st) {
    await raiseAlert(ctx, 'adopted_existing', {
      audience: a,
      campaignName: s.mcCampaignName,
      providerState: st ? st.state : 'UNKNOWN',
      draft: true,
    });
    log(ctx, a, 'create:adopted_draft:needs_approval');
    return kept;
  }
  await raiseAlert(ctx, 'adopted_existing', { audience: a, campaignName: s.mcCampaignName, providerState: st.state });
  if (st.state === 'FAILED') {
    await markProviderFailed(ctx, kept, claimAt, st);
    return null;
  }
  await markScheduled(ctx, kept, claimAt, 'create:adopted_existing:accepted', { adopted: true });
  return fresh(s.id);
}

/**
 * Calls createDraft(). Its write-ahead stamp comes first, in one update fenced
 * on our claim: `createSentAt` (we are about to call the provider — what
 * decision A trusts) and `createAttemptedAt` (re-armed for a later attempt;
 * the same instant the claim wrote on a first one). A lost claim calls nothing.
 */
async function issueCreate(ctx: Ctx, s: DigestSend, claimAt: Date, target: AudienceTarget): Promise<DigestSend | null> {
  if (!(await writeClaimed(s.id, claimAt, { createAttemptedAt: ctx.now, createSentAt: ctx.now }))) {
    log(ctx, s.audience, 'create:claim_lost');
    return null;
  }
  let campaignId: string;
  try {
    ({ campaignId } = await ctx.sender.createDraft({
      name: s.mcCampaignName,
      audience: s.audience,
      subject: s.subject,
      preheader: s.preheader,
      html: s.html as string, // the FROZEN copy, never re-rendered
      text: s.text,
      target,
    }));
  } catch (err) {
    await recordFailure(ctx, s, claimAt, err, 'create');
    return null;
  }
  return persistCreated(ctx, s, campaignId, 'create:ok');
}

/**
 * Persists the provider id the moment we have it. Fenced on "no id yet", not
 * on the claim: the id must be kept even after a stale-claim takeover. A lost
 * write leaves `createAttemptedAt` set, so the next attempt asks the provider.
 */
async function persistCreated(
  ctx: Ctx,
  send: DigestSend,
  campaignId: string,
  what: string,
  opts: { extra?: Prisma.DigestSendUpdateManyMutationInput; keepClaim?: boolean } = {},
): Promise<DigestSend | null> {
  const a = send.audience;
  try {
    const r = await prisma.digestSend.updateMany({
      where: { id: send.id, mcCampaignId: null },
      data: {
        ...opts.extra,
        mcCampaignId: campaignId,
        state: 'CREATED',
        ...(opts.keepClaim ? {} : { stepClaimedAt: null }),
        nextAttemptAt: null,
        lastError: null,
        lastErrorKind: null,
        stepAttempts: 0,
        stepFirstFailureAt: null,
      },
    });
    if (r.count !== 1) {
      await raiseAlert(ctx, 'orphan_draft', { audience: a, campaignName: send.mcCampaignName });
      log(ctx, a, 'create:orphan_draft');
      return null;
    }
  } catch (err) {
    log(ctx, a, `create:persist_failed:${redactError(err)}`);
    return null;
  }
  log(ctx, a, what);
  return fresh(send.id);
}

/** Quiet hours or the cut-off, read on a FRESH clock (a slow step may have crossed either). */
function clockBlocker(ctx: Ctx): string | null {
  const t = ctx.clock();
  if (isPastCutoff(t, ctx.run.runDate, ctx.cfg.cutoff)) return 'past_cutoff';
  if (isQuietHours(t, ctx.quiet.start, ctx.quiet.end)) return 'quiet_hours';
  return null;
}

/** The reason schedule() may not be called right now, or null when every gate is open. */
function scheduleBlocker(ctx: Ctx, send: DigestSend): string | null {
  if (!ctx.cfg.sendLive) return 'preview_only';
  if (ctx.run.approval === 'HELD') return 'held_by_editor';
  if (sanityHeld(ctx)) return 'sanity_hold';
  if (isComplaintHeld(ctx.run) && ctx.run.approval !== 'APPROVED') return 'complaint_hold';
  if (ctx.cfg.approvalRequired && ctx.run.approval !== 'APPROVED') return 'awaiting_approval';
  if (awaitingOwnApproval(ctx, send)) return 'awaiting_variant_approval';
  if (ctx.clock().getTime() < send.sendAfter.getTime()) return 'waiting_send_time';
  const clock = clockBlocker(ctx);
  if (clock) return clock;
  if (retryWaitPending(ctx, send)) return 'waiting_retry';
  return null;
}

/**
 * Step 2: send the saved draft now, on the SAME id.
 *
 *  - Marker null and CREATED → claim and set `scheduleAttemptedAt` in one
 *    update, then call schedule(): provably the first call.
 *  - Marker set (an earlier attempt of any outcome, a crash, a takeover) →
 *    status() first. Accepted/sending/sent → SCHEDULED without calling
 *    schedule(). Provider FAILED → terminal. DRAFT → the provider confirms it
 *    was not scheduled: call schedule() once more. Status unknown → no call,
 *    alert, try again later (the cut-off sweep resolves it at 17:00).
 */
async function scheduleStep(ctx: Ctx, send: DigestSend): Promise<DigestSend | null> {
  const a = send.audience;
  const blocker = scheduleBlocker(ctx, send);
  if (blocker) {
    log(ctx, a, `wait:${blocker}`);
    return null;
  }
  const id = send.mcCampaignId as string;

  if (send.scheduleAttemptedAt === null && send.state === 'CREATED') {
    const claimAt = await claimStep(
      send.id,
      { state: 'CREATED', mcCampaignId: id, scheduleAttemptedAt: null },
      ctx,
      { scheduleAttemptedAt: ctx.now },
    );
    if (!claimAt) {
      log(ctx, a, 'schedule:claimed_elsewhere');
      return null;
    }
    return issueSchedule(ctx, await fresh(send.id), claimAt, null);
  }

  const claimAt = await claimStep(send.id, { state: { in: ['CREATED', 'FAILED'] }, mcCampaignId: id }, ctx);
  if (!claimAt) {
    log(ctx, a, 'schedule:claimed_elsewhere');
    return null;
  }
  const s = await fresh(send.id);
  let st: CampaignStatus;
  try {
    st = await ctx.sender.status(id);
  } catch (err) {
    await recordFailure(ctx, s, claimAt, err, 'schedule', { kind: 'AMBIGUOUS' });
    await raiseAlert(ctx, 'schedule_unconfirmed', { audience: a });
    return null;
  }
  if (st.state === 'DRAFT') {
    const previous = s.scheduleAttemptedAt;
    if (!(await writeClaimed(s.id, claimAt, { scheduleAttemptedAt: ctx.now }))) return null;
    return issueSchedule(ctx, s, claimAt, previous);
  }
  if (st.state === 'FAILED') {
    await markProviderFailed(ctx, s, claimAt, st);
    return null;
  }
  await markScheduled(ctx, s, claimAt, 'schedule:already_accepted');
  return fresh(s.id);
}

/**
 * Calls schedule() — the only place that does. The marker is already set and
 * the claim held. A last look at a fresh clock first: if quiet hours or the
 * cut-off arrived meanwhile, no call is made and the marker goes back to what
 * it was (we hold the claim, so we know no call happened).
 */
async function issueSchedule(ctx: Ctx, s: DigestSend, claimAt: Date, previousMarker: Date | null): Promise<DigestSend | null> {
  const late = clockBlocker(ctx);
  if (late) {
    await finishStep(s.id, claimAt, { scheduleAttemptedAt: previousMarker });
    log(ctx, s.audience, `wait:${late}`);
    return null;
  }
  try {
    await ctx.sender.schedule(s.mcCampaignId as string, 'now');
  } catch (err) {
    await recordFailure(ctx, s, claimAt, err, 'schedule');
    return null;
  }
  await markScheduled(ctx, s, claimAt, 'schedule:ok');
  return fresh(s.id);
}

async function markScheduled(ctx: Ctx, send: DigestSend, claimAt: Date, what: string, opts: { adopted?: boolean } = {}): Promise<void> {
  const ok = await finishStep(send.id, claimAt, {
    state: 'SCHEDULED',
    scheduledAt: ctx.now,
    // An adopted campaign was accepted before we knew of it: verify at once.
    nextAttemptAt: opts.adopted ? ctx.now : new Date(ctx.now.getTime() + VERIFY_OFFSETS_MIN[0] * MINUTE),
    lastError: null,
    lastErrorKind: null,
    stepAttempts: 0,
    stepFirstFailureAt: null,
  });
  if (!ok) {
    // Claim taken over meanwhile; the marker makes the new holder ask the provider.
    log(ctx, send.audience, `${what}:claim_lost`);
    return;
  }
  await recordAudit({
    action: 'DIGEST_SCHEDULED',
    resourceType: 'DigestSend',
    resourceId: send.id,
    metadata: { runId: ctx.run.id, audience: send.audience, trigger: ctx.trigger, ...(opts.adopted ? { adopted: true } : {}) },
  });
  log(ctx, send.audience, what);
}

/**
 * The provider reports the campaign FAILED. Readers it reached (a KNOWN
 * reached > 0) are done → PARTIALLY_SENT. Otherwise FAILED, terminal for the
 * day; an unknown reach stays null ("unknown", not "nobody").
 */
async function markProviderFailed(ctx: Ctx, s: DigestSend, claimAt: Date, st: CampaignStatus): Promise<void> {
  const counts = { targeted: st.targeted, reached: st.reached };
  if (st.reached !== null && st.reached > 0) {
    await finishStep(s.id, claimAt, { state: 'PARTIALLY_SENT', ...counts, sentConfirmedAt: ctx.now, sentVia: 'status_poll', nextAttemptAt: null });
    await raiseAlert(ctx, 'partial_send', { audience: s.audience, ...counts });
    log(ctx, s.audience, 'provider_failed:partially_sent');
    return;
  }
  const why = st.reached === null ? 'provider_failed: reach unknown' : 'provider_failed: nobody reached';
  await finishStep(s.id, claimAt, { state: 'FAILED', ...counts, lastError: why, lastErrorKind: null, nextAttemptAt: null });
  await raiseAlert(ctx, 'provider_failed', { audience: s.audience, reachKnown: st.reached !== null });
  log(ctx, s.audience, 'provider_failed:terminal');
}

/** The next verification poll after `scheduledAt`: +10, +30, +60 min, then hourly. */
export function nextVerifyAt(scheduledAt: Date, now: Date): Date {
  for (const m of VERIFY_OFFSETS_MIN) {
    const at = new Date(scheduledAt.getTime() + m * MINUTE);
    if (at.getTime() > now.getTime()) return at;
  }
  const last = VERIFY_OFFSETS_MIN[VERIFY_OFFSETS_MIN.length - 1];
  const hoursPast = Math.floor((now.getTime() - scheduledAt.getTime() - last * MINUTE) / (60 * MINUTE)) + 1;
  return new Date(scheduledAt.getTime() + (last + hoursPast * 60) * MINUTE);
}

/**
 * Step 3: confirm delivery with status(). SENT (or a KNOWN reached < targeted
 * → PARTIALLY_SENT) is final; anything else is polled again. A status error
 * changes nothing. After the cut-off, `final` turns "still pending" into
 * FAILED not_confirmed_by_cutoff. Nothing here ever calls schedule().
 */
async function verifyStep(ctx: Ctx, send: DigestSend, final = false): Promise<void> {
  const a = send.audience;
  if (!final && retryWaitPending(ctx, send)) return;
  const claimAt = await claimStep(send.id, { state: 'SCHEDULED' }, ctx);
  if (!claimAt) {
    log(ctx, a, 'verify:claimed_elsewhere');
    return;
  }
  const s = await fresh(send.id);
  let st: CampaignStatus;
  try {
    st = await ctx.sender.status(s.mcCampaignId as string);
  } catch (err) {
    if (final) {
      await notConfirmedByCutoff(ctx, s, claimAt, `not_confirmed_by_cutoff: ${redactError(err)}`);
      return;
    }
    await finishStep(s.id, claimAt, { nextAttemptAt: nextVerifyAt(s.scheduledAt ?? ctx.now, ctx.now) });
    log(ctx, a, 'verify:status_error');
    return;
  }

  const counts = { targeted: st.targeted, reached: st.reached };
  const short = st.targeted !== null && st.reached !== null && st.reached < st.targeted;
  if (st.state === 'SENT' && !short) {
    await finishStep(s.id, claimAt, { state: 'SENT', ...counts, sentConfirmedAt: ctx.now, sentVia: 'status_poll', nextAttemptAt: null });
    log(ctx, a, 'verify:sent');
  } else if (st.state === 'SENT' || st.state === 'PARTIALLY_SENT') {
    // Reached readers are done; the rest get tomorrow's roll-forward (task 4). Never re-sent.
    await finishStep(s.id, claimAt, { state: 'PARTIALLY_SENT', ...counts, sentConfirmedAt: ctx.now, sentVia: 'status_poll', nextAttemptAt: null });
    await raiseAlert(ctx, 'partial_send', { audience: a, ...counts });
    log(ctx, a, 'verify:partially_sent');
  } else if (st.state === 'FAILED') {
    await markProviderFailed(ctx, s, claimAt, st);
  } else if (final) {
    await notConfirmedByCutoff(ctx, s, claimAt, 'not_confirmed_by_cutoff');
  } else {
    await finishStep(s.id, claimAt, { nextAttemptAt: nextVerifyAt(s.scheduledAt ?? ctx.now, ctx.now) });
    log(ctx, a, `verify:pending:${st.state}`);
  }
}

async function notConfirmedByCutoff(ctx: Ctx, s: DigestSend, claimAt: Date, lastError: string): Promise<void> {
  await finishStep(s.id, claimAt, { state: 'FAILED', lastError, nextAttemptAt: null });
  await raiseAlert(ctx, 'not_confirmed_by_cutoff', { audience: s.audience });
  log(ctx, s.audience, 'not_confirmed_by_cutoff');
}

/**
 * Applies the retry policy to a failed create/schedule. Each step keeps its
 * own sequence (`stepAttempts` / `stepFirstFailureAt`, reset when a step
 * succeeds), so a schedule failure hours after a create failure starts again
 * at +1 / +5 / +15 min.
 *
 * create:   the write-ahead marker is cleared only when the provider provably
 *           did not act; FATAL → FAILED (no retry); marker kept and no lookup
 *           → FAILED for a human; out of time → SKIPPED (no id was saved, so
 *           nothing can have been sent).
 * schedule: the marker is always kept (status() decides next time); FATAL →
 *           FAILED; out of time → wait for the cut-off sweep, which asks the
 *           provider before anything is called SKIPPED.
 */
async function recordFailure(
  ctx: Ctx,
  s: DigestSend,
  claimAt: Date,
  err: unknown,
  step: 'create' | 'schedule',
  opts: { kind?: SenderErrorKind; keepMarker?: boolean } = {},
): Promise<void> {
  const a = s.audience;
  const kind = opts.kind ?? errorKind(err);
  const stepAttempts = s.stepAttempts + 1;
  const stepFirstFailureAt = s.stepFirstFailureAt ?? ctx.now;
  const duplicate = isDuplicateNameError(err);
  const base: Prisma.DigestSendUpdateManyMutationInput = {
    attempts: s.attempts + 1,
    firstFailureAt: s.firstFailureAt ?? ctx.now,
    stepAttempts,
    stepFirstFailureAt,
    // A lookup that found two campaigns with our exact name is a problem a person fixes
    // (delete the extra one in Mailercloud), not "Mailercloud is not answering".
    lastError: duplicate ? `duplicate_name: two campaigns named "${s.mcCampaignName}" exist in Mailercloud` : redactError(err),
    lastErrorKind: kind,
  };
  const next = nextAttemptAt(stepFirstFailureAt, stepAttempts, ctx.cutoffAt);

  if (step === 'create') {
    const notApplied = !opts.keepMarker && opts.kind === undefined && provablyNotApplied(err);
    // Provably not applied: this attempt's create made nothing, and every create is
    // preceded by a lookup proving none existed (or, without a lookup, nothing is ever
    // adopted), so neither stamp may make a later-found draft look like ours.
    if (notApplied) {
      base.createAttemptedAt = null;
      base.createSentAt = null;
    }
    if (kind === 'FATAL') {
      await finishStep(s.id, claimAt, { ...base, state: 'FAILED', nextAttemptAt: null });
      await raiseAlert(ctx, 'fatal', { audience: a, step, error: base.lastError });
      log(ctx, a, 'create:fatal');
      return;
    }
    if (!notApplied && !ctx.sender.findCampaignByName) {
      await finishStep(s.id, claimAt, { ...base, state: 'FAILED', nextAttemptAt: null });
      await raiseAlert(ctx, 'ambiguous_create', { audience: a, campaignName: s.mcCampaignName });
      log(ctx, a, 'create:ambiguous_needs_human');
      return;
    }
    if (next === null) {
      await finishStep(s.id, claimAt, { ...base, state: 'SKIPPED', nextAttemptAt: null });
      await setRunSkipReason(ctx, 'cutoff_passed');
      await raiseAlert(ctx, 'skipped', { audience: a, reason: 'cutoff_passed' });
      await auditSkipped(ctx, s, 'cutoff_passed');
      log(ctx, a, 'create:retries_exhausted:skipped');
      return;
    }
    await finishStep(s.id, claimAt, { ...base, state: 'PENDING', nextAttemptAt: next });
  } else {
    if (kind === 'FATAL') {
      await finishStep(s.id, claimAt, { ...base, state: 'FAILED', nextAttemptAt: null });
      await raiseAlert(ctx, 'fatal', { audience: a, step, error: base.lastError });
      log(ctx, a, 'schedule:fatal');
      return;
    }
    if (next === null) {
      await finishStep(s.id, claimAt, { ...base, state: 'CREATED', nextAttemptAt: ctx.cutoffAt });
      log(ctx, a, 'schedule:retries_exhausted:awaiting_cutoff_check');
      return;
    }
    await finishStep(s.id, claimAt, { ...base, state: 'CREATED', nextAttemptAt: next });
  }
  if (duplicate) await raiseAlert(ctx, 'duplicate_name', { audience: a, campaignName: s.mcCampaignName });
  else if (stepAttempts === 1) await raiseAlert(ctx, 'retrying', { audience: a, step });
  log(ctx, a, `${step}:${kind.toLowerCase()}:retry_at:${(next as Date).toISOString()}`);
}

async function auditSkipped(ctx: Ctx, send: DigestSend, reason: string): Promise<void> {
  await recordAudit({
    action: 'DIGEST_SKIPPED',
    resourceType: 'DigestSend',
    resourceId: send.id,
    metadata: { runId: ctx.run.id, audience: send.audience, reason },
  });
}

/* ------------------------------------------------------------------ */
/* Cut-off                                                             */
/* ------------------------------------------------------------------ */

/** Why an unfinished variant is being skipped at the cut-off. */
function cutoffReason(ctx: Ctx, send?: Pick<DigestSend, 'ownApprovalRequired' | 'approvedAt' | 'adoptedDraftAt'>): string {
  if (ctx.run.approval === 'HELD') return 'held_by_editor';
  if (sanityHeld(ctx)) return 'sanity_hold_expired';
  if (isComplaintHeld(ctx.run) && ctx.run.approval !== 'APPROVED') return 'complaint_hold_expired';
  if (ctx.cfg.approvalRequired && ctx.run.approval !== 'APPROVED') return 'not_approved';
  // A variant rendered after the run was approved that never got its own approval.
  if (send && awaitingOwnApproval(ctx, send)) return 'not_approved';
  return 'cutoff_passed';
}

/**
 * At/after 17:00 IST (or on any later day): nothing more is ever scheduled.
 *  - An unbuilt run is SKIPPED.
 *  - A variant whose `scheduleAttemptedAt` is null was provably never
 *    scheduled → SKIPPED (its stories roll forward, task 4).
 *  - A variant with the marker set may have gone out → ask the provider:
 *    DRAFT → SKIPPED; accepted → SCHEDULED and a final check; unknown →
 *    FAILED not_confirmed_by_cutoff + alert.
 *  - SCHEDULED gets one last status check.
 * Terminal FAILED variants and rows a live step is holding are left alone.
 */
async function cutoffSweep(ctx: Ctx): Promise<void> {
  if (ctx.run.build === 'BUILDING' || ctx.run.build === 'BUILD_FAILED') {
    // The CURRENT cause decides (QA L5): a build held back by an unfillable ad
    // slot is skipped as config_invalid — but not one that failed for another
    // reason after the ads were fixed, whatever alert markers the day raised.
    const adsBlocked = ctx.run.build === 'BUILD_FAILED' && ctx.run.buildFailure === 'ads_unfillable';
    const reason = adsBlocked ? 'config_invalid' : ctx.run.build === 'BUILD_FAILED' ? 'build_failed' : 'cutoff_passed';
    const r = await prisma.digestRun.updateMany({
      where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
      data: { build: 'SKIPPED', skipReason: reason, buildNextAttemptAt: null },
    });
    if (r.count === 1) {
      await raiseAlert(ctx, 'skipped', { reason, ...(adsBlocked ? { source: 'ads' } : {}) });
      await recordAudit({ action: 'DIGEST_SKIPPED', resourceType: 'DigestRun', resourceId: ctx.run.id, metadata: { reason } });
      log(ctx, null, `cutoff:skipped:${reason}`);
    }
    return;
  }

  for (const audience of AUDIENCES) {
    const s = await prisma.digestSend.findUnique({ where: { runId_audience: { runId: ctx.run.id, audience } } });
    if (!s) continue;
    const reason = cutoffReason(ctx, s);
    if (s.state === 'SCHEDULED') {
      await verifyStep(ctx, s, true);
      continue;
    }
    if (s.state !== 'PENDING' && s.state !== 'CREATED' && s.state !== 'FAILED') continue;
    if (isTerminal(s)) continue;
    if (s.scheduleAttemptedAt !== null && s.mcCampaignId) {
      await resolveAtCutoff(ctx, s, reason);
      continue;
    }
    const claimAt = await claimStep(s.id, { state: { in: ['PENDING', 'CREATED', 'FAILED'] }, scheduleAttemptedAt: null }, ctx);
    if (!claimAt) continue;
    await finishStep(s.id, claimAt, { state: 'SKIPPED', nextAttemptAt: null });
    // A variant still waiting for its ads ends the way an unfillable run does.
    if (s.contentPendingAt !== null) await markSkipped(ctx, s, 'config_invalid', { source: 'ads', audience: s.audience });
    else await markSkipped(ctx, s, reason);
  }
}

async function markSkipped(ctx: Ctx, s: DigestSend, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
  await setRunSkipReason(ctx, reason);
  await raiseAlert(ctx, 'skipped', { reason, ...extra });
  await auditSkipped(ctx, s, reason);
  log(ctx, s.audience, `cutoff:skipped:${reason}`);
}

/** A variant that may have been scheduled: only the provider can say whether it is safe to call it skipped. */
async function resolveAtCutoff(ctx: Ctx, send: DigestSend, reason: string): Promise<void> {
  const claimAt = await claimStep(send.id, { state: { in: ['PENDING', 'CREATED', 'FAILED'] } }, ctx);
  if (!claimAt) return;
  const s = await fresh(send.id);
  let st: CampaignStatus;
  try {
    st = await ctx.sender.status(s.mcCampaignId as string);
  } catch (err) {
    await notConfirmedByCutoff(ctx, s, claimAt, `not_confirmed_by_cutoff: ${redactError(err)}`);
    return;
  }
  if (st.state === 'DRAFT') {
    await finishStep(s.id, claimAt, { state: 'SKIPPED', nextAttemptAt: null });
    await markSkipped(ctx, s, reason);
    return;
  }
  if (st.state === 'FAILED') {
    await markProviderFailed(ctx, s, claimAt, st);
    return;
  }
  await markScheduled(ctx, s, claimAt, 'cutoff:found_scheduled');
  await verifyStep(ctx, await fresh(s.id), true);
}
