import bcrypt from 'bcrypt';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';

/**
 * Brief 2026-11-02-whatsapp-channel-queue, acceptance 3–6: the queue for an IST day, the one-row-per-article rule,
 * Posted / Skipped / undo, roles and the flag. Rows live under a unique `test-wa-*` portal and are removed afterwards.
 */
jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL = `test-wa-${RUN}`;
const PASSWORD = 'wa-queue-test-pw-1';
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const IST_MS = (5 * 60 + 30) * 60_000;
/** An instant given as IST wall-clock on 2026-11-02 (+ dayOffset). */
const ist = (h: number, m = 0, dayOffset = 0) => new Date(Date.UTC(2026, 10, 2 + dayOffset, h, m) - IST_MS);
const NOW = ist(20, 0); // 2 Nov 2026 20:00 IST

const userIds: string[] = [];
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
let n = 0;
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const app = (enabled = true) => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, whatsapp: { enabled: () => enabled, clock: () => NOW, portal: () => PORTAL } });

async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `wa-${role.toLowerCase()}-${RUN}-${++n}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}

const camps: Record<string, string> = {};
async function seed(key: string, o: { id: number; at: Date; slug?: string; host?: string; status?: 'SENT' | 'DRAFT'; title?: string; body?: string; portal?: string; url?: string; extra?: Record<string, unknown> }) {
  const url = o.url ?? `https://${o.host ?? 'www.taxscan.in'}/${o.slug ?? 'gst'}/story-${key}-${o.id}`;
  const c = await prisma.campaign.create({
    data: {
      portal: o.portal ?? PORTAL,
      title: o.title ?? `Story ${key}`,
      body: o.body ?? `Body of ${key}`,
      url,
      target: {},
      status: o.status ?? 'SENT',
      lastSentAt: o.at,
      authority: 'Supreme Court',
      categories: ['GST', 'Top Stories'],
      ...(o.extra ?? {}),
    } as never,
  });
  camps[key] = c.id;
  return c;
}
const get = (a: ReturnType<typeof app>, q = '') => request(a).get(`/api/whatsapp/queue${q}`).set('Authorization', AUTH);

beforeAll(async () => {
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
  // 2 Nov IST day: boundaries and order (inserted out of order on purpose)
  await seed('late', { id: 100003, at: ist(23, 59) });
  await seed('early', { id: 100001, at: ist(0, 0) });
  await seed('mid', { id: 100002, at: ist(12, 30) });
  await seed('academy', { id: 100010, at: ist(13, 0), host: 'academy.taxscan.in' });
  await seed('draft', { id: 100011, at: ist(13, 5), status: 'DRAFT' });
  await seed('home', { id: 0, at: ist(13, 10), url: 'https://www.taxscan.in/' }); // not an article
  await seed('section', { id: 0, at: ist(13, 11), url: 'https://www.taxscan.in/income-tax' }); // a section page: not an article
  // today's shape: no trailing id (G1); pushed twice (G3)
  await seed('noid', { id: 0, at: ist(14, 0), url: 'https://www.taxscan.in/income-tax/interest-on-enhanced-compensation-is-not-taxable-itat-read-order' });
  await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story noid again', body: 'x', url: 'https://www.taxscan.in/income-tax/interest-on-enhanced-compensation-is-not-taxable-itat-read-order', target: {}, status: 'SENT', lastSentAt: ist(19, 30) } });
  await seed('otherportal', { id: 100012, at: ist(13, 15), portal: `${PORTAL}-x` });
  // H2 (LinkedIn follow-up 1): a Compose send aimed ONLY at the test-segment topic is not on the list; a real topic is
  await seed('testonly', { id: 100030, at: ist(15, 0), extra: { target: { type: 'topics', topics: [env.testSegmentTopic] } } });
  await seed('testreal', { id: 100031, at: ist(15, 5), extra: { createdByUserId: undefined, target: { type: 'topics', topics: [env.testSegmentTopic, 'gst'] } } });
  // the day before and the day after
  await seed('before', { id: 100020, at: ist(23, 59, -1) });
  await seed('after', { id: 100021, at: ist(0, 0, 1) });
  // a backfill clone of an earlier article on the same day (same trailing id, new slug/campaign), and one pushed the next day
  await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story mid', body: 'Body of mid', url: 'https://www.taxscan.in/top-stories/old-slug-100002', target: {}, status: 'SENT', lastSentAt: ist(18, 45) } });
  await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story before again', body: 'x', url: 'https://www.taxscan.in/gst/story-before-100020', target: {}, status: 'SENT', lastSentAt: ist(7, 30, 0) } });
});

afterAll(async () => {
  await prisma.whatsAppPost.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('3. the queue for an IST day', () => {
  it('returns only SENT taxscan.in articles of that IST day, in lastSentAt order (00:00 and 23:59 IST both in; the neighbours out)', async () => {
    const res = await get(app());
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-11-02');
    expect(res.body.rows.map((r: { headline: string }) => r.headline)).toEqual(['Story early', 'Story mid', 'Story noid', 'Story testreal', 'Story late']);
    expect(res.body.rows.map((r: { pushedTime: string }) => r.pushedTime)).toEqual(['00:00', '12:30', '14:00', '15:05', '23:59']);
    expect(res.body.counts).toEqual({ todo: 5, posted: 0, skipped: 0, all: 5 });
    const row = res.body.rows[1];
    expect(row).toMatchObject({ authority: 'Supreme Court', category: 'GST', status: 'TODO', actedBy: null, actedAt: null });
    expect(row.text).toContain('*Story mid*');
    expect(row.text).toContain('utm_source=taxscan-whatsapp');
    expect(row.text).toContain('utm_content=100002');
  });
  it('shows the day before on its own date (the day after is the future: refused below)', async () => {
    const prev = await get(app(), '?date=2026-11-01');
    expect(prev.body.rows.map((r: { headline: string }) => r.headline)).toEqual(['Story before']);
    expect(prev.body.rows[0].pushedAgainTime).toBe('07:30'); // pushed again the next morning (IST)
  });
  it('validates the date: bad format, the future, more than 14 days back', async () => {
    expect((await get(app(), '?date=nope')).status).toBe(400);
    expect((await get(app(), '?date=2026-02-30')).status).toBe(400);
    expect((await get(app(), '?date=2026-11-03')).status).toBe(400);
    expect((await get(app(), '?date=2026-10-18')).status).toBe(400);
    expect((await get(app(), '?date=2026-10-19')).status).toBe(200);
  });
});

describe('4. a re-push collapses into the first push', () => {
  it('the same-day clone of "mid" adds no row, stays at the first push\'s position, and sets "pushed again"', async () => {
    const res = await get(app());
    const mids = res.body.rows.filter((r: { articleKey: string }) => r.articleKey === 'article:100002');
    expect(mids).toHaveLength(1);
    expect(mids[0].campaignId).toBe(camps.mid);
    expect(mids[0].pushedTime).toBe('12:30');
    expect(mids[0].pushedAgainTime).toBe('18:45');
    expect(res.body.rows.findIndex((r: { articleKey: string }) => r.articleKey === 'article:100002')).toBe(1);
  });
  it('G3: two pushes of the same no-id URL are one row, with "pushed again"; G1: both URL shapes are listed in push order', async () => {
    const rows = (await get(app())).body.rows;
    const noid = rows.filter((r: { headline: string }) => r.headline === 'Story noid');
    expect(noid).toHaveLength(1);
    expect(noid[0]).toMatchObject({ pushedTime: '14:00', pushedAgainTime: '19:30', status: 'TODO' });
    expect(noid[0].articleKey).toMatch(/^https:\/\/www\.taxscan\.in\/income-tax\//);
    expect(noid[0].text).toContain('utm_content=interest-on-enhanced-compensation-is-not-taxable-itat-read-order');
    expect(rows.some((r: { articleKey: string }) => r.articleKey.startsWith('article:'))).toBe(true);
  });
});

describe('5. Posted / Skipped / undo', () => {
  const mark = (a: ReturnType<typeof app>, id: string, status: string, cookie = adminCookie) => request(a).post(`/api/whatsapp/queue/${id}`).set('Cookie', cookie).send({ status });
  it('POSTED shows as Posted with user and time; a re-push of it stays Posted; TODO deletes the row', async () => {
    const a = app();
    expect((await mark(a, camps.mid, 'POSTED')).status).toBe(200);
    let rows = (await get(a)).body.rows;
    const mid = rows.find((r: { articleKey: string }) => r.articleKey === 'article:100002');
    expect(mid).toMatchObject({ status: 'POSTED', actedBy: { id: admin.id, email: admin.email }, actedAt: NOW.toISOString() });
    // marking through the re-push's campaign id is the same article
    const clone = await prisma.campaign.findFirstOrThrow({ where: { portal: PORTAL, url: { contains: 'old-slug-100002' } } });
    expect((await mark(a, clone.id, 'SKIPPED', publisherCookie)).status).toBe(200);
    rows = (await get(a)).body.rows;
    expect(rows.find((r: { articleKey: string }) => r.articleKey === 'article:100002')).toMatchObject({ status: 'SKIPPED', actedBy: { id: publisher.id } });
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL, articleKey: 'article:100002' } })).toBe(1);
    expect((await mark(a, camps.mid, 'POSTED')).status).toBe(200);
    expect((await get(a)).body.counts).toEqual({ todo: 4, posted: 1, skipped: 0, all: 5 });
    expect((await mark(a, camps.mid, 'TODO')).status).toBe(200);
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL } })).toBe(0);
    expect((await get(a)).body.counts.todo).toBe(5);
  });
  it('G1: a no-id article can be marked Posted and Skipped, and undone', async () => {
    const a = app();
    expect((await mark(a, camps.noid, 'POSTED')).status).toBe(200);
    expect((await get(a)).body.rows.find((r: { headline: string }) => r.headline === 'Story noid')).toMatchObject({ status: 'POSTED', actedBy: { id: admin.id } });
    expect((await mark(a, camps.noid, 'SKIPPED')).status).toBe(200);
    expect((await get(a)).body.counts.skipped).toBe(1);
    expect((await mark(a, camps.noid, 'TODO')).status).toBe(200);
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL } })).toBe(0);
  });
  it('a later push of a Posted article does not bring it back as To do', async () => {
    const a = app();
    await mark(a, camps.early, 'POSTED');
    await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story early again', body: 'x', url: 'https://www.taxscan.in/gst/another-slug-100001', target: {}, status: 'SENT', lastSentAt: ist(19, 0) } });
    const rows = (await get(a)).body.rows;
    expect(rows.filter((r: { articleKey: string }) => r.articleKey === 'article:100001')).toMatchObject([{ status: 'POSTED', pushedAgainTime: '19:00' }]);
    await prisma.whatsAppPost.deleteMany({ where: { portal: PORTAL } });
  });
  it('refuses a campaign that is not a sent taxscan article (404), and a bad status (400)', async () => {
    const a = app();
    expect((await mark(a, camps.academy, 'POSTED')).status).toBe(404);
    expect((await mark(a, camps.draft, 'POSTED')).status).toBe(404);
    expect((await mark(a, camps.home, 'POSTED')).status).toBe(404);
    expect((await mark(a, camps.section, 'POSTED')).status).toBe(404);
    expect((await mark(a, camps.testonly, 'POSTED')).status).toBe(404); // H2: a test send is never on the list
    expect((await mark(a, camps.otherportal, 'POSTED')).status).toBe(404);
    expect((await mark(a, 'nope', 'POSTED')).status).toBe(404);
    expect((await mark(a, camps.mid, 'DONE')).status).toBe(400);
    expect(await prisma.whatsAppPost.count({ where: { portal: { startsWith: PORTAL } } })).toBe(0);
  });
});

describe('6. roles and the flag', () => {
  it('ADMIN and PUBLISHER can read and mark; no session is 401', async () => {
    const a = app();
    for (const cookie of [adminCookie, publisherCookie]) {
      expect((await request(a).get('/api/whatsapp/queue').set('Cookie', cookie)).status).toBe(200);
    }
    expect((await request(a).get('/api/whatsapp/queue')).status).toBe(401);
    expect((await request(a).post(`/api/whatsapp/queue/${camps.mid}`).send({ status: 'POSTED' })).status).toBe(401);
  });
  it('flag off: 404 on both endpoints, even with a valid session', async () => {
    const a = app(false);
    expect((await request(a).get('/api/whatsapp/queue').set('Cookie', adminCookie)).status).toBe(404);
    expect((await request(a).post(`/api/whatsapp/queue/${camps.mid}`).set('Cookie', adminCookie).send({ status: 'POSTED' })).status).toBe(404);
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL } })).toBe(0);
  });
  it('/api/auth/me tells the SPA whether the menu item shows (the configured flag; off by default)', async () => {
    const me = await request(loginApp).get('/api/auth/me').set('Cookie', adminCookie);
    expect(me.body.features).toEqual({ whatsappQueue: env.whatsapp.queueEnabled, linkedinPosting: env.linkedin.enabled, facebookPosting: env.facebook.enabled });
  });
});
