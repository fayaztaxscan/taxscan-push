import type { Subscriber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { runPacerTick } from '../services/pacer';
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
