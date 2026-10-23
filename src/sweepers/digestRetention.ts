/**
 * Digest retention (docs/EMAIL_DIGEST_DESIGN.md §3 lifecycle table, §13 task 11;
 * docs/DIGEST_RETENTION.md). The email twin of `eventRetention.ts`, same rules.
 *
 * WHAT IT DOES, NIGHTLY (03:45 IST, flag DIGEST_RETENTION_ENABLED, default OFF)
 *
 *  1. EmailEvent older than EMAIL_EVENT_RETENTION_DAYS (90) is FOLDED and deleted, in
 *     batches, each batch one transaction with the fold:
 *       - UNSUBSCRIBE / HARD_BOUNCE / SPAM linked to one of our sends (`sendId`) →
 *         `DigestSend.rolledUnsub / rolledBounce / rolledSpam` += n. Account-wide events
 *         with no send of ours (hand-made digests, promotions) were never counted by
 *         anything; they are simply deleted.
 *       - CAMPAIGN_SENT / CAMPAIGN_ERROR are the "our webhook was receiving" PROOF that
 *         `digestSendStats()` needs to show real counts (a number, possibly 0) instead
 *         of "—". Before they go, every send they prove — linked by `sendId` OR by
 *         `mcCampaignId`, exactly the rule in stats.ts — gets `webhookProofAt` stamped.
 *       - NO_ADDRESS (the daily "opt-outs without a readable address" counter) and any
 *         other type are deleted WITHOUT folding: they count nothing per send.
 *  2. DigestSend.html / text are nulled once the run's IST date is older than
 *     DIGEST_HTML_RETENTION_DAYS (30), with `htmlPurgedAt` stamped. The preview says
 *     "no longer stored"; subject, preheader, size, DigestItem and placements are kept.
 *
 * THE RULE THIS ENFORCES
 * Every digest statistic is `rolled-up + live`, and `digestSendStats()` in
 * src/services/digest/stats.ts is the single implementation. The fold writes the
 * rolled half in the SAME transaction as the delete, so a crash mid-run leaves
 * the numbers consistent and a re-run is safe. Parity before/after is tested.
 *
 * NEVER TOUCHED: EmailSuppression (an opt-out outlives any window — only the owner's
 * re-subscribe rule, built with the Feed 1 task, ever removes a row), DigestRun,
 * DigestItem (90-day dedupe + roll-forward), DigestAdPlacement, templates and ads.
 */

import cron from 'node-cron';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { safeErrorLog } from '../lib/httpErrors';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Reader feedback folded into the send's `rolled*` columns. */
const FOLD_COLUMN = { UNSUBSCRIBE: 'rolledUnsub', HARD_BOUNCE: 'rolledBounce', SPAM: 'rolledSpam' } as const;
/** Events that prove the webhook was receiving for a send (stats.ts COVERAGE_TYPES). */
const PROOF_TYPES = new Set(['CAMPAIGN_SENT', 'CAMPAIGN_ERROR']);

export type DigestSweepDeps = {
  now?: Date;
  eventDays?: number;
  htmlDays?: number;
  batchSize?: number;
  /** Stop after this many event batches; the next run continues. 0 = unbounded. */
  maxBatches?: number;
  dryRun?: boolean;
};

export type DigestSweepResult = {
  eventCutoff: Date;
  /** The first IST run date whose html is KEPT (older ones are nulled). */
  htmlKeepFrom: Date;
  dryRun: boolean;
  /** EmailEvent rows deleted (or that WOULD be), by type. */
  deleted: Record<string, number>;
  /** Of those, how many were folded into a send's rolled* counts. */
  folded: number;
  /** Sends newly stamped with `webhookProofAt`. */
  proofStamped: number;
  /** Sends whose html/text were nulled (or WOULD be). */
  htmlNulled: number;
  batches: number;
  more: boolean;
  ms: number;
};

type Row = { id: string; type: string; sendId: string | null; mcCampaignId: string | null };

/** Today's IST date at 00:00 UTC (the `@db.Date` runDate convention), minus `days`. */
function istDateMinus(now: Date, days: number): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - days * MS_PER_DAY);
}

/** Folds one batch and deletes it — one transaction, so counts and delete both happen or neither. */
async function foldAndDelete(tx: Prisma.TransactionClient, batch: Row[], now: Date): Promise<{ folded: number; proofStamped: number }> {
  const perSend = new Map<string, { rolledUnsub: number; rolledBounce: number; rolledSpam: number }>();
  const proofSends = new Set<string>();
  const proofCampaigns = new Set<string>();
  let folded = 0;
  for (const r of batch) {
    const col = FOLD_COLUMN[r.type as keyof typeof FOLD_COLUMN];
    if (col && r.sendId) {
      const c = perSend.get(r.sendId) ?? { rolledUnsub: 0, rolledBounce: 0, rolledSpam: 0 };
      c[col] += 1;
      perSend.set(r.sendId, c);
      folded += 1;
    } else if (PROOF_TYPES.has(r.type)) {
      if (r.sendId) proofSends.add(r.sendId);
      if (r.mcCampaignId) proofCampaigns.add(r.mcCampaignId);
    }
  }

  // The proof first, so no instant exists where a proved send reads as "—".
  let proofStamped = 0;
  if (proofSends.size > 0 || proofCampaigns.size > 0) {
    const r = await tx.digestSend.updateMany({
      where: {
        webhookProofAt: null,
        OR: [...(proofSends.size ? [{ id: { in: [...proofSends] } }] : []), ...(proofCampaigns.size ? [{ mcCampaignId: { in: [...proofCampaigns] } }] : [])],
      },
      data: { webhookProofAt: now },
    });
    proofStamped = r.count;
  }
  // updateMany: a send that no longer exists (its run was deleted) must not abort the batch.
  for (const [sendId, c] of perSend) {
    await tx.digestSend.updateMany({
      where: { id: sendId },
      data: { rolledUnsub: { increment: c.rolledUnsub }, rolledBounce: { increment: c.rolledBounce }, rolledSpam: { increment: c.rolledSpam } },
    });
  }
  await tx.emailEvent.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
  return { folded, proofStamped };
}

export async function sweepDigestRetention(deps: DigestSweepDeps = {}): Promise<DigestSweepResult> {
  const startedAt = Date.now();
  const now = deps.now ?? new Date();
  const eventDays = deps.eventDays ?? env.digest.emailEventRetentionDays;
  const htmlDays = deps.htmlDays ?? env.digest.htmlRetentionDays;
  const batchSize = deps.batchSize ?? env.digestRetention.batchSize;
  const maxBatches = deps.maxBatches ?? env.digestRetention.maxBatches;
  const dryRun = deps.dryRun ?? false;
  if (!(eventDays > 0) || !(htmlDays > 0)) throw new Error('digest retention windows must be positive (EMAIL_EVENT_RETENTION_DAYS, DIGEST_HTML_RETENTION_DAYS)');
  const eventCutoff = new Date(now.getTime() - eventDays * MS_PER_DAY);
  const htmlKeepFrom = istDateMinus(now, htmlDays);
  const htmlWhere: Prisma.DigestSendWhereInput = { OR: [{ html: { not: null } }, { text: { not: null } }], run: { runDate: { lt: htmlKeepFrom } } };

  const deleted: Record<string, number> = {};
  const bump = (t: string, k: number) => void (deleted[t] = (deleted[t] ?? 0) + k);

  if (dryRun) {
    const aged = await prisma.emailEvent.groupBy({ by: ['type'], where: { receivedAt: { lt: eventCutoff } }, _count: { _all: true } });
    for (const g of aged) bump(g.type, g._count._all);
    const folded = await prisma.emailEvent.count({ where: { receivedAt: { lt: eventCutoff }, sendId: { not: null }, type: { in: Object.keys(FOLD_COLUMN) } } });
    const htmlNulled = await prisma.digestSend.count({ where: htmlWhere });
    return { eventCutoff, htmlKeepFrom, dryRun: true, deleted, folded, proofStamped: 0, htmlNulled, batches: 0, more: false, ms: Date.now() - startedAt };
  }

  let batches = 0;
  let more = false;
  let folded = 0;
  let proofStamped = 0;
  for (;;) {
    if (maxBatches > 0 && batches >= maxBatches) {
      more = true;
      break;
    }
    const batch = await prisma.emailEvent.findMany({
      where: { receivedAt: { lt: eventCutoff } },
      select: { id: true, type: true, sendId: true, mcCampaignId: true },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });
    if (batch.length === 0) break;
    // Prisma's interactive-transaction default (5 s) bit the push sweeper on its first prod run.
    const r = await prisma.$transaction((tx) => foldAndDelete(tx, batch, now), { timeout: 60_000, maxWait: 10_000 });
    folded += r.folded;
    proofStamped += r.proofStamped;
    for (const row of batch) bump(row.type, 1);
    batches += 1;
    if (batch.length < batchSize) break;
  }

  // ~2 sends a day: one statement is enough. Fenced on the same condition, so a re-run is a no-op.
  const nulled = await prisma.digestSend.updateMany({ where: htmlWhere, data: { html: null, text: null, htmlPurgedAt: now } });

  const ms = Date.now() - startedAt;
  const summary = Object.entries(deleted)
    .map(([t, k]) => `${t.toLowerCase()}=${k}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(
    `[digest-retention] deleted ${summary || 'nothing'} folded=${folded} proof_stamped=${proofStamped} html_nulled=${nulled.count} ` +
      `batches=${batches} ms=${ms} (events>${eventDays}d cutoff=${eventCutoff.toISOString()} html>${htmlDays}d before=${htmlKeepFrom.toISOString().slice(0, 10)}${more ? ' MORE-REMAINING' : ''})`,
  );
  return { eventCutoff, htmlKeepFrom, dryRun: false, deleted, folded, proofStamped, htmlNulled: nulled.count, batches, more, ms };
}

let isSweeping = false;

export function startDigestRetentionSweeper(): void {
  if (!env.digestRetention.enabled) {
    // eslint-disable-next-line no-console
    console.log('[digest-retention] disabled (set DIGEST_RETENTION_ENABLED=true to enable)');
    return;
  }
  if (!cron.validate(env.digestRetention.cron)) throw new Error(`Invalid DIGEST_RETENTION_CRON: ${env.digestRetention.cron}`);
  cron.schedule(
    env.digestRetention.cron,
    async () => {
      if (isSweeping) {
        // eslint-disable-next-line no-console
        console.log('[digest-retention] previous tick still running, skipping');
        return;
      }
      isSweeping = true;
      try {
        await sweepDigestRetention();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[digest-retention] tick failed', safeErrorLog(err, { stack: true }));
      } finally {
        isSweeping = false;
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(
    `[digest-retention] scheduled cron="${env.digestRetention.cron}" events=${env.digest.emailEventRetentionDays}d html=${env.digest.htmlRetentionDays}d batch=${env.digestRetention.batchSize} tz=${env.rss.tz}`,
  );
}
