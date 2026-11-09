import bcrypt from 'bcrypt';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env, parseAllPushesFrom, WHATSAPP_ALL_PUSHES_FROM_VAR } from '../lib/env';
import { articleKey } from '../services/reports';
import { getQueue, istDay, logWhatsAppAllPushes, type QueueRow } from '../services/whatsapp/queue';
import { buildPushPostText } from '../services/whatsapp/pushText';
import { nudgeTitle } from '../services/whatsapp/nudge';
import { pushKey } from '../services/social/allPushes';
import { listCampaigns } from '../services/metrics';

/**
 * Brief 2026-11-05-whatsapp-every-push: from WHATSAPP_ALL_PUSHES_FROM the WhatsApp queue lists EVERY push (article, course, product), one
 * row per push, repeats included; before the time, and with the variable unset, it is exactly today's queue. The queue and marks live under
 * a unique `test-wa-all-*` portal; the Channels test uses portal `taxscan` (the channel's own) with ids filtered by this run.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL = `test-wa-all-${RUN}`;
const PASSWORD = 'wa-all-pushes-test-pw-1';
const IST_MS = (5 * 60 + 30) * 60_000;
/** An instant given as IST wall-clock on 2026-11-02 (+ dayOffset). */
const ist = (h: number, m = 0, dayOffset = 0) => new Date(Date.UTC(2026, 10, 2 + dayOffset, h, m) - IST_MS);
const NOW = ist(20, 0); // 2 Nov 2026 20:00 IST
const FROM = ist(10, 0); // the switch time: 2 Nov 10:00 IST

const userIds: string[] = [];
let n = 0;
let admin: User;
let adminCookie: string;
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const app = (from: Date | null | undefined = FROM, now: Date = NOW) =>
  createApp({
    rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
    whatsapp: { enabled: () => true, clock: () => now, portal: () => PORTAL, ...(from === undefined ? {} : { allPushesFrom: () => from }) },
  });

async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `wa-all-${role.toLowerCase()}-${RUN}-${++n}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}

const art = (slug: string) => `https://www.taxscan.in/gst/${slug}-${RUN}-wa`;
const course = (slug: string) => `https://academy.taxscan.in/course/${slug}-${RUN}-wa`;
const product = (slug: string) => `https://shop.taxscan.in/products/${slug}-${RUN}-wa`;

const camps: Record<string, string> = {};
async function seed(key: string, o: { url: string; at: Date; title?: string; body?: string; portal?: string; target?: unknown; status?: 'SENT' | 'DRAFT' }) {
  const c = await prisma.campaign.create({
    data: {
      portal: o.portal ?? PORTAL,
      title: o.title ?? `Title ${key}`,
      body: o.body ?? `Body of ${key}`,
      url: o.url,
      target: (o.target ?? {}) as never,
      status: o.status ?? 'SENT',
      lastSentAt: o.at,
      authority: 'Supreme Court',
      categories: ['GST'],
    } as never,
  });
  camps[key] = c.id;
  return c;
}
const get = (a: ReturnType<typeof app>, q = '') => request(a).get(`/api/whatsapp/queue${q}`).set('Cookie', adminCookie);
const rowsOf = async (a: ReturnType<typeof app>, q = ''): Promise<QueueRow[]> => (await get(a, q)).body.rows;
const mark = (a: ReturnType<typeof app>, key: string, body: Record<string, unknown>) => request(a).post(`/api/whatsapp/queue/${camps[key]}`).set('Cookie', adminCookie).send(body);
const keyOf = (r: { id: string; lastSentAt: Date }) => pushKey(r);
const find = (rows: QueueRow[], key: string) => rows.filter((r) => r.campaignId === camps[key]);

beforeAll(async () => {
  admin = await makeUser('ADMIN');
  adminCookie = await cookieFor(admin);

  // ---- BEFORE the switch time (10:00): today's rule for good
  await seed('preArt', { url: art('pre-article'), at: ist(8, 0), title: 'Pre-time article' });
  await seed('preClone', { url: art('pre-article'), at: ist(9, 0), title: 'Pre-time article' }); // a backfill clone, still before the time
  await seed('preCourse', { url: course('pre-course'), at: ist(8, 30), title: 'Pre-time course' });
  await seed('preShop', { url: product('pre-shop'), at: ist(9, 0), title: 'Pre-time product' });
  // ---- AFTER the switch time
  await seed('art1', { url: art('both-times'), at: ist(11, 0), title: 'Article pushed twice' });
  await seed('art1b', { url: art('both-times'), at: ist(15, 0), title: 'Article pushed twice' }); // a backfill clone of art1
  await seed('courseA', { url: course('forensic'), at: ist(12, 0), title: '🔥 Reconcile Right. Report Accurately. Stay GST Ready!', body: 'Join our live batch.\nSeats are limited.' });
  await seed('courseA2', { url: course('forensic'), at: ist(16, 0), title: '🔥 Reconcile Right. Report Accurately. Stay GST Ready!', body: 'Join our live batch.\nSeats are limited.' }); // same course, same wording
  await seed('shop1', { url: product('zero-to-ai'), at: ist(13, 0), title: '📘  Zero to AI (2026) | COD AVAILABLE', body: 'Cash on delivery is available.' });
  await seed('preArtRepeat', { url: art('pre-article'), at: ist(14, 0), title: 'Pre-time article' }); // the pre-time article repeated AFTER the time
  // not eligible under either rule
  await seed('acadAbout', { url: 'https://academy.taxscan.in/about', at: ist(12, 30) });
  await seed('shopCollection', { url: 'https://shop.taxscan.in/collections/all', at: ist(12, 40) });
  await seed('home', { url: 'https://www.taxscan.in/', at: ist(12, 50) });
  await seed('section', { url: 'https://www.taxscan.in/income-tax', at: ist(12, 55) });
  await seed('testOnly', { url: art('test-only'), at: ist(13, 5), target: { type: 'topics', topics: [env.testSegmentTopic] } });
  await seed('draft', { url: art('a-draft'), at: ist(13, 6), status: 'DRAFT' });
  // a push at 23:59 IST, and one the next morning
  await seed('lateArt', { url: art('late'), at: ist(23, 59), title: 'Pushed at 23:59' });
  await seed('nextDay', { url: art('next-day'), at: ist(0, 5, 1), title: 'Pushed the next morning' });
  // the pre-time article's own mark (today's rule), intact
  await prisma.whatsAppPost.create({ data: { portal: PORTAL, articleKey: articleKey({ id: camps.preArt, url: art('pre-article') } as never), campaignId: camps.preArt, status: 'POSTED', actedByUserId: admin.id, actedAt: ist(9, 30) } });
});

afterAll(async () => {
  await prisma.whatsAppPost.deleteMany({ where: { portal: PORTAL } });
  await prisma.campaign.deleteMany({ where: { OR: [{ portal: PORTAL }, { url: { contains: RUN } }] } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('1. variable unset or invalid: today’s queue exactly', () => {
  it('no new-rule row: no course, product or repeat; no `kind`/`rule` field on any row', async () => {
    const rows = await rowsOf(app(null));
    const ids = rows.map((r) => r.campaignId);
    for (const k of ['preCourse', 'preShop', 'courseA', 'courseA2', 'shop1', 'art1b', 'preArtRepeat']) expect(ids).not.toContain(camps[k]);
    expect(ids).toEqual(expect.arrayContaining([camps.preArt, camps.art1, camps.lateArt]));
    for (const r of rows) expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['kind']));
    expect(rows.every((r) => r.rule === undefined)).toBe(true);
    // article rows are grouped, with "pushed again"
    expect(find(rows, 'art1')[0].pushedAgainTime).toBe('15:00');
    expect(find(rows, 'preArt')[0]).toMatchObject({ status: 'POSTED', pushedAgainTime: '14:00' });
  });

  it('the route with no injected time behaves as unset (reads env, which is unset here)', async () => {
    expect(env.whatsapp.allPushesFrom).toBeNull();
    const a = await rowsOf(app());
    // `app()` passes FROM; build one with no option at all to hit env
    const bare = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, whatsapp: { enabled: () => true, clock: () => NOW, portal: () => PORTAL } });
    const b = await rowsOf(bare);
    expect(JSON.stringify(b)).toBe(JSON.stringify(await rowsOf(app(null))));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('invalid values leave it off, and the boot line says why without printing the value', () => {
    for (const bad of ['04/11/2026', 'tomorrow', '2026', 'x'.repeat(5)]) {
      expect(parseAllPushesFrom({ [WHATSAPP_ALL_PUSHES_FROM_VAR]: bad }, WHATSAPP_ALL_PUSHES_FROM_VAR)).toEqual({ at: null, off: `${WHATSAPP_ALL_PUSHES_FROM_VAR} is not a valid ISO time` });
    }
    expect(parseAllPushesFrom({}, WHATSAPP_ALL_PUSHES_FROM_VAR).off).toBe(`${WHATSAPP_ALL_PUSHES_FROM_VAR} is not set`);
    expect(parseAllPushesFrom({ [WHATSAPP_ALL_PUSHES_FROM_VAR]: '2026-11-05T10:00:00Z' }, WHATSAPP_ALL_PUSHES_FROM_VAR).at?.toISOString()).toBe('2026-11-05T10:00:00.000Z');
    const saved = env.whatsapp.queueEnabled;
    env.whatsapp.queueEnabled = true;
    logs.length = 0;
    try {
      logWhatsAppAllPushes();
    } finally {
      env.whatsapp.queueEnabled = saved;
    }
    expect(logs.join('\n')).toMatch(/\[whatsapp\] all pushes off: WHATSAPP_ALL_PUSHES_FROM is not set \(today's rule: one row per article\)/);
  });

  it('the boot line says "on" with the time when set, and prints nothing while the queue is off', () => {
    const saved = { q: env.whatsapp.queueEnabled, at: env.whatsapp.allPushesFrom };
    env.whatsapp.queueEnabled = true;
    env.whatsapp.allPushesFrom = FROM;
    logs.length = 0;
    try {
      logWhatsAppAllPushes();
      expect(logs.join('\n')).toBe(`[whatsapp] all pushes on for WHATSAPP_ALL_PUSHES_FROM (from ${FROM.toISOString()})`);
      env.whatsapp.queueEnabled = false;
      logs.length = 0;
      logWhatsAppAllPushes();
      expect(logs).toEqual([]);
    } finally {
      Object.assign(env.whatsapp, { queueEnabled: saved.q, allPushesFrom: saved.at });
    }
  });
});

describe('2. no flood at switch-on', () => {
  it('pre-time articles, clones, courses and products make no new row; the pre-time article keeps its row and mark', async () => {
    const rows = await rowsOf(app());
    const ids = rows.map((r) => r.campaignId);
    for (const k of ['preCourse', 'preShop', 'preClone']) expect(ids).not.toContain(camps[k]);
    const pre = find(rows, 'preArt');
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatchObject({ status: 'POSTED', actedBy: { email: admin.email }, pushedTime: '08:00', pushedAgainTime: '09:00' }); // only the PRE-time clone counts as "pushed again"
    expect(pre[0].rule).toBeUndefined();
  });
});

describe('3–6. what gets a row after the time', () => {
  it('3. the same article pushed twice gives two rows; the same course twice gives two; a clone of a posted article is a new row', async () => {
    const rows = await rowsOf(app());
    expect(find(rows, 'art1')).toHaveLength(1);
    expect(find(rows, 'art1b')).toHaveLength(1);
    expect(find(rows, 'art1')[0]).toMatchObject({ rule: 'push', kind: 'article', pushedTime: '11:00', pushedAgainTime: null });
    expect(find(rows, 'art1b')[0]).toMatchObject({ rule: 'push', kind: 'article', pushedTime: '15:00' });
    expect(find(rows, 'courseA')[0]).toMatchObject({ rule: 'push', kind: 'course', pushedTime: '12:00' });
    expect(find(rows, 'courseA2')[0]).toMatchObject({ rule: 'push', kind: 'course', pushedTime: '16:00' });
    expect(find(rows, 'courseA')[0].articleKey).not.toBe(find(rows, 'courseA2')[0].articleKey);
    expect(find(rows, 'art1')[0].articleKey).toBe(`push:${camps.art1}:${ist(11, 0).getTime()}`);
  });

  it('4. an article first pushed before the time and repeated after it: one new row for the repeat, the old row and mark untouched', async () => {
    const rows = await rowsOf(app());
    expect(find(rows, 'preArtRepeat')).toHaveLength(1);
    expect(find(rows, 'preArtRepeat')[0]).toMatchObject({ rule: 'push', kind: 'article', status: 'TODO', pushedTime: '14:00' });
    expect(find(rows, 'preArt')[0]).toMatchObject({ status: 'POSTED', pushedAgainTime: '09:00' });
  });

  it('5. a shop product and an academy course each get one row with the right text and link', async () => {
    const rows = await rowsOf(app());
    const shop = find(rows, 'shop1');
    expect(shop).toHaveLength(1);
    expect(shop[0]).toMatchObject({ kind: 'product', headline: '📘  Zero to AI (2026) | COD AVAILABLE' });
    expect(shop[0].text).toBe(`*📘 Zero to AI (2026) | COD AVAILABLE*\n\nCash on delivery is available.\n\n${product('zero-to-ai')}?utm_source=taxscan-whatsapp&utm_medium=social&utm_campaign=whatsapp-channel&utm_content=zero-to-ai-${RUN}-wa`);
    const c = find(rows, 'courseA');
    expect(c).toHaveLength(1);
    expect(c[0].text.startsWith('*🔥 Reconcile Right. Report Accurately. Stay GST Ready!*\n\nJoin our live batch. Seats are limited.\n\n')).toBe(true);
    expect(c[0].text).toContain(`${course('forensic')}?utm_source=taxscan-whatsapp`);
  });

  it('6. a non-course academy page, a shop collection, a home page, a section page, a draft and a test-segment-only push make no row', async () => {
    const ids = (await rowsOf(app())).map((r) => r.campaignId);
    for (const k of ['acadAbout', 'shopCollection', 'home', 'section', 'testOnly', 'draft']) expect(ids).not.toContain(camps[k]);
  });
});

describe('7–8. the post text', () => {
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

  it('7. each link carries exactly one set of UTMs, the push’s own gone', async () => {
    const own = `https://academy.taxscan.in/course/own-utms-${RUN}?utm_source=taxscan-push&utm_medium=push&utm_campaign=x&utm_content=y&keep=1`;
    const text = buildPushPostText({ id: 'c1', title: 'A course', body: 'Body', url: own })!;
    const link = text.split('\n\n').pop()!;
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) expect(count(link, new RegExp(`${k}=`, 'g'))).toBe(1);
    expect(new URL(link).searchParams.get('utm_source')).toBe('taxscan-whatsapp');
    expect(new URL(link).searchParams.get('utm_medium')).toBe('social');
    expect(new URL(link).searchParams.get('utm_campaign')).toBe('whatsapp-channel');
    expect(new URL(link).searchParams.get('utm_content')).toBe(`own-utms-${RUN}`);
    expect(new URL(link).searchParams.get('keep')).toBe('1');
    expect(link).not.toContain('taxscan-push');
    // an article keeps today's id|slug content
    const a = buildPushPostText({ id: 'c2', title: 'T', body: 'B', url: `https://www.taxscan.in/gst/some-slug-${RUN}-wa?utm_source=taxscan-push` })!;
    expect(new URL(a.split('\n\n').pop()!).searchParams.get('utm_source')).toBe('taxscan-whatsapp');
    expect(count(a, /utm_source=/g)).toBe(1);
  });

  it('8. emoji, * _ ~ `, line breaks and an over-long body: a correct post, title kept, body cut', () => {
    const t = buildPushPostText({
      id: 'c3',
      title: '📘 *Zero* to _AI_ ~2026~ `COD` 🔥',
      body: `${'Line one with *stars* and _under_.\n'.repeat(3)}${'word '.repeat(80)}`,
      url: course('formatting'),
    })!;
    const [head, line, link] = t.split('\n\n');
    expect(head).toBe('*📘 Zero to AI 2026 COD 🔥*');
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toContain('\n');
    expect(link.startsWith(course('formatting'))).toBe(true);
    expect(t.split('\n\n')).toHaveLength(3);
  });

  it('an empty body, or a body equal to the title, adds no paragraph; an off-allowlist link gives no post; another allowed page has a course-shaped post', () => {
    expect(buildPushPostText({ id: 'c4', title: 'Only a title', body: '', url: product('only-title') })!.split('\n\n')).toHaveLength(2);
    expect(buildPushPostText({ id: 'c5', title: 'Same words', body: 'same  words', url: product('same-words') })!.split('\n\n')).toHaveLength(2);
    expect(buildPushPostText({ id: 'c6', title: 'T', body: 'B', url: 'https://evil.example/course/x' })).toBeNull();
    expect(buildPushPostText({ id: 'c7', title: 'T', body: 'B', url: 'https://evil.example/collections/all' })).toBeNull();
    // Any OTHER allowed page (brief 2026-11-07-social-every-link) has the same shape as a course's post. Whether a push to it is listed at all
    // is decided by `isAllPushesCampaign` and SOCIAL_ANY_LINK_FROM, never here (socialEveryLink.test.ts).
    const page = buildPushPostText({ id: 'c7', title: 'T', body: 'B', url: 'https://shop.taxscan.in/collections/all' })!;
    expect(page.split('\n\n').slice(0, 2)).toEqual(['*T*', 'B']);
    expect(page.split('\n\n')[2]).toContain('utm_content=collections-all');
    // an article is exactly today's post
    const a = buildPushPostText({ id: 'c8', title: 'Headline', body: 'Short line', url: art('exact') })!;
    expect(a.split('\n\n')[0]).toBe('*Headline*');
  });
});

describe('9. marks', () => {
  it('Posted, Skip and undo on one repeat leave the other untouched; a double press leaves one row', async () => {
    const a = app();
    const rows = await rowsOf(a);
    const k1 = find(rows, 'art1')[0].articleKey;
    const k2 = find(rows, 'art1b')[0].articleKey;
    expect((await mark(a, 'art1', { status: 'POSTED', articleKey: k1 })).status).toBe(200);
    expect((await mark(a, 'art1', { status: 'POSTED', articleKey: k1 })).status).toBe(200); // double press
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL, articleKey: k1 } })).toBe(1);
    let after = await rowsOf(a);
    expect(find(after, 'art1')[0]).toMatchObject({ status: 'POSTED', actedBy: { email: admin.email } });
    expect(find(after, 'art1b')[0].status).toBe('TODO');
    expect((await mark(a, 'art1b', { status: 'SKIPPED', articleKey: k2 })).status).toBe(200);
    after = await rowsOf(a);
    expect(find(after, 'art1')[0].status).toBe('POSTED');
    expect(find(after, 'art1b')[0].status).toBe('SKIPPED');
    // undo one, the other stays
    expect((await mark(a, 'art1', { status: 'TODO', articleKey: k1 })).status).toBe(200);
    after = await rowsOf(a);
    expect(find(after, 'art1')[0].status).toBe('TODO');
    expect(find(after, 'art1b')[0].status).toBe('SKIPPED');
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL, articleKey: k1 } })).toBe(0);
    // a course repeat is its own mark too
    const ck = find(after, 'courseA')[0].articleKey;
    expect((await mark(a, 'courseA', { status: 'POSTED', articleKey: ck })).status).toBe(200);
    after = await rowsOf(a);
    expect(find(after, 'courseA')[0].status).toBe('POSTED');
    expect(find(after, 'courseA2')[0].status).toBe('TODO');
  });

  it('marking without the key marks that push under its own key; a pre-time article keeps today’s mark', async () => {
    const a = app();
    expect((await mark(a, 'shop1', { status: 'POSTED' })).status).toBe(200);
    const row = find(await rowsOf(a), 'shop1')[0];
    expect(row.status).toBe('POSTED');
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL, articleKey: row.articleKey } })).toBe(1);
    // the pre-time article: today's rule, per ARTICLE (the pre-time clone shares it)
    expect((await mark(a, 'preClone', { status: 'SKIPPED' })).status).toBe(200);
    expect(find(await rowsOf(a), 'preArt')[0].status).toBe('SKIPPED');
    expect(find(await rowsOf(a), 'preArtRepeat')[0].status).toBe('TODO'); // the repeat after the time is its own row
  });

  it('a campaign that is eligible under neither rule, a wrong key, or a key on an old-rule push gives not_found', async () => {
    const a = app();
    for (const k of ['acadAbout', 'shopCollection', 'home', 'section', 'testOnly', 'draft', 'preCourse', 'preShop']) {
      expect((await mark(a, k, { status: 'POSTED' })).body).toEqual({ error: 'not_found' });
    }
    expect((await mark(a, 'art1', { status: 'POSTED', articleKey: `push:${camps.art1}:1` })).status).toBe(404);
    expect((await mark(a, 'preArt', { status: 'POSTED', articleKey: `push:${camps.preArt}:${ist(8, 0).getTime()}` })).status).toBe(404);
    expect((await mark(a, 'art1', { status: 'POSTED', articleKey: 'not-a-key' })).status).toBe(400);
    expect((await request(a).post('/api/whatsapp/queue/does-not-exist').set('Cookie', adminCookie).send({ status: 'POSTED' })).status).toBe(404);
  });
});

describe('10. days', () => {
  it('a row stays on its push’s IST day across midnight, and the 14-day limit holds', async () => {
    const tomorrow = app(FROM, ist(9, 0, 1)); // 3 Nov 09:00 IST: both days are readable
    const d2 = await rowsOf(tomorrow, '?date=2026-11-02');
    const d3 = await rowsOf(tomorrow, '?date=2026-11-03');
    expect(find(d2, 'lateArt')[0]).toMatchObject({ pushedTime: '23:59', rule: 'push' });
    expect(find(d3, 'lateArt')).toHaveLength(0);
    expect(find(d3, 'nextDay')[0]).toMatchObject({ pushedTime: '00:05', rule: 'push' });
    expect(find(d2, 'nextDay')).toHaveLength(0);
    // a repeat pushed on a later day is on THAT day, not the first push's
    await seed('midnightRepeat', { url: art('late'), at: ist(0, 30, 1), title: 'Pushed at 23:59' });
    const d3b = await rowsOf(tomorrow, '?date=2026-11-03');
    expect(find(d3b, 'midnightRepeat')).toHaveLength(1);
    expect(find(await rowsOf(tomorrow, '?date=2026-11-02'), 'midnightRepeat')).toHaveLength(0);
    const tooOld = istDay(new Date(ist(9, 0, 1).getTime() - 15 * 24 * 60 * 60_000));
    const res = await get(tomorrow, `?date=${tooOld}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_date');
  });
});

describe('11. nudge', () => {
  // The nudge's own tick keeps a shared watermark row (NUDGE_KEY) that whatsappNudge.test.ts also uses, so it is not run from here; its tests
  // are unchanged. What the nudge counts is `getQueue`'s TODO rows of today (+ the night before), so that is what this checks, and the title.
  it('`waiting=` matches the screen’s Todo count with the switch on, and the title says "posts" once a course or product is waiting', async () => {
    const a = app();
    const today = await rowsOf(a);
    const yesterday = await rowsOf(a, '?date=2026-11-01');
    const nightStart = ist(0, 0).getTime() - 60 * 60_000;
    const waiting = [...yesterday.filter((r) => Date.parse(r.pushedAt) >= nightStart), ...today].filter((r) => r.status === 'TODO');
    const counts = (await get(a)).body.counts;
    expect(waiting.length).toBe(counts.todo);
    expect(waiting.some((r) => r.kind === 'course')).toBe(true);
    expect(nudgeTitle(waiting)).toBe(`WhatsApp: ${counts.todo} posts waiting`);
    // brief 2026-11-09-small-fixes: every push is a row, so the title counts POSTS whatever the kinds (it used to say "articles" while only articles waited)
    expect(nudgeTitle([{}, {}])).toBe('WhatsApp: 2 posts waiting');
    expect(nudgeTitle([{ kind: 'article' }])).toBe('WhatsApp: 1 post waiting');
    expect(nudgeTitle([{ kind: 'article' }, { kind: 'product' }])).toBe('WhatsApp: 2 posts waiting');
    expect(nudgeTitle([{ kind: 'article' }, { kind: 'article' }, { kind: 'article' }])).toBe('WhatsApp: 3 posts waiting');
    expect(nudgeTitle([{ kind: 'course' }, { kind: 'product' }, { kind: 'page' }])).toBe('WhatsApp: 3 posts waiting');
  });
});

describe('12. Campaigns Channels', () => {
  const saved = { q: env.whatsapp.queueEnabled, at: env.whatsapp.allPushesFrom };
  const WA_PORTAL = env.rss.portal;
  const wurl = (slug: string) => `https://www.taxscan.in/gst/${slug}-${RUN}-ch`;
  const ids: Record<string, string> = {};
  const ch = async (k: string) => (await listCampaigns(600)).find((r) => r.id === ids[k]);

  beforeAll(async () => {
    const at = new Date(Date.now() - 3 * 3600_000);
    const mk = async (k: string, url: string, when: Date, title = `Chan ${k}`) => {
      ids[k] = (await prisma.campaign.create({ data: { portal: WA_PORTAL, title, body: 'b', url, target: {}, status: 'SENT', lastSentAt: when } as never })).id;
    };
    await mk('old', wurl('old'), new Date(at.getTime() - 5 * 3600_000));
    await mk('repeatA', wurl('rep'), new Date(at.getTime() + 1000));
    await mk('repeatB', wurl('rep'), new Date(at.getTime() + 2000));
    await mk('course', `https://academy.taxscan.in/course/chan-${RUN}-ch`, new Date(at.getTime() + 3000));
    env.whatsapp.queueEnabled = true;
  });
  afterAll(async () => {
    Object.assign(env.whatsapp, { queueEnabled: saved.q, allPushesFrom: saved.at });
    await prisma.whatsAppPost.deleteMany({ where: { campaignId: { in: Object.values(ids) } } });
  });

  it('with the switch off the output is today’s: an article is TODO by its article key, a course has no mark', async () => {
    env.whatsapp.allPushesFrom = null;
    const before = JSON.stringify([await ch('old'), await ch('repeatA'), await ch('repeatB'), await ch('course')].map((r) => r?.channels));
    expect((await ch('repeatA'))?.channels?.whatsapp).toBe('TODO');
    expect((await ch('course'))?.channels?.whatsapp).toBeNull();
    // an article-key mark is shared by the article's pushes
    await prisma.whatsAppPost.create({ data: { portal: WA_PORTAL, articleKey: articleKey({ id: ids.repeatA, url: wurl('rep') } as never), campaignId: ids.repeatA, status: 'POSTED', actedAt: new Date() } });
    expect((await ch('repeatB'))?.channels?.whatsapp).toBe('POSTED');
    await prisma.whatsAppPost.deleteMany({ where: { campaignId: ids.repeatA } });
    expect(JSON.stringify([await ch('old'), await ch('repeatA'), await ch('repeatB'), await ch('course')].map((r) => r?.channels))).toBe(before);
  });

  it('with the switch on a new-rule push shows the status of its OWN row; a course gets one; the pre-time article keeps today’s', async () => {
    const at = (await prisma.campaign.findUniqueOrThrow({ where: { id: ids.repeatA } })).lastSentAt!;
    env.whatsapp.allPushesFrom = new Date(at.getTime() - 1000); // repeatA/B and the course are new-rule; `old` is before
    const rowA = { id: ids.repeatA, lastSentAt: at };
    await prisma.whatsAppPost.create({ data: { portal: WA_PORTAL, articleKey: keyOf(rowA), campaignId: ids.repeatA, status: 'POSTED', actedAt: new Date() } });
    expect((await ch('repeatA'))?.channels?.whatsapp).toBe('POSTED');
    expect((await ch('repeatB'))?.channels?.whatsapp).toBe('TODO'); // its own row, not shared
    expect((await ch('course'))?.channels?.whatsapp).toBe('TODO');
    expect((await ch('old'))?.channels?.whatsapp).toBe('TODO'); // today's rule
    await prisma.whatsAppPost.deleteMany({ where: { campaignId: ids.repeatA } });
  });
});

describe('removing or moving the time never re-lists what was handled', () => {
  it('a push marked under the new rule still shows its mark under today’s rule, and undo clears it', async () => {
    const a = app();
    const rows = await rowsOf(a);
    const k = find(rows, 'preArtRepeat')[0].articleKey; // pushed 14:00, after FROM
    expect((await mark(a, 'preArtRepeat', { status: 'POSTED', articleKey: k })).status).toBe(200);
    // the time is moved past that push: it is now today's rule, grouped with its article (whose OWN mark is SKIPPED from the test above, or POSTED)
    const later = ist(23, 0);
    const removed = await getQueue(PORTAL, '2026-11-02', { allPushesFrom: null });
    const row = removed.rows.find((r) => r.campaignId === camps.preArt)!;
    expect(row.status).not.toBe('TODO');
    // an article that has ONLY a push-key mark (no mark of its own): art1b
    const rows2 = await rowsOf(a);
    const k2 = find(rows2, 'art1b')[0].articleKey;
    await prisma.whatsAppPost.deleteMany({ where: { portal: PORTAL, campaignId: { in: [camps.art1, camps.art1b] } } });
    expect((await mark(a, 'art1b', { status: 'POSTED', articleKey: k2 })).status).toBe(200);
    const off = await getQueue(PORTAL, '2026-11-02', { allPushesFrom: null });
    expect(off.rows.find((r) => r.campaignId === camps.art1)).toMatchObject({ status: 'POSTED' }); // not "waiting" again
    expect(off.counts.todo).toBe(off.rows.filter((r) => r.status === 'TODO').length);
    void later;
    // undo on today's-rule row clears the handed-back mark too
    const offApp = app(null);
    expect((await mark(offApp, 'art1', { status: 'TODO' })).status).toBe(200);
    const cleared = await getQueue(PORTAL, '2026-11-02', { allPushesFrom: null });
    expect(cleared.rows.find((r) => r.campaignId === camps.art1)).toMatchObject({ status: 'TODO' });
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL, articleKey: k2 } })).toBe(0);
  });
});

describe('13. read paths', () => {
  it('the queue reads Campaign and WhatsAppPost only (never Event)', async () => {
    const ev = jest.spyOn(prisma.event, 'findMany');
    const evc = jest.spyOn(prisma.event, 'count');
    try {
      await rowsOf(app());
      expect(ev).not.toHaveBeenCalled();
      expect(evc).not.toHaveBeenCalled();
    } finally {
      ev.mockRestore();
      evc.mockRestore();
    }
  });
});
