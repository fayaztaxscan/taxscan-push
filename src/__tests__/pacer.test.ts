import type { Subscriber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { runPacerTick, isUrlDeadDefault } from '../services/pacer';
import type { Sender } from '../services/send';
import type { SendQueue } from '../services/classify';
import { validKeys } from './helpers';

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

const subscriberIds: string[] = [];
const campaignIds: string[] = [];

function uniquePortal(name: string): string {
  return `test-pacer-${name}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function makeSubscriber(portal: string): Promise<Subscriber> {
  const keys = validKeys();
  const sub = await prisma.subscriber.create({
    data: {
      endpoint: `https://test-pacer.example.com/${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      p256dh: keys.p256dh,
      auth: keys.auth,
      portal,
      topics: ['all'],
    },
  });
  subscriberIds.push(sub.id);
  return sub;
}

async function draft(
  portal: string,
  opts: { title: string; queue: SendQueue; authority?: string | null; createdAt: Date },
) {
  const c = await prisma.campaign.create({
    data: {
      portal,
      title: opts.title,
      body: '...',
      url: 'https://taxscan.in',
      target: { type: 'all' },
      status: 'DRAFT',
      sendQueue: opts.queue,
      authority: opts.authority ?? null,
      createdAt: opts.createdAt,
    },
  });
  campaignIds.push(c.id);
  return c;
}

/** A prior SENT push in this portal at `at` (drives spacing + daily-count). */
async function priorSend(portal: string, at: Date) {
  const c = await prisma.campaign.create({
    data: { portal, title: 'prior', body: '.', url: 'https://taxscan.in', target: { type: 'all' }, status: 'SENT' },
  });
  campaignIds.push(c.id);
  await prisma.event.create({ data: { type: 'SENT', campaignId: c.id, createdAt: at } });
  return c;
}

/**
 * A campaign captured at `at` (createdAt) and SENT at `sentAt` (defaults to
 * `at`), with `clicks` CLICKED events. `sentAt` lets a test model a re-send
 * (dated yesterday, but sent today).
 */
async function sentCampaign(
  portal: string,
  opts: {
    title: string;
    queue: SendQueue;
    authority?: string | null;
    url: string;
    at: Date;
    sentAt?: Date;
    clicks?: number;
  },
) {
  const c = await prisma.campaign.create({
    data: {
      portal,
      title: opts.title,
      body: '...',
      url: opts.url,
      target: { type: 'all' },
      status: 'SENT',
      sendQueue: opts.queue,
      authority: opts.authority ?? null,
      createdAt: opts.at,
    },
  });
  campaignIds.push(c.id);
  await prisma.event.create({
    data: { type: 'SENT', campaignId: c.id, createdAt: opts.sentAt ?? opts.at },
  });
  for (let i = 0; i < (opts.clicks ?? 0); i++) {
    await prisma.event.create({ data: { type: 'CLICKED', campaignId: c.id, createdAt: opts.at } });
  }
  return c;
}

const BACKFILL = { ...{ spacingMinutes: 45, dailyCeiling: 20, quietStart: '23:00', quietEnd: '07:00' }, backfillEnabled: true, morningUntil: '12:00' };

function okSender(): Sender {
  return async () => ({ ok: true, statusCode: 201 });
}

afterAll(async () => {
  if (campaignIds.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  }
  if (subscriberIds.length) {
    await prisma.event.deleteMany({ where: { subscriberId: { in: subscriberIds } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
  }
  await prisma.$disconnect();
});

const BASE = { spacingMinutes: 45, dailyCeiling: 20, quietStart: '23:00', quietEnd: '07:00' };

describe('runPacerTick', () => {
  it('releases the top QUALIFIED article to full reach and marks it SENT', async () => {
    const portal = uniquePortal('send');
    const now = ist(2026, 6, 16, 12, 0);
    await makeSubscriber(portal);
    const c = await draft(portal, {
      title: 'Supreme Court ruling [Read Judgment]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 6, 16, 11, 0),
    });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });

    expect(r.reason).toBe('sent');
    expect(r.released).toBe('QUALIFIED');
    expect(r.campaignId).toBe(c.id);
    const after = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe('SENT');
    const sent = await prisma.event.count({ where: { campaignId: c.id, type: 'SENT' } });
    expect(sent).toBe(1);
  });

  it('holds the slot while inside the spacing window (last push < 45 min ago)', async () => {
    const portal = uniquePortal('spacing');
    const now = ist(2026, 6, 16, 12, 0);
    await priorSend(portal, ist(2026, 6, 16, 11, 50)); // 10 min ago
    await draft(portal, { title: 'GSTAT update', queue: 'QUALIFIED', authority: 'GSTAT', createdAt: now });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.reason).toBe('spacing');
    expect(r.campaignId).toBeNull();
  });

  it('hard-stops the automated pacer at the daily ceiling', async () => {
    const portal = uniquePortal('ceiling');
    const now = ist(2026, 6, 16, 12, 0);
    await priorSend(portal, ist(2026, 6, 16, 8, 0)); // 1 push today, well outside spacing
    await draft(portal, { title: 'High Court order [Read Order]', queue: 'QUALIFIED', authority: 'High Court', createdAt: now });

    const r = await runPacerTick({ ...BASE, dailyCeiling: 1, now, portal, sender: okSender() });
    expect(r.reason).toBe('ceiling');
    expect(r.sentToday).toBe(1);
  });

  it('does not send during quiet hours', async () => {
    const portal = uniquePortal('quiet');
    const now = ist(2026, 6, 16, 2, 0); // inside 23:00–07:00
    await draft(portal, { title: 'CBDT notification', queue: 'QUALIFIED', authority: 'CBDT', createdAt: now });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.reason).toBe('quiet_hours');
  });

  it("prefers today's qualified over an older higher-tier one (D3 freshness)", async () => {
    const portal = uniquePortal('fresh');
    const now = ist(2026, 6, 16, 12, 0);
    await makeSubscriber(portal);
    const yesterdaySC = await draft(portal, {
      title: 'Supreme Court big judgment [Read Judgment]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 6, 15, 20, 0),
    });
    const todayGstat = await draft(portal, {
      title: 'GSTAT procedure update',
      queue: 'QUALIFIED',
      authority: 'GSTAT',
      createdAt: ist(2026, 6, 16, 9, 0),
    });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.campaignId).toBe(todayGstat.id); // today wins despite lower tier
    expect(r.campaignId).not.toBe(yesterdaySC.id);
  });

  it('within the same day, higher authority tier wins (SC over GSTAT)', async () => {
    const portal = uniquePortal('tier');
    const now = ist(2026, 6, 16, 12, 0);
    await makeSubscriber(portal);
    const gstat = await draft(portal, { title: 'GSTAT update', queue: 'QUALIFIED', authority: 'GSTAT', createdAt: ist(2026, 6, 16, 8, 0) });
    const sc = await draft(portal, { title: 'Supreme Court ruling [Read Judgment]', queue: 'QUALIFIED', authority: 'Supreme Court', createdAt: ist(2026, 6, 16, 9, 0) });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.campaignId).toBe(sc.id);
    expect(r.campaignId).not.toBe(gstat.id);
  });

  it('within the same day and tier, sends the OLDEST-published article first', async () => {
    const portal = uniquePortal('publish-order');
    const now = ist(2026, 6, 18, 12, 0);
    await makeSubscriber(portal);
    const first = await draft(portal, {
      title: 'Karnataka HC dismisses appeal [Read Order]',
      queue: 'QUALIFIED',
      authority: 'High Court',
      createdAt: ist(2026, 6, 18, 10, 10),
    });
    const second = await draft(portal, {
      title: 'Bombay HC quashes notice [Read Order]',
      queue: 'QUALIFIED',
      authority: 'High Court',
      createdAt: ist(2026, 6, 18, 10, 25),
    });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.campaignId).toBe(first.id); // first-published goes first
    expect(r.campaignId).not.toBe(second.id);
  });

  it('a priority High Court (Bombay) jumps ahead of a generic High Court the same day', async () => {
    const portal = uniquePortal('priority-hc');
    const now = ist(2026, 6, 18, 12, 0);
    await makeSubscriber(portal);
    // Generic HC published EARLIER; Bombay HC published later but outranks it.
    await draft(portal, {
      title: 'Karnataka HC dismisses appeal [Read Order]',
      queue: 'QUALIFIED',
      authority: 'High Court',
      createdAt: ist(2026, 6, 18, 10, 10),
    });
    const bombay = await draft(portal, {
      title: 'Bombay HC quashes notice [Read Order]',
      queue: 'QUALIFIED',
      authority: 'Bombay High Court',
      createdAt: ist(2026, 6, 18, 10, 25),
    });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.campaignId).toBe(bombay.id); // priority bench jumps the order
  });

  it('falls back to the most-recent FALLBACK only when no qualified is pending', async () => {
    const portal = uniquePortal('fallback');
    const now = ist(2026, 6, 16, 12, 0);
    await makeSubscriber(portal);
    await draft(portal, { title: 'Old CESTAT order [Read Order]', queue: 'FALLBACK', authority: 'CESTAT', createdAt: ist(2026, 6, 16, 8, 0) });
    const newerItat = await draft(portal, { title: 'Newer ITAT order [Read Order]', queue: 'FALLBACK', authority: 'ITAT', createdAt: ist(2026, 6, 16, 10, 0) });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.reason).toBe('sent');
    expect(r.released).toBe('FALLBACK');
    expect(r.campaignId).toBe(newerItat.id);
  });

  it('does not auto-send REVIEW items; returns empty when only REVIEW is pending', async () => {
    const portal = uniquePortal('review');
    const now = ist(2026, 6, 16, 12, 0);
    await draft(portal, { title: 'Understanding GST on Renting', queue: 'REVIEW', authority: null, createdAt: now });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.reason).toBe('empty');
    expect(r.campaignId).toBeNull();
  });

  it('an approved analytical item (QUALIFIED, null authority) beats a FALLBACK item', async () => {
    const portal = uniquePortal('approved');
    const now = ist(2026, 6, 16, 12, 0);
    await makeSubscriber(portal);
    const approved = await draft(portal, {
      title: 'Understanding GST on Renting of Property',
      queue: 'QUALIFIED',
      authority: null,
      createdAt: ist(2026, 6, 16, 9, 0),
    });
    await draft(portal, { title: 'ITAT order [Read Order]', queue: 'FALLBACK', authority: 'ITAT', createdAt: ist(2026, 6, 16, 10, 0) });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.campaignId).toBe(approved.id);
    expect(r.released).toBe('QUALIFIED');
  });

  it('within the same day, Supreme Court (tier 1) outranks an approved analytical item (tier 3)', async () => {
    const portal = uniquePortal('approved-tier');
    const now = ist(2026, 6, 16, 12, 0);
    await makeSubscriber(portal);
    await draft(portal, { title: 'Understanding GST on Renting', queue: 'QUALIFIED', authority: null, createdAt: ist(2026, 6, 16, 10, 0) });
    const sc = await draft(portal, { title: 'Supreme Court ruling [Read Judgment]', queue: 'QUALIFIED', authority: 'Supreme Court', createdAt: ist(2026, 6, 16, 9, 0) });

    const r = await runPacerTick({ ...BASE, now, portal, sender: okSender() });
    expect(r.campaignId).toBe(sc.id);
  });
});

describe('runPacerTick — morning backfill (§5a)', () => {
  it('re-sends yesterday SC ahead of a fresh tribunal (clone, leaves original)', async () => {
    const portal = uniquePortal('bf-court');
    const now = ist(2026, 6, 18, 8, 0);
    await makeSubscriber(portal);
    const sc = await sentCampaign(portal, {
      title: 'Supreme Court ruling [Read Judgment]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      url: 'https://taxscan.in/sc-y',
      at: ist(2026, 6, 17, 10, 0),
      clicks: 2,
    });
    const itat = await draft(portal, {
      title: 'Fresh ITAT order [Read Order]',
      queue: 'FALLBACK',
      authority: 'ITAT',
      createdAt: ist(2026, 6, 18, 7, 30),
    });

    const r = await runPacerTick({ ...BACKFILL, now, portal, sender: okSender() });
    expect(r.reason).toBe('sent');
    expect(r.backfill).toBe(true);
    expect(r.campaignId).not.toBe(sc.id); // a clone, not the original
    expect(r.campaignId).not.toBe(itat.id);
    if (r.campaignId) campaignIds.push(r.campaignId);
    const sent = await prisma.campaign.findUnique({ where: { id: r.campaignId! } });
    expect(sent?.authority).toBe('Supreme Court');
    const itatAfter = await prisma.campaign.findUnique({ where: { id: itat.id } });
    expect(itatAfter?.status).toBe('DRAFT'); // fresh tribunal untouched
  });

  it('picks an unsent other-category item when no yesterday court (sent directly)', async () => {
    const portal = uniquePortal('bf-other-unsent');
    const now = ist(2026, 6, 18, 8, 0);
    await makeSubscriber(portal);
    const cbdt = await draft(portal, {
      title: 'CBDT notification',
      queue: 'QUALIFIED',
      authority: 'CBDT',
      createdAt: ist(2026, 6, 17, 10, 0),
    });
    const r = await runPacerTick({ ...BACKFILL, now, portal, sender: okSender() });
    expect(r.reason).toBe('sent');
    expect(r.backfill).toBe(true);
    expect(r.campaignId).toBe(cbdt.id); // unsent → dispatched directly, no clone
  });

  it('re-sends the best-clicked other-category item when none are unsent', async () => {
    const portal = uniquePortal('bf-clicks');
    const now = ist(2026, 6, 18, 8, 0);
    await makeSubscriber(portal);
    await sentCampaign(portal, { title: 'ICAI notice', queue: 'QUALIFIED', authority: 'ICAI', url: 'https://taxscan.in/icai-y', at: ist(2026, 6, 17, 9, 0), clicks: 1 });
    await sentCampaign(portal, { title: 'CBIC circular', queue: 'QUALIFIED', authority: 'CBIC', url: 'https://taxscan.in/cbic-y', at: ist(2026, 6, 17, 10, 0), clicks: 9 });
    const r = await runPacerTick({ ...BACKFILL, now, portal, sender: okSender() });
    expect(r.reason).toBe('sent');
    expect(r.backfill).toBe(true);
    if (r.campaignId) campaignIds.push(r.campaignId);
    const sent = await prisma.campaign.findUnique({ where: { id: r.campaignId! } });
    expect(sent?.authority).toBe('CBIC'); // most clicks
  });

  it('does not backfill after the morning window closes', async () => {
    const portal = uniquePortal('bf-window');
    const now = ist(2026, 6, 18, 13, 0); // after MORNING_BACKFILL_UNTIL 12:00
    await sentCampaign(portal, { title: 'Supreme Court ruling [Read Judgment]', queue: 'QUALIFIED', authority: 'Supreme Court', url: 'https://taxscan.in/sc-late', at: ist(2026, 6, 17, 10, 0) });
    const r = await runPacerTick({ ...BACKFILL, now, portal, sender: okSender() });
    expect(r.backfill).toBe(false);
    expect(r.reason).toBe('empty');
  });

  it('stops backfilling once today has produced a qualified article', async () => {
    const portal = uniquePortal('bf-fresh-arrived');
    const now = ist(2026, 6, 18, 8, 0);
    await sentCampaign(portal, { title: 'Supreme Court ruling [Read Judgment]', queue: 'QUALIFIED', authority: 'Supreme Court', url: 'https://taxscan.in/sc-y2', at: ist(2026, 6, 17, 10, 0) });
    await sentCampaign(portal, { title: 'High Court order [Read Order]', queue: 'QUALIFIED', authority: 'High Court', url: 'https://taxscan.in/hc-today', at: ist(2026, 6, 18, 7, 0) });
    const r = await runPacerTick({ ...BACKFILL, now, portal, sender: okSender() });
    expect(r.backfill).toBe(false);
    expect(r.reason).toBe('empty');
  });

  it('does not re-send a URL already pushed today (once per day)', async () => {
    const portal = uniquePortal('bf-dedup');
    const now = ist(2026, 6, 18, 8, 0);
    const url = 'https://taxscan.in/sc-dedup';
    await sentCampaign(portal, { title: 'Supreme Court ruling [Read Judgment]', queue: 'QUALIFIED', authority: 'Supreme Court', url, at: ist(2026, 6, 17, 10, 0) });
    // a re-send of the same URL already went out earlier today (dated yesterday).
    await sentCampaign(portal, { title: 'Supreme Court ruling [Read Judgment]', queue: 'QUALIFIED', authority: 'Supreme Court', url, at: ist(2026, 6, 17, 10, 0), sentAt: ist(2026, 6, 18, 7, 0) });
    const r = await runPacerTick({ ...BACKFILL, now, portal, sender: okSender() });
    expect(r.backfill).toBe(false);
    expect(r.reason).toBe('empty');
  });

  it('is inert when the flag is off (existing behaviour)', async () => {
    const portal = uniquePortal('bf-off');
    const now = ist(2026, 6, 18, 8, 0);
    await sentCampaign(portal, { title: 'Supreme Court ruling [Read Judgment]', queue: 'QUALIFIED', authority: 'Supreme Court', url: 'https://taxscan.in/sc-off', at: ist(2026, 6, 17, 10, 0) });
    const r = await runPacerTick({ ...BASE, backfillEnabled: false, now, portal, sender: okSender() });
    expect(r.backfill).toBe(false);
    expect(r.reason).toBe('empty'); // no fresh + backfill off → idle
  });
});

describe('runPacerTick — pre-push link check', () => {
  it('archives an article the CMS has deleted instead of pushing a dead link', async () => {
    const portal = uniquePortal('deadlink');
    const now = ist(2026, 7, 28, 12, 0);
    await makeSubscriber(portal);
    const c = await draft(portal, {
      title: 'Supreme Court ruling [Read Order]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 7, 28, 11, 0),
    });
    const sender = okSender();

    const r = await runPacerTick({
      ...BASE,
      now,
      portal,
      sender,
      linkCheck: true,
      isUrlDead: async () => true,
    });

    expect(r.reason).toBe('dead_link');
    expect(r.released).toBeNull();
    // EXPIRED, not DRAFT — otherwise every later tick re-picks the dead row and
    // the queue wedges on it.
    const after = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe('EXPIRED');
    const sent = await prisma.event.count({ where: { campaignId: c.id, type: 'SENT' } });
    expect(sent).toBe(0);
  });

  it('moves on to the next article on the following tick', async () => {
    const portal = uniquePortal('deadlink-next');
    await makeSubscriber(portal);
    const dead = await draft(portal, {
      title: 'Supreme Court dead ruling [Read Order]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 7, 28, 10, 0),
    });
    const live = await draft(portal, {
      title: 'Supreme Court live ruling [Read Order]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 7, 28, 11, 0),
    });
    // `draft()` uses one fixed url; the check keys off the url, so separate them.
    await prisma.campaign.update({
      where: { id: dead.id },
      data: { url: 'https://taxscan.in/top-stories/dead-1' },
    });
    await prisma.campaign.update({
      where: { id: live.id },
      data: { url: 'https://taxscan.in/top-stories/live-1' },
    });

    const first = await runPacerTick({
      ...BASE,
      now: ist(2026, 7, 28, 12, 0),
      portal,
      sender: okSender(),
      linkCheck: true,
      isUrlDead: async (url) => url.includes('dead'),
    });
    expect(first.reason).toBe('dead_link');
    expect(first.campaignId).toBe(dead.id);

    // No SENT event was written, so spacing does not block the very next tick.
    const second = await runPacerTick({
      ...BASE,
      now: ist(2026, 7, 28, 12, 1),
      portal,
      sender: okSender(),
      linkCheck: true,
      isUrlDead: async (url) => url.includes('dead'),
    });
    expect(second.reason).toBe('sent');
    expect(second.campaignId).toBe(live.id);
  });

  it('sends normally when the article is still live', async () => {
    const portal = uniquePortal('livelink');
    const now = ist(2026, 7, 28, 12, 0);
    await makeSubscriber(portal);
    const c = await draft(portal, {
      title: 'Supreme Court ruling [Read Order]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 7, 28, 11, 0),
    });

    const r = await runPacerTick({
      ...BASE,
      now,
      portal,
      sender: okSender(),
      linkCheck: true,
      isUrlDead: async () => false,
    });

    expect(r.reason).toBe('sent');
    expect(r.campaignId).toBe(c.id);
  });

  it('does not check the link when the flag is off', async () => {
    const portal = uniquePortal('nolinkcheck');
    const now = ist(2026, 7, 28, 12, 0);
    await makeSubscriber(portal);
    await draft(portal, {
      title: 'Supreme Court ruling [Read Order]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 7, 28, 11, 0),
    });
    let called = false;

    const r = await runPacerTick({
      ...BASE,
      now,
      portal,
      sender: okSender(),
      linkCheck: false,
      isUrlDead: async () => {
        called = true;
        return true;
      },
    });

    expect(called).toBe(false);
    expect(r.reason).toBe('sent');
  });
});

describe('isUrlDeadDefault', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('treats 404 and 410 as dead', async () => {
    for (const status of [404, 410]) {
      global.fetch = (async () => ({ status })) as unknown as typeof fetch;
      await expect(isUrlDeadDefault('https://taxscan.in/x', 1000)).resolves.toBe(true);
    }
  });

  it('fails open on 200, 5xx, and network errors — never blocks a send', async () => {
    global.fetch = (async () => ({ status: 200 })) as unknown as typeof fetch;
    await expect(isUrlDeadDefault('https://taxscan.in/x', 1000)).resolves.toBe(false);

    global.fetch = (async () => ({ status: 503 })) as unknown as typeof fetch;
    await expect(isUrlDeadDefault('https://taxscan.in/x', 1000)).resolves.toBe(false);

    global.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(isUrlDeadDefault('https://taxscan.in/x', 1000)).resolves.toBe(false);
  });
});
