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
 *  - NONE     — otherwise. A plain `free` account is NONE: free sign-ups reach the Free digest
 *               through the existing hand list, not through us.
 *  - noMarketing — any live account said `false` (Q2: null is NOT false), OR the address is held
 *               only by deleted accounts (contract v1.2: a deleted account is removed from every
 *               audience, incl. the hand list — the No-marketing tag is the only way to do that).
 *
 * An unknown status grants nothing (and `CmsAccount.status` keeps the last KNOWN status, so an
 * unknown one never changes a role it already had). Pure.
 */

export type MemberRole = 'PREMIUM' | 'FORMER' | 'NONE';

export type RuleAccount = {
  status: string;
  consentValue: boolean | null;
  deletedAt: Date | null;
};

export type RuleOptions = { formerToFree: boolean };

export function isLive(a: RuleAccount): boolean {
  return a.deletedAt === null && a.status !== 'deleted';
}

export function memberRole(accounts: readonly RuleAccount[], opts: RuleOptions): { role: MemberRole; noMarketing: boolean } {
  const live = accounts.filter(isLive);
  let role: MemberRole = 'NONE';
  if (live.some((a) => a.status === 'active' || a.status === 'cancelled')) role = 'PREMIUM';
  else if (opts.formerToFree && live.some((a) => a.status === 'ended' && a.consentValue !== false)) role = 'FORMER';
  const noMarketing = live.some((a) => a.consentValue === false) || (live.length === 0 && accounts.length > 0);
  return { role, noMarketing };
}
