/**
 * The audience rule — the SINGLE definition (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4; owner rulings Q1–Q3).
 *
 * Input: every CMS account that shares one address (an address can belong to several accounts).
 * Output: the address's role and whether it must be kept out of marketing mail.
 *
 *  - PREMIUM  — any live account is `active` or `cancelled` (cancelled = still paid). A service
 *               email: consent does not matter (Q3), an unsubscribe still wins (the writer's job).
 *  - FORMER   — otherwise, any live `ended` account whose consent is not an explicit `false`
 *               (Q1: ended → the Former tag → the Free digest; `AUDIENCE_FORMER_TO_FREE=false` → none).
 *  - FREE     — otherwise, with AUDIENCE_FREE_READERS on (brief 2026-11-08-free-cms-readers; owner 8 Nov:
 *               Free = SwZafy + every free / ended CMS account): any live `free` account whose consent is
 *               not an explicit `false` (null counts as consent, owner 22 Oct). The Free-reader tag; the
 *               writer admits new FREE members in daily batches (AUDIENCE_FREE_ADMIT_PER_DAY).
 *  - NONE     — otherwise. With AUDIENCE_FREE_READERS off a plain `free` account is NONE (free sign-ups
 *               then reach the Free digest only through the hand list).
 * Precedence: PREMIUM > FORMER > FREE > NONE.
 *  - noMarketing — any live account said `false` (Q2: null is NOT false), OR the address is held
 *               only by deleted accounts (contract v1.2: a deleted account is removed from every
 *               audience, incl. the hand list — the No-marketing tag is the only way to do that).
 *
 * An account OUT OF SCOPE (`outOfScopeAt`: missing from a complete full load, task 5) is ignored
 * entirely — as if the address did not hold it — so the absence rule removes our tags without adding
 * a No-marketing exclusion (absence is inferred, not a CMS statement).
 *
 * An unknown status grants nothing (and `CmsAccount.status` keeps the last KNOWN status, so an
 * unknown one never changes a role it already had). Pure.
 */

export type MemberRole = 'PREMIUM' | 'FORMER' | 'FREE' | 'NONE';

/**
 * The statuses that make an account PREMIUM: `active`, and `cancelled` (cancelled = still paid until the period ends, when the CMS
 * moves it to `ended`). The ONE list: `memberRole` below and the CMS digest-notice list (`digestNoticeList`) both read it.
 */
export const PAID_STATUSES = ['active', 'cancelled'] as const;

export type RuleAccount = {
  status: string;
  consentValue: boolean | null;
  deletedAt: Date | null;
  outOfScopeAt?: Date | null;
};

/** `freeReaders` absent = off (today's rule). */
export type RuleOptions = { formerToFree: boolean; freeReaders?: boolean };

export function inScope(a: RuleAccount): boolean {
  return a.outOfScopeAt === undefined || a.outOfScopeAt === null;
}

export function isLive(a: RuleAccount): boolean {
  return a.deletedAt === null && a.status !== 'deleted' && inScope(a);
}

export function memberRole(all: readonly RuleAccount[], opts: RuleOptions): { role: MemberRole; noMarketing: boolean } {
  const accounts = all.filter(inScope);
  const live = accounts.filter(isLive);
  let role: MemberRole = 'NONE';
  if (live.some((a) => (PAID_STATUSES as readonly string[]).includes(a.status))) role = 'PREMIUM';
  else if (opts.formerToFree && live.some((a) => a.status === 'ended' && a.consentValue !== false)) role = 'FORMER';
  else if (opts.freeReaders && live.some((a) => a.status === 'free' && a.consentValue !== false)) role = 'FREE';
  const noMarketing = live.some((a) => a.consentValue === false) || (live.length === 0 && accounts.length > 0);
  return { role, noMarketing };
}
