import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { isQuietHours, nextAllowedAt } from '../lib/quietHours';
import { executeCampaign, type Sender } from './send';

export type SweepDeps = {
  sender?: Sender;
  now?: Date;
  cap?: number;
  concurrency?: number;
  quietStart?: string;
  quietEnd?: string;
};

export type SweepResult = {
  found: number;
  swept: number;
  deferred: number;
  errors: number;
};

export async function sweepScheduledCampaigns(deps: SweepDeps = {}): Promise<SweepResult> {
  const now = deps.now ?? new Date();
  const quietStart = deps.quietStart ?? env.send.quietStart;
  const quietEnd = deps.quietEnd ?? env.send.quietEnd;
  const startedAt = Date.now();

  let swept = 0;
  let deferred = 0;
  let errors = 0;

  const due = await prisma.campaign.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
    orderBy: { scheduledAt: 'asc' },
  });

  for (const campaign of due) {
    if (isQuietHours(now, quietStart, quietEnd)) {
      const nextAt = nextAllowedAt(now, quietStart, quietEnd);
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { scheduledAt: nextAt },
      });
      deferred++;
      continue;
    }

    // Atomic claim: only proceed if status is still SCHEDULED. Guards against
    // concurrent ticks racing on the same row.
    const claim = await prisma.campaign.updateMany({
      where: { id: campaign.id, status: 'SCHEDULED' },
      data: { status: 'DRAFT' },
    });
    if (claim.count === 0) continue;

    try {
      await executeCampaign(campaign, {
        sender: deps.sender,
        now,
        cap: deps.cap,
        concurrency: deps.concurrency,
      });
      swept++;
    } catch (err) {
      errors++;
      // eslint-disable-next-line no-console
      console.error('[sweeper] executeCampaign threw', { campaignId: campaign.id, err });
    }
  }

  const ms = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `[sweeper] tick found=${due.length} swept=${swept} deferred=${deferred} errors=${errors} ms=${ms}`,
  );

  return { found: due.length, swept, deferred, errors };
}

let isSweeping = false;

export function startSweeper(): void {
  if (!env.sweeper.enabled) {
    // eslint-disable-next-line no-console
    console.log('[sweeper] disabled (set SWEEPER_ENABLED=true to start)');
    return;
  }
  if (!cron.validate(env.sweeper.cron)) {
    throw new Error(`Invalid SWEEPER_CRON: ${env.sweeper.cron}`);
  }
  cron.schedule(
    env.sweeper.cron,
    async () => {
      if (isSweeping) {
        // eslint-disable-next-line no-console
        console.log('[sweeper] previous tick still running, skipping');
        return;
      }
      isSweeping = true;
      try {
        await sweepScheduledCampaigns();
      } finally {
        isSweeping = false;
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(`[sweeper] scheduled cron="${env.sweeper.cron}" tz=${env.rss.tz}`);
}
