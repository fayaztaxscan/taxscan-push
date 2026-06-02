import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import type { Sender } from '../services/send';
import { validKeys } from './helpers';

const okSender: Sender = async () => ({ ok: true, statusCode: 201 });
const app = createApp({ sender: okSender });

const TEST_PREFIX = 'https://test-admin.example.com/sub/';
const createdCampaignIds: string[] = [];
const createdSubscriberEndpoints: string[] = [];

function uniquePortal(name: string): string {
  return `test-admin-${name}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

afterAll(async () => {
  if (createdCampaignIds.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: createdCampaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: createdCampaignIds } } });
  }
  if (createdSubscriberEndpoints.length) {
    const subs = await prisma.subscriber.findMany({
      where: { endpoint: { in: createdSubscriberEndpoints } },
      select: { id: true },
    });
    const ids = subs.map((s) => s.id);
    if (ids.length) {
      await prisma.event.deleteMany({ where: { subscriberId: { in: ids } } });
      await prisma.subscriber.deleteMany({ where: { id: { in: ids } } });
    }
  }
  await prisma.$disconnect();
});

describe('POST /api/auth/login', () => {
  it('returns the bearer token and the test segment topic for the right password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: process.env.ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(process.env.ADMIN_TOKEN);
    expect(typeof res.body.testSegmentTopic).toBe('string');
  });

  it('rejects the wrong password with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'definitely-wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/send — scheduledAt', () => {
  it('persists a campaign as SCHEDULED when scheduledAt is in the future and does not dispatch', async () => {
    const portal = uniquePortal('scheduled');
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const res = await request(app)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({
        portal,
        title: 'later',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        scheduledAt: future.toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SCHEDULED');
    expect(res.body.deferred?.scheduledAt).toBe(future.toISOString());
    expect(res.body.sent).toBe(0);
    createdCampaignIds.push(res.body.campaignId);

    const row = await prisma.campaign.findUnique({ where: { id: res.body.campaignId } });
    expect(row?.status).toBe('SCHEDULED');
    expect(row?.scheduledAt?.toISOString()).toBe(future.toISOString());

    const events = await prisma.event.findMany({
      where: { campaignId: res.body.campaignId, type: 'SENT' },
    });
    expect(events).toHaveLength(0);
  });

  it('dispatches immediately if scheduledAt is in the past', async () => {
    const portal = uniquePortal('scheduled-past');
    const subscription = {
      endpoint: `${TEST_PREFIX}past-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      keys: validKeys(),
    };
    createdSubscriberEndpoints.push(subscription.endpoint);
    await request(app).post('/api/subscribe').send({ subscription, portal }).expect(201);

    const past = new Date(Date.now() - 5 * 60 * 1000);
    const res = await request(app)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({
        portal,
        title: 'past',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        breaking: true,
        scheduledAt: past.toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SENT');
    createdCampaignIds.push(res.body.campaignId);
  });
});

describe('GET /api/campaigns', () => {
  it('requires the bearer token', async () => {
    const res = await request(app).get('/api/campaigns');
    expect(res.status).toBe(401);
  });

  it('returns a list with sent/clicked/ctr', async () => {
    const portal = uniquePortal('list');
    const subscription = {
      endpoint: `${TEST_PREFIX}list-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      keys: validKeys(),
    };
    createdSubscriberEndpoints.push(subscription.endpoint);
    await request(app).post('/api/subscribe').send({ subscription, portal }).expect(201);

    const send = await request(app)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({
        portal,
        title: 'list-test',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        breaking: true,
      });
    expect(send.status).toBe(200);
    createdCampaignIds.push(send.body.campaignId);

    await request(app)
      .post('/api/track')
      .send({ type: 'CLICKED', campaignId: send.body.campaignId });

    const list = await request(app)
      .get('/api/campaigns')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(list.status).toBe(200);
    const mine = list.body.campaigns.find(
      (c: { id: string }) => c.id === send.body.campaignId,
    );
    expect(mine).toBeDefined();
    expect(mine.sent).toBeGreaterThanOrEqual(1);
    expect(mine.clicked).toBeGreaterThanOrEqual(1);
    expect(mine.ctr).toBeGreaterThan(0);
  });
});

describe('admin test-segment helpers', () => {
  it('GET /api/admin/subscribers returns recent ACTIVE rows + the test topic', async () => {
    const portal = uniquePortal('list-subs');
    const subscription = {
      endpoint: `${TEST_PREFIX}list-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      keys: validKeys(),
    };
    createdSubscriberEndpoints.push(subscription.endpoint);
    await request(app).post('/api/subscribe').send({ subscription, portal }).expect(201);

    const res = await request(app)
      .get('/api/admin/subscribers?limit=10')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.subscribers)).toBe(true);
    expect(typeof res.body.testSegmentTopic).toBe('string');
    const mine = res.body.subscribers.find(
      (s: { endpoint: string }) => s.endpoint === subscription.endpoint,
    );
    expect(mine).toBeDefined();
    // Default-topics rule: a subscribe with no topics lands as ['all'].
    expect(mine.topics).toEqual(['all']);
  });

  it('POST /api/admin/subscribers/:id/test-segment appends the test topic', async () => {
    const portal = uniquePortal('add-test');
    const subscription = {
      endpoint: `${TEST_PREFIX}add-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      keys: validKeys(),
    };
    createdSubscriberEndpoints.push(subscription.endpoint);
    const create = await request(app)
      .post('/api/subscribe')
      .send({ subscription, portal, topics: ['gst'] });
    expect(create.status).toBe(201);
    const id = create.body.id as string;

    const first = await request(app)
      .post(`/api/admin/subscribers/${id}/test-segment`)
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(first.status).toBe(200);
    expect(first.body.added).toBe(true);
    expect(first.body.subscriber.topics).toContain('test');
    expect(first.body.subscriber.topics).toContain('gst');

    // Idempotent — second call doesn't duplicate.
    const second = await request(app)
      .post(`/api/admin/subscribers/${id}/test-segment`)
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(second.status).toBe(200);
    expect(second.body.added).toBe(false);
    const reloaded = await prisma.subscriber.findUnique({ where: { id } });
    expect(reloaded?.topics.filter((t) => t === 'test').length).toBe(1);
  });

  it('POST /api/admin/subscribers/:id/test-segment returns 404 for unknown ids', async () => {
    const res = await request(app)
      .post('/api/admin/subscribers/does-not-exist/test-segment')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('admin endpoints require the bearer token', async () => {
    const a = await request(app).get('/api/admin/subscribers');
    expect(a.status).toBe(401);
    const b = await request(app).post('/api/admin/subscribers/x/test-segment');
    expect(b.status).toBe(401);
  });
});

describe('GET /api/metrics', () => {
  it('requires the bearer token', async () => {
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(401);
  });

  it('returns the dashboard shape with non-negative numbers', async () => {
    const res = await request(app)
      .get('/api/metrics')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.activeSubscribers).toBe('number');
    expect(res.body.activeSubscribers).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.body.growth)).toBe(true);
    expect(res.body.growth.length).toBe(30);
    expect(res.body.funnel).toEqual(
      expect.objectContaining({
        promptShown: expect.any(Number),
        promptAccepted: expect.any(Number),
        subscribed: expect.any(Number),
      }),
    );
    expect(res.body.totals).toEqual(
      expect.objectContaining({
        sent: expect.any(Number),
        clicked: expect.any(Number),
        expired: expect.any(Number),
      }),
    );
    expect(Array.isArray(res.body.campaigns)).toBe(true);
  });

  it('funnel.subscribed only counts SUBSCRIBED events with meta.source = "soft-prompt"', async () => {
    const before = await request(app)
      .get('/api/metrics')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(before.status).toBe(200);
    const beforeSubscribed = before.body.funnel.subscribed as number;

    const subSoftPrompt = await prisma.subscriber.create({
      data: {
        endpoint: `${TEST_PREFIX}funnel-sp-${Date.now()}`,
        p256dh: validKeys().p256dh,
        auth: validKeys().auth,
        portal: 'taxscan',
        topics: [],
      },
    });
    createdSubscriberEndpoints.push(subSoftPrompt.endpoint);

    const subRecapture = await prisma.subscriber.create({
      data: {
        endpoint: `${TEST_PREFIX}funnel-rc-${Date.now()}`,
        p256dh: validKeys().p256dh,
        auth: validKeys().auth,
        portal: 'taxscan',
        topics: [],
      },
    });
    createdSubscriberEndpoints.push(subRecapture.endpoint);

    await prisma.event.create({
      data: { type: 'SUBSCRIBED', subscriberId: subSoftPrompt.id, meta: { source: 'soft-prompt' } },
    });
    await prisma.event.create({
      data: { type: 'SUBSCRIBED', subscriberId: subRecapture.id, meta: { source: 'recapture' } },
    });

    const after = await request(app)
      .get('/api/metrics')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(after.status).toBe(200);
    const afterSubscribed = after.body.funnel.subscribed as number;
    // Only the soft-prompt row should count toward the funnel. The recapture row
    // is excluded.
    expect(afterSubscribed - beforeSubscribed).toBe(1);
  });
});
