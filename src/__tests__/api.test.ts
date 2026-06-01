import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import type { Sender } from '../services/send';

const okSender: Sender = async () => ({ ok: true, statusCode: 201 });
const app = createApp();
const sendApp = createApp({ sender: okSender });

const TEST_PREFIX = 'https://test-taxscan.example.com/sub/';
const SEND_PORTAL = 'test-api-send';
function makeEndpoint(suffix: string): string {
  return `${TEST_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function makeSubscription(suffix: string) {
  return {
    endpoint: makeEndpoint(suffix),
    keys: { p256dh: 'p256dh-' + suffix, auth: 'auth-' + suffix },
  };
}

const apiCampaignIds: string[] = [];

afterAll(async () => {
  if (apiCampaignIds.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: apiCampaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: apiCampaignIds } } });
  }
  const subs = await prisma.subscriber.findMany({
    where: { endpoint: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const ids = subs.map((s) => s.id);
  if (ids.length) {
    await prisma.event.deleteMany({ where: { subscriberId: { in: ids } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

describe('POST /api/subscribe', () => {
  it('upserts the subscriber, records SUBSCRIBED, and returns 201', async () => {
    const subscription = makeSubscription('subscribe');
    const res = await request(app)
      .post('/api/subscribe')
      .send({
        subscription,
        portal: 'taxscan',
        topics: ['gst', 'income-tax'],
        userAgent: 'jest-test',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));

    const sub = await prisma.subscriber.findUnique({ where: { endpoint: subscription.endpoint } });
    expect(sub).not.toBeNull();
    expect(sub?.portal).toBe('taxscan');
    expect(sub?.status).toBe('ACTIVE');
    expect(sub?.topics).toEqual(['gst', 'income-tax']);

    const events = await prisma.event.findMany({
      where: { subscriberId: sub!.id, type: 'SUBSCRIBED' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed body with 400', async () => {
    const res = await request(app).post('/api/subscribe').send({ portal: 'taxscan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('upsert re-subscribes an EXPIRED endpoint back to ACTIVE', async () => {
    const subscription = makeSubscription('reactivate');
    await request(app).post('/api/subscribe').send({ subscription, portal: 'taxscan' }).expect(201);
    await prisma.subscriber.update({
      where: { endpoint: subscription.endpoint },
      data: { status: 'EXPIRED' },
    });
    await request(app).post('/api/subscribe').send({ subscription, portal: 'taxscan' }).expect(201);
    const sub = await prisma.subscriber.findUnique({ where: { endpoint: subscription.endpoint } });
    expect(sub?.status).toBe('ACTIVE');
  });
});

describe('POST /api/unsubscribe', () => {
  it('marks the subscriber EXPIRED and records UNSUBSCRIBED', async () => {
    const subscription = makeSubscription('unsubscribe');
    await request(app).post('/api/subscribe').send({ subscription, portal: 'taxscan' }).expect(201);

    const res = await request(app)
      .post('/api/unsubscribe')
      .send({ endpoint: subscription.endpoint });
    expect(res.status).toBe(200);

    const sub = await prisma.subscriber.findUnique({ where: { endpoint: subscription.endpoint } });
    expect(sub?.status).toBe('EXPIRED');

    const events = await prisma.event.findMany({
      where: { subscriberId: sub!.id, type: 'UNSUBSCRIBED' },
    });
    expect(events.length).toBe(1);
  });

  it('rejects malformed body with 400', async () => {
    const res = await request(app).post('/api/unsubscribe').send({});
    expect(res.status).toBe(400);
  });

  it('is idempotent for an unknown endpoint', async () => {
    const res = await request(app)
      .post('/api/unsubscribe')
      .send({ endpoint: makeEndpoint('ghost') });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/track', () => {
  it('records a CLICKED event for a known endpoint and returns 204', async () => {
    const subscription = makeSubscription('track-click');
    await request(app).post('/api/subscribe').send({ subscription, portal: 'taxscan' }).expect(201);

    const res = await request(app)
      .post('/api/track')
      .send({ type: 'CLICKED', endpoint: subscription.endpoint });
    expect(res.status).toBe(204);

    const sub = await prisma.subscriber.findUnique({ where: { endpoint: subscription.endpoint } });
    const events = await prisma.event.findMany({
      where: { subscriberId: sub!.id, type: 'CLICKED' },
    });
    expect(events.length).toBe(1);
  });

  it('records a PROMPT_SHOWN event without an endpoint', async () => {
    const res = await request(app).post('/api/track').send({ type: 'PROMPT_SHOWN' });
    expect(res.status).toBe(204);
  });

  it('rejects a disallowed event type with 400', async () => {
    const res = await request(app).post('/api/track').send({ type: 'SENT' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing type with 400', async () => {
    const res = await request(app).post('/api/track').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/config', () => {
  it('returns the VAPID public key', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.vapidPublicKey).toBe('string');
  });
});

describe('POST /api/send', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await request(sendApp).post('/api/send').send({
      portal: SEND_PORTAL,
      title: 't',
      body: 'b',
      url: 'https://taxscan.in',
      target: { type: 'all' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong bearer token', async () => {
    const res = await request(sendApp)
      .post('/api/send')
      .set('Authorization', 'Bearer wrong')
      .send({
        portal: SEND_PORTAL,
        title: 't',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
      });
    expect(res.status).toBe(401);
  });

  it('returns 400 for a malformed body', async () => {
    const res = await request(sendApp)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({ portal: SEND_PORTAL });
    expect(res.status).toBe(400);
  });

  it('dispatches a campaign to a seeded subscriber and records SENT', async () => {
    const subscription = makeSubscription('api-send');
    await request(sendApp)
      .post('/api/subscribe')
      .send({ subscription, portal: SEND_PORTAL })
      .expect(201);

    const res = await request(sendApp)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({
        portal: SEND_PORTAL,
        title: 'api hello',
        body: 'from /api/send',
        url: 'https://taxscan.in/x',
        target: { type: 'all' },
        breaking: true, // bypass quiet hours so this is deterministic regardless of wall clock
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SENT');
    expect(res.body.sent).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.campaignId).toBe('string');
    apiCampaignIds.push(res.body.campaignId);

    const events = await prisma.event.findMany({
      where: { campaignId: res.body.campaignId, type: 'SENT' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
