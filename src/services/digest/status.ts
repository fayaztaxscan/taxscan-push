import type { DigestApproval, DigestAudience, DigestBuild, DigestSendState, SenderErrorKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { isEmailConfigured } from '../../lib/email';
import { digestRunState, type DigestRunState } from './runState';
import { istDateOf, runDateKey } from './retryPolicy';
import { validateDigestSchedule } from './scheduler';
import { BLOCKING_KINDS, INFO_KINDS, alertCopy, safeDetail, skipWords, type AlertMap } from './alerts';
import { complaintCheckOf, isComplaintHeld, runNeedsApproval, type ComplaintCheck } from './holds';
import { noAddressRecently, webhookHealth, type WebhookHealth } from './webhookLiveness';

/**
 * `GET /api/digest/status` payload and the Dashboard banner decision
 * (docs/EMAIL_DIGEST_DESIGN.md §6, §7, task 6).
 *
 * Like `/api/backup-status`, the "does this need a human?" decision is made
 * HERE, not in the SPA: the schedule, the cut-off and the sanity limit are
 * server-side knowledge. `digestAttention()` is pure and table-tested; the
 * Dashboard only renders what it returns.
 *
 * No reader data and no html bodies: ids, states, counts and redacted text.
 */

export const DIGESTS_ROUTE = '/digests';
const HISTORY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AttentionInput = {
  enabled: boolean;
  now: Date;
  cfg: Pick<DigestEnv, 'sendLive' | 'approvalRequired' | 'sanityMaxCandidates' | 'cutoff'>;
  run: {
    build: DigestBuild;
    approval: DigestApproval;
    skipReason: string | null;
    candidateCount: number;
    /**
     * The CURRENT reason a failed build is failing (`ads_unfillable` | `build_error`)
     * and its plain-words detail. Read instead of the once-per-run alert markers, so
     * a later non-ads failure is never reported as "ads" (QA L5). Optional for table tests.
     */
    buildFailure?: string | null;
    buildError?: string | null;
    /** Task 13: the last Mailercloud health check (null = none yet today). Optional for table tests. */
    healthOk?: boolean | null;
    healthError?: string | null;
    /** Task 13: the complaint-rate check taken when the run opened (`holds.ts` ComplaintCheck). */
    complaintCheck?: unknown;
    /** Task 13: the daily webhook status read (false = Mailercloud reports it inactive). */
    webhookActive?: boolean | null;
  } | null;
  sends: ReadonlyArray<{
    /** Optional for table tests; needed to name the audience of a per-variant ad failure. */
    audience?: DigestAudience;
    state: DigestSendState;
    sendAfter: Date;
    lastError: string | null;
    lastErrorKind: SenderErrorKind | null;
    /** Set while the variant waits for its ads (frozen without content). */
    contentPendingAt?: Date | null;
    /** Owner 2026-10-23: rendered after the build, so it needs its own approval in approval mode. */
    ownApprovalRequired?: boolean;
    approvedAt?: Date | null;
    /** Owner 2026-10-23: the custom template failed and the built-in one was used. */
    templateFallbackFromId?: string | null;
    /** Task 13, owner decision A: adopted a Mailercloud draft, so it waits for its own approval. */
    adoptedDraftAt?: Date | null;
    /** Task 13: the provider campaign name, for the duplicate-name banner. */
    mcCampaignName?: string;
  }>;
  /** Task 8: the most recent judgeable send got no campaign webhook (`webhookHealth().alive === false`). */
  webhookSilent?: boolean;
  /** Task 8: opt-out events without a readable address in the last 24 h (count). */
  webhookNoAddress?: number;
};

export type Attention = { code: string; headline: string; action: string; link: string };

function attention(code: string, headline: string, action: string): Attention {
  return { code, headline, action, link: DIGESTS_ROUTE };
}

/**
 * Whether today's digest needs a human, and the one line saying what to do.
 * Null when the digest is off, has no run today, or nothing is wrong. First
 * match wins:
 *
 *  1. failed (a variant FAILED, or the build failed) — worded by the cause;
 *  2. sanity hold (more candidates than DIGEST_SANITY_MAX_CANDIDATES, not approved);
 *  3. skipped for any reason except too_little_news (and, in preview mode,
 *     except the routine cut-off skip of unscheduled drafts);
 *  4. partially sent;
 *  5. waiting for approval past the send time;
 *  6. a variant is retrying after a temporary provider error;
 *  7. (task 8) the Mailercloud webhook looks switched off — shown even with no
 *     run today, because it concerns an earlier send;
 *  8. (task 8) opt-out events without a readable address in the last 24 h.
 *
 * Task 13 adds, in this order inside the run's checks: an adopted Mailercloud
 * draft waiting for a person (after "failed"), a failing health check, the
 * complaint hold (after the sanity hold), two campaigns with the same name
 * (before "retrying"); then, after the run's checks, the webhook reported
 * inactive by the daily status read, and — lowest, only while sending is live —
 * a previous send whose complaint rate is UNKNOWN (no webhook proof), because the
 * automatic hold cannot protect the next send then.
 */
export function digestAttention(i: AttentionInput): Attention | null {
  if (!i.enabled) return null;
  const forRun = i.run ? runAttention(i) : null;
  if (forRun) return forRun;
  if (i.run?.webhookActive === false) {
    return attention(
      'webhook_disabled',
      'Mailercloud reports our webhook as switched off.',
      'Switch the webhook back on in Mailercloud. Sends are still checked, but unsubscribes and bounces are not being copied meanwhile.',
    );
  }
  if (i.webhookSilent) {
    return attention(
      'webhook_silent',
      'Mailercloud has stopped calling our webhook.',
      'Switch the webhook back on in Mailercloud. Sends are still checked, but unsubscribes and bounces are not being copied meanwhile.',
    );
  }
  if (i.webhookNoAddress && i.webhookNoAddress > 0) {
    return attention(
      'webhook_no_address',
      `${i.webhookNoAddress} unsubscribe/bounce event(s) from Mailercloud arrived without a readable address.`,
      'They were not copied to our suppression list (Mailercloud still honours its own). Ask the developer to check the webhook field names.',
    );
  }
  const check = i.run ? complaintCheckOf(i.run) : null;
  if (i.cfg.sendLive && check && !check.held && check.sends.some((x) => x.ratePct === null)) {
    const names = check.sends.filter((x) => x.ratePct === null).map((x) => audienceName(x.audience as DigestAudience)).join(' and ');
    return attention(
      'complaint_rate_unknown',
      `The spam-complaint rate of the last ${names} digest${check.previousRunDate ? ` (${check.previousRunDate})` : ''} is unknown: Mailercloud has not confirmed that send through the webhook.`,
      `So the automatic hold (above ${check.thresholdPct}%) cannot protect today's digest. Check the Complaints column in Digests and the webhook in Mailercloud.`,
    );
  }
  return null;
}

function runAttention(i: AttentionInput): Attention | null {
  if (!i.run) return null;
  const { run, sends, cfg } = i;
  const cutoff = `${cfg.cutoff} IST`;
  const state = digestRunState(run, sends);

  const fixAds = `Open Ads and give every slot an active or default ad, then press Retry now in Digests before ${cutoff}.`;
  if (state === 'failed') {
    if (run.build === 'BUILD_FAILED' && run.buildFailure === 'ads_unfillable') {
      return attention('ads_unfillable', `Today's digest is stopped: an ad slot cannot be filled${detailOf(run.buildError)}.`, fixAds);
    }
    const waitingForAds = sends.filter((s) => s.state === 'FAILED' && s.contentPendingAt);
    if (run.build === 'BUILT' && waitingForAds.length > 0) {
      const names = waitingForAds.map((s) => audienceName(s.audience)).join(' and ');
      const others = sends.filter((s) => !s.contentPendingAt).map((s) => audienceName(s.audience));
      return attention(
        'ads_unfillable',
        `The ${names} digest is stopped: an ad slot cannot be filled${detailOf(waitingForAds.map((s) => s.lastError?.replace(/^ads_unfillable:\s*/, '')).join('; '))}.` +
          (others.length ? ` The ${others.join(' and ')} digest is not affected.` : ''),
        fixAds,
      );
    }
    if (run.build === 'BUILD_FAILED') {
      return attention('build_failed', "Today's digest could not be built.", `It is retried until ${cutoff}; if it keeps failing, check the app logs and the digest settings.`);
    }
    const failed = sends.filter((s) => s.state === 'FAILED');
    const err = (p: string) => failed.some((s) => s.lastError?.startsWith(p));
    if (err('config_invalid')) {
      return attention('config_invalid', "Today's digest settings are incomplete.", `Fix the DIGEST_* variables in Railway, then press Retry now in Digests before ${cutoff}.`);
    }
    if (err('provider_failed')) {
      return attention('provider_failed', 'Mailercloud reported today’s digest as failed.', 'Check the campaign in Mailercloud; it will not be re-sent today.');
    }
    if (err('not_confirmed_by_cutoff')) {
      return attention('not_confirmed_by_cutoff', `Today's digest was not confirmed sent by ${cfg.cutoff}.`, 'Check in Mailercloud whether the campaign went out.');
    }
    if (failed.some((s) => s.lastErrorKind === 'FATAL')) {
      return attention('fatal', 'Mailercloud rejected today’s digest.', `Check the Mailercloud API key and account in Railway, then press Retry now in Digests before ${cutoff}.`);
    }
    if (failed.some((s) => s.lastErrorKind === 'AMBIGUOUS')) {
      return attention('ambiguous', 'Mailercloud did not confirm today’s digest.', `Check Mailercloud for today’s TS-DIGEST draft, then press Retry now in Digests before ${cutoff}.`);
    }
    return attention('failed', "Today's digest failed.", 'Open Digests for the details.');
  }

  const unfinished = state === 'building' || state === 'created';

  // Owner decision A: a variant that adopted a Mailercloud draft waits for a person in every mode.
  const adopted = sends.filter((s) => s.adoptedDraftAt && !s.approvedAt && (s.state === 'PENDING' || s.state === 'CREATED'));
  if (adopted.length > 0) {
    const names = adopted.map((s) => audienceName(s.audience)).join(' and ');
    return attention(
      'adopted_draft',
      `Mailercloud already had today's ${names} digest draft, which this system did not see being made (it may be from before a database restore). It is not sent until someone approves it.`,
      `Open that draft in Mailercloud: delete it if it is not today's content (a fresh one is made by itself), or approve the ${names} digest in Digests before ${cutoff}.`,
    );
  }

  if (run.healthOk === false && (unfinished || state === 'scheduled')) {
    const fatal = Boolean(run.healthError?.startsWith('FATAL'));
    return attention(
      'health_failed',
      fatal ? 'Mailercloud rejected the digest health check (key or account).' : 'Mailercloud is unreachable (the digest health check failed).',
      fatal
        ? 'Check the Mailercloud API key and plan in Railway and Mailercloud; the check repeats hourly and picks the digest up again once it passes.'
        : 'Nothing yet; the check repeats before the send. If it keeps failing, check Mailercloud’s status.',
    );
  }

  if (unfinished && run.build === 'BUILT' && run.candidateCount > cfg.sanityMaxCandidates && run.approval !== 'APPROVED' && run.approval !== 'HELD') {
    return attention(
      'sanity_hold',
      `Today's digest is held: ${run.candidateCount} candidate stories is unusually many.`,
      `Check the story list, then approve or hold it in Digests before ${cutoff}.`,
    );
  }

  const complaint = complaintCheckOf(run);
  if (unfinished && complaint && isComplaintHeld(run) && run.approval !== 'APPROVED' && run.approval !== 'HELD') {
    const worst = complaint.sends.filter((x) => x.ratePct !== null).sort((a, b) => (b.ratePct ?? 0) - (a.ratePct ?? 0))[0];
    return attention(
      'complaint_hold',
      `Today's digest is held: the last ${audienceName(worst?.audience as DigestAudience)} digest had a spam-complaint rate of ${worst?.ratePct?.toFixed(2) ?? '?'}% (limit ${complaint.thresholdPct}%).`,
      `Find out why readers marked it as spam, then approve or hold today's digest in Digests before ${cutoff}.`,
    );
  }

  const skippedForAds = (s: AttentionInput['sends'][number]) => s.state === 'SKIPPED' && Boolean(s.contentPendingAt);
  if (state === 'skipped') {
    const reason = run.skipReason;
    if (reason === 'too_little_news') return null;
    if (!cfg.sendLive && (reason === 'cutoff_passed' || reason === 'not_approved')) return null;
    const ads = reason === 'config_invalid' && (run.buildFailure === 'ads_unfillable' || sends.some(skippedForAds));
    return attention(
      'skipped',
      ads ? "Today's digest was skipped because an ad slot could not be filled before the cut-off." : `Today's digest was skipped because ${skipWords(reason)}.`,
      ads
        ? 'Open Ads and make the coverage check show every slot ✓; the top stories roll into the next digest.'
        : reason === 'config_invalid'
          ? 'Fix the DIGEST_* variables in Railway; the top stories roll into the next digest.'
          : 'Open Digests for the details; the top stories roll into the next digest.',
    );
  }

  // One variant went out and the other was skipped (e.g. its ads could not be filled):
  // say which, rather than "part was not delivered".
  const skippedSends = sends.filter((s) => s.state === 'SKIPPED');
  if (state === 'partially_sent' && skippedSends.length > 0 && skippedSends.length < sends.length && sends.every((s) => s.state === 'SENT' || s.state === 'SKIPPED')) {
    const ads = skippedSends.some(skippedForAds);
    const names = skippedSends.map((s) => audienceName(s.audience)).join(' and ');
    const sent = sends.filter((s) => s.state === 'SENT').map((s) => audienceName(s.audience)).join(' and ');
    if (!cfg.sendLive && !ads) return null;
    return attention(
      'variant_skipped',
      `Only the ${sent} digest went out today; the ${names} digest was skipped because ${ads ? 'an ad slot could not be filled before the cut-off' : skipWords(run.skipReason)}.`,
      ads ? 'Open Ads and make the coverage check show every slot ✓; its top stories roll into the next digest.' : 'Open Digests for the details; its top stories roll into the next digest.',
    );
  }

  if (state === 'partially_sent') {
    return attention('partially_sent', 'Part of today’s digest was not delivered.', 'Check the campaign report in Mailercloud; the top stories go into the next digest.');
  }

  if (unfinished && cfg.sendLive && cfg.approvalRequired && run.approval === 'PENDING') {
    const sendAt = sends.length ? Math.min(...sends.map((s) => s.sendAfter.getTime())) : null;
    if (sendAt !== null && i.now.getTime() >= sendAt) {
      return attention('awaiting_approval', "Today's digest is waiting for approval.", `Approve or hold it in Digests before ${cutoff}, or it is skipped.`);
    }
  }

  // A variant rendered after the run was approved waits for its OWN approval (owner, 2026-10-23).
  // The same "who must approve" rule as the runner and the screen (holds.ts), so a complaint-held
  // auto-mode day is covered too (QA of task 13: it was approval mode / sanity hold only here).
  const approvalNeeded = runNeedsApproval(cfg, run);
  const waitingOwn = sends.filter(
    (s) => s.ownApprovalRequired && !s.approvedAt && (s.state === 'PENDING' || s.state === 'CREATED') && !s.contentPendingAt,
  );
  if (cfg.sendLive && approvalNeeded && run.approval === 'APPROVED' && waitingOwn.length > 0 && waitingOwn.some((s) => i.now.getTime() >= s.sendAfter.getTime())) {
    const names = waitingOwn.map((s) => audienceName(s.audience)).join(' and ');
    return attention(
      'awaiting_approval',
      `The ${names} digest is waiting for approval: it was built after today's approval, so that approval does not cover it.`,
      `Check it and press Approve in Digests before ${cutoff}, or it is skipped.`,
    );
  }

  const duplicate = sends.filter((s) => (s.state === 'PENDING' || s.state === 'CREATED') && s.lastError?.startsWith('duplicate_name'));
  if (duplicate.length > 0) {
    const names = duplicate.map((s) => (s.mcCampaignName ? `"${s.mcCampaignName}"` : `for the ${audienceName(s.audience)} digest`)).join(' and ');
    return attention(
      'duplicate_name',
      `Two campaigns named ${names} exist in Mailercloud, so the system cannot tell which one is ours.`,
      `Delete the extra one in Mailercloud (keep the one that was sent, if any). The digest carries on by itself at its next check, until ${cutoff}.`,
    );
  }

  if (sends.some((s) => (s.state === 'PENDING' || s.state === 'CREATED') && s.lastError)) {
    return attention('retrying', 'Mailercloud is not answering; today’s digest is retrying.', `Retries continue automatically until ${cutoff}. Nothing to do yet.`);
  }

  // Owner, 2026-10-23: a custom template failed at send time and the built-in one was used.
  const fellBack = sends.filter((s) => s.templateFallbackFromId);
  if (fellBack.length > 0) {
    const names = fellBack.map((s) => audienceName(s.audience)).join(' and ');
    return attention(
      'template_fallback',
      `Today's ${names} digest used the built-in template: its own template could not be used.`,
      'Open Templates, fix that template (its checklist shows why) or revert it; until then each digest falls back the same way.',
    );
  }
  return null;
}

function audienceName(a: DigestAudience | undefined): string {
  return a === 'PREMIUM' ? 'Premium' : a === 'FREE' ? 'Free' : 'one';
}

/** " (Slot 3 — Premium: …)" from stored plain words, shortened; '' when there is nothing to add. */
function detailOf(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  return ` (${t.length > 200 ? `${t.slice(0, 197)}...` : t})`;
}

export type DigestStatusPayload = {
  enabled: boolean;
  generatedAt: string;
  config: {
    sendLive: boolean;
    approvalRequired: boolean;
    sendAt: string;
    /** When the daily build runs (IST HH:MM), or null when the schedule is invalid. */
    buildAt: string | null;
    cutoff: string;
    providerConfigured: boolean;
    alertEmailConfigured: boolean;
    webhooksEnabled: boolean;
  };
  /** Task 8: whether the Mailercloud webhook looks alive (null = nothing to judge yet). */
  webhook: WebhookHealth;
  today: null | {
    runId: string;
    runDate: string;
    state: DigestRunState;
    build: DigestBuild;
    approval: DigestApproval;
    skipReason: string | null;
    candidateCount: number;
    readsUsed: boolean | null;
    readsSource: string | null;
    builtAt: Date | null;
    /** The current build failure cause (ads_unfillable | build_error) and its detail, while BUILD_FAILED. */
    buildFailure: string | null;
    buildError: string | null;
    /** Task 13: the last Mailercloud health check. */
    health: { ok: boolean | null; checkedAt: Date | null; error: string | null };
    /** Task 13: the previous send's complaint rate, judged when the run opened (null = not yet). */
    complaintCheck: ComplaintCheck | null;
    /** Task 13: the daily webhook status read (null = not read today, or no MAILERCLOUD_WEBHOOK_ID). */
    webhookActive: boolean | null;
    variants: {
      audience: string;
      state: DigestSendState;
      sendAfter: Date;
      scheduledAt: Date | null;
      sentConfirmedAt: Date | null;
      nextAttemptAt: Date | null;
      attempts: number;
      lastError: string | null;
      lastErrorKind: SenderErrorKind | null;
      targeted: number | null;
      reached: number | null;
    }[];
    alerts: { kind: string; text: string; raisedAt: string | null; open: boolean; emailed: boolean; emailedAt: string | null }[];
    resolvedAt: string | null;
  };
  attention: Attention | null;
  history: { runDate: string; state: DigestRunState }[];
};

/** The daily build time for the "no run yet" line; never throws (a bad QUIET_HOURS_* would). */
function buildAtOf(cfg: DigestEnv): string | null {
  try {
    const check = validateDigestSchedule(cfg);
    return check.ok ? check.schedule.buildAt : null;
  } catch {
    return null;
  }
}

/** Builds the status payload for `portal` at `now`. */
export async function digestStatus(opts: { portal?: string; now?: Date; cfg?: DigestEnv } = {}): Promise<DigestStatusPayload> {
  const cfg = opts.cfg ?? env.digest;
  const now = opts.now ?? new Date();
  const portal = opts.portal ?? env.rss.portal;
  const base: Omit<DigestStatusPayload, 'today' | 'attention' | 'history' | 'webhook'> = {
    enabled: cfg.enabled,
    generatedAt: now.toISOString(),
    config: {
      sendLive: cfg.sendLive,
      approvalRequired: cfg.approvalRequired,
      sendAt: cfg.sendAt,
      buildAt: buildAtOf(cfg),
      cutoff: cfg.cutoff,
      providerConfigured: cfg.mailercloud.apiKey.trim() !== '',
      alertEmailConfigured: isEmailConfigured(),
      webhooksEnabled: cfg.webhooksEnabled,
    },
  };
  if (!cfg.enabled) {
    const webhook = { enabled: cfg.webhooksEnabled, alive: null, lastEventAt: null, lastNoAddressAt: null, noAddressCount: 0 };
    return { ...base, webhook, today: null, attention: null, history: [] };
  }
  const webhook = await webhookHealth({ portal, now, cfg });
  const webhookSilent = webhook.alive === false;
  const webhookNoAddress = noAddressRecently(webhook, now) ? webhook.noAddressCount : 0;

  const todayDate = istDateOf(now);
  const runs = await prisma.digestRun.findMany({
    where: { portal, runDate: { gte: new Date(todayDate.getTime() - (HISTORY_DAYS - 1) * DAY_MS), lte: todayDate } },
    orderBy: { runDate: 'desc' },
    include: {
      sends: {
        orderBy: { audience: 'asc' },
        select: {
          audience: true,
          state: true,
          sendAfter: true,
          scheduledAt: true,
          sentConfirmedAt: true,
          nextAttemptAt: true,
          attempts: true,
          lastError: true,
          lastErrorKind: true,
          targeted: true,
          reached: true,
          contentPendingAt: true,
          ownApprovalRequired: true,
          approvedAt: true,
          templateFallbackFromId: true,
          templateFallbackReason: true,
          adoptedDraftAt: true,
          mcCampaignName: true,
        },
      },
    },
  });
  const history = runs.map((r) => ({ runDate: runDateKey(r.runDate), state: digestRunState(r, r.sends) }));
  const run = runs.find((r) => r.runDate.getTime() === todayDate.getTime()) ?? null;
  if (!run) {
    return { ...base, webhook, today: null, attention: digestAttention({ enabled: cfg.enabled, now, cfg, run: null, sends: [], webhookSilent, webhookNoAddress }), history };
  }

  const alerts = (run.alerts ?? {}) as AlertMap;
  const resolvedAt = alerts.resolved?.raisedAt ?? null;
  const alertRows = Object.entries(alerts)
    .filter(([, m]) => m && typeof m === 'object')
    .map(([kind, m]) => ({
      kind,
      text: alertCopy(kind, m, cfg).short,
      raisedAt: m.raisedAt ?? null,
      open: !INFO_KINDS.has(kind) && !(resolvedAt && BLOCKING_KINDS.has(kind)),
      emailed: Boolean(m.emailedAt),
      emailedAt: m.emailedAt ?? null,
    }))
    .sort((a, b) => String(a.raisedAt).localeCompare(String(b.raisedAt)));

  return {
    ...base,
    webhook,
    today: {
      runId: run.id,
      runDate: runDateKey(run.runDate),
      state: digestRunState(run, run.sends),
      build: run.build,
      approval: run.approval,
      skipReason: run.skipReason,
      candidateCount: run.candidateCount,
      readsUsed: run.readsUsed,
      readsSource: run.readsSource,
      builtAt: run.builtAt,
      buildFailure: run.buildFailure,
      buildError: run.buildError ? safeDetail(run.buildError, cfg) : null,
      health: { ok: run.healthOk, checkedAt: run.healthCheckedAt, error: run.healthError ? safeDetail(run.healthError, cfg) : null },
      complaintCheck: complaintCheckOf(run),
      webhookActive: run.webhookActive,
      variants: run.sends.map((s) => ({
        ...s,
        lastError: s.lastError ? safeDetail(s.lastError, cfg) : null,
        templateFallbackReason: s.templateFallbackReason ? safeDetail(s.templateFallbackReason, cfg) : null,
      })),
      alerts: alertRows,
      resolvedAt,
    },
    attention: digestAttention({ enabled: cfg.enabled, now, cfg, run, sends: run.sends, webhookSilent, webhookNoAddress }),
    history,
  };
}

