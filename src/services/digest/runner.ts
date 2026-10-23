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
import { renderDigestContent, senderAddressProblems, type BuildContent } from './renderer';
import { writeDigestItems, type DigestSelection, type FrozenItem } from './builder';
import { sendDigestAlerts } from './alerts';
import { recordRunAlert } from './runAlerts';
import { checkWebhookLiveness } from './webhookLiveness';

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
  | 'retrying'
  | 'skipped'
  | 'partial_send'
  | 'provider_failed'
  | 'not_confirmed_by_cutoff'
  | 'build_failed'
  | 'sanity_hold'
  | 'webhook_silent';

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
 */
async function claimStep(
  sendId: string,
  where: Prisma.DigestSendWhereInput,
  ctx: Ctx,
  extra: Prisma.DigestSendUpdateManyMutationInput = {},
): Promise<Date | null> {
  const claimAt = ctx.now;
  const r = await prisma.digestSend.updateMany({
    where: {
      AND: [
        { id: sendId },
        where,
        { OR: [{ stepClaimedAt: null }, { stepClaimedAt: { lt: new Date(ctx.now.getTime() - ctx.staleMs) } }] },
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
  // eslint-disable-next-line no-console
  console.log(`[digest] run=${ctx.run.id}${audience ? ` ${audience}` : ''} ${what} (${ctx.trigger})`);
}

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
    const built = await buildStep(ctx, deps.buildContent ?? renderDigestContent, deps.selectItems);
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
    const after = await prisma.digestSend.findMany({ where: { runId }, select: { state: true, lastError: true } });
    const actionable = after.some(
      (s) => s.state === 'PENDING' || s.state === 'CREATED' || s.state === 'SCHEDULED' || (s.state === 'FAILED' && !isTerminal(s)),
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
 * Freezes both variants' content onto DigestSend rows, once. The run moves
 * BUILDING → BUILT in the same transaction that inserts the rows, guarded by
 * a conditional update, so two runners cannot build twice and a BUILT run is
 * never re-rendered. Returns false when the run did not reach BUILT.
 */
async function buildStep(ctx: Ctx, buildContent: BuildContent, selectItems?: SelectItems): Promise<boolean> {
  const problems = buildConfigProblems(ctx.cfg);
  if (problems.length > 0) {
    await prisma.digestRun.updateMany({
      where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
      data: { build: 'SKIPPED', skipReason: 'config_invalid' },
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

  let contents: { audience: DigestAudience; subject: string; preheader: string; html: string; text: string }[];
  let selection: DigestSelection | null = null;
  try {
    // The window is recomputed on every build attempt (§8: a retried build sees `now`).
    if (selectItems) selection = await selectItems(ctx.run, ctx.now);
    if (selection?.outcome === 'too_little_news') return await skipTooLittleNews(ctx, selection);
    const itemsFor = (a: DigestAudience): FrozenItem[] | undefined => selection?.perAudience[a];
    contents = await Promise.all(
      AUDIENCES.map(async (audience) => ({
        audience,
        ...(await buildContent({ runId: ctx.run.id, runDate: ctx.run.runDate, audience, items: itemsFor(audience), cfg: ctx.cfg })),
      })),
    );
  } catch (err) {
    // Task 4 adds the build retry schedule (§8); until then the next tick retries.
    await prisma.digestRun.updateMany({ where: { id: ctx.run.id, build: 'BUILDING' }, data: { build: 'BUILD_FAILED' } });
    await raiseAlert(ctx, 'build_failed', { error: redactError(err) });
    log(ctx, null, 'build:failed');
    return false;
  }

  const sendAfter = istInstant(ctx.run.runDate, ctx.cfg.sendAt);
  const dateKey = runDateKey(ctx.run.runDate);
  const built = await prisma.$transaction(async (tx) => {
    const claimed = await tx.digestRun.updateMany({
      where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
      data: { build: 'BUILT', builtAt: ctx.now, ...(selection ? selectionRunFields(selection) : {}) },
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
    await tx.digestSend.createMany({
      data: contents.map((c) => ({
        runId: ctx.run.id,
        audience: c.audience,
        subject: c.subject,
        preheader: c.preheader,
        html: c.html,
        text: c.text,
        htmlBytes: Buffer.byteLength(c.html, 'utf8'),
        mcCampaignName: `TS-DIGEST-${dateKey}-${c.audience}-${ctx.run.id}`,
        sendAfter,
      })),
    });
    return true;
  });
  if (built && selection?.outcome === 'sanity_hold') {
    await raiseAlert(ctx, 'sanity_hold', { candidates: selection.candidateCount, max: ctx.cfg.sanityMaxCandidates });
    log(ctx, null, `build:sanity_hold:${selection.candidateCount}`);
  }
  if (built && selection) log(ctx, null, `build:items:${selection.rows.length}:reads=${selection.reads.used ? selection.reads.source : 'off'}`);
  log(ctx, null, built ? 'build:frozen' : 'build:claimed_elsewhere');
  return built;
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
      data: { build: 'SKIPPED', skipReason: 'too_little_news', builtAt: ctx.now, ...selectionRunFields(sel) },
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

  if (s.state === 'FAILED') {
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
 *  - Marker null → claim and set `createAttemptedAt` in one update, then call
 *    createDraft: nobody has created this variant before.
 *  - Marker set, no saved id → a create may have reached the provider. Look the
 *    draft up by its unique name and adopt it; if the provider confirms there
 *    is none, create. Without a lookup, stop for a human (FAILED +
 *    ambiguous_create). Only Retry now / Send now on that FAILED variant
 *    creates again; the worst case is an inert orphan draft, because only the
 *    SAVED id is ever scheduled.
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
    return issueCreate(ctx, await fresh(send.id), claimAt, target.target);
  }

  const claimAt = await claimStep(send.id, legal, ctx);
  if (!claimAt) {
    log(ctx, a, 'create:claimed_elsewhere');
    return null;
  }
  const s = await fresh(send.id);

  if (ctx.sender.findCampaignByName) {
    let found: { campaignId: string } | null;
    try {
      found = await ctx.sender.findCampaignByName(s.mcCampaignName);
    } catch (err) {
      await recordFailure(ctx, s, claimAt, err, 'create', { keepMarker: true });
      return null;
    }
    if (found) return persistCreated(ctx, s, found.campaignId, 'create:adopted_existing');
    // The provider confirms no such campaign: a create is safe. Re-arm the marker first.
    if (!(await writeClaimed(s.id, claimAt, { createAttemptedAt: ctx.now }))) return null;
    return issueCreate(ctx, s, claimAt, target.target);
  }

  if ((ctx.trigger === 'retry' || ctx.trigger === 'send_now') && s.state === 'FAILED') {
    if (!(await writeClaimed(s.id, claimAt, { createAttemptedAt: ctx.now }))) return null;
    log(ctx, a, 'create:human_override');
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

async function issueCreate(ctx: Ctx, s: DigestSend, claimAt: Date, target: AudienceTarget): Promise<DigestSend | null> {
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
async function persistCreated(ctx: Ctx, send: DigestSend, campaignId: string, what: string): Promise<DigestSend | null> {
  const a = send.audience;
  try {
    const r = await prisma.digestSend.updateMany({
      where: { id: send.id, mcCampaignId: null },
      data: {
        mcCampaignId: campaignId,
        state: 'CREATED',
        stepClaimedAt: null,
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
  if (ctx.cfg.approvalRequired && ctx.run.approval !== 'APPROVED') return 'awaiting_approval';
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

async function markScheduled(ctx: Ctx, send: DigestSend, claimAt: Date, what: string): Promise<void> {
  const ok = await finishStep(send.id, claimAt, {
    state: 'SCHEDULED',
    scheduledAt: ctx.now,
    nextAttemptAt: new Date(ctx.now.getTime() + VERIFY_OFFSETS_MIN[0] * MINUTE),
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
    metadata: { runId: ctx.run.id, audience: send.audience, trigger: ctx.trigger },
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
  const base: Prisma.DigestSendUpdateManyMutationInput = {
    attempts: s.attempts + 1,
    firstFailureAt: s.firstFailureAt ?? ctx.now,
    stepAttempts,
    stepFirstFailureAt,
    lastError: redactError(err),
    lastErrorKind: kind,
  };
  const next = nextAttemptAt(stepFirstFailureAt, stepAttempts, ctx.cutoffAt);

  if (step === 'create') {
    const notApplied = !opts.keepMarker && opts.kind === undefined && provablyNotApplied(err);
    if (notApplied) base.createAttemptedAt = null;
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
  if (stepAttempts === 1) await raiseAlert(ctx, 'retrying', { audience: a, step });
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

/** Why unfinished variants are being skipped at the cut-off. */
function cutoffReason(ctx: Ctx): string {
  if (ctx.run.approval === 'HELD') return 'held_by_editor';
  if (sanityHeld(ctx)) return 'sanity_hold_expired';
  if (ctx.cfg.approvalRequired && ctx.run.approval !== 'APPROVED') return 'not_approved';
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
    const reason = ctx.run.build === 'BUILD_FAILED' ? 'build_failed' : 'cutoff_passed';
    const r = await prisma.digestRun.updateMany({
      where: { id: ctx.run.id, build: { in: ['BUILDING', 'BUILD_FAILED'] } },
      data: { build: 'SKIPPED', skipReason: reason },
    });
    if (r.count === 1) {
      await raiseAlert(ctx, 'skipped', { reason });
      await recordAudit({ action: 'DIGEST_SKIPPED', resourceType: 'DigestRun', resourceId: ctx.run.id, metadata: { reason } });
      log(ctx, null, `cutoff:skipped:${reason}`);
    }
    return;
  }

  const reason = cutoffReason(ctx);
  for (const audience of AUDIENCES) {
    const s = await prisma.digestSend.findUnique({ where: { runId_audience: { runId: ctx.run.id, audience } } });
    if (!s) continue;
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
    await markSkipped(ctx, s, reason);
  }
}

async function markSkipped(ctx: Ctx, s: DigestSend, reason: string): Promise<void> {
  await setRunSkipReason(ctx, reason);
  await raiseAlert(ctx, 'skipped', { reason });
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
