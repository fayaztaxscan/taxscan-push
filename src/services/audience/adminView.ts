import { prisma } from '../../lib/prisma';
import { env, type AudienceEnv } from '../../lib/env';
import { todaysCounters } from './breaker';
import { GUARD_SHORT, audienceGuard, loadGuardSnapshot, type GuardResult } from './guard';

/**
 * The Digests → Audience card payload (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.2). Postgres only — it never calls the
 * CMS or Mailercloud on the request path. Counts, reason codes and times; never an address, a hash or an account id.
 *
 *  - PUBLISHER: `line` (number-free) and `ok`, nothing else;
 *  - ADMIN: the same plus counts, last syncs, errors in the last 24 h, the breaker and its reviewed counts.
 * `enabled: false` (AUDIENCE_SYNC_ENABLED off) → the card is hidden entirely.
 */

const BREAKER_WORDS: Record<string, string> = {
  first_load: 'The first complete reader load from the CMS arrived. An ADMIN reviews the counts once before Mailercloud writes start.',
  scope_change: 'A complete load was far larger than the one before it (the CMS may have widened what it sends).',
  change_too_large: 'One run would have changed too many readers’ roles at once.',
  premium_removals: 'Unusually many Premium members were removed within 24 hours.',
  erasure_cap: 'More erasure requests arrived in a day than the daily limit.',
  truncated_load: 'The last full load did not complete. It resumes by itself when a later one does.',
};

export function breakerWords(reason: string | null): string {
  return (reason && BREAKER_WORDS[reason]) || 'The sync stopped for review.';
}

export type AudienceCardRole = 'ADMIN' | 'PUBLISHER';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Only numbers survive from the breaker's review snapshot (counts, never an id). */
function reviewCounts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  }
  return out;
}

function lineOf(res: GuardResult, breakerOpen: boolean, guardActive: boolean): string {
  const tail = guardActive ? '' : ' (the send guard is off)';
  if (breakerOpen) return `Audience sync is paused for review.${tail}`;
  if (res.ok) return `Audience sync is healthy; the Premium list is verified.${tail}`;
  return `Audience sync needs attention: ${GUARD_SHORT[res.check]}.${tail}`;
}

export async function audienceCard(portal: string, role: AudienceCardRole, now: Date, cfg: AudienceEnv = env.audience) {
  if (!cfg.enabled) return { enabled: false as const };
  const snap = await loadGuardSnapshot(portal, cfg);
  const premium = audienceGuard('PREMIUM', snap, now, cfg.thresholds);
  const line = lineOf(premium, snap.breakerOpen, cfg.digestFromCms);
  if (role !== 'ADMIN') return { enabled: true as const, ok: premium.ok && !snap.breakerOpen, line };

  const since = new Date(now.getTime() - 24 * 3_600_000);
  const [st, former, noMarketing, retryable, fatal, counters] = await Promise.all([
    prisma.audienceSyncState.findUnique({ where: { portal } }),
    prisma.audienceMember.count({ where: { desiredRole: 'FORMER' } }),
    prisma.audienceMember.count({ where: { noMarketing: true } }),
    prisma.audienceMember.count({ where: { lastErrorKind: 'RETRYABLE', updatedAt: { gte: since } } }),
    prisma.audienceMember.count({ where: { lastErrorKind: 'FATAL', updatedAt: { gte: since } } }),
    todaysCounters(prisma, portal, now),
  ]);
  const drift = (st?.drift ?? null) as { at?: unknown; premiumMailercloud?: unknown } | null;
  return {
    enabled: true as const,
    ok: premium.ok && !snap.breakerOpen,
    line,
    writesLive: cfg.writeMailercloud,
    guardActive: cfg.digestFromCms,
    counts: {
      premiumCms: snap.cmsPremium,
      premiumOurs: snap.premiumDesired,
      premiumApplied: snap.premiumApplied,
      premiumMailercloud: n(drift?.premiumMailercloud),
      former,
      noMarketing,
      pendingWrites: snap.pendingPremium,
    },
    last: { webhookAt: iso(st?.lastWebhookAt), incrementalAt: iso(st?.lastIncrOkAt), fullAt: iso(st?.lastFullOkAt) },
    errors24h: { writerRetryable: retryable, writerFatal: fatal, seqConflict: counters.seqConflict, unknownStatus: counters.unknownStatus },
    guard: premium.ok ? { ok: true as const } : { ok: false as const, check: premium.check, plain: premium.plain },
    breaker: {
      open: !!st?.breakerOpenAt,
      reason: st?.breakerReason ?? null,
      plain: st?.breakerOpenAt ? breakerWords(st.breakerReason) : null,
      openedAt: iso(st?.breakerOpenAt),
      review: st?.breakerOpenAt ? reviewCounts(st.pendingReview) : {},
    },
  };
}
