import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { redactError } from './sender';
import { runDateKey } from './retryPolicy';
import { digestRunState } from './runState';

/**
 * Digest alert emails (docs/EMAIL_DIGEST_DESIGN.md §4 `alerts.ts`, §8, task 6).
 *
 * The runner records "alert needed" markers on `DigestRun.alerts`
 * (`{kind: {raisedAt, …detail}}`, at most one per kind per run). This module
 * turns each marker into ONE email to the active ADMIN users, sent through the
 * same ElasticEmail transactional path as the report emails — deliberately a
 * different channel from the digest provider (Mailercloud), so "Mailercloud is
 * down" can still be reported.
 *
 * Dedupe, per kind, inside the same JSON:
 *  - a conditional UPDATE claims the kind (`emailClaim` token) only while
 *    `emailedAt` is null and no live claim exists — two ticks cannot both send;
 *  - success stamps `emailedAt` (+ `emailedTo` count), so no tick re-sends it;
 *  - every claim counts one `emailAttempts`; after `MAX_ATTEMPTS` the kind is
 *    never claimed again (so even a lost stamp repeats an email at most that
 *    often); a failed send waits `RETRY_AFTER_MIN` — the banner is the backstop.
 *
 * Recovery: when a run that had a blocking alert reaches `sent`, a `resolved`
 * marker is written and one "resolved" email goes out — but only if a problem
 * email was actually sent (or is in flight), so nobody gets a recovery note
 * for a problem they never heard about.
 *
 * Never throws. Never puts an API key, a reader address or a full provider
 * error into an email or a log line: every free-text detail is re-redacted and
 * shortened here even though the runner already redacted it.
 */

export type AlertKind =
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
  | 'webhook_silent'
  | 'resolved';

/**
 * Kinds that a later successful send makes moot. Terminal kinds (skipped,
 * provider_failed, partial_send, not_confirmed_by_cutoff) cannot be followed by
 * a `sent` run, and orphan_draft is housekeeping, not a failed send.
 */
export const BLOCKING_KINDS: ReadonlySet<string> = new Set([
  'fatal',
  'config_invalid',
  'ambiguous_create',
  'schedule_unconfirmed',
  'retrying',
  'build_failed',
  'sanity_hold',
]);

/** Skip reasons that are routine while DIGEST_SEND_LIVE is off (drafts only, nothing is meant to send). */
const PREVIEW_ROUTINE_SKIPS = new Set(['cutoff_passed', 'not_approved']);

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MIN = 10;
const CLAIM_STALE_MIN = 10;
const MINUTE = 60_000;
const DETAIL_MAX = 160;

/** One alert marker as stored in `DigestRun.alerts`. Fields after `raisedAt` are optional. */
export type AlertMarker = {
  raisedAt?: string;
  audience?: string;
  step?: string;
  error?: string;
  reason?: string;
  problems?: unknown;
  /** 'ads' when an unfillable ad slot stopped the build (task 9). */
  source?: string;
  campaignName?: string;
  candidates?: number;
  max?: number;
  targeted?: number | null;
  reached?: number | null;
  reachKnown?: boolean;
  emailedAt?: string | null;
  emailedTo?: number;
  emailSkipped?: string;
  emailClaim?: string;
  emailClaimedAt?: string;
  emailAttempts?: number;
  emailRetryAfter?: string;
  emailError?: string;
  [k: string]: unknown;
};

export type AlertMap = Record<string, AlertMarker>;

/** Plain-words copy for one alert: used by the email AND by `/api/digest/status`. */
export type AlertCopy = {
  /** Subject fragment, also the short text on the status screen. */
  short: string;
  /** What happened. */
  what: string;
  /** What the system did about it. */
  did: string;
  /** What a human should do. */
  todo: string;
};

/** Re-redacts and shortens any free text taken from a marker. */
export function safeDetail(value: unknown, cfg: Pick<DigestEnv, 'mailercloud'> = env.digest): string {
  if (value === null || value === undefined) return '';
  const raw = Array.isArray(value) ? value.map(String).join('; ') : String(value);
  const secrets = [cfg.mailercloud.apiKey, cfg.mailercloud.webhookToken, cfg.mailercloud.webhookTokenPrevious, env.email.apiKey];
  const red = redactError(raw, secrets);
  return red.length > DETAIL_MAX ? `${red.slice(0, DETAIL_MAX - 3)}...` : red;
}

const SKIP_WORDS: Record<string, string> = {
  cutoff_passed: 'it was not sent before the cut-off',
  not_approved: 'nobody approved it before the cut-off',
  held_by_editor: 'an editor held it',
  sanity_hold_expired: 'it was held for unusually many stories and not approved before the cut-off',
  build_failed: 'it could not be built before the cut-off',
  config_invalid: 'the digest settings are incomplete',
  too_little_news: 'there was too little news',
};

export function skipWords(reason: string | null | undefined): string {
  return (reason && SKIP_WORDS[reason]) || 'of an unknown reason';
}

function variantWords(m: AlertMarker): string {
  if (m.audience === 'FREE') return 'The Free digest';
  if (m.audience === 'PREMIUM') return 'The Premium digest';
  return "Today's digest";
}

/** The copy for one alert kind. Unknown (future) kinds get a generic text, never nothing. */
export function alertCopy(kind: string, m: AlertMarker, cfg: DigestEnv = env.digest): AlertCopy {
  const cutoff = `${cfg.cutoff} IST`;
  const who = variantWords(m);
  const retryNow = `press Retry now in Admin → Digests before ${cutoff}`;
  switch (kind) {
    case 'fatal':
      return {
        short: 'Mailercloud rejected the digest',
        what: `${who} was refused by Mailercloud at the ${m.step ?? 'send'} step${m.error ? ` (${safeDetail(m.error, cfg)})` : ''}.`,
        did: 'Stopped — there is no automatic retry for this error, and nothing was sent.',
        todo: `Check the Mailercloud API key and the account (plan, quota, sender) in Railway and Mailercloud, then ${retryNow}.`,
      };
    case 'config_invalid':
      if (m.source === 'ads') {
        // One audience blocked (task 9 follow-ups): the other one is built and goes out as normal.
        const one = m.audience === 'FREE' || m.audience === 'PREMIUM';
        const other = m.audience === 'FREE' ? 'Premium' : 'Free';
        return {
          short: one ? `${who.replace(/^The /, '')} has an ad slot that cannot be filled` : 'A digest ad slot cannot be filled',
          what: `${one ? who : "Today's digest"} has an ad slot no ad can fill: ${safeDetail(m.problems, cfg) || 'see Admin → Ads'}.`,
          did: one
            ? `The ${other} digest was built and goes out as normal. The ${who.replace(/^The /, '')} was not created — a slot is never sent empty — and is tried again until ${cutoff}, then skipped.`
            : `Stopped before anything was frozen or created — a slot is never sent empty. The build is tried again until ${cutoff}.`,
          todo: `In Admin → Ads, give that slot an active ad or a default ad (the coverage check there must show every slot ✓), then ${retryNow}.`,
        };
      }
      return {
        short: 'Digest settings are incomplete',
        what: `The digest settings are incomplete: ${safeDetail(m.problems, cfg) || 'see Admin → Digests'}.`,
        did: 'Stopped — nothing was created or sent. Today’s stories roll into the next digest.',
        todo: 'Fix the listed DIGEST_* / MAILERCLOUD_* variables in Railway. If only one variant failed, then ' + retryNow + '.',
      };
    case 'ambiguous_create':
      return {
        short: 'Digest draft not confirmed — check Mailercloud',
        what: `${who}: Mailercloud did not confirm whether it created the draft${m.campaignName ? ` "${safeDetail(m.campaignName, cfg)}"` : ''}.`,
        did: 'Stopped — no second draft is created blindly, and nothing was scheduled.',
        todo: `Look in Mailercloud for that draft name, then ${retryNow}. Only the saved draft is ever sent.`,
      };
    case 'schedule_unconfirmed':
      return {
        short: 'Could not confirm the digest was scheduled',
        what: `${who}: Mailercloud did not answer whether the campaign was scheduled.`,
        did: `Paused — nothing is re-sent until Mailercloud answers; it is checked again on the next attempt and at ${cutoff}.`,
        todo: 'Check the campaign in Mailercloud. Nothing to do if it shows as sending or sent.',
      };
    case 'orphan_draft':
      return {
        short: 'Spare digest draft in Mailercloud',
        what: `${who}: a second draft${m.campaignName ? ` named "${safeDetail(m.campaignName, cfg)}"` : ''} exists in Mailercloud.`,
        did: 'Nothing was sent from it — only the saved draft is ever scheduled.',
        todo: 'Delete the spare draft in Mailercloud when convenient.',
      };
    case 'retrying':
      return {
        short: 'Mailercloud not answering — retrying',
        what: `${who}: the ${m.step ?? 'send'} step failed with a temporary error.`,
        did: `Retrying automatically (+1, +5, +15 minutes, then hourly) until ${cutoff}.`,
        todo: 'Nothing yet. If Admin → Digests still shows it failing by mid-morning, check Mailercloud’s status.',
      };
    case 'skipped':
      if (m.source === 'ads') {
        return {
          short: `${m.audience ? who.replace(/^The /, '') : "Today's digest"} was skipped — an ad slot could not be filled`,
          what: `${m.audience ? who : "Today's digest"} was skipped because an ad slot could not be filled before the cut-off.`,
          did: 'Stopped — nothing more is sent today for it. Its top stories roll into the next digest.',
          todo: 'In Admin → Ads, make the coverage check show every slot ✓ so tomorrow’s digest is not stopped too.',
        };
      }
      return {
        short: "Today's digest was skipped",
        what: `Today's digest was skipped because ${skipWords(m.reason)}.`,
        did: 'Stopped — nothing more is sent today. The top stories roll into the next digest.',
        todo:
          m.reason === 'not_approved' || m.reason === 'sanity_hold_expired'
            ? `Approve earlier next time (Admin → Digests, before ${cutoff}).`
            : 'Open Admin → Digests to see what happened; no action is needed for today.',
      };
    case 'partial_send':
      return {
        short: 'Digest only partly delivered',
        what: `${who} stopped part-way in Mailercloud${typeof m.reached === 'number' && typeof m.targeted === 'number' ? ` (${m.reached} of ${m.targeted} reached)` : ''}.`,
        did: 'Not re-sent (readers who got it would get it twice). Its top stories go into the next digest’s “In case you missed it”.',
        todo: 'Check the campaign report in Mailercloud.',
      };
    case 'provider_failed':
      return {
        short: 'Mailercloud reported the digest as failed',
        what: `${who}: Mailercloud reports the campaign as failed${m.reachKnown === false ? ' (reach unknown)' : ''}.`,
        did: 'Stopped for today — it will not be re-sent.',
        todo: 'Check the campaign and the account status in Mailercloud.',
      };
    case 'not_confirmed_by_cutoff':
      return {
        short: `Digest not confirmed sent by ${cfg.cutoff}`,
        what: `${who} could not be confirmed as sent by the ${cutoff} cut-off.`,
        did: 'Stopped — no more attempts today.',
        todo: 'Check in Mailercloud whether the campaign went out.',
      };
    case 'build_failed':
      return {
        short: 'Digest build failed',
        what: `Today's digest could not be built${m.error ? ` (${safeDetail(m.error, cfg)})` : ''}.`,
        did: `Nothing was created or sent. The build is retried until ${cutoff}.`,
        todo: 'If Admin → Digests still shows it failing, check the app logs and the digest settings.',
      };
    case 'sanity_hold':
      return {
        short: 'Digest held for approval — unusually many stories',
        what: `Today's digest found ${m.candidates ?? 'too many'} candidate stories (the limit is ${m.max ?? cfg.sanityMaxCandidates}). This usually means the site re-published its feed.`,
        did: 'Held for approval — nothing is sent until an editor approves.',
        todo: `Check the story list, then approve or hold it in Admin → Digests before ${cutoff}.`,
      };
    case 'webhook_silent':
      return {
        short: 'Mailercloud webhook is silent — re-enable it',
        what: `${who} was confirmed sent by polling, but Mailercloud never called our webhook about it. Mailercloud switches a webhook off after repeated failed deliveries.`,
        did: 'Sends are still verified by polling; unsubscribes, bounces and spam reports are not being copied to our suppression list meanwhile.',
        todo: 'In Mailercloud, check the webhook pointing at push.taxscan.in and switch it back on (or re-create it with the current URL).',
      };
    case 'resolved':
      return {
        short: 'Resolved — digest sent',
        what: "Today's digest was sent to every audience after the earlier problem.",
        did: 'Delivered; the earlier alert no longer applies.',
        todo: 'Nothing to do.',
      };
    default:
      return {
        short: 'Digest needs attention',
        what: `The digest raised an alert (${safeDetail(kind, cfg)}).`,
        did: 'See Admin → Digests for the current state.',
        todo: 'Open Admin → Digests.',
      };
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Subject + bodies for one alert email. */
export function buildAlertEmail(
  kind: string,
  m: AlertMarker,
  runDate: Date,
  cfg: DigestEnv = env.digest,
): { subject: string; html: string; text: string } {
  const c = alertCopy(kind, m, cfg);
  const date = runDateKey(runDate);
  const subject = `[Taxscan digest] ${c.short} — ${date}`;
  const rows: [string, string][] = [
    ['What happened', c.what],
    ['What the system did', c.did],
    ['What to do', c.todo],
  ];
  const text = [
    `Daily email digest, ${date}`,
    '',
    ...rows.flatMap(([h, v]) => [`${h}: ${v}`, '']),
    'This is an internal alert for Taxscan Push administrators. Readers never receive it.',
  ].join('\n');
  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.5;">
    <p><strong>Daily email digest, ${esc(date)}</strong></p>
${rows.map(([h, v]) => `    <p><strong>${esc(h)}:</strong> ${esc(v)}</p>`).join('\n')}
    <p style="font-size: 13px; color: #555;">This is an internal alert for Taxscan Push administrators. Readers never receive it.</p>
  </body>
</html>`;
  return { subject, html, text };
}

/** Active ADMIN users — the alert audience. No separate recipient list. Never logged. */
export async function digestAlertRecipients(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true, role: 'ADMIN' }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.trim().toLowerCase()))];
}

export type AlertDeps = {
  emailSender?: EmailSender;
  /** Default: `isEmailConfigured()` (ElasticEmail key + from-address present). */
  isConfigured?: () => boolean;
  recipients?: () => Promise<string[]>;
  now?: Date;
  cfg?: DigestEnv;
};

export type AlertOutcome = {
  runId: string;
  /** Kinds emailed by THIS call. */
  emailed: string[];
  /** Kinds this call tried and could not deliver to anyone. */
  failed: string[];
  notConfigured?: boolean;
};

let warnedNotConfigured = false;

/** For tests: the "not configured" warning is logged once per process. */
export function resetAlertWarningsForTests(): void {
  warnedNotConfigured = false;
}

function warn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[digest-alerts] ${msg}`);
}

/**
 * Claims one kind for emailing. The database evaluates the WHERE under the
 * row lock (re-checked on the latest row version if another tick updated it
 * meanwhile), so of two concurrent callers exactly one wins.
 *
 * `emailAttempts` is incremented IN this statement, before the send, so every
 * attempt counts — including one whose email went out but whose `emailedAt`
 * stamp never landed (crash, DB blip). After MAX_ATTEMPTS claims the kind is
 * never claimed again: a lost stamp repeats an email at most MAX_ATTEMPTS
 * times in total, never forever.
 *
 * A problem kind (BLOCKING_KINDS) is not claimed once `resolved` exists: the
 * recovery note covers it, and the resolved decision (`addResolvedMarker`) is
 * taken on the same locked row, so the two cannot interleave.
 *
 * Returns the attempt number won, or null.
 */
async function claimKind(runId: string, kind: string, token: string, now: Date): Promise<number | null> {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - CLAIM_STALE_MIN * MINUTE).toISOString();
  const patch = JSON.stringify({ emailClaim: token, emailClaimedAt: nowIso });
  const blocking = BLOCKING_KINDS.has(kind);
  const rows = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE "DigestRun"
       SET alerts = jsonb_set(
             alerts, ARRAY[${kind}::text],
             (alerts -> ${kind}::text) || ${patch}::jsonb || jsonb_build_object(
               'emailAttempts', COALESCE((alerts -> ${kind}::text ->> 'emailAttempts')::int, 0) + 1))
     WHERE id = ${runId}
       AND jsonb_typeof(alerts -> ${kind}::text) = 'object'
       AND (alerts -> ${kind}::text ->> 'emailedAt') IS NULL
       AND (alerts -> ${kind}::text ->> 'emailSkipped') IS NULL
       AND ((alerts -> ${kind}::text ->> 'emailClaimedAt') IS NULL
            OR (alerts -> ${kind}::text ->> 'emailClaimedAt')::timestamptz < ${staleIso}::timestamptz)
       AND COALESCE((alerts -> ${kind}::text ->> 'emailAttempts')::int, 0) < ${MAX_ATTEMPTS}
       AND ((alerts -> ${kind}::text ->> 'emailRetryAfter') IS NULL
            OR (alerts -> ${kind}::text ->> 'emailRetryAfter')::timestamptz <= ${nowIso}::timestamptz)
       AND (${!blocking} OR alerts -> 'resolved' IS NULL)
     RETURNING (alerts -> ${kind}::text ->> 'emailAttempts')::int AS attempts`;
  return rows.length === 1 ? Number(rows[0].attempts) : null;
}

/**
 * Writes the `resolved` marker once, deciding on the LOCKED row whether a
 * problem email was sent or is mid-send (`emailedAt` or `emailClaim` on any
 * blocking kind). If none was, the marker is born `emailSkipped` — nobody gets
 * a recovery note for a problem they never heard about. Because problem claims
 * refuse once `resolved` exists, a problem email is either visible here or
 * never sent.
 */
async function addResolvedMarker(runId: string, now: Date): Promise<void> {
  const base = JSON.stringify({ raisedAt: now.toISOString(), emailedAt: null });
  const skipped = JSON.stringify({ emailSkipped: 'no_problem_email_was_sent' });
  const kinds = [...BLOCKING_KINDS];
  await prisma.$executeRaw`
    UPDATE "DigestRun"
       SET alerts = alerts || jsonb_build_object('resolved',
             ${base}::jsonb || CASE WHEN EXISTS (
               SELECT 1 FROM jsonb_each("DigestRun".alerts) e
                WHERE e.key = ANY(${kinds}::text[])
                  AND jsonb_typeof(e.value) = 'object'
                  AND ((e.value ->> 'emailedAt') IS NOT NULL OR (e.value ->> 'emailClaim') IS NOT NULL)
             ) THEN '{}'::jsonb ELSE ${skipped}::jsonb END)
     WHERE id = ${runId} AND alerts -> 'resolved' IS NULL`;
}

/** Writes the outcome while our claim still stands, and releases the claim. */
async function finishKind(runId: string, kind: string, token: string, patch: Record<string, unknown>): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "DigestRun"
       SET alerts = jsonb_set(
             alerts, ARRAY[${kind}::text],
             ((alerts -> ${kind}::text) - 'emailClaim' - 'emailClaimedAt') || ${JSON.stringify(patch)}::jsonb)
     WHERE id = ${runId} AND (alerts -> ${kind}::text ->> 'emailClaim') = ${token}`;
}

/** Order the emails go out in: problems first, the recovery note last. */
function orderKinds(kinds: string[]): string[] {
  return [...kinds].sort((a, b) => Number(a === 'resolved') - Number(b === 'resolved') || a.localeCompare(b));
}

/**
 * Emails every alert marker on the run that has not been emailed yet (one per
 * kind per run), then the recovery note if the run has since been sent. Safe
 * to call after every `advanceRun` and from concurrent ticks. Never throws.
 */
export async function sendDigestAlerts(runId: string, deps: AlertDeps = {}): Promise<AlertOutcome> {
  const out: AlertOutcome = { runId, emailed: [], failed: [] };
  try {
    const configured = (deps.isConfigured ?? isEmailConfigured)();
    if (!configured) {
      if (!warnedNotConfigured) {
        warnedNotConfigured = true;
        warn('alert email not configured (ELASTICEMAIL_API_KEY/EMAIL_FROM) — relying on the Dashboard banner');
      }
      out.notConfigured = true;
      return out;
    }
    const cfg = deps.cfg ?? env.digest;
    const now = deps.now ?? new Date();
    const sender = deps.emailSender ?? defaultEmailSender;

    const run = await prisma.digestRun.findUnique({ where: { id: runId } });
    if (!run) return out;
    let alerts = (run.alerts ?? {}) as AlertMap;

    // Recovery: a run that had a blocking alert has now been sent.
    const sends = await prisma.digestSend.findMany({ where: { runId }, select: { state: true } });
    const blocking = Object.keys(alerts).filter((k) => BLOCKING_KINDS.has(k));
    if (digestRunState(run, sends) === 'sent' && blocking.length > 0 && !alerts.resolved) {
      await addResolvedMarker(runId, now);
      const fresh = await prisma.digestRun.findUnique({ where: { id: runId }, select: { alerts: true } });
      alerts = (fresh?.alerts ?? alerts) as AlertMap;
    }

    let recipients: string[] | null = null;
    for (const kind of orderKinds(Object.keys(alerts))) {
      const m = alerts[kind];
      if (!m || typeof m !== 'object' || m.emailedAt || m.emailSkipped) continue;
      // A problem fixed before its email went out: the recovery note covers it.
      if (alerts.resolved && BLOCKING_KINDS.has(kind)) continue;

      const token = randomUUID();
      const attempt = await claimKind(runId, kind, token, now);
      if (attempt === null) continue;

      // Routine in preview mode (drafts only): the 17:00 sweep skips every
      // unscheduled draft by design, so this is not news to anyone.
      if (kind === 'skipped' && !cfg.sendLive && PREVIEW_ROUTINE_SKIPS.has(String(m.reason))) {
        await finishKind(runId, kind, token, { emailSkipped: 'preview_only' });
        continue;
      }

      recipients ??= await (deps.recipients ?? digestAlertRecipients)();
      if (recipients.length === 0) {
        await finishKind(runId, kind, token, { emailSkipped: 'no_recipients' });
        warn(`run=${runId} ${kind}: no active ADMIN user to email`);
        continue;
      }

      const msg = buildAlertEmail(kind, m, run.runDate, cfg);
      let ok = 0;
      let lastError = '';
      for (const to of recipients) {
        try {
          const r = await sender({ to, ...msg });
          if (r.ok) ok++;
          else lastError = r.error;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (ok > 0) {
        // Delivered to at least one admin: never re-send (it would duplicate for the rest).
        await finishKind(runId, kind, token, {
          emailedAt: new Date().toISOString(),
          emailedTo: ok,
          ...(ok < recipients.length ? { emailFailedTo: recipients.length - ok } : {}),
        });
        out.emailed.push(kind);
      } else {
        const attempts = attempt; // already counted by the claim
        await finishKind(runId, kind, token, {
          emailRetryAfter: new Date(now.getTime() + RETRY_AFTER_MIN * MINUTE).toISOString(),
          emailError: safeDetail(lastError, cfg),
        });
        out.failed.push(kind);
        warn(`run=${runId} ${kind}: alert email failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${safeDetail(lastError, cfg)}`);
      }
    }
  } catch (err) {
    warn(`run=${runId} alert pass failed: ${safeDetail(err instanceof Error ? err.message : err)}`);
  }
  return out;
}
