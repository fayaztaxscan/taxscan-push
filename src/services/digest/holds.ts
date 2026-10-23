import type { DigestEnv } from '../../lib/env';

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
export function awaitingOwnApproval(cfg: Pick<DigestEnv, 'approvalRequired' | 'sanityMaxCandidates'>, run: HoldRun, send: HoldSend): boolean {
  return variantNeedsOwnApproval(cfg, run, send) && send.approvedAt === null;
}
