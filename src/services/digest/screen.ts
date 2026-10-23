import type { DigestApproval, DigestAudience, DigestBuild, DigestSendState, SenderErrorKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { isQuietHours } from '../../lib/quietHours';
import { authorityTier } from '../classify';
import { digestRunState, type DigestRunState } from './runState';
import { istDateOf, istInstant, runDateKey } from './retryPolicy';
import { TERMINAL_ERRORS } from './runner';
import { safeDetail, skipWords } from './alerts';
import { digestSendStats } from './stats';

/**
 * Payloads for the Digests screen (docs/EMAIL_DIGEST_DESIGN.md §6, §7, task 7):
 * run detail, 14-day history, and the one decision of which buttons the
 * screen offers (`digestActions`, pure and table-tested).
 *
 * Nothing here returns a reader address or an html body: the html is served
 * only by the preview route, with its own CSP. Error text passes through
 * `safeDetail` (email-shaped substrings and secrets masked).
 *
 * The buttons are a convenience, not a gate: every send-capable action still
 * goes through `advanceRun`, which enforces all the rules again.
 */

const AUDIENCES: DigestAudience[] = ['FREE', 'PREMIUM'];
const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORY_DEFAULT_DAYS = 14;
export const HISTORY_MAX_DAYS = 60;

/* ------------------------------------------------------------------ */
/* Which buttons the screen offers                                     */
/* ------------------------------------------------------------------ */

/** One button: whether it appears at all, whether it can be pressed, and why not. */
export type ScreenAction = { show: boolean; enabled: boolean; reason: string | null };

export type DigestActions = {
  approve: ScreenAction;
  hold: ScreenAction;
  sendNow: ScreenAction;
  retry: ScreenAction;
  testSend: Record<DigestAudience, ScreenAction>;
};

export type ActionsInput = {
  cfg: Pick<DigestEnv, 'enabled' | 'sendLive' | 'approvalRequired' | 'sanityMaxCandidates' | 'cutoff'>;
  now: Date;
  quiet: { start: string; end: string };
  /** A provider client exists (key set, or a sender injected). */
  providerReady: boolean;
  /** The viewer's own address is in DIGEST_TEST_RECIPIENTS. */
  viewerCanTest: boolean;
  run: { runDate: Date; build: DigestBuild; approval: DigestApproval; candidateCount: number };
  sends: ReadonlyArray<{
    audience: DigestAudience;
    state: DigestSendState;
    lastError: string | null;
    nextAttemptAt: Date | null;
    mcCampaignId: string | null;
    hasHtml: boolean;
    /** Owner 2026-10-23: rendered after the build — needs its own approval in approval mode. */
    ownApprovalRequired?: boolean;
    approvedAt?: Date | null;
  }>;
};

const HIDDEN: ScreenAction = { show: false, enabled: false, reason: null };
const on = (): ScreenAction => ({ show: true, enabled: true, reason: null });
const off = (reason: string): ScreenAction => ({ show: true, enabled: false, reason });

/** A FAILED variant whose failure ends it for the day (no door resumes it). */
export function isTerminalFailure(s: { state: DigestSendState; lastError: string | null }): boolean {
  return s.state === 'FAILED' && TERMINAL_ERRORS.some((e) => s.lastError?.startsWith(e));
}

/**
 * Variants with content that were rendered after the build and have no approval of their
 * own yet, and could still go out today. The single rule the screen, the route and the
 * banner share (the runner's gate is `awaitingOwnApproval`).
 */
export function variantsAwaitingOwnApproval<T extends ActionsInput['sends'][number]>(sends: ReadonlyArray<T>): T[] {
  return sends.filter(
    (s) =>
      s.ownApprovalRequired === true &&
      !s.approvedAt &&
      s.hasHtml &&
      (s.state === 'PENDING' || s.state === 'CREATED' || (s.state === 'FAILED' && !isTerminalFailure(s))),
  );
}

/** Why a variant cannot be sent from this screen right now, or null. Shared by Send now and Retry now. */
function sendBlocker(i: ActionsInput): string | null {
  if (!i.cfg.sendLive) return 'Sending is switched off (preview only). DIGEST_SEND_LIVE must be on to send.';
  if (!i.providerReady) return 'Mailercloud is not configured (MAILERCLOUD_API_KEY is not set).';
  return null;
}

/**
 * The buttons for one run. Mirrors the runner's gates closely enough that a
 * pressed button almost never comes back refused; when it does (a race), the
 * runner's own reason is shown.
 */
export function digestActions(i: ActionsInput): DigestActions {
  const testSend = {} as Record<DigestAudience, ScreenAction>;
  for (const a of AUDIENCES) testSend[a] = HIDDEN;
  const none: DigestActions = { approve: HIDDEN, hold: HIDDEN, sendNow: HIDDEN, retry: HIDDEN, testSend };
  if (!i.cfg.enabled) return none;

  const { run, sends } = i;
  const pastCutoff = i.now.getTime() >= istInstant(run.runDate, i.cfg.cutoff).getTime();
  const handedOver = sends.some((s) => s.state === 'SCHEDULED' || s.state === 'SENT' || s.state === 'PARTIALLY_SENT');
  const skipped = sends.some((s) => s.state === 'SKIPPED');
  const sendable = sends.some(
    (s) => s.state === 'PENDING' || s.state === 'CREATED' || (s.state === 'FAILED' && !isTerminalFailure(s)),
  );
  const open = run.build === 'BUILT' && !pastCutoff && !handedOver && sendable;

  const needsApproval = i.cfg.approvalRequired || run.candidateCount > i.cfg.sanityMaxCandidates;
  // A variant rendered after the run was approved is not covered by that approval (owner,
  // 2026-10-23): Approve stays on offer for it alone, even once the other variant went out.
  const waitingOwn = needsApproval && run.build === 'BUILT' && !pastCutoff ? variantsAwaitingOwnApproval(sends) : [];
  const runLevelApprove = open && (run.approval === 'PENDING' || run.approval === 'HELD');
  const approve = runLevelApprove || (run.approval === 'APPROVED' && waitingOwn.length > 0) ? on() : HIDDEN;
  const hold = open && run.approval !== 'HELD' ? on() : HIDDEN;

  let sendNow: ScreenAction = HIDDEN;
  if (open && !skipped) {
    const blocker =
      sendBlocker(i) ??
      (run.approval === 'HELD'
        ? 'An editor held it. Approve it first.'
        : needsApproval && run.approval !== 'APPROVED'
          ? 'Approve it first.'
          : waitingOwn.length > 0
            ? `Approve the ${waitingOwn.map((s) => (s.audience === 'PREMIUM' ? 'Premium' : 'Free')).join(' and ')} digest first: it was built after the approval.`
          : isQuietHours(i.now, i.quiet.start, i.quiet.end)
            ? `It is quiet hours (${i.quiet.start}–${i.quiet.end} IST); nothing is sent at night.`
            : null);
    sendNow = blocker ? off(blocker) : on();
  }

  let retry: ScreenAction = HIDDEN;
  const retryable =
    run.build === 'BUILD_FAILED' ||
    sends.some((s) => s.state === 'FAILED' && !isTerminalFailure(s)) ||
    sends.some(
      (s) => (s.state === 'PENDING' || s.state === 'CREATED') && s.lastError && s.nextAttemptAt && s.nextAttemptAt > i.now,
    );
  if (!pastCutoff && retryable) {
    const blocker = sendBlocker(i);
    retry = blocker ? off(blocker) : on();
  }

  for (const s of sends) {
    testSend[s.audience] = !i.providerReady
      ? off('Mailercloud is not configured (MAILERCLOUD_API_KEY is not set).')
      : !i.viewerCanTest
        ? off('Test sends go only to addresses in DIGEST_TEST_RECIPIENTS, and yours is not listed.')
        : !s.mcCampaignId
          ? off('The Mailercloud draft has not been created yet.')
          : !s.hasHtml
            ? off('The stored copy of this digest has expired.')
            : on();
  }
  return { approve, hold, sendNow, retry, testSend };
}

/* ------------------------------------------------------------------ */
/* Why an item ranked where it did                                     */
/* ------------------------------------------------------------------ */

/**
 * What the read-rate column means for one item:
 *  - `reads`: ranked by organic reads per hour (`readRate`);
 *  - `new`: reads were used for this build but the story was too fresh to
 *    judge, so it sorted at its group's median ("new — neutral");
 *  - `none`: reads were not used (stale or off), or a carried-over ICYMI item.
 */
export type ReadBasis = 'reads' | 'new' | 'none';

export function itemReadBasis(item: { section: string; readRate: number | null }, readsUsed: boolean | null): ReadBasis {
  if (item.readRate !== null) return 'reads';
  if (readsUsed && item.section === 'MAIN') return 'new';
  return 'none';
}

/** The plain-words line under "Today": how the stories were ordered. */
export function readsLine(readsUsed: boolean | null, readsSource: string | null, readsNote: string | null): string | null {
  if (readsUsed === null) return null;
  if (readsUsed) return `Ranked by reads (${readsSource === 'cms' ? 'CMS view counts' : 'Google Analytics'}).`;
  return `Ranked newest-first${readsNote ? ` — ${readsNote}` : ''}.`;
}

/* ------------------------------------------------------------------ */
/* Run detail                                                          */
/* ------------------------------------------------------------------ */

const AUDIT_WORDS: Record<string, string> = {
  DIGEST_APPROVED: 'Approved',
  DIGEST_HELD: 'Held',
  DIGEST_SEND_NOW: 'Send now pressed',
  DIGEST_RETRY: 'Retry now pressed',
  DIGEST_TEST_SENT: 'Test send',
  DIGEST_SCHEDULED: 'Handed to Mailercloud to send',
  DIGEST_SKIPPED: 'Skipped',
};

const audienceWord = (a: unknown) => (a === 'FREE' ? 'Free' : a === 'PREMIUM' ? 'Premium' : null);

export type TimelineEntry = { at: string; text: string; by: string | null };

/** Last known audience size per variant (Mailercloud's `targeted`), for "Send to ~N readers?". */
export async function audienceEstimate(portal: string): Promise<Record<DigestAudience, number | null>> {
  const out = { FREE: null, PREMIUM: null } as Record<DigestAudience, number | null>;
  for (const a of AUDIENCES) {
    const last = await prisma.digestSend.findFirst({
      where: { audience: a, targeted: { not: null }, run: { portal } },
      orderBy: { run: { runDate: 'desc' } },
      select: { targeted: true },
    });
    out[a] = last?.targeted ?? null;
  }
  return out;
}

export type DetailOptions = {
  cfg?: DigestEnv;
  now?: Date;
  quiet?: { start: string; end: string };
  providerReady: boolean;
  viewerCanTest: boolean;
};

/** The Digests screen's run payload, or null when the run does not exist. */
export async function digestRunDetail(runId: string, opts: DetailOptions) {
  const cfg = opts.cfg ?? env.digest;
  const now = opts.now ?? new Date();
  const quiet = opts.quiet ?? { start: env.send.quietStart, end: env.send.quietEnd };
  const run = await prisma.digestRun.findUnique({
    where: { id: runId },
    include: {
      sends: {
        orderBy: { audience: 'asc' },
        // Explicit list: html/text are deliberately NOT selected (preview route only).
        select: {
          id: true,
          audience: true,
          state: true,
          subject: true,
          preheader: true,
          htmlBytes: true,
          mcCampaignId: true,
          sendAfter: true,
          scheduledAt: true,
          sentConfirmedAt: true,
          nextAttemptAt: true,
          attempts: true,
          lastError: true,
          lastErrorKind: true,
          contentPendingAt: true,
          ownApprovalRequired: true,
          approvedAt: true,
          approvedByUserId: true,
          templateFallbackFromId: true,
          templateFallbackReason: true,
          targeted: true,
          reached: true,
          opens: true,
          clicks: true,
          placements: { orderBy: { slot: 'asc' }, select: { slot: true, adId: true, utmContent: true, ad: { select: { name: true, kind: true } } } },
        },
      },
      items: { orderBy: [{ rank: 'asc' }] },
    },
  });
  if (!run) return null;

  // Whether a frozen copy still exists, without loading it.
  const withHtml = new Set(
    (await prisma.digestSend.findMany({ where: { runId, html: { not: null } }, select: { id: true } })).map((s) => s.id),
  );
  const approver = run.approvedByUserId
    ? await prisma.user.findUnique({ where: { id: run.approvedByUserId }, select: { email: true } })
    : null;
  const variantApproverIds = [...new Set(run.sends.map((s) => s.approvedByUserId).filter((x): x is string => Boolean(x)))];
  const variantApprovers = new Map(
    (variantApproverIds.length ? await prisma.user.findMany({ where: { id: { in: variantApproverIds } }, select: { id: true, email: true } }) : []).map(
      (u) => [u.id, u.email],
    ),
  );
  const needsApproval = cfg.approvalRequired || run.candidateCount > cfg.sanityMaxCandidates;
  /** not_needed | waiting | approved — per variant (owner 2026-10-23: a later-rendered one has its own). */
  const variantApproval = (s: { ownApprovalRequired: boolean; approvedAt: Date | null }): 'not_needed' | 'waiting' | 'approved' => {
    if (!needsApproval) return 'not_needed';
    if (s.ownApprovalRequired) return s.approvedAt ? 'approved' : 'waiting';
    return run.approval === 'APPROVED' ? 'approved' : 'waiting';
  };

  const sends = run.sends.map((s) => ({ ...s, hasHtml: withHtml.has(s.id) }));
  const actions = digestActions({
    cfg,
    now,
    quiet,
    providerReady: opts.providerReady,
    viewerCanTest: opts.viewerCanTest,
    run,
    sends,
  });

  const items = {} as Record<DigestAudience, ReturnType<typeof itemView>[]>;
  const itemView = (it: (typeof run.items)[number]) => ({
    rank: it.rank,
    section: it.section,
    title: it.title,
    url: it.url,
    authority: it.authority,
    tier: authorityTier(it.authority),
    category: it.category,
    capturedAt: it.capturedAt,
    readRate: it.readRate,
    readBasis: itemReadBasis(it, run.readsUsed),
  });
  for (const a of AUDIENCES) {
    items[a] = run.items.filter((it) => it.audience === null || it.audience === a).map(itemView);
  }

  return {
    runId: run.id,
    runDate: runDateKey(run.runDate),
    isToday: run.runDate.getTime() === istDateOf(now).getTime(),
    state: digestRunState(run, run.sends),
    build: run.build,
    skipReason: run.skipReason,
    skipText: run.skipReason ? skipWords(run.skipReason) : null,
    builtAt: run.builtAt,
    candidateCount: run.candidateCount,
    approval: run.approval,
    approvedAt: run.approvedAt,
    approvedBy: approver?.email ?? null,
    readsUsed: run.readsUsed,
    readsSource: run.readsSource,
    readsLine: readsLine(run.readsUsed, run.readsSource, run.readsNote),
    variants: sends.map((s) => ({
      audience: s.audience,
      state: s.state,
      subject: s.subject,
      preheader: s.preheader,
      htmlBytes: s.htmlBytes,
      hasPreview: s.hasHtml,
      // Frozen without content: its ad slots could not be filled (no html yet, not "expired").
      contentPending: s.contentPendingAt !== null,
      mcCampaignId: s.mcCampaignId,
      sendAfter: s.sendAfter,
      scheduledAt: s.scheduledAt,
      sentConfirmedAt: s.sentConfirmedAt,
      nextAttemptAt: s.nextAttemptAt,
      attempts: s.attempts,
      lastError: s.lastError ? safeDetail(s.lastError, cfg) : null,
      lastErrorKind: s.lastErrorKind as SenderErrorKind | null,
      targeted: s.targeted,
      reached: s.reached,
      // Owner 2026-10-23: rendered after the build → its own approval, never the run's.
      approval: variantApproval(s),
      ownApproval: s.ownApprovalRequired,
      approvedAt: s.ownApprovalRequired ? s.approvedAt : run.approvedAt,
      approvedBy: s.ownApprovalRequired ? (s.approvedByUserId ? (variantApprovers.get(s.approvedByUserId) ?? null) : null) : (approver?.email ?? null),
      // Owner 2026-10-23: the custom template failed; this copy uses the built-in template.
      templateFallback: s.templateFallbackFromId
        ? { fromId: s.templateFallbackFromId, reason: s.templateFallbackReason ? safeDetail(s.templateFallbackReason, cfg) : null }
        : null,
      // Task 9: the house ad drawn in each slot of this frozen email.
      ads: s.placements.map((p) => ({ slot: p.slot, adId: p.adId, name: p.ad.name, kind: p.ad.kind, utmContent: p.utmContent })),
    })),
    items,
    actions,
    audienceEstimate: await audienceEstimate(run.portal),
    timeline: await runTimeline(run, cfg),
  };
}

async function runTimeline(
  run: { id: string; builtAt: Date | null; build: DigestBuild; items: unknown[]; sends: { id: string; audience: DigestAudience; sentConfirmedAt: Date | null }[] },
  cfg: DigestEnv,
): Promise<TimelineEntry[]> {
  const entries: TimelineEntry[] = [];
  if (run.builtAt) {
    entries.push({
      at: run.builtAt.toISOString(),
      text: run.build === 'SKIPPED' ? 'Built, then skipped' : `Built — ${new Set((run.items as { articleKey: string }[]).map((i) => i.articleKey)).size} stories frozen`,
      by: null,
    });
  }
  for (const s of run.sends) {
    if (s.sentConfirmedAt) entries.push({ at: s.sentConfirmedAt.toISOString(), text: `${audienceWord(s.audience)} confirmed sent`, by: null });
  }
  const sendIds = run.sends.map((s) => s.id);
  const rows = await prisma.auditLog.findMany({
    where: {
      OR: [
        { resourceType: 'DigestRun', resourceId: run.id },
        ...(sendIds.length ? [{ resourceType: 'DigestSend', resourceId: { in: sendIds } }] : []),
      ],
      action: { in: Object.keys(AUDIT_WORDS) as never[] },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { action: true, createdAt: true, metadata: true, user: { select: { email: true } } },
  });
  for (const r of rows) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const parts = [AUDIT_WORDS[r.action] ?? r.action];
    const who = audienceWord(m.audience) ?? (Array.isArray(m.audiences) ? m.audiences.map(audienceWord).filter(Boolean).join(' and ') || null : null);
    if (who) parts.push(`(${who})`);
    if (r.action === 'DIGEST_SKIPPED' && typeof m.reason === 'string') parts.push(`— ${skipWords(m.reason)}`);
    if ((r.action === 'DIGEST_SEND_NOW' || r.action === 'DIGEST_RETRY') && m.outcome === 'refused') {
      parts.push(`— refused${typeof m.reason === 'string' ? `: ${safeDetail(m.reason, cfg)}` : ''}`);
    }
    entries.push({ at: r.createdAt.toISOString(), text: parts.join(' '), by: r.user?.email ?? null });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export type HistoryRow = {
  runId: string;
  runDate: string;
  state: DigestRunState;
  skipReason: string | null;
  items: Record<DigestAudience, number>;
  variants: {
    audience: DigestAudience;
    state: DigestSendState;
    mcCampaignId: string | null;
    delivered: number | null;
    clicks: number | null;
    /**
     * From `digestSendStats()` (rolled + live). Null ("—") while DIGEST_WEBHOOKS_ENABLED
     * is off, or when there is no proof the webhook was receiving for this send: never a fake 0.
     */
    unsubscribes: number | null;
    bounces: number | null;
    complaints: number | null;
  }[];
};

/** The last `days` IST days of runs for `portal`, newest first. */
export async function digestHistory(opts: { portal: string; days?: number; now?: Date; cfg?: DigestEnv }): Promise<HistoryRow[]> {
  const days = Math.min(HISTORY_MAX_DAYS, Math.max(1, Math.floor(opts.days ?? HISTORY_DEFAULT_DAYS)));
  const today = istDateOf(opts.now ?? new Date());
  const runs = await prisma.digestRun.findMany({
    where: { portal: opts.portal, runDate: { gte: new Date(today.getTime() - (days - 1) * DAY_MS), lte: today } },
    orderBy: { runDate: 'desc' },
    select: {
      id: true,
      runDate: true,
      build: true,
      skipReason: true,
      sends: {
        orderBy: { audience: 'asc' },
        select: { id: true, audience: true, state: true, mcCampaignId: true, reached: true, clicks: true },
      },
      items: { select: { audience: true } },
    },
  });
  const counted = (opts.cfg ?? env.digest).webhooksEnabled;
  const stats = counted ? await digestSendStats(runs.flatMap((r) => r.sends.map((s) => s.id))) : null;
  return runs.map((r) => {
    const items = {} as Record<DigestAudience, number>;
    for (const a of AUDIENCES) items[a] = r.items.filter((it) => it.audience === null || it.audience === a).length;
    return {
      runId: r.id,
      runDate: runDateKey(r.runDate),
      state: digestRunState(r, r.sends),
      skipReason: r.skipReason,
      items,
      variants: r.sends.map((s) => ({
        audience: s.audience,
        state: s.state,
        mcCampaignId: s.mcCampaignId,
        delivered: s.reached,
        clicks: s.clicks,
        unsubscribes: stats?.get(s.id)?.unsubscribes ?? null,
        bounces: stats?.get(s.id)?.bounces ?? null,
        complaints: stats?.get(s.id)?.complaints ?? null,
      })),
    };
  });
}
