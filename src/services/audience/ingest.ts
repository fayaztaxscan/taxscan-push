import { createHash } from 'node:crypto';
import { Prisma, type AudienceMember, type CmsAccount } from '@prisma/client';
import { env, type AudienceEnv } from '../../lib/env';
import { emailHash } from '../digest/webhook';
import { findSuppressions, isSuppressed } from '../suppression';
import { isKnownStatus, type AccountSnapshot } from './snapshot';
import { isLive, memberRole, type MemberRole } from './rules';

/**
 * CMS audience ingest core (docs/CMS_AUDIENCE_SYNC_DESIGN.md §3.1, §4, §5, §6.3; push-feed contract
 * v1.2 §3, §7, §10, §11). `applyAccountSnapshot()` is the ONE path by which a CMS account changes —
 * the signed webhook, the hourly incremental pull and the nightly full pull all call it — and
 * nothing else writes `CmsAccount`.
 *
 * Seq rule (CMS, 24 Oct): a webhook EVENT applies only if `seq` > stored; a LIST row applies if
 * `seq` ≥ stored (an equal seq re-applies idempotently and repairs drift); lower is skipped. A
 * tombstone is a row with `deletedAt`, so the same comparison stops a late lower-seq event from
 * resurrecting a deleted account; a higher-seq live snapshot (e.g. `account.created` with
 * `reactivated: true`) revives it — unless the account was ERASED, which is final.
 *
 * Effects, all inside the caller's transaction:
 *  - the account row (hashes only — never an address or a name);
 *  - suppressions, by account id (design §6.2 rule 4): a deactivation adds an `ACCOUNT_DELETED`
 *    row (weakest reason) that a revival lifts; an erasure nulls the address on every matching row
 *    and keeps the hash; the consent LIFT deletes UNSUBSCRIBE / HARD_BOUNCE / SPAM rows when the
 *    account's explicit opt-in is dated after them (MANUAL never; ≤ 20 a day);
 *  - `recomputeMembers()` for the old and the new address.
 *
 * Lock order (prevents deadlocks with the Mailercloud webhook): CmsAccount → EmailSuppression →
 * AudienceMember, members in hash order. Never logs; returns counts and flags only.
 */

type Tx = Prisma.TransactionClient;

export type SnapshotSource = 'webhook' | 'pull_incr' | 'pull_full';

export type ApplyOutcome =
  /** Stored (higher seq, or a first sighting). */
  | 'applied'
  /** A list row at the stored seq, re-applied (idempotent). */
  | 'repaired'
  /** Seq too low (or, for an event, equal): nothing changed. */
  | 'stale_seq'
  /** A live snapshot for an ERASED account: never reactivated. */
  | 'erased';

export type ApplyResult = {
  outcome: ApplyOutcome;
  /** The stored row actually changed. */
  changed: boolean;
  /** The snapshot's status is not one the rules know (kept verbatim; the role is unchanged). */
  unknownStatus: boolean;
  /** A list row at the stored seq whose content differed (the CMS broke its own seq contract). */
  seqConflict: boolean;
  revived: boolean;
  deactivated: boolean;
  /** An erasure was queued now (first `erasure: true` for this account). */
  erasureQueued: boolean;
  /** An erasure for an address we never held: nothing to erase in Mailercloud. */
  erasureWithoutAddress: boolean;
  /** Suppressions lifted by the consent rule. */
  lifted: number;
  /** Lifts due but held back by the daily cap (retried by the next snapshot / nightly list). */
  liftsDeferred: number;
  /** Member rows created, changed or deleted. */
  memberChanges: number;
  /** Members whose role changed (the task-5 breaker counts these). */
  roleChanges: number;
};

export type ApplyOptions = {
  now?: Date;
  cfg?: AudienceEnv;
  portal?: string;
};

/** Every reason the consent lift may remove (digest design §3). MANUAL never; ACCOUNT_DELETED only by a revival. */
export const LIFTABLE_REASONS: readonly string[] = ['UNSUBSCRIBE', 'HARD_BOUNCE', 'SPAM'];
/** Most consent lifts per IST day (design §6.3). */
export const MAX_LIFTS_PER_DAY = 20;
/** An opt-in dated further ahead than this is not believed (design §6.3: `at` ≤ now + 5 min). */
export const CONSENT_FUTURE_TOLERANCE_MS = 5 * 60_000;
export const CMS_SUPPRESSION_SOURCE = 'cms_feed';

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** 00:00 IST of `now`'s IST day, as an instant. */
export function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

function sameDate(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** The stored content a list row at an equal seq must match (else `seqConflict`). */
function sameContent(row: CmsAccount, next: Omit<CmsAccount, 'updatedAt' | 'portal' | 'lastSource'>): boolean {
  return (
    row.status === next.status &&
    row.unknownStatus === next.unknownStatus &&
    row.plan === next.plan &&
    sameDate(row.periodEnd, next.periodEnd) &&
    row.consentValue === next.consentValue &&
    sameDate(row.consentAt, next.consentAt) &&
    row.emailHash === next.emailHash &&
    (row.deletedAt === null) === (next.deletedAt === null) &&
    (row.erasedAt === null) === (next.erasedAt === null)
  );
}

/**
 * Apply one CMS snapshot. Call inside a transaction (`prisma.$transaction(tx => …, { timeout })`):
 * the webhook inserts its receipt in the same one, so a failed apply leaves no receipt.
 */
export async function applyAccountSnapshot(tx: Tx, snap: AccountSnapshot, source: SnapshotSource, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const cfg = opts.cfg ?? env.audience;
  const portal = opts.portal ?? 'taxscan';
  const result: ApplyResult = {
    outcome: 'stale_seq',
    changed: false,
    unknownStatus: !isKnownStatus(snap.status),
    seqConflict: false,
    revived: false,
    deactivated: false,
    erasureQueued: false,
    erasureWithoutAddress: false,
    lifted: 0,
    liftsDeferred: 0,
    memberChanges: 0,
    roleChanges: 0,
  };

  // 1. Lock the account row (if any) for the whole transaction.
  await tx.$queryRaw`SELECT 1 FROM "CmsAccount" WHERE "accountId" = ${snap.accountId} FOR UPDATE`;
  const prev = await tx.cmsAccount.findUnique({ where: { accountId: snap.accountId } });

  // 2. Seq: events strictly greater, list rows greater-or-equal.
  if (prev) {
    const ok = source === 'webhook' ? snap.seq > prev.seq : snap.seq >= prev.seq;
    if (!ok) return result;
    // 3. Erased is final: no live snapshot ever revives it (a later deletion still advances seq).
    if (prev.erasedAt && !snap.deleted) {
      result.outcome = 'erased';
      return result;
    }
  }
  const equalSeq = prev !== null && snap.seq === prev.seq;

  // 4. The next row. A null email never changes the linked address: withheld (consent false +
  //    free/ended) and deletions keep the last known hash, so the address stays excluded.
  const known = isKnownStatus(snap.status);
  const next = {
    accountId: snap.accountId,
    seq: snap.seq,
    status: known ? snap.status : (prev?.status ?? snap.status),
    unknownStatus: known ? null : snap.status,
    plan: snap.plan,
    periodEnd: snap.periodEnd,
    consentValue: snap.consentValue,
    consentAt: snap.consentAt,
    emailHash: snap.email ? emailHash(snap.email) : (prev?.emailHash ?? null),
    deletedAt: snap.deleted ? (prev?.deletedAt ?? snap.deletedAt ?? now) : null,
    erasedAt: prev?.erasedAt ?? (snap.deleted && snap.erasure ? now : null),
  };
  if (equalSeq && prev) {
    result.seqConflict = !sameContent(prev, next);
    result.outcome = 'repaired';
  } else {
    result.outcome = 'applied';
  }
  result.changed = !prev || !sameContent(prev, next) || prev.seq !== next.seq;

  if (prev) {
    await tx.cmsAccount.update({ where: { accountId: snap.accountId }, data: { ...next, lastSource: source } });
  } else {
    await tx.cmsAccount.create({ data: { ...next, portal, lastSource: source } });
  }

  // 5. Suppression effects (before any member row is locked).
  const wasDeleted = prev !== null && prev.deletedAt !== null;
  result.revived = wasDeleted && !snap.deleted;
  result.deactivated = snap.deleted && !wasDeleted;
  const hashes = [...new Set([prev?.emailHash, next.emailHash].filter((h): h is string => !!h))].sort();

  if (result.revived) {
    // Eligibility restored: only the deactivation suppression goes; real opt-outs stay.
    await tx.emailSuppression.deleteMany({ where: { accountId: snap.accountId, reason: 'ACCOUNT_DELETED' } });
  }
  if (snap.deleted) {
    // "Suppress it by account_id, keep the record" (contract §10). Idempotent on a re-applied tombstone.
    const has = await tx.emailSuppression.count({ where: { accountId: snap.accountId, reason: 'ACCOUNT_DELETED' } });
    if (has === 0) {
      await tx.emailSuppression.create({
        data: { email: null, emailHash: null, accountId: snap.accountId, reason: 'ACCOUNT_DELETED', source: CMS_SUPPRESSION_SOURCE, firstSeenAt: now, lastSeenAt: now },
      });
    }
  }
  const erasureNow = next.erasedAt !== null && !prev?.erasedAt;
  if (next.erasedAt !== null) {
    // Every opt-out of this person loses its address and keeps its hash, so it still matches.
    for (const row of await findSuppressions(tx, { emailHash: next.emailHash, accountIds: [snap.accountId] })) {
      if (row.email !== null) await tx.emailSuppression.update({ where: { id: row.id }, data: { email: null } });
    }
  }
  if (!snap.deleted) {
    const l = await liftOnConsent(tx, snap, next.emailHash, now);
    result.lifted = l.lifted;
    result.liftsDeferred = l.deferred;
  }

  // 6. The members of the old and the new address.
  const members = await recomputeMembers(tx, hashes, {
    now,
    cfg,
    emailFor: snap.email && next.emailHash ? { [next.emailHash]: snap.email } : {},
    eraseHash: erasureNow ? next.emailHash : null,
  });
  result.memberChanges = members.changes;
  result.roleChanges = members.roleChanges;

  if (erasureNow) {
    result.erasureQueued = true;
    result.erasureWithoutAddress = !members.erasureMarked;
    await tx.auditLog.create({
      data: { action: 'AUDIENCE_ERASURE', resourceType: 'cms_account', metadata: { source, count: 1, address_held: members.erasureMarked } },
    });
    await tripErasureBreaker(tx, portal, cfg, now);
  }
  return result;
}

/**
 * The consent lift (digest design §3; this design §6.3): an explicit opt-in (`true`) dated after a
 * suppression's `lastSeenAt` — and not more than 5 min in the future — deletes it and records a
 * `RESUBSCRIBE` EmailEvent by hash. MANUAL is never lifted; ACCOUNT_DELETED only by a revival. At
 * most MAX_LIFTS_PER_DAY a day; a deferred lift is retried by the next snapshot (the nightly list
 * re-applies every row at its seq). Mailercloud's own unsubscribe is NOT touched here: only the
 * writer, with AUDIENCE_RESUBSCRIBE_WRITES, ever sends `contact_type` (task 6).
 */
async function liftOnConsent(tx: Tx, snap: AccountSnapshot, hash: string | null, now: Date): Promise<{ lifted: number; deferred: number }> {
  if (snap.consentValue !== true || !snap.consentAt) return { lifted: 0, deferred: 0 };
  if (snap.consentAt.getTime() > now.getTime() + CONSENT_FUTURE_TOLERANCE_MS) return { lifted: 0, deferred: 0 };
  const due = (await findSuppressions(tx, { emailHash: hash, accountIds: [snap.accountId] })).filter(
    (r) => LIFTABLE_REASONS.includes(r.reason) && snap.consentAt!.getTime() > r.lastSeenAt.getTime(),
  );
  if (due.length === 0) return { lifted: 0, deferred: 0 };
  const today = await tx.emailEvent.count({ where: { type: 'RESUBSCRIBE', receivedAt: { gte: istDayStart(now) } } });
  const room = Math.max(0, MAX_LIFTS_PER_DAY - today);
  const lift = due.slice(0, room);
  for (const row of lift) {
    await tx.emailSuppression.delete({ where: { id: row.id } });
    await tx.emailEvent.create({
      data: {
        provider: 'cms',
        type: 'RESUBSCRIBE',
        emailHash: row.emailHash,
        dedupeKey: createHash('sha256').update(`cms|RESUBSCRIBE|${row.id}`).digest('hex'),
        meta: { reason: row.reason, at: snap.consentAt.toISOString() },
        receivedAt: now,
      },
    });
    await tx.auditLog.create({
      data: { action: 'AUDIENCE_RESUBSCRIBED', resourceType: 'email_suppression', metadata: { reason: row.reason, emailHash: row.emailHash } },
    });
  }
  return { lifted: lift.length, deferred: due.length - lift.length };
}

/** Over AUDIENCE_MAX_ERASURES_PER_DAY erasures today → the breaker opens (writes pause; ingest continues). */
async function tripErasureBreaker(tx: Tx, portal: string, cfg: AudienceEnv, now: Date): Promise<void> {
  const today = await tx.cmsAccount.count({ where: { erasedAt: { gte: istDayStart(now) } } });
  if (today <= cfg.thresholds.maxErasuresPerDay) return;
  const state = await tx.audienceSyncState.findUnique({ where: { portal } });
  if (state?.breakerOpenAt) return; // already open: keep its reason and time
  await tx.audienceSyncState.upsert({
    where: { portal },
    create: { portal, breakerOpenAt: now, breakerReason: 'erasure_cap', pendingReview: { erasuresToday: today } },
    update: { breakerOpenAt: now, breakerReason: 'erasure_cap', pendingReview: { erasuresToday: today } },
  });
}

export type RecomputeOptions = {
  now?: Date;
  cfg?: AudienceEnv;
  /** Fresh addresses from the snapshot being applied, by hash (the only way an address arrives). */
  emailFor?: Readonly<Record<string, string>>;
  /** This address is being erased: queue the Mailercloud erase on its member row. */
  eraseHash?: string | null;
};

export type RecomputeResult = { changes: number; roleChanges: number; erasureMarked: boolean };

/**
 * Bring the `AudienceMember` rows of these addresses in line with the accounts that hold them.
 * Phase 1 (all hashes): stamp the single live account onto account-less suppression rows.
 * Phase 2 (hash order): role + noMarketing (`memberRole`), suppressed (by hash OR any linked live
 * account id), then create / update / delete the row:
 *  - a row exists only while it has a role, noMarketing, a pending erasure, or tags still applied
 *    in Mailercloud (then the writer removes them before it goes);
 *  - an address is stored only when one arrives with a snapshot; a row is never created without one;
 *  - any change of desired state makes the row due for the writer (`nextAttemptAt = now`).
 */
export async function recomputeMembers(tx: Tx, hashes: readonly string[], opts: RecomputeOptions = {}): Promise<RecomputeResult> {
  const now = opts.now ?? new Date();
  const cfg = opts.cfg ?? env.audience;
  const list = [...new Set(hashes)].sort();
  const out: RecomputeResult = { changes: 0, roleChanges: 0, erasureMarked: false };
  if (list.length === 0) return out;

  const accounts = await tx.cmsAccount.findMany({ where: { emailHash: { in: list } } });
  const byHash = new Map<string, CmsAccount[]>(list.map((h) => [h, []]));
  for (const a of accounts) byHash.get(a.emailHash!)?.push(a);

  for (const h of list) {
    const live = byHash.get(h)!.filter(isLive);
    if (live.length === 1) {
      await tx.emailSuppression.updateMany({ where: { emailHash: h, accountId: null }, data: { accountId: live[0].accountId } });
    }
  }

  for (const h of list) {
    const linked = byHash.get(h)!;
    const { role, noMarketing } = memberRole(linked, { formerToFree: cfg.formerToFree });
    const liveIds = linked.filter(isLive).map((a) => a.accountId);
    // By address OR by any live account holding it (an opt-out follows an email change).
    const suppressed = await isSuppressed(tx, { emailHash: h, accountIds: liveIds });
    await tx.$queryRaw`SELECT 1 FROM "AudienceMember" WHERE "emailHash" = ${h} FOR UPDATE`;
    const existing = await tx.audienceMember.findUnique({ where: { emailHash: h } });
    const erase = opts.eraseHash === h;
    const address = opts.emailFor?.[h] ?? existing?.email ?? null;
    const eraseRequestedAt = existing?.eraseRequestedAt ?? (erase && address ? now : null);
    if (erase && address) out.erasureMarked = true;

    const needed = role !== 'NONE' || noMarketing || eraseRequestedAt !== null || (existing?.appliedTags.length ?? 0) > 0;
    if (!needed) {
      if (existing) {
        await tx.audienceMember.delete({ where: { emailHash: h } });
        out.changes += 1;
        if (existing.desiredRole !== 'NONE') out.roleChanges += 1;
      }
      continue;
    }
    if (!existing && !address) continue; // nothing to hold: no address ever arrived for it

    const data = {
      desiredRole: role as MemberRole,
      noMarketing,
      suppressed,
      // While an erasure is pending the writer still needs the address; it nulls it afterwards.
      email: address,
      eraseRequestedAt,
    };
    if (!existing) {
      await tx.audienceMember.create({ data: { emailHash: h, ...data, nextAttemptAt: now } });
      out.changes += 1;
      if (role !== 'NONE') out.roleChanges += 1;
      continue;
    }
    if (memberUnchanged(existing, data)) continue;
    await tx.audienceMember.update({ where: { emailHash: h }, data: { ...data, nextAttemptAt: now } });
    out.changes += 1;
    if (existing.desiredRole !== role) out.roleChanges += 1;
  }
  return out;
}

/** Recompute one address (e.g. after a suppression changed). */
export async function recomputeMember(tx: Tx, hash: string, opts: RecomputeOptions = {}): Promise<RecomputeResult> {
  return recomputeMembers(tx, [hash], opts);
}

function memberUnchanged(
  m: AudienceMember,
  d: { desiredRole: string; noMarketing: boolean; suppressed: boolean; email: string | null; eraseRequestedAt: Date | null },
): boolean {
  return (
    m.desiredRole === d.desiredRole &&
    m.noMarketing === d.noMarketing &&
    m.suppressed === d.suppressed &&
    m.email === d.email &&
    sameDate(m.eraseRequestedAt, d.eraseRequestedAt)
  );
}
