import type { DigestAudience } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type AudienceEnv } from '../../lib/env';

/**
 * The digest send guard (docs/CMS_AUDIENCE_SYNC_DESIGN.md §7.2): fail closed. `audienceGuard` is a PURE function
 * over a snapshot of `AudienceSyncState` plus counts, so every check is table-testable; `loadGuardSnapshot` builds
 * the snapshot from Postgres only (never the CMS, never Mailercloud); `checkAudienceGuard` is the two together.
 *
 * PREMIUM refuses when ANY of these holds (a missing input counts as a refusal and names itself):
 *  - `stale_full_load`        the last complete full load is older than AUDIENCE_MAX_STALE_HOURS;
 *  - `no_activity`            no successful pull or webhook for 3 h;
 *  - `breaker_open`           the circuit breaker is open;
 *  - `pending_writes`         members whose Premium tag is still pending number more than max(1 %, 10);
 *  - `mailercloud_deviation`  Mailercloud's Premium count differs from our applied count by more than
 *                             max(AUDIENCE_PREMIUM_DEVIATION_PCT, 25) (both read from the nightly drift check,
 *                             so they describe the same instant); `mailercloud_count_missing` when it never ran;
 *  - `cms_deviation`          the CMS's active + cancelled count differs from our desired Premium count by more
 *                             than the same tolerance; `cms_count_missing` before any complete full load.
 * FREE refuses only when the Premium exclude cannot be trusted: `premium_tag_empty` (no member carries the
 * Premium tag) or `sync_stale` (no sync activity for 72 h). An open breaker does NOT hold Free.
 *
 * Counts and reason codes only — never an address, a hash or an account id.
 */

export const LIVENESS_HOURS = 3;
export const FREE_MAX_STALE_HOURS = 72;
export const PENDING_PCT = 1;
export const PENDING_MIN = 10;
export const DEVIATION_MIN = 25;

const HOUR_MS = 3_600_000;

export type GuardCheck =
  | 'stale_full_load'
  | 'no_activity'
  | 'breaker_open'
  | 'pending_writes'
  | 'mailercloud_deviation'
  | 'mailercloud_count_missing'
  | 'cms_deviation'
  | 'cms_count_missing'
  | 'premium_tag_empty'
  | 'sync_stale';

export type GuardResult = { ok: true } | { ok: false; check: GuardCheck; plain: string };

/** Everything the guard looks at. `null` = not known yet. */
export type GuardSnapshot = {
  lastFullOkAt: Date | null;
  lastIncrOkAt: Date | null;
  lastWebhookAt: Date | null;
  breakerOpen: boolean;
  /** Members whose Premium role and Premium tag disagree (tag still to be written or removed). */
  pendingPremium: number;
  /** Members whose desired role is Premium. */
  premiumDesired: number;
  /** Members carrying the Premium tag (Mailercloud acknowledged). */
  premiumApplied: number;
  /** Drift check pair, same instant: our applied count and Mailercloud's. */
  driftOurs: number | null;
  driftMailercloud: number | null;
  /** The CMS's own count (active + cancelled) from the last complete full load. */
  cmsPremium: number | null;
};

export type GuardThresholds = Pick<AudienceEnv['thresholds'], 'maxStaleHours' | 'premiumDeviationPct'>;

const newest = (...ds: (Date | null)[]): number | null => {
  const t = ds.filter((d): d is Date => d !== null).map((d) => d.getTime());
  return t.length ? Math.max(...t) : null;
};

const hoursAgo = (now: Date, t: number | null): number | null => (t === null ? null : (now.getTime() - t) / HOUR_MS);

/** The tolerance for a count comparison: max(pct % of the base, 25). */
export function deviationLimit(base: number, pct: number): number {
  return Math.max(Math.ceil((base * pct) / 100), DEVIATION_MIN);
}

/** The pending-writes tolerance: max(1 % of Premium, 10). */
export function pendingLimit(premiumDesired: number): number {
  return Math.max(Math.ceil((premiumDesired * PENDING_PCT) / 100), PENDING_MIN);
}

/** A number-free phrase per check, for the one-line status a PUBLISHER sees. */
export const GUARD_SHORT: Record<GuardCheck, string> = {
  stale_full_load: 'the nightly reader load from the CMS is overdue',
  no_activity: 'nothing has arrived from the CMS for a few hours',
  breaker_open: 'the sync is paused for an ADMIN to review',
  pending_writes: 'Mailercloud has not caught up with the latest changes',
  mailercloud_deviation: 'Mailercloud’s Premium count does not match ours',
  mailercloud_count_missing: 'Mailercloud’s Premium count has not been checked yet',
  cms_deviation: 'the CMS’s Premium count does not match ours',
  cms_count_missing: 'the CMS’s Premium count is not known yet',
  premium_tag_empty: 'no member carries the Premium tag yet',
  sync_stale: 'the audience has not synced for days',
};

const refuse = (check: GuardCheck, plain: string): GuardResult => ({ ok: false, check, plain });

export function audienceGuard(audience: DigestAudience, snap: GuardSnapshot, now: Date, thr: GuardThresholds = env.audience.thresholds): GuardResult {
  if (audience === 'FREE') {
    if (snap.premiumApplied === 0) return refuse('premium_tag_empty', 'no member carries the Premium tag yet, so Premium members cannot be left out of the Free digest');
    const age = hoursAgo(now, newest(snap.lastFullOkAt, snap.lastIncrOkAt, snap.lastWebhookAt));
    if (age === null || age > FREE_MAX_STALE_HOURS) {
      return refuse('sync_stale', `the audience has not synced from the CMS for over ${FREE_MAX_STALE_HOURS} hours, so the Premium list cannot be trusted`);
    }
    return { ok: true };
  }

  const fullAge = hoursAgo(now, snap.lastFullOkAt?.getTime() ?? null);
  if (fullAge === null || fullAge > thr.maxStaleHours) {
    return refuse('stale_full_load', `the last complete reader load from the CMS is ${fullAge === null ? 'missing' : `${Math.floor(fullAge)} hours old`} (limit ${thr.maxStaleHours})`);
  }
  const quiet = hoursAgo(now, newest(snap.lastFullOkAt, snap.lastIncrOkAt, snap.lastWebhookAt));
  if (quiet === null || quiet > LIVENESS_HOURS) {
    return refuse('no_activity', `nothing has arrived from the CMS (pull or webhook) for over ${LIVENESS_HOURS} hours`);
  }
  if (snap.breakerOpen) return refuse('breaker_open', 'the audience sync is paused for review (an ADMIN presses Resume on the Audience card)');
  const pendLimit = pendingLimit(snap.premiumDesired);
  if (snap.pendingPremium > pendLimit) {
    return refuse('pending_writes', `${snap.pendingPremium} Premium members are still waiting to be tagged in Mailercloud (limit ${pendLimit})`);
  }
  if (snap.driftMailercloud === null || snap.driftOurs === null) {
    return refuse('mailercloud_count_missing', 'Mailercloud’s Premium count has not been checked yet (the nightly check has not run)');
  }
  const mcLimit = deviationLimit(snap.driftOurs, thr.premiumDeviationPct);
  if (Math.abs(snap.driftMailercloud - snap.driftOurs) > mcLimit) {
    return refuse('mailercloud_deviation', `Mailercloud counts ${snap.driftMailercloud} Premium contacts but we expect ${snap.driftOurs} (allowed difference ${mcLimit})`);
  }
  if (snap.cmsPremium === null) return refuse('cms_count_missing', 'the CMS’s own Premium count is not known yet (no complete full load)');
  const cmsLimit = deviationLimit(snap.premiumDesired, thr.premiumDeviationPct);
  if (Math.abs(snap.cmsPremium - snap.premiumDesired) > cmsLimit) {
    return refuse('cms_deviation', `the CMS reports ${snap.cmsPremium} Premium members but we hold ${snap.premiumDesired} (allowed difference ${cmsLimit})`);
  }
  return { ok: true };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The snapshot, from Postgres only. */
export async function loadGuardSnapshot(portal: string, cfg: AudienceEnv = env.audience): Promise<GuardSnapshot> {
  const st = await prisma.audienceSyncState.findUnique({ where: { portal } });
  const tag = cfg.mailercloud.tagPremium;
  const [premiumDesired, premiumApplied, pending] = await Promise.all([
    prisma.audienceMember.count({ where: { desiredRole: 'PREMIUM' } }),
    tag ? prisma.audienceMember.count({ where: { appliedTags: { has: tag } } }) : Promise.resolve(0),
    tag
      ? prisma.audienceMember.count({
          where: { OR: [{ desiredRole: 'PREMIUM', NOT: { appliedTags: { has: tag } } }, { desiredRole: { not: 'PREMIUM' }, appliedTags: { has: tag } }] },
        })
      : prisma.audienceMember.count({ where: { desiredRole: 'PREMIUM' } }),
  ]);
  const drift = (st?.drift ?? null) as { premiumOurs?: unknown; premiumMailercloud?: unknown } | null;
  const counts = (st?.cmsCounts ?? {}) as { active?: unknown; cancelled?: unknown };
  const active = num(counts.active);
  return {
    lastFullOkAt: st?.lastFullOkAt ?? null,
    lastIncrOkAt: st?.lastIncrOkAt ?? null,
    lastWebhookAt: st?.lastWebhookAt ?? null,
    breakerOpen: !!st?.breakerOpenAt,
    pendingPremium: pending,
    premiumDesired,
    premiumApplied,
    driftOurs: num(drift?.premiumOurs),
    driftMailercloud: num(drift?.premiumMailercloud),
    cmsPremium: active === null ? null : active + (num(counts.cancelled) ?? 0),
  };
}

/** Load the snapshot and judge it. A thrown read counts as a refusal for the caller to treat (see runner). */
export async function checkAudienceGuard(audience: DigestAudience, portal: string, now: Date, cfg: AudienceEnv = env.audience): Promise<GuardResult> {
  return audienceGuard(audience, await loadGuardSnapshot(portal, cfg), now, cfg.thresholds);
}
