import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import type { Sender } from '../services/send';
import type { SendQueue } from '../services/classify';
import { validKeys } from './helpers';

const okSender: Sender = async () => ({ ok: true, statusCode: 201 });
const app = createApp({ sender: okSender });
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

const campaignIds: string[] = [];
const subscriberIds: string[] = [];

async function draft(
  portal: string,
  opts: { title: string; queue: SendQueue; authority?: string | null; createdAt: Date },
) {
  const c = await prisma.campaign.create({
    data: {
      portal,
      title: opts.title,
      body: 'summary',
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

async function makeSubscriber(portal: string) {
  const keys = validKeys();
  const sub = await prisma.subscriber.create({
    data: {
      endpoint: `https://test-queue.example.com/${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      p256dh: keys.p256dh,
      auth: keys.auth,
      portal,
      topics: ['all'],
    },
  });
  subscriberIds.push(sub.id);
  return sub;
}

afterAll(async () => {
  if (campaignIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'campaign' AND "resourceId" = ANY(${campaignIds}::text[])`;
    });
    await prisma.event.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  }
  if (subscriberIds.length) {
    await prisma.event.deleteMany({ where: { subscriberId: { in: subscriberIds } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
  }
  await prisma.$disconnect();
});

describe('send queue API', () => {
  it('GET /api/queue requires auth', async () => {
    const res = await request(app).get('/api/queue');
    expect(res.status).toBe(401);
  });

  it('lists QUALIFIED before FALLBACK, oldest-published-first within QUALIFIED', async () => {
    // The endpoint is scoped to env.rss.portal — seed there and assert on the
    // RELATIVE order of our own ids (other portals/tests can't reorder them).
    const portal = env.rss.portal;
    const qOld = await draft(portal, {
      title: 'Karnataka HC dismisses appeal [Read Order]',
      queue: 'QUALIFIED',
      authority: 'High Court',
      createdAt: ist(2026, 6, 18, 10, 10),
    });
    const qNew = await draft(portal, {
      title: 'Bombay HC quashes notice [Read Order]',
      queue: 'QUALIFIED',
      authority: 'High Court',
      createdAt: ist(2026, 6, 18, 10, 25),
    });
    const fb = await draft(portal, {
      title: 'ITAT order [Read Order]',
      queue: 'FALLBACK',
      authority: 'ITAT',
      createdAt: ist(2026, 6, 18, 11, 0),
    });

    const res = await request(app).get('/api/queue').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([qOld.id, qNew.id, fb.id]));
    expect(ids.indexOf(qOld.id)).toBeLessThan(ids.indexOf(qNew.id)); // oldest first
    expect(ids.indexOf(qNew.id)).toBeLessThan(ids.indexOf(fb.id)); // qualified before fallback
  });

  it('POST /api/queue/:id/push sends to full reach and marks the campaign SENT', async () => {
    const portal = `test-queue-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await makeSubscriber(portal);
    const c = await draft(portal, {
      title: 'Supreme Court ruling [Read Judgment]',
      queue: 'QUALIFIED',
      authority: 'Supreme Court',
      createdAt: ist(2026, 6, 18, 9, 0),
    });

    const res = await request(app).post(`/api/queue/${c.id}/push`).set('Authorization', AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sent).toBeGreaterThanOrEqual(1);

    const after = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe('SENT');
    const sent = await prisma.event.count({ where: { campaignId: c.id, type: 'SENT' } });
    expect(sent).toBeGreaterThanOrEqual(1);
  });

  it('pushing an already-sent / non-pending item returns 404', async () => {
    const portal = `test-queue-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const c = await draft(portal, {
      title: 'CBDT notification',
      queue: 'QUALIFIED',
      authority: 'CBDT',
      createdAt: ist(2026, 6, 18, 9, 0),
    });
    await request(app).post(`/api/queue/${c.id}/push`).set('Authorization', AUTH).send({});
    const res = await request(app).post(`/api/queue/${c.id}/push`).set('Authorization', AUTH).send({});
    expect(res.status).toBe(404);
  });
});
