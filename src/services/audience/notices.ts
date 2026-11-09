import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { PAID_STATUSES, memberRole } from './rules';

/**
 * The list behind door N (brief 2026-11-09-digest-notice-list): the paid CMS accounts whose daily digest cannot reach them, each with a
 * reason, which the CMS pulls once a day and shows as a signed-in notice. THE SINGLE DEFINITION is `digestNoticeList`: the door, the
 * Audience card and the tests all read it, nothing re-derives it. Built on request from Postgres; the request path never calls the CMS
 * or Mailercloud. Never returns, logs or stores an address: an account id and a reason only.
 *
 * One row per CMS ACCOUNT (two accounts that share an address both appear), from:
 *  - accounts that currently receive the paid digest's role: `memberRole()` = PREMIUM, i.e. `active`, or `cancelled` with time left
 *    (still paid; Follow-up 1), never ended / free / deleted / erased / out of scope, with an address on file (`emailHash`). The paid
 *    test is `memberRole` itself, applied to the account, so it cannot drift from who gets the paid digest;
 *  - joined by `emailHash` to `AudienceMember` (must be PREMIUM, and consent must not be false) and to `EmailSuppression`, by
 *    `emailHash` OR by `accountId` (an opt-out that follows the account).
 * Reasons:
 *  - `bad_address`  the writer's FATAL (Mailercloud refuses the address) or a HARD_BOUNCE suppression; it wins over `unsubscribed`;
 *  - `unsubscribed` an UNSUBSCRIBE suppression.
 * Never listed: a SPAM / MANUAL / ACCOUNT_DELETED suppression (a complaint, a person's decision or a deleted account is not for a
 * "fix your address" notice), `noMarketing` (consent = false), a non-PREMIUM member, and any account not live. Sorted by account id, so
 * the same list always has the same ETag. Re-subscribing is the existing consent lift (ingest.ts `liftOnConsent`): a CMS opt-in dated
 * after the suppression deletes it, and the account leaves the list on the next build. Nothing new here.
 */

export type NoticeReason = 'bad_address' | 'unsubscribed';
export type NoticeItem = { accountId: string; reason: NoticeReason };

/** A suppression of these reasons is never a notice (spam complaint, a person's decision, a deleted account). */
const NEVER_NOTIFY = new Set(['SPAM', 'MANUAL', 'ACCOUNT_DELETED']);
/** IN-list size per query (the paid list is ~2,600; the chunk keeps a bind list small whatever it grows to). */
const CHUNK = 5000;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

export async function digestNoticeList(portal: string, _now: Date = new Date()): Promise<NoticeItem[]> {
  const accounts = await prisma.cmsAccount.findMany({
    // The statuses memberRole grants PREMIUM, as a prefilter only: the test itself is memberRole() just below.
    where: { portal, status: { in: [...PAID_STATUSES] }, deletedAt: null, erasedAt: null, outOfScopeAt: null, emailHash: { not: null } },
    select: { accountId: true, emailHash: true, status: true, consentValue: true, deletedAt: true, outOfScopeAt: true },
    orderBy: { accountId: 'asc' },
  });
  if (accounts.length === 0) return [];
  const hashes = [...new Set(accounts.map((a) => a.emailHash as string))];
  const ids = accounts.map((a) => a.accountId);

  const members = new Map<string, { noMarketing: boolean; fatal: boolean }>();
  for (const part of chunks(hashes)) {
    const rows = await prisma.audienceMember.findMany({
      where: { emailHash: { in: part }, desiredRole: 'PREMIUM' },
      select: { emailHash: true, noMarketing: true, lastErrorKind: true },
    });
    for (const r of rows) members.set(r.emailHash, { noMarketing: r.noMarketing, fatal: r.lastErrorKind === 'FATAL' });
  }

  // Suppressions by address hash or by account id (one read per chunk; each row filed under every key it matches).
  const byHash = new Map<string, string[]>();
  const byAccount = new Map<string, string[]>();
  const file = (m: Map<string, string[]>, k: string, reason: string) => {
    const l = m.get(k);
    if (l) l.push(reason);
    else m.set(k, [reason]);
  };
  const seen = new Set<string>();
  const readSuppressions = async (where: Prisma.EmailSuppressionWhereInput) => {
    for (const r of await prisma.emailSuppression.findMany({ where, select: { id: true, emailHash: true, accountId: true, reason: true } })) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.emailHash) file(byHash, r.emailHash, r.reason);
      if (r.accountId) file(byAccount, r.accountId, r.reason);
    }
  };
  for (const part of chunks(hashes)) await readSuppressions({ emailHash: { in: part } });
  for (const part of chunks(ids)) await readSuppressions({ accountId: { in: part } });

  const out: NoticeItem[] = [];
  for (const a of accounts) {
    // The single definition of "paid": this account's own role is PREMIUM (consent does not matter for a service email: noMarketing below).
    if (memberRole([a], { formerToFree: false }).role !== 'PREMIUM') continue;
    const hash = a.emailHash as string;
    const m = members.get(hash);
    if (!m || m.noMarketing) continue; // not PREMIUM, or consent = false
    const reasons = [...(byHash.get(hash) ?? []), ...(byAccount.get(a.accountId) ?? [])];
    if (reasons.some((r) => NEVER_NOTIFY.has(r))) continue;
    if (m.fatal || reasons.includes('HARD_BOUNCE')) out.push({ accountId: a.accountId, reason: 'bad_address' });
    else if (reasons.includes('UNSUBSCRIBE')) out.push({ accountId: a.accountId, reason: 'unsubscribed' });
  }
  return out; // accounts were read in account-id order
}

/** The list's ETag: sha256 of the items (account id + reason, in order). Stable while the list is. */
export function noticesEtag(items: readonly NoticeItem[]): string {
  return createHash('sha256').update(JSON.stringify(items.map((i) => [i.accountId, i.reason])), 'utf8').digest('hex');
}

/** Counts per reason (the Audience card). */
export function noticeCounts(items: readonly NoticeItem[]): { badAddress: number; unsubscribed: number } {
  let badAddress = 0;
  for (const i of items) if (i.reason === 'bad_address') badAddress += 1;
  return { badAddress, unsubscribed: items.length - badAddress };
}

/** The CMS list must be fresh: a COMPLETE full load within this long. */
export const NOTICES_MAX_FULL_AGE_MS = 48 * 3_600_000;

export type NotReady = 'no_full_load' | 'breaker_open';

/**
 * Why we cannot vouch for the list right now, or null. `no_full_load`: no COMPLETE full CMS load in the last 48 h (the nightly one
 * did not finish, or never ran); `breaker_open`: the audience breaker is open (the sync is paused for review). The door answers
 * 503 `not_ready` for either; "no data" is never sent as an empty list.
 */
export async function noticesNotReady(portal: string, now: Date): Promise<NotReady | null> {
  const st = await prisma.audienceSyncState.findUnique({ where: { portal }, select: { lastFullOkAt: true, breakerOpenAt: true } });
  if (!st?.lastFullOkAt || now.getTime() - st.lastFullOkAt.getTime() > NOTICES_MAX_FULL_AGE_MS) return 'no_full_load';
  if (st.breakerOpenAt) return 'breaker_open';
  return null;
}

/* ---------------------------- the signed door's nonce store ---------------------------- */

/** A nonce is single-use for this long (twice the ±300 s skew, so a captured request cannot be replayed inside its own window). */
export const NONCE_TTL_MS = 10 * 60_000;
const NONCE_PREFIX = 'cms-notices:nonce:';

/**
 * Claims a verified nonce. True the first time; false when it was already used inside the last 10 minutes. Stored in `DigestSetting`
 * (a unique key, so two concurrent requests with one nonce cannot both win; no migration). Called only AFTER the signature verified,
 * so an unsigned request can never write a row.
 *
 * The rule lives in the row's own expiry: a second claim wins only once that has passed (the row is taken over in ONE conditional
 * update, so two concurrent re-claims cannot both win). The sweep that deletes old rows is housekeeping on REAL time, rows expired
 * over an hour ago only: it never reads the caller's clock, so one caller can never delete another's live nonce.
 */
export async function claimNonce(nonce: string, now: Date): Promise<boolean> {
  await prisma.digestSetting.deleteMany({ where: { key: { startsWith: NONCE_PREFIX }, value: { lt: new Date(Date.now() - 3_600_000).toISOString() } } });
  const key = `${NONCE_PREFIX}${nonce}`;
  const expires = new Date(now.getTime() + NONCE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await prisma.digestSetting.create({ data: { key, value: expires } });
      return true;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    // Used before: free again only if that use has expired.
    const taken = await prisma.digestSetting.updateMany({ where: { key, value: { lt: now.toISOString() } }, data: { value: expires } });
    if (taken.count === 1) return true;
    if ((await prisma.digestSetting.count({ where: { key } })) > 0) return false; // still live
    // the row vanished between the insert and the update (swept): claim it afresh
  }
  return false;
}

/** The one boot line (names, never values): on or off, and any config fault. */
export function noticesBootLine(n: { enabled: boolean; secret: string; problems: string[] }, allowedIps: readonly string[]): string {
  if (!n.enabled) return `[audience] digest notices off (set DIGEST_NOTICES_ENABLED=true to answer the CMS)${n.problems.length ? `; config problems: ${n.problems.join('; ')}` : ''}`;
  const faults = [...n.problems, ...(n.secret ? [] : ['CMS_FEED_NOTICES_SECRET is unset: every request is refused']), ...(allowedIps.length ? [] : ['CMS_FEED_ALLOWED_IPS is empty: every request is refused'])];
  return `[audience] digest notices on${faults.length ? `; config problems: ${faults.join('; ')}` : ''}`;
}
