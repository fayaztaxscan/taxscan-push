import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import type { Sender } from '../services/send';
import { validKeys } from './helpers';

const okSender: Sender = async () => ({ ok: true, statusCode: 201 });
const app = createApp({ sender: okSender });
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;

const PORTAL = `test-review-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const campaignIds: string[] = [];
const subscriberIds: string[] = [];

async function reviewDraft(title: string) {
  const c = await prisma.campaign.create({
    data: {
      portal: PORTAL,
      title,
      body: 'summary',
      url: 'https://taxscan.in',
      target: { type: 'all' },
      status: 'DRAFT',
      sendQueue: 'REVIEW',
      authority: null,
    },
  });
  campaignIds.push(c.id);
  return c;
}

async function makeSubscriber() {
  const keys = validKeys();
  const sub = await prisma.subscriber.create({
    data: {
      endpoint: `https://test-review.example.com/${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      p256dh: keys.p256dh,
      auth: keys.auth,
      portal: PORTAL,
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

describe('review queue API', () => {
  it('GET /api/review requires auth', async () => {
    const res = await request(app).get('/api/review');
    expect(res.status).toBe(401);
  });

  it('GET /api/review lists pending REVIEW drafts', async () => {
    const c = await reviewDraft('Understanding GST on Renting of Property');
    const res = await request(app).get('/api/review').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(c.id);
  });

  it('approve promotes the item to QUALIFIED and removes it from the queue', async () => {
    const c = await reviewDraft('What S.58(3) Means for Businesses');
    const res = await request(app).post(`/api/review/${c.id}/approve`).set('Authorization', AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, queue: 'QUALIFIED' });

    const after = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(after?.sendQueue).toBe('QUALIFIED');
    expect(after?.reviewedAt).not.toBeNull();

    const list = await request(app).get('/api/review').set('Authorization', AUTH);
    expect((list.body.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(c.id);
  });

  it('reject marks it reviewed but leaves it a REVIEW draft (never sent)', async () => {
    const c = await reviewDraft('Next GST Council Meet to Advance Reforms');
    const res = await request(app).post(`/api/review/${c.id}/reject`).set('Authorization', AUTH).send({});
    expect(res.status).toBe(200);

    const after = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(after?.sendQueue).toBe('REVIEW');
    expect(after?.reviewedAt).not.toBeNull();
    expect(after?.status).toBe('DRAFT');
  });

  it('push sends immediately to full reach and marks the campaign SENT', async () => {
    await makeSubscriber();
    const c = await reviewDraft('GST on RWA Maintenance Charges Explained');
    const res = await request(app).post(`/api/review/${c.id}/push`).set('Authorization', AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sent).toBeGreaterThanOrEqual(1);

    const after = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe('SENT');
    expect(after?.reviewedAt).not.toBeNull();
    const sent = await prisma.event.count({ where: { campaignId: c.id, type: 'SENT' } });
    expect(sent).toBeGreaterThanOrEqual(1);
  });

  it('acting on an already-handled item returns 404', async () => {
    const c = await reviewDraft('Some analytical piece');
    await request(app).post(`/api/review/${c.id}/reject`).set('Authorization', AUTH).send({});
    const res = await request(app).post(`/api/review/${c.id}/approve`).set('Authorization', AUTH).send({});
    expect(res.status).toBe(404);
  });
});
