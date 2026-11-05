import type { DigestEnv } from '../../lib/env';

/** The flag, optional in the config pieces callers pass around so a partial config (tests) still compiles. */
export type ManualCfg = { freeManual?: boolean };

/**
 * Who must approve a digest before it may be scheduled — the ONE definition
 * shared by the runner's gate (`runner.ts`), the Digests screen's buttons
 * (`screen.ts`) and the banner (`status.ts`). Pure.
 *
 * A run needs an editor's approval when any of these holds:
 *  - approval mode (`DIGEST_APPROVAL_REQUIRED`, the default);
 *  - the sanity hold: more candidates than `DIGEST_SANITY_MAX_CANDIDATES` (the
 *    re-platform guard, task 4);
 *  - the complaint hold (task 13, design §8): the previous send's spam-complaint
 *    rate was above `DIGEST_COMPLAINT_HOLD_PCT`. Recorded once, when the run is
 *    created, in `DigestRun.complaintCheck.held`. An UNKNOWN rate never holds.
 *
 * A single variant also needs its OWN approval (whatever the run's approval says)
 * when it carries `ownApprovalRequired` and either
 *  - the run needs approval (a variant rendered after the build, owner 2026-10-23), or
 *  - it adopted a campaign Mailercloud already had as a draft (`adoptedDraftAt`,
 *    owner decision A, 2026-10-23) — in EVERY mode, because nobody can confirm that
 *    draft's content matches our frozen html.
 */

export type HoldRun = { candidateCount: number; complaintCheck?: unknown };
export type HoldSend = { ownApprovalRequired: boolean; approvedAt: Date | null; adoptedDraftAt?: Date | null };

/** The stored complaint check (`DigestRun.complaintCheck`), as written by the scheduler. */
export type ComplaintCheck = {
  checkedAt: string;
  thresholdPct: number;
  held: boolean;
  /** IST date of the run whose sends were judged; null = no earlier send to judge. */
  previousRunDate: string | null;
  sends: {
    audience: string;
    complaints: number | null;
    delivered: number | null;
    /** complaints / delivered × 100; null = UNKNOWN (no webhook proof, or no delivered count). */
    ratePct: number | null;
    /** The send was still unconfirmed at the cut-off (FAILED not_confirmed_by_cutoff): always UNKNOWN. */
    unconfirmed?: boolean;
  }[];
};

/** The parsed complaint check, or null when none was taken / the value is not one. */
export function complaintCheckOf(run: { complaintCheck?: unknown }): ComplaintCheck | null {
  const c = run.complaintCheck;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const x = c as Partial<ComplaintCheck>;
  if (typeof x.held !== 'boolean' || !Array.isArray(x.sends)) return null;
  return x as ComplaintCheck;
}

/** True when the previous send's complaint rate put this run on hold. */
export function isComplaintHeld(run: { complaintCheck?: unknown }): boolean {
  return complaintCheckOf(run)?.held === true;
}

/** Whether the run needs an editor's approval at all (approval mode, sanity hold or complaint hold). */
export function runNeedsApproval(cfg: Pick<DigestEnv, 'approvalRequired' | 'sanityMaxCandidates'>, run: HoldRun): boolean {
  return cfg.approvalRequired || run.candidateCount > cfg.sanityMaxCandidates || isComplaintHeld(run);
}

/** Whether this variant's approval is its own (not the run's), so it waits for `approvedAt`. */
export function variantNeedsOwnApproval(
  cfg: Pick<DigestEnv, 'approvalRequired' | 'sanityMaxCandidates'>,
  run: HoldRun,
  send: Pick<HoldSend, 'ownApprovalRequired' | 'adoptedDraftAt'>,
): boolean {
  if (!send.ownApprovalRequired) return false;
  return runNeedsApproval(cfg, run) || Boolean(send.adoptedDraftAt);
}

/** True while a variant that needs its own approval has not had it. */
export function awaitingOwnApproval(cfg: Pick<DigestEnv, 'approvalRequired' | 'sanityMaxCandidates'> & ManualCfg, run: HoldRun, send: HoldSend & { audience?: string }): boolean {
  // A manual-only version waits for its press, not for an approval: `awaitingManualPress` is its gate.
  if (send.audience !== undefined && isManualOnly(cfg, send.audience)) return false;
  return variantNeedsOwnApproval(cfg, run, send) && send.approvedAt === null;
}

/* ------------------------------------------------------------------ */
/* Manual-only Free (DIGEST_FREE_MANUAL, owner 2026-11-05)             */
/* ------------------------------------------------------------------ */

/**
 * `DigestSend.lastError` on a Free version skipped at the cut-off because nobody pressed Send Free. A routine day, not a
 * failure: no alert, no banner, and it does not make the run read "partly sent" (`runState.ts`).
 */
export const MANUAL_NOT_SENT = 'manual_not_sent';

/**
 * THE one definition of "this version is manual-only": with `DIGEST_FREE_MANUAL` on, the Free version never goes out by
 * itself, in any approval mode — only through Send Free. The runner's gate, the screen, the banner, the alerts and the
 * Approve route all ask this, so there is no second copy of the rule.
 */
export function isManualOnly(cfg: ManualCfg, audience: string): boolean {
  return cfg.freeManual === true && audience === 'FREE';
}

/**
 * True while a manual-only version has not been pressed. The press is stamped in `approvedAt` (+ `approvedByUserId`) on
 * that version: the run's Approve never writes it for a manual-only version, so it can only come from Send Free.
 */
export function awaitingManualPress(cfg: ManualCfg, send: { audience: string; approvedAt?: Date | null }): boolean {
  return isManualOnly(cfg, send.audience) && !send.approvedAt;
}

/** The versions the run's Approve covers: every version except a manual-only one. */
export function approvalAudiences<T extends string>(cfg: ManualCfg, audiences: ReadonlyArray<T>): T[] {
  return audiences.filter((a) => !isManualOnly(cfg, a));
}

/**
 * Why Send Free was refused, in plain words: ONE wording for the route (the 409 message) and the screen (the button's
 * `off(reason)`), so they cannot drift. The codes are the runner's schedule gates plus the press's own checks.
 */
export type FreePressCode =
  | 'not_manual'
  | 'not_built'
  | 'no_draft'
  | 'content_pending'
  | 'preview_only'
  | 'held_by_editor'
  | 'sanity_hold'
  | 'complaint_hold'
  | 'quiet_hours'
  | 'past_cutoff'
  | 'config_invalid'
  | 'audience_unverified'
  | 'already_pressed'
  | 'already_sent'
  | 'skipped'
  | 'failed_final';

export function freePressRefusal(code: string, x: { quiet?: { start: string; end: string }; cutoff?: string; detail?: string } = {}): string {
  switch (code) {
    case 'not_manual':
      return 'Send Free is not switched on (DIGEST_FREE_MANUAL).';
    case 'not_built':
      return "Today's digest has not been built yet.";
    case 'no_draft':
      return 'The Free draft is not in Mailercloud yet. It is made automatically after the build; try again in a minute.';
    case 'content_pending':
      return 'The Free version is still waiting for its ads. Fix them in Ads first.';
    case 'preview_only':
      return 'Sending is switched off (preview only). DIGEST_SEND_LIVE must be on to send.';
    case 'held_by_editor':
      return "An editor held today's digest. Approve it first.";
    case 'sanity_hold':
      return "Today's digest is on hold: it found unusually many stories. Approve it first, then send Free.";
    case 'complaint_hold':
      return "Today's digest is on hold: yesterday's spam-complaint rate was high. Approve it first, then send Free.";
    case 'quiet_hours':
      return `It is quiet hours${x.quiet ? ` (${x.quiet.start}–${x.quiet.end} IST)` : ''}; nothing is sent at night.`;
    case 'past_cutoff':
      return `It is past the cut-off${x.cutoff ? ` (${x.cutoff} IST)` : ''}; nothing is sent after it.`;
    case 'config_invalid':
      return `The Free audience settings are incomplete${x.detail ? `: ${x.detail}` : ''}.`;
    case 'audience_unverified':
      return `The Free reader list could not be verified${x.detail ? `: ${x.detail}` : ''}.`;
    case 'already_pressed':
      return 'Send Free was already pressed. It is on its way.';
    case 'already_sent':
      return 'The Free digest was already handed to Mailercloud today.';
    case 'skipped':
      return 'The Free digest was skipped for today.';
    case 'failed_final':
      return 'The Free digest stopped for today after a final failure. See the alert on this screen.';
    default:
      return 'Send Free cannot be pressed right now.';
  }
}
