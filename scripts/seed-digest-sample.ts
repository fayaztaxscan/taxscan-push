/* eslint-disable no-console */
/**
 * LOCAL ONLY: seeds a sample email digest so the Digests screen can be checked
 * in a browser. Refuses to run unless DATABASE_URL points at localhost.
 *
 *   npm run digest:seed-sample
 *
 * What it does, on portal `RSS_PORTAL` (default "taxscan"):
 *  - deletes today's (IST) digest run on that portal, if any, and the sample
 *    history runs from earlier seeds;
 *  - builds today's run through the REAL runner path (`advanceRun`, real
 *    renderer) with fake headlines and an in-memory sender that contacts
 *    nobody — so both variants end up CREATED with a fake draft id, frozen
 *    html, items and reads columns, exactly as the 06:30 build leaves them;
 *  - adds five earlier days of history rows in assorted states.
 *
 * Fake headlines on www.taxscan.in URLs, internal addresses only. Nothing is
 * sent anywhere.
 */
import type { DigestAudience } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { env, parseDigestEnv } from '../src/lib/env';
import { advanceRun, ensureRun } from '../src/services/digest/runner';
import { collapseRows, type DigestSelection, type FrozenItem } from '../src/services/digest/builder';
import { istDateOf, istInstant } from '../src/services/digest/retryPolicy';
import { createMockDigestSender } from '../src/services/digest/mockSender';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const SAMPLE_PREFIX = 'TS-DIGEST-SAMPLE-';

function assertLocal(): void {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* fall through */
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host) || env.nodeEnv === 'production') {
    console.error('[seed-digest] refused: DATABASE_URL is not a localhost database.');
    process.exit(1);
  }
}

const HEADLINES: [string, string | null, string][] = [
  ['Sample: Supreme Court holds reassessment notice beyond limitation invalid', 'Supreme Court', 'Income Tax'],
  ['Sample: Bombay High Court quashes GST demand for want of personal hearing', 'Bombay High Court', 'GST'],
  ['Sample: Delhi High Court allows refund of unutilised ITC on exports', 'Delhi High Court', 'GST'],
  ['Sample: High Court sets aside customs penalty on mis-declared imports', 'High Court', 'Customs'],
  ['Sample: CBDT notifies revised form for TDS returns', 'CBDT', 'Income Tax'],
  ['Sample: ITAT deletes addition under section 68 for genuine share capital', 'ITAT', 'Income Tax'],
  ['Sample: CESTAT rules service tax not payable on reimbursed expenses', 'CESTAT', 'Service Tax'],
  ['Sample: NCLAT upholds resolution plan approved by committee of creditors', 'NCLAT', 'Corporate Law'],
];

function sampleSelection(now: Date): DigestSelection {
  const main: FrozenItem[] = HEADLINES.map(([title, authority, category], i) => ({
    rank: 0,
    section: 'MAIN',
    articleKey: `sample-${1000001 + i}`,
    campaignId: null,
    title,
    url: `https://www.taxscan.in/sample-digest-story-${1000001 + i}`,
    authority,
    category,
    excerpt: 'Sample excerpt for a local layout check. Not a real story.',
    capturedAt: new Date(now.getTime() - (i + 1) * 1.5 * HOUR),
    // Two fresh stories show "new — neutral"; the rest carry a read rate.
    readRate: i === 1 || i === 4 ? null : Math.round((90 - i * 9) * 10) / 10,
  }));
  const icymi: FrozenItem = {
    rank: 0,
    section: 'ICYMI',
    articleKey: 'sample-0999999',
    campaignId: null,
    title: 'Sample: Madras High Court on interest for delayed GST refund (carried over)',
    url: 'https://www.taxscan.in/sample-digest-story-0999999',
    authority: 'Madras High Court',
    category: 'GST',
    excerpt: null,
    capturedAt: new Date(now.getTime() - 30 * HOUR),
    readRate: null,
  };
  const perAudience = {} as Record<DigestAudience, FrozenItem[]>;
  for (const a of ['FREE', 'PREMIUM'] as DigestAudience[]) {
    perAudience[a] = [...main, icymi].map((it, i) => ({ ...it, rank: i + 1 }));
  }
  return {
    windowStart: new Date(now.getTime() - 24 * HOUR),
    windowEnd: now,
    candidateCount: 42,
    outcome: 'ok',
    perAudience,
    mainCounts: { FREE: main.length, PREMIUM: main.length },
    rows: collapseRows(perAudience),
    reads: { used: true, source: 'ga', note: null },
    droppedDead: 0,
  };
}

async function main(): Promise<void> {
  assertLocal();
  const portal = env.rss.portal;
  const now = new Date();
  const today = istDateOf(now);

  await prisma.digestRun.deleteMany({ where: { portal, runDate: today } });
  await prisma.digestRun.deleteMany({ where: { portal, sends: { some: { mcCampaignName: { startsWith: SAMPLE_PREFIX } } } } });

  // Today's run, through the real build path. Config is the local env plus
  // the minimum a build needs (fake list ids, an internal address).
  const cfg = parseDigestEnv({
    ...process.env,
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'false',
    DIGEST_FREE_LIST_IDS: process.env.DIGEST_FREE_LIST_IDS || 'sample-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: process.env.DIGEST_FREE_EXCLUDE_LIST_IDS || 'sample-premium',
    DIGEST_PREMIUM_LIST_IDS: process.env.DIGEST_PREMIUM_LIST_IDS || 'sample-premium',
    DIGEST_POSTAL_ADDRESS: process.env.DIGEST_POSTAL_ADDRESS || 'Sample address, Kochi, Kerala',
    MAILERCLOUD_SENDER_EMAIL: process.env.MAILERCLOUD_SENDER_EMAIL || 'digest@localhost.test',
    MAILERCLOUD_REPLY_EMAIL: process.env.MAILERCLOUD_REPLY_EMAIL || 'desk@localhost.test',
  });
  // Built "at 06:30 IST" today, as the morning build would be, so a seed run
  // late in the day is not swept by the cut-off during the build itself.
  const buildAt = istInstant(today, '06:30');
  const run = await ensureRun({ portal, now: buildAt, cfg });
  const result = await advanceRun(run.id, 'cron', {
    sender: createMockDigestSender(),
    now: buildAt,
    cfg,
    quiet: { start: '00:00', end: '00:00' },
    selectItems: async () => sampleSelection(buildAt),
    alerts: false,
  });
  console.log(`[seed-digest] today ${today.toISOString().slice(0, 10)} run=${run.id} state=${result.state} steps=${result.steps.join(',')}`);

  // Earlier days: history rows only (no html), assorted outcomes.
  const past: { daysAgo: number; free: 'SENT' | 'SKIPPED' | 'FAILED' | 'PARTIALLY_SENT'; premium: 'SENT' | 'SKIPPED' | 'FAILED'; reached?: [number, number] }[] = [
    { daysAgo: 1, free: 'SENT', premium: 'SENT', reached: [9981, 2688] },
    { daysAgo: 2, free: 'SENT', premium: 'SENT', reached: [10012, 2694] },
    { daysAgo: 3, free: 'SKIPPED', premium: 'SKIPPED' },
    { daysAgo: 4, free: 'PARTIALLY_SENT', premium: 'SENT', reached: [6120, 2701] },
    { daysAgo: 5, free: 'FAILED', premium: 'FAILED' },
  ];
  for (const p of past) {
    const runDate = new Date(today.getTime() - p.daysAgo * DAY);
    await prisma.digestRun.deleteMany({ where: { portal, runDate } });
    const r = await prisma.digestRun.create({
      data: {
        portal,
        runDate,
        windowStart: new Date(runDate.getTime() - DAY),
        builtAt: istInstant(runDate, '06:30'),
        build: 'BUILT',
        skipReason: p.free === 'SKIPPED' ? 'not_approved' : null,
        approval: 'APPROVED',
        candidateCount: 40,
        readsUsed: true,
        readsSource: 'ga',
      },
    });
    const key = runDate.toISOString().slice(0, 10);
    for (const [audience, state, reached] of [
      ['FREE', p.free, p.reached?.[0]],
      ['PREMIUM', p.premium, p.reached?.[1]],
    ] as const) {
      await prisma.digestSend.create({
        data: {
          runId: r.id,
          audience,
          state,
          subject: `Sample digest ${key}`,
          preheader: 'Sample history row',
          htmlBytes: 0,
          mcCampaignName: `${SAMPLE_PREFIX}${key}-${audience}-${r.id}`,
          mcCampaignId: state === 'SKIPPED' ? null : `mock-${audience.toLowerCase()}-${key}`,
          sendAfter: istInstant(runDate, '07:30'),
          lastError: state === 'FAILED' ? 'Sample: Mailercloud rejected the request (http=401)' : null,
          lastErrorKind: state === 'FAILED' ? 'FATAL' : null,
          targeted: reached ? Math.round(reached * 1.01) : null,
          reached: reached ?? null,
          clicks: reached ? Math.round(reached * 0.04) : null,
        },
      });
    }
    await prisma.digestItem.createMany({
      data: HEADLINES.slice(0, 6).map(([title, authority, category], i) => ({
        runId: r.id,
        rank: i + 1,
        section: 'MAIN',
        articleKey: `sample-h${p.daysAgo}-${i}`,
        title,
        url: `https://www.taxscan.in/sample-digest-story-h${p.daysAgo}${i}`,
        authority,
        category,
        capturedAt: new Date(runDate.getTime() - (i + 2) * HOUR),
      })),
    });
  }
  console.log(`[seed-digest] history: ${past.length} earlier days on portal "${portal}"`);
}

main()
  .catch((err) => {
    console.error('[seed-digest] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
