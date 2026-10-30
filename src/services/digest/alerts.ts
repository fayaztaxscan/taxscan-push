import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { redactError } from './sender';
import { runDateKey } from './retryPolicy';
import { digestRunState } from './runState';
import { pushToActiveStaff, type StaffPushTransport } from '../staffPush';
import type { StaffPushSubscription } from '@prisma/client';
import { DEFAULT_NOTIFICATION_BADGE, DEFAULT_NOTIFICATION_ICON } from '../send';

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
 *
 * Task 13: two kinds go to EDITORS (active ADMIN and PUBLISHER users — the people
 * who may approve, design §12 "Roles"), not admins only: `ready_for_approval`
 * (raised at the build in approval mode) and `not_approved_yet` (raised by the
 * scheduler at the send time + 60 min while approval is still pending). Both are
 * once per run like every kind, and both carry a link to the Digests screen.
 * The design does not keep these internal emails out of quiet hours (its 06:30
 * row sends "ready for approval" inside them), so neither waits for 07:00.
 * `health_failed` / `health_recovered` are the health check's pair (`health.ts`).
 */

export type AlertKind =
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
  | 'duplicate_name'
  | 'ready_for_approval'
  | 'not_approved_yet'
  | 'health_failed'
  | 'health_recovered'
  | 'complaint_hold'
  | 'webhook_disabled'
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
  'duplicate_name',
  'audience_unverified',
]);

/** Kinds emailed to editors (active ADMIN + PUBLISHER) instead of admins only. */
export const EDITOR_KINDS: ReadonlySet<string> = new Set(['ready_for_approval', 'not_approved_yet']);

/** Kinds that report progress, not a problem: never "open" on the status payload. */
export const INFO_KINDS: ReadonlySet<string> = new Set(['ready_for_approval', 'health_recovered', 'resolved']);

/** The problems a `health_recovered` note follows (only if one of them was emailed). */
export const HEALTH_PROBLEM_KINDS: ReadonlySet<string> = new Set(['health_failed']);

/** The Digests screen, absolute, for links in editor emails. */
export function digestsScreenUrl(cfg: Pick<DigestEnv, 'assetBaseUrl'> = env.digest): string {
  return `${appBase(cfg)}/admin/digests`;
}

/** The admin's absolute origin (APP_BASE_URL, else the asset base, else production). */
function appBase(cfg: Pick<DigestEnv, 'assetBaseUrl'>): string {
  return (env.appBaseUrl || cfg.assetBaseUrl || 'https://push.taxscan.in').replace(/\/+$/, '');
}

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
  complaint_hold_expired: 'it was held after a high spam-complaint rate and not approved before the cut-off',
  config_invalid: 'the digest settings are incomplete',
  too_little_news: 'there was too little news',
  audience_unverified: 'the reader list could not be verified before the cut-off',
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
export function alertCopy(kind: string, m: AlertMarker, cfg: DigestEnv = env.digest, guardOn: boolean = env.audience.digestFromCms): AlertCopy {
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
    case 'adopted_existing':
      if (m.draft === true) {
        return {
          short: 'Digest draft already in Mailercloud — held for approval',
          what: `${who}: Mailercloud already had today's campaign${m.campaignName ? ` "${safeDetail(m.campaignName, cfg)}"` : ''}${m.providerState === 'UNKNOWN' ? ' (its status could not be read)' : ''}, which this system did not create (e.g. after a database restore, or a campaign made by hand) — check it before approving.`,
          did: 'Adopted it without sending. It is not sent until a person approves it, even with automatic sending on.',
          todo: 'In Mailercloud, open that draft: if it is not today’s content, delete it (a fresh one is made at the next check). If it is right, approve that version in Admin → Digests.',
        };
      }
      return {
        short: 'Digest already in Mailercloud — adopted, not re-sent',
        what: `${who}: Mailercloud already had today's campaign${m.campaignName ? ` "${safeDetail(m.campaignName, cfg)}"` : ''}${typeof m.providerState === 'string' ? ` (${safeDetail(m.providerState.toLowerCase(), cfg)})` : ''} before this system had sent anything. This usually follows a database restore.`,
        did: 'Adopted that campaign and followed its status in Mailercloud. Nothing was created or sent a second time.',
        todo: 'Check Mailercloud shows exactly one campaign with that name for today. The story list on Admin → Digests may differ from what that campaign carried.',
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
    case 'template_fallback': {
      const names = Array.isArray(m.templates)
        ? (m.templates as { audience?: string; name?: string }[]).map((t) => `"${safeDetail(t.name, cfg)}" (${t.audience === 'PREMIUM' ? 'Premium' : 'Free'})`).join(' and ')
        : `"${safeDetail(m.templateName, cfg)}"`;
      return {
        short: 'Digest template failed — the built-in template was used',
        what: `The digest template ${names} could not be used at send time${m.reason ? ` (${safeDetail(m.reason, cfg)})` : ''}.`,
        did: 'That digest was built with the built-in template instead, with every usual check (allowlist, size, no subscription ad for Premium). Nothing else changed.',
        todo: 'Open Admin → Templates, run the checklist on that template and fix it (or revert to the previous one). Tomorrow uses it again unless it is fixed or replaced.',
      };
    }
    case 'duplicate_name':
      return {
        short: 'Two digest campaigns with the same name in Mailercloud',
        what: `${who}: Mailercloud has two campaigns named${m.campaignName ? ` "${safeDetail(m.campaignName, cfg)}"` : ' like today’s digest'}, so the system cannot tell which one is ours.`,
        did: `Paused — nothing is created or sent while there are two. It checks again by itself (+1, +5, +15 minutes, then hourly) until ${cutoff}.`,
        todo: 'In Mailercloud, delete the extra campaign with that name (keep the one that was sent, if any). The digest carries on by itself at the next check.',
      };
    case 'ready_for_approval': {
      const preview = m.preview === true;
      const why =
        m.reason === 'complaint_hold'
          ? ' It needs an approval today because yesterday’s spam-complaint rate was high.'
          : m.reason === 'sanity_hold'
            ? ' It needs an approval today because it found unusually many stories.'
            : '';
      const names = Array.isArray(m.audiences) && m.audiences.length
        ? (m.audiences as string[]).map((a) => (a === 'PREMIUM' ? 'Premium' : 'Free')).join(' and ')
        : 'Both';
      return {
        short: preview ? "Today's digest is ready to review" : "Today's digest is ready for approval",
        what: `${names} ${Array.isArray(m.audiences) && m.audiences.length === 1 ? 'version is' : 'versions are'} built and frozen.${why}`,
        did: preview
          ? 'Preview only: sending is switched off (DIGEST_SEND_LIVE), so nothing goes to readers.'
          : `Waiting for an editor. It goes out at ${cfg.sendAt} IST once approved; not approved by ${cutoff}, it is skipped.`,
        todo: `Open the Digests screen (${digestsScreenUrl(cfg)}), read the preview, then ${preview ? 'compare it with the hand-made digest.' : 'press Approve (or Hold).'}`,
      };
    }
    case 'not_approved_yet':
      return {
        short: "Today's digest is still waiting for approval",
        what: `Today's digest was due at ${cfg.sendAt} IST and nobody has approved it yet.`,
        did: `Waiting — it is not sent without an approval. Not approved by ${cutoff}, it is skipped and its top stories roll into the next digest.`,
        todo: `Open the Digests screen (${digestsScreenUrl(cfg)}) and press Approve or Hold.`,
      };
    case 'health_failed':
      return {
        short: m.kind === 'FATAL' ? 'Mailercloud rejected the health check' : 'Mailercloud unreachable',
        what: `The Mailercloud health check failed${m.error ? ` (${safeDetail(m.error, cfg)})` : ''}.`,
        did:
          m.kind === 'FATAL'
            ? 'The digest carries on, but a send would be refused the same way. The check repeats every hour until it passes.'
            : 'The digest carries on; the send attempt decides. The check repeats before the send.',
        todo: m.kind === 'FATAL' ? 'Check the Mailercloud API key and the account (plan, quota) in Railway and Mailercloud.' : 'Nothing yet. If it keeps failing, check Mailercloud’s status.',
      };
    case 'health_recovered':
      return {
        short: 'Mailercloud answering again',
        what: 'The Mailercloud health check passes again.',
        did: m.resumed ? 'A digest version stopped by the earlier error was picked up again with the same frozen email.' : 'Nothing else needed doing.',
        todo: 'Nothing to do. Admin → Digests shows the current state.',
      };
    case 'complaint_hold': {
      const rate = typeof m.ratePct === 'number' ? `${m.ratePct.toFixed(2)}%` : 'above the limit';
      const limit = typeof m.thresholdPct === 'number' ? `${m.thresholdPct}%` : `${cfg.complaintHoldPct}%`;
      return {
        short: `Digest held — spam-complaint rate ${rate}`,
        what: `${who === "Today's digest" ? 'The last' : who.replace(/^The /, 'The last ')} digest${m.previousRunDate ? ` (${safeDetail(m.previousRunDate, cfg)})` : ''} had a spam-complaint rate of ${rate}${typeof m.complaints === 'number' && typeof m.delivered === 'number' ? ` (${m.complaints} of ${m.delivered} delivered)` : ''}, above the ${limit} limit.`,
        did: `Today's digest is held: it is built as usual but sent only after an editor approves it, even with automatic sending on. Not approved by ${cutoff}, it is skipped.`,
        todo: 'Find out why readers marked it as spam (content, audience, frequency), then approve or hold today’s digest in Admin → Digests.',
      };
    }
    case 'webhook_disabled':
      return {
        short: 'Mailercloud webhook is switched off',
        what: 'Mailercloud reports our webhook as inactive.',
        did: 'Sends are still verified by polling; unsubscribes, bounces and spam reports are not being copied to our suppression list meanwhile.',
        todo: 'In Mailercloud, switch the webhook pointing at push.taxscan.in back on.',
      };
    // ── CMS audience sync (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.2): stored on AudienceSyncState.alerts,
    //    emailed by services/audience/alerts.ts with this same copy. Counts and reason codes only.
    case 'audience_full_incomplete':
      return {
        short: 'Audience sync: the nightly CMS load was incomplete',
        what: `The nightly full load of reader accounts from the CMS did not complete (${safeDetail(m.reason, cfg) || 'unknown reason'}; ${Number(m.rows ?? 0)} rows read).`,
        did: 'The rows it did read were applied. Nobody was removed for being missing, and Mailercloud writes are paused until a complete load.',
        todo: 'Nothing if tomorrow night’s load completes (it resumes by itself). If it repeats, check the CMS feed with the CMS team.',
      };
    case 'audience_unverified':
      return {
        short: `${who} held — the reader list could not be verified`,
        what: `${who} was not sent because ${safeDetail(m.plain, cfg) || 'the audience check failed'}.`,
        did: `Held, and checked again every minute; it goes out by itself as soon as the check passes. Approval does not override it. Not verified by ${cutoff}, it is skipped and its top stories roll into the next digest.`,
        todo: 'Open Admin → Digests (Audience card) to see the counts. If the sync is paused, an ADMIN reviews them and presses Resume.',
      };
    case 'audience_breaker_open':
      return {
        short: 'Audience sync paused — needs review',
        what: `The audience sync stopped writing to Mailercloud (${safeDetail(m.reason, cfg) || 'unknown reason'}). The data still lands in Postgres.`,
        did: guardOn
          ? 'Paused Mailercloud writes. The Premium digest is held while the audience cannot be trusted.'
          : 'Paused Mailercloud writes. Premium is not held yet (the send guard is off); today’s digest goes to its configured lists as usual.',
        todo:
          m.reason === 'truncated_load'
            ? 'Nothing if the next full load completes; it resumes by itself.'
            : 'An ADMIN reviews the counts on Admin → Digests (Audience card) and presses Resume if they look right.',
      };
    case 'seq_conflict':
      return {
        short: 'Audience sync: the CMS sent conflicting data',
        what: `${Number(m.count ?? 0)} reader account(s) arrived today with the same sequence number but different content (the CMS broke its own contract).`,
        did: 'Applied the list row (the CMS’s repair rule) and counted it.',
        todo: 'Tell the CMS team the count and the date; no reader data is in this email.',
      };
    case 'unknown_status':
      return {
        short: 'Audience sync: unknown account status from the CMS',
        what: `${Number(m.count ?? 0)} reader account(s) arrived today with a status we do not know.`,
        did: 'Kept their previous role (an unknown status never grants Premium).',
        todo: 'Ask the CMS team what the new status means, so the rule can be extended.',
      };
    case 'audience_writer_fatal':
      return {
        short: 'Audience sync: Mailercloud refused a contact write',
        what: `Mailercloud refused ${Number(m.count ?? 1)} contact write(s) with an error that retrying will not fix (${safeDetail(m.reason, cfg) || 'see Admin'}).`,
        did: 'Stopped writing those contacts; everything else carries on.',
        todo: 'Check the sync key (MAILERCLOUD_SYNC_API_KEY), the tag/list ids and the contact quota in Mailercloud.',
      };
    case 'audience_writer_failing':
      return {
        short: 'Audience sync: Mailercloud writes failing for 6 hours',
        what: 'Contact writes to Mailercloud have been failing for more than 6 hours.',
        did: guardOn
          ? 'Kept retrying (hourly). Nothing is lost; the Premium digest is held if its audience falls too far behind.'
          : 'Kept retrying (hourly). Nothing is lost; the send guard is off, so the digest is not held.',
        todo: 'Check Mailercloud’s status and the sync key.',
      };
    case 'audience_drift':
      return {
        short: 'Audience sync: Mailercloud does not match our audience',
        what: `The nightly check found ${Number(m.mismatched ?? 0)} of ${Number(m.sampled ?? 0)} sampled contacts with the wrong tags${m.premiumOurs !== undefined ? ` (Premium: ours ${Number(m.premiumOurs)}, Mailercloud ${m.premiumMailercloud === null || m.premiumMailercloud === undefined ? 'unknown' : Number(m.premiumMailercloud)})` : ''}.`,
        did: 'Marked the mismatched contacts for re-sync.',
        todo: 'Nothing if it clears tomorrow. If it repeats, someone may be editing those tags by hand in Mailercloud.',
      };
    case 'cms_views_failed':
      return {
        short: 'Reads from the CMS: the sync failed',
        what: `The latest pull of article views from the CMS did not complete${m.reason ? ` (${safeDetail(m.reason, cfg)})` : ''}.`,
        did: 'Wrote nothing from that run: the last good numbers stay in place (stale, never partial). It tries again at the next slot.',
        todo: 'Nothing if it clears at the next run. If it repeats, check CMS_FEED_VIEWS_SECRET and that the CMS views feed is up.',
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

/**
 * The alert audience. No separate recipient list. Never logged.
 * Active ADMIN users; for an EDITOR_KINDS kind (ready / not approved yet), active
 * ADMIN and PUBLISHER users — everyone who may approve.
 */
export async function digestAlertRecipients(kind?: string): Promise<string[]> {
  const roles: ('ADMIN' | 'PUBLISHER')[] = kind && EDITOR_KINDS.has(kind) ? ['ADMIN', 'PUBLISHER'] : ['ADMIN'];
  const users = await prisma.user.findMany({ where: { isActive: true, role: { in: roles } }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.trim().toLowerCase()))];
}

export type AlertDeps = {
  emailSender?: EmailSender;
  /** Default: `isEmailConfigured()` (ElasticEmail key + from-address present). */
  isConfigured?: () => boolean;
  /** Default: `digestAlertRecipients(kind)`. Called once per audience group (admins / editors). */
  recipients?: (kind?: string) => Promise<string[]>;
  now?: Date;
  cfg?: DigestEnv;
  /**
   * Task 14: the staff push pass after the emails. `false` skips it; otherwise
   * these override the kill-switch (`DIGEST_STAFF_PUSH_ENABLED`), the transport
   * (web-push) and the device list (active users' devices).
   */
  staffPush?: false | StaffPushDeps;
};

export type StaffPushDeps = {
  enabled?: boolean;
  transport?: StaffPushTransport;
  devices?: () => Promise<StaffPushSubscription[]>;
};

export type AlertOutcome = {
  runId: string;
  /** Kinds emailed by THIS call. */
  emailed: string[];
  /** Kinds this call tried and could not deliver to anyone. */
  failed: string[];
  notConfigured?: boolean;
  /** Task 14: kinds pushed to staff devices by THIS call. */
  pushed?: string[];
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
  await addRecoveryMarker(runId, now, 'resolved', BLOCKING_KINDS);
}

/**
 * Writes a recovery marker (`kind`) once, born `emailSkipped` unless one of
 * `problemKinds` was emailed or is mid-email — decided on the LOCKED row, the same
 * rule as `resolved`. Used by `resolved` and by the health check's
 * `health_recovered` (task 13). Returns true when THIS call wrote it.
 */
export async function addRecoveryMarker(
  runId: string,
  now: Date,
  kind: string,
  problemKinds: ReadonlySet<string>,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const base = JSON.stringify({ raisedAt: now.toISOString(), emailedAt: null, ...detail });
  const skipped = JSON.stringify({ emailSkipped: 'no_problem_email_was_sent' });
  const kinds = [...problemKinds];
  const n = await prisma.$executeRaw`
    UPDATE "DigestRun"
       SET alerts = alerts || jsonb_build_object(${kind}::text,
             ${base}::jsonb || CASE WHEN EXISTS (
               SELECT 1 FROM jsonb_each("DigestRun".alerts) e
                WHERE e.key = ANY(${kinds}::text[])
                  AND jsonb_typeof(e.value) = 'object'
                  AND ((e.value ->> 'emailedAt') IS NOT NULL OR (e.value ->> 'emailClaim') IS NOT NULL)
             ) THEN '{}'::jsonb ELSE ${skipped}::jsonb END)
     WHERE id = ${runId} AND alerts -> ${kind}::text IS NULL`;
  return n === 1;
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
 * The alert pass: emails every alert marker on the run that has not been
 * emailed yet (one per kind per run), then the recovery note if the run has
 * since been sent; then (task 14) pushes the editor kinds to staff devices.
 * The two channels have separate once-per-run claims on the same marker, so
 * neither waits for, nor is blocked by, the other — a push failure never stops
 * an email, and an unconfigured email does not stop the push. Safe to call
 * after every `advanceRun` and from concurrent ticks. Never throws.
 */
export async function sendDigestAlerts(runId: string, deps: AlertDeps = {}): Promise<AlertOutcome> {
  const out = await emailDigestAlerts(runId, deps);
  if (deps.staffPush !== false) {
    try {
      const pushed = await pushDigestAlerts(runId, { ...(deps.staffPush ?? {}), cfg: deps.cfg, now: deps.now });
      if (pushed.length) out.pushed = pushed;
    } catch {
      // pushDigestAlerts never throws; belt and braces — the email outcome stands.
    }
  }
  return out;
}

async function emailDigestAlerts(runId: string, deps: AlertDeps): Promise<AlertOutcome> {
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

    const recipientsBy = new Map<string, string[]>();
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

      const group = EDITOR_KINDS.has(kind) ? 'editors' : 'admins';
      let recipients = recipientsBy.get(group);
      if (!recipients) {
        recipients = await (deps.recipients ?? digestAlertRecipients)(kind);
        recipientsBy.set(group, recipients);
      }
      if (recipients.length === 0) {
        await finishKind(runId, kind, token, { emailSkipped: 'no_recipients' });
        warn(`run=${runId} ${kind}: no active ${group === 'editors' ? 'ADMIN or PUBLISHER' : 'ADMIN'} user to email`);
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

/* ------------------------------------------------------------------ */
/* Staff push notifications (task 14)                                  */
/* ------------------------------------------------------------------ */

/**
 * A push older than this is not sent (`pushSkipped: 'stale'`): switching the
 * kill-switch on at noon must not announce the 06:30 build.
 */
const PUSH_STALE_MIN = 180;

/** Title + body of the staff notification for an editor kind; null for any other kind. */
export function staffPushCopy(kind: string, m: AlertMarker, cfg: DigestEnv = env.digest): { title: string; body: string } | null {
  const cutoff = `${cfg.cutoff} IST`;
  if (kind === 'ready_for_approval') {
    if (m.preview === true) {
      return { title: "Today's digest is ready to review", body: 'Preview only: sending is off, so nothing goes to readers. Tap to compare it.' };
    }
    const why =
      m.reason === 'complaint_hold'
        ? 'Held after a high spam-complaint rate. '
        : m.reason === 'sanity_hold'
          ? 'Unusually many stories: check the list. '
          : '';
    return { title: "Today's digest is ready — tap to review", body: `${why}Approve it before ${cutoff}, or it is skipped.` };
  }
  if (kind === 'not_approved_yet') {
    return {
      title: 'Digest still waiting for approval',
      body: `It was due at ${cfg.sendAt} IST. Not approved by ${cutoff}, it is skipped.`,
    };
  }
  return null;
}

/**
 * The web-push payload for one editor kind. `tag` is per run date, so the 08:30
 * reminder replaces the 06:30 notification on the device (`renotify` makes it
 * sound again). `url` is the Digests screen; the staff worker opens or focuses it.
 */
export function buildStaffPushPayload(
  kind: string,
  m: AlertMarker,
  runDate: Date,
  cfg: DigestEnv = env.digest,
): { title: string; body: string; url: string; icon: string; badge: string; tag: string; renotify: true; kind: string } | null {
  const copy = staffPushCopy(kind, m, cfg);
  if (!copy) return null;
  // The brand icon + the monochrome "T" badge (absolute, production host, as on reader pushes). The URL is the same
  // link as the editor email's; the staff worker opens its PATH on its own origin.
  const icon = DEFAULT_NOTIFICATION_ICON;
  return { ...copy, url: digestsScreenUrl(cfg), icon, badge: DEFAULT_NOTIFICATION_BADGE, tag: `taxscan-digest-${runDateKey(runDate)}`, renotify: true, kind };
}

/** The push twin of `claimKind`: its own fields on the same marker, the same rules. */
async function claimPush(runId: string, kind: string, token: string, now: Date): Promise<number | null> {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - CLAIM_STALE_MIN * MINUTE).toISOString();
  const patch = JSON.stringify({ pushClaim: token, pushClaimedAt: nowIso });
  const rows = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE "DigestRun"
       SET alerts = jsonb_set(
             alerts, ARRAY[${kind}::text],
             (alerts -> ${kind}::text) || ${patch}::jsonb || jsonb_build_object(
               'pushAttempts', COALESCE((alerts -> ${kind}::text ->> 'pushAttempts')::int, 0) + 1))
     WHERE id = ${runId}
       AND jsonb_typeof(alerts -> ${kind}::text) = 'object'
       AND (alerts -> ${kind}::text ->> 'pushedAt') IS NULL
       AND (alerts -> ${kind}::text ->> 'pushSkipped') IS NULL
       AND ((alerts -> ${kind}::text ->> 'pushClaimedAt') IS NULL
            OR (alerts -> ${kind}::text ->> 'pushClaimedAt')::timestamptz < ${staleIso}::timestamptz)
       AND COALESCE((alerts -> ${kind}::text ->> 'pushAttempts')::int, 0) < ${MAX_ATTEMPTS}
       AND ((alerts -> ${kind}::text ->> 'pushRetryAfter') IS NULL
            OR (alerts -> ${kind}::text ->> 'pushRetryAfter')::timestamptz <= ${nowIso}::timestamptz)
     RETURNING (alerts -> ${kind}::text ->> 'pushAttempts')::int AS attempts`;
  return rows.length === 1 ? Number(rows[0].attempts) : null;
}

async function finishPush(runId: string, kind: string, token: string, patch: Record<string, unknown>): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "DigestRun"
       SET alerts = jsonb_set(
             alerts, ARRAY[${kind}::text],
             ((alerts -> ${kind}::text) - 'pushClaim' - 'pushClaimedAt') || ${JSON.stringify(patch)}::jsonb)
     WHERE id = ${runId} AND (alerts -> ${kind}::text ->> 'pushClaim') = ${token}`;
}

/**
 * Pushes each editor kind (`ready_for_approval`, `not_approved_yet`) on the run
 * to every active staff device, once per run — a claim on the marker
 * (`pushClaim` / `pushedAt` / `pushAttempts`, the email's rules: two processes
 * cannot both send, a restart does not repeat a stamped push, at most
 * MAX_ATTEMPTS tries, RETRY_AFTER_MIN between failed ones). Only while the
 * digest is on (`cfg.enabled`) and the kill-switch is on. Delivered to at least
 * one device → stamped, never re-sent. No device → `pushSkipped: 'no_devices'`.
 * Logs counts and device ids only. Never throws. Returns the kinds pushed.
 */
export async function pushDigestAlerts(
  runId: string,
  deps: StaffPushDeps & { cfg?: DigestEnv; now?: Date } = {},
): Promise<string[]> {
  const pushed: string[] = [];
  try {
    const cfg = deps.cfg ?? env.digest;
    if (!cfg.enabled || !(deps.enabled ?? env.staffPush.enabled)) return pushed;
    const now = deps.now ?? new Date();
    const run = await prisma.digestRun.findUnique({ where: { id: runId }, select: { runDate: true, alerts: true } });
    if (!run) return pushed;
    const alerts = (run.alerts ?? {}) as AlertMap;
    for (const kind of Object.keys(alerts).filter((k) => EDITOR_KINDS.has(k)).sort()) {
      const m = alerts[kind];
      if (!m || typeof m !== 'object' || m.pushedAt || m.pushSkipped) continue;
      const token = randomUUID();
      const attempt = await claimPush(runId, kind, token, now);
      if (attempt === null) continue;

      const raised = m.raisedAt ? Date.parse(m.raisedAt) : NaN;
      if (Number.isFinite(raised) && now.getTime() - raised > PUSH_STALE_MIN * MINUTE) {
        await finishPush(runId, kind, token, { pushSkipped: 'stale' });
        continue;
      }
      const payload = buildStaffPushPayload(kind, m, run.runDate, cfg);
      if (!payload) {
        await finishPush(runId, kind, token, { pushSkipped: 'no_copy' });
        continue;
      }
      const r = await pushToActiveStaff(payload, {
        ...(deps.transport ? { transport: deps.transport } : {}),
        ...(deps.devices ? { devices: deps.devices } : {}),
      });
      const failures = r.results.filter((x) => x.outcome === 'failed').map((x) => `${x.deviceId}:${x.statusCode ?? 'error'}`);
      if (r.devices === 0) {
        await finishPush(runId, kind, token, { pushSkipped: 'no_devices' });
      } else if (r.delivered > 0) {
        await finishPush(runId, kind, token, {
          pushedAt: new Date().toISOString(),
          pushedTo: r.delivered,
          ...(r.failed ? { pushFailedTo: r.failed } : {}),
          ...(r.pruned ? { pushPruned: r.pruned } : {}),
        });
        pushed.push(kind);
      } else if (r.failed === 0) {
        // Every device answered 404/410 and was pruned: nobody left to tell.
        await finishPush(runId, kind, token, { pushSkipped: 'no_devices', pushPruned: r.pruned });
      } else {
        await finishPush(runId, kind, token, {
          pushRetryAfter: new Date(now.getTime() + RETRY_AFTER_MIN * MINUTE).toISOString(),
          pushError: failures.slice(0, 5).join(', '),
          ...(r.pruned ? { pushPruned: r.pruned } : {}),
        });
      }
      // eslint-disable-next-line no-console
      console.log(
        `[digest-push] run=${runId} ${kind} attempt=${attempt}/${MAX_ATTEMPTS} devices=${r.devices} delivered=${r.delivered} pruned=${r.pruned} failed=${r.failed}` +
          (failures.length ? ` failures=${failures.slice(0, 5).join(',')}` : ''),
      );
    }
  } catch (err) {
    warn(`run=${runId} staff push pass failed: ${safeDetail(err instanceof Error ? err.message : err)}`);
  }
  return pushed;
}
