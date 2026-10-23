import type { DigestApproval, DigestBuild, DigestSendState, SenderErrorKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { isEmailConfigured } from '../../lib/email';
import { digestRunState, type DigestRunState } from './runState';
import { istDateOf, runDateKey } from './retryPolicy';
import { validateDigestSchedule } from './scheduler';
import { BLOCKING_KINDS, alertCopy, safeDetail, skipWords, type AlertMap } from './alerts';
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
    /** Run alert markers (task 9 reads `config_invalid.source === 'ads'`). Optional for table tests. */
    alerts?: unknown;
  } | null;
  sends: ReadonlyArray<{
    state: DigestSendState;
    sendAfter: Date;
    lastError: string | null;
    lastErrorKind: SenderErrorKind | null;
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
 */
export function digestAttention(i: AttentionInput): Attention | null {
  if (!i.enabled) return null;
  const forRun = i.run ? runAttention(i) : null;
  if (forRun) return forRun;
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
  return null;
}

function runAttention(i: AttentionInput): Attention | null {
  if (!i.run) return null;
  const { run, sends, cfg } = i;
  const cutoff = `${cfg.cutoff} IST`;
  const state = digestRunState(run, sends);

  if (state === 'failed') {
    if (run.build === 'BUILD_FAILED' && (run.alerts as Record<string, { source?: string } | undefined> | null)?.config_invalid?.source === 'ads') {
      return attention('ads_unfillable', "Today's digest is stopped: an ad slot cannot be filled.", `Open Ads and give every slot an active or default ad, then press Retry now in Digests before ${cutoff}.`);
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
  if (unfinished && run.build === 'BUILT' && run.candidateCount > cfg.sanityMaxCandidates && run.approval !== 'APPROVED' && run.approval !== 'HELD') {
    return attention(
      'sanity_hold',
      `Today's digest is held: ${run.candidateCount} candidate stories is unusually many.`,
      `Check the story list, then approve or hold it in Digests before ${cutoff}.`,
    );
  }

  if (state === 'skipped') {
    const reason = run.skipReason;
    if (reason === 'too_little_news') return null;
    if (!cfg.sendLive && (reason === 'cutoff_passed' || reason === 'not_approved')) return null;
    return attention(
      'skipped',
      `Today's digest was skipped because ${skipWords(reason)}.`,
      reason === 'config_invalid'
        ? 'Fix the DIGEST_* variables in Railway; the top stories roll into the next digest.'
        : 'Open Digests for the details; the top stories roll into the next digest.',
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

  if (sends.some((s) => (s.state === 'PENDING' || s.state === 'CREATED') && s.lastError)) {
    return attention('retrying', 'Mailercloud is not answering; today’s digest is retrying.', `Retries continue automatically until ${cutoff}. Nothing to do yet.`);
  }
  return null;
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
      open: kind !== 'resolved' && !(resolvedAt && BLOCKING_KINDS.has(kind)),
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
      variants: run.sends.map((s) => ({ ...s, lastError: s.lastError ? safeDetail(s.lastError, cfg) : null })),
      alerts: alertRows,
      resolvedAt,
    },
    attention: digestAttention({ enabled: cfg.enabled, now, cfg, run, sends: run.sends, webhookSilent, webhookNoAddress }),
    history,
  };
}

