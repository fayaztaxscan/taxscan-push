import bcrypt from 'bcrypt';
import cron from 'node-cron';
import request from 'supertest';
import { inspect } from 'node:util';
import type { Prisma, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { listCampaigns } from '../services/metrics';
import { activeSocialPages } from '../services/social/pages';
import { socialImageUrl } from '../services/social/picture';
import { pushKey } from '../services/social/allPushes';
import type { TelegramRequest, TelegramResult } from '../services/telegram/client';
import { alertKey, channelStop, MAX_PER_TICK, resumeChannel, retryNow, runTelegramTick, startTelegramWorker, stopKey, UNKNOWN_ERROR, type WorkerDeps } from '../services/telegram/worker';

/**
 * Brief 2026-11-09-telegram-channel, acceptance 1-8 against Postgres. Telegram is a fake: the worker's `call` is injected, and the global
 * `fetch` is a trap that fails the suite if anything reaches api.telegram.org. Rows live under a unique `test-tg-*` portal mapped to a
 * private page, so the real `taxscan` channel state is never touched.
 */
const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
const realFetch = global.fetch;
const trap = jest.fn(() => {
  throw new Error('a test reached the network');
});

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL = `test-tg-${RUN}`;
const PAGE = `tgtest${Math.floor(Math.random() * 1e9)}`; // private per run
const TOKEN = '987654321:AAFsecretSECRET-tokenvalue_0123456789xyz';
const CHANNEL = '@taxscan_in';
const PASSWORD = 'tg-worker-test-pw-1';
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 10) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const NOW = ist(10, 0);
const FROM = ist(4, 0);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const COVER = 'https://documents.taxscan.in/uploads/cover.jpg';

const ok = (id = 501): TelegramResult => ({ kind: 'posted', messageId: id });
const bad = (kind: 'rate' | 'transient' | 'stop' | 'failed', status: number, error: string, retryAfterSec: number | null = null): TelegramResult => ({ kind, status, code: status, retryAfterSec, error });

let calls: TelegramRequest[] = [];
let script: (n: number, r: TelegramRequest) => TelegramResult | Promise<TelegramResult> = () => ok();
const call: NonNullable<WorkerDeps['call']> = async (r) => {
  calls.push(r);
  return script(calls.length, r);
};
let mails: { to: string; subject: string; text: string }[] = [];
const cmsWith = (o: { coverImageUrl?: string | null; excerpt?: string | null } = {}) => async () => ({ keywords: [], courts: [], category: null, coverImageUrl: COVER, excerpt: 'An excerpt.', ...o });
const deps = (over: WorkerDeps = {}): WorkerDeps => ({
  now: () => NOW,
  call,
  fetchCms: cmsWith(),
  fetchArticle: async () => ({ image: null }),
  fetchStore: async () => ({ ok: false, reason: 'page_host' }),
  socialPicture: true,
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: PAGE },
  config: { token: TOKEN, channel: CHANNEL, postFrom: FROM },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});

let seq = 0;
async function camp(slug: string, lastSentAt: Date, o: { url?: string; host?: string; status?: 'SENT' | 'DRAFT'; title?: string; body?: string; target?: object; socialSkip?: string[]; socialImageId?: string } = {}) {
  return prisma.campaign.create({
    data: {
      portal: PORTAL,
      title: o.title ?? `Story ${slug}`,
      body: o.body ?? 'push body',
      url: o.url ?? `https://${o.host ?? 'www.taxscan.in'}/gst/${slug}-${RUN}-${++seq}`,
      target: (o.target ?? {}) as Prisma.InputJsonValue,
      status: o.status ?? 'SENT',
      lastSentAt,
      authority: 'Supreme Court',
      categories: ['GST'],
      ...(o.socialSkip ? { socialSkip: o.socialSkip } : {}),
      ...(o.socialImageId ? { socialImageId: o.socialImageId } : {}),
    } as never,
  });
}
const rowsOf = () => prisma.telegramPost.findMany({ where: { page: PAGE }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const sentTo = (n = 0) => calls[n]!.body as Record<string, unknown>;
const tick = (over: WorkerDeps = {}) => runTelegramTick(deps(over));
async function ticks(n: number, start: Date, over: WorkerDeps = {}) {
  for (let i = 0; i < n; i += 1) await runTelegramTick(deps({ now: () => at(start, i), ...over }));
}
const hrefOf = (html: string): string => (/<a href="([^"]+)">/.exec(html)?.[1] ?? '').replace(/&amp;/g, '&');

const userIds: string[] = [];
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `tg-${role.toLowerCase()}-${RUN}-${++seq}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
const replies: string[] = []; // every API reply body, for the token scan
const appWith = (over: WorkerDeps = {}, fetchImpl?: typeof fetch) =>
  createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, telegram: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGE }), worker: deps(over), ...(fetchImpl ? { fetch: fetchImpl } : {}) } });
const api = async (app: ReturnType<typeof appWith>, method: 'get' | 'post', url: string, cookie?: string) => {
  const r = await request(app)[method](url).set('Cookie', cookie ?? '');
  replies.push(JSON.stringify(r.body));
  return r;
};

const IMAGE_ID = 'a'.repeat(63) + '1';
const savedTelegram = { ...env.telegram };
const savedAnyLink = env.social.anyLinkFrom;
const cleanState = async () => {
  await prisma.telegramPost.deleteMany({ where: { page: PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [stopKey(PAGE), alertKey(PAGE)] } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
};
beforeAll(async () => {
  global.fetch = trap as unknown as typeof fetch;
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
  await prisma.socialImage.upsert({ where: { id: IMAGE_ID }, update: {}, create: { id: IMAGE_ID, mime: 'image/jpeg', width: 1080, height: 1080, size: 4, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } });
});
beforeEach(async () => {
  calls = [];
  mails = [];
  script = () => ok();
  Object.assign(env.telegram, savedTelegram);
  env.social.anyLinkFrom = savedAnyLink;
  await cleanState();
  logSpy.mockClear();
  warnSpy.mockClear();
  errSpy.mockClear();
});
afterAll(async () => {
  global.fetch = realFetch;
  Object.assign(env.telegram, savedTelegram);
  env.social.anyLinkFrom = savedAnyLink;
  await cleanState();
  await prisma.socialImage.deleteMany({ where: { id: IMAGE_ID } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  expect(trap).not.toHaveBeenCalled();
  await prisma.$disconnect();
});

describe('1. off unless all four variables are valid: one boot line, no rows, nothing else changes', () => {
  it('the flag off → "disabled", no cron; flag on with a missing or invalid variable → one line naming it, no cron, no refusal to start', () => {
    const schedule = jest.spyOn(cron, 'schedule').mockImplementation((() => ({ stop: () => undefined })) as never);
    try {
      Object.assign(env.telegram, { enabled: false, config: null, off: 'TELEGRAM_POSTING_ENABLED is not true' });
      startTelegramWorker();
      Object.assign(env.telegram, { enabled: true, config: null, off: 'TELEGRAM_BOT_TOKEN is not set; TELEGRAM_POST_FROM is not a valid ISO time' });
      expect(() => startTelegramWorker()).not.toThrow();
      expect(schedule).not.toHaveBeenCalled();
      const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[telegram]'));
      expect(lines).toEqual(['[telegram] disabled (set TELEGRAM_POSTING_ENABLED=true to start)', '[telegram] not active, no posts: TELEGRAM_BOT_TOKEN is not set; TELEGRAM_POST_FROM is not a valid ISO time']);
      expect(errSpy).not.toHaveBeenCalled();
      Object.assign(env.telegram, { enabled: true, config: { token: TOKEN, channel: CHANNEL, postFrom: FROM }, off: null });
      startTelegramWorker();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule.mock.calls[0]![0]).toBe('* * * * *');
      expect(logSpy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith('[telegram] worker started'))).toBe(true);
    } finally {
      schedule.mockRestore();
    }
  });

  it('a tick with no configuration makes no row and no call, however many pushes wait', async () => {
    await camp('a', at(NOW, -10));
    const r = await tick({ config: null });
    expect(r.refused).toMatch(/not configured/);
    expect(calls).toHaveLength(0);
    expect(await rowsOf()).toHaveLength(0);
  });

  it('while off: the API answers 404 (before auth), the menu switch is false, Post-to has no Telegram, Campaigns carry no Telegram mark', async () => {
    Object.assign(env.telegram, { enabled: false, config: null });
    const off = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } }); // the real gate: telegramActive()
    expect((await request(off).get('/api/telegram/posts')).status).toBe(404);
    expect((await request(off).post('/api/telegram/resume')).status).toBe(404);
    const me = await request(off).get('/api/auth/me').set('Cookie', adminCookie);
    expect(me.body.features.telegramPosting).toBe(false);
    expect(activeSocialPages().some((p) => p.key.startsWith('telegram:'))).toBe(false);
    const c = await camp('mark', at(NOW, -5), { url: `https://www.taxscan.in/gst/mark-off-${RUN}` });
    const row = (await listCampaigns(600)).find((x) => x.id === c.id);
    expect(row?.channels === undefined || !('telegram' in (row.channels as object))).toBe(true);
  });

  it('a flag that is on but incomplete is off everywhere too (all four are needed)', async () => {
    Object.assign(env.telegram, { enabled: true, config: null, off: 'TELEGRAM_CHANNEL is not set' });
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
    expect((await request(app).get('/api/telegram/posts').set('Cookie', adminCookie)).status).toBe(404);
    expect(activeSocialPages().some((p) => p.key.startsWith('telegram:'))).toBe(false);
  });
});

describe('2. what posts: every push, one post per push', () => {
  it('an article push → ONE sendPhoto to the channel with the escaped caption, the cover picture and the tagged link', async () => {
    const c = await camp('art', at(NOW, -20), { title: 'SC: "Section 16" & <ITC>', url: `https://www.taxscan.in/gst/some-article-${RUN}-777001` });
    await ticks(3, NOW, { fetchCms: cmsWith({ excerpt: 'Held: A & B <i>not</i> "C"' }) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendPhoto');
    expect(calls[0]!.token).toBe(TOKEN);
    const b = sentTo();
    expect(b.chat_id).toBe(CHANNEL);
    expect(b.photo).toBe(COVER);
    expect(b.parse_mode).toBe('HTML');
    expect(b.caption).toContain('<b>SC: &quot;Section 16&quot; &amp; &lt;ITC&gt;</b>');
    expect(b.caption).toContain('Held: A &amp; B &lt;i&gt;not&lt;/i&gt; &quot;C&quot;');
    const link = new URL(hrefOf(String(b.caption)));
    expect(link.origin + link.pathname).toBe(`https://www.taxscan.in/gst/some-article-${RUN}-777001`);
    expect(Object.fromEntries([...link.searchParams])).toEqual({ utm_source: 'taxscan-telegram', utm_medium: 'social', utm_campaign: 'telegram-channel', utm_content: `some-article-${RUN}-777001`.match(/(\d+)$/)![1] });
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ campaignId: c.id, status: 'POSTED', messageId: 501, attempts: 1, error: null, pushKey: pushKey({ id: c.id, lastSentAt: c.lastSentAt! }) });
    expect(logSpy.mock.calls.map((x) => String(x[0]))).toContain(`[telegram] page=${PAGE} campaign=${c.id} outcome=posted image=ok kind=article`);
  });

  it('a course, a product and (with SOCIAL_ANY_LINK_FROM) a site-page push each post; the page push does not before that time', async () => {
    const course = await camp('course', at(NOW, -30), { url: `https://academy.taxscan.in/course/gst-${RUN}`, body: 'Learn GST in 10 days' });
    const product = await camp('product', at(NOW, -29), { url: `https://shop.taxscan.in/products/ebook-${RUN}`, body: 'An e-book' });
    const pricing = await camp('pricing', at(NOW, -28), { url: 'https://www.taxscan.in/pricing', body: 'Plans' });
    env.social.anyLinkFrom = null;
    await ticks(3, NOW);
    expect(calls).toHaveLength(2); // course + product; the pricing page is not covered yet
    env.social.anyLinkFrom = at(NOW, -60);
    await ticks(2, at(NOW, 3));
    expect(calls).toHaveLength(3);
    const texts = calls.map((c) => String((c.body as { text?: string; caption?: string }).text ?? (c.body as { caption?: string }).caption));
    expect(texts[0]).toContain('Learn GST in 10 days');
    expect(texts[2]).toContain('Plans');
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage', 'sendMessage']); // no picture anywhere in this test
    expect((await rowsOf()).map((r) => r.campaignId)).toEqual([course.id, product.id, pricing.id]);
    const utm = (i: number) => new URL(hrefOf(texts[i]!)).searchParams.get('utm_content');
    expect([utm(0), utm(1), utm(2)]).toEqual([`gst-${RUN}`, `ebook-${RUN}`, 'pricing']);
  });

  it('an exact repeat posts again: two pushes of the same URL are two rows and two posts', async () => {
    const url = `https://www.taxscan.in/gst/again-${RUN}-777002`;
    const a = await camp('first', at(NOW, -40), { url });
    const b = await camp('second', at(NOW, -10), { url });
    await ticks(3, NOW);
    expect(calls).toHaveLength(2);
    const rows = await rowsOf();
    expect(rows.map((r) => r.campaignId)).toEqual([a.id, b.id]);
    expect(new Set(rows.map((r) => r.pushKey)).size).toBe(2);
    // and the same push is never posted twice, however many ticks run
    await ticks(5, at(NOW, 5));
    expect(calls).toHaveLength(2);
  });

  it('a test-segment-only push, a push before TELEGRAM_POST_FROM, a draft, an off-list host and an unknown page never post', async () => {
    await camp('test-only', at(NOW, -30), { target: { type: 'topics', topics: [env.testSegmentTopic] } });
    await camp('before-golive', at(FROM, -1));
    await camp('draft', at(NOW, -29), { status: 'DRAFT' });
    await camp('offlist', at(NOW, -28), { url: 'https://evil.example.com/gst/x-1' });
    await camp('home-no-switch', at(NOW, -27), { url: 'https://www.taxscan.in/' });
    env.social.anyLinkFrom = null;
    const exactly = await camp('exactly-at-golive', FROM);
    await ticks(6, NOW);
    expect(calls).toHaveLength(1);
    expect((await rowsOf()).map((r) => r.campaignId)).toEqual([exactly.id]);
  });

  it('there is no age limit: an old push after go-live posts, oldest first; a morning-backfill clone or Compose send is just another push', async () => {
    const old = await camp('old', at(NOW, -3 * 24 * 60));
    const newer = await camp('newer', at(NOW, -5));
    await ticks(3, NOW, { config: { token: TOKEN, channel: CHANNEL, postFrom: at(NOW, -5 * 24 * 60) } });
    expect((await rowsOf()).map((r) => r.campaignId)).toEqual([old.id, newer.id]);
  });
});

describe('3. the picture: Compose wins, then the cover, then the page; none = a text post with the preview on', () => {
  it('the Compose picture wins over the cover', async () => {
    await camp('composed', at(NOW, -5), { socialImageId: IMAGE_ID, url: `https://www.taxscan.in/gst/pic-${RUN}-777003` });
    await tick();
    expect(calls[0]!.method).toBe('sendPhoto');
    expect(sentTo().photo).toBe(socialImageUrl({ id: IMAGE_ID, mime: 'image/jpeg' }));
    expect(sentTo().photo).not.toBe(COVER);
  });

  it('with the picture setting off, the cover is used even though the push carries a Compose picture', async () => {
    await camp('composed-off', at(NOW, -5), { socialImageId: IMAGE_ID });
    await tick({ socialPicture: false });
    expect(sentTo().photo).toBe(COVER);
  });

  it('no cover → the article page\'s og:image; a course → its page\'s og:image (https, on an allowed host only)', async () => {
    await camp('art-og', at(NOW, -9), { url: `https://www.taxscan.in/gst/og-${RUN}-777004` });
    await camp('course-og', at(NOW, -8), { url: `https://academy.taxscan.in/course/og-${RUN}` });
    await camp('course-evil', at(NOW, -7), { url: `https://academy.taxscan.in/course/evil-${RUN}` });
    const fetchStore: NonNullable<WorkerDeps['fetchStore']> = async (u) =>
      ({ ok: true, tags: { title: null, description: null, imageUrl: u.includes('evil') ? 'https://evil.example.com/x.jpg' : 'https://academy.taxscan.in/wp-content/uploads/c.png', imageReason: null } }) as never;
    await ticks(4, NOW, { fetchCms: cmsWith({ coverImageUrl: null }), fetchArticle: async () => ({ image: 'https://documents.taxscan.in/og.jpg' }), fetchStore });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendPhoto', 'sendMessage']);
    expect(calls.map((c) => sentTo(calls.indexOf(c)).photo)).toEqual(['https://documents.taxscan.in/og.jpg', 'https://academy.taxscan.in/wp-content/uploads/c.png', undefined]);
  });

  it('a cover on a host that is not allowed is not offered to Telegram', async () => {
    await camp('bad-cover', at(NOW, -5));
    await tick({ fetchCms: cmsWith({ coverImageUrl: 'http://documents.taxscan.in/plain.jpg' }) });
    expect(calls[0]!.method).toBe('sendMessage');
  });

  it('no picture anywhere → sendMessage with the link preview ON (for the tagged link)', async () => {
    await camp('nopic', at(NOW, -5));
    await tick({ fetchCms: cmsWith({ coverImageUrl: null }) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendMessage');
    const b = sentTo();
    expect(b.chat_id).toBe(CHANNEL);
    expect(b.parse_mode).toBe('HTML');
    const lp = b.link_preview_options as { is_disabled: boolean; url: string };
    expect(lp.is_disabled).toBe(false);
    expect(lp.url).toBe(hrefOf(String(b.text)));
    expect(logSpy.mock.calls.map((x) => String(x[0])).some((l) => /outcome=posted image=none/.test(l))).toBe(true);
  });

  it('a photo Telegram refuses with a 400 → ONE fallback to sendMessage, logged image=dropped; the row is POSTED', async () => {
    const c = await camp('refused', at(NOW, -5));
    script = (_n, r) => (r.method === 'sendPhoto' ? bad('failed', 400, 'telegram_400_photo_refused') : ok(902));
    await ticks(3, NOW);
    expect(calls.map((x) => x.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(sentTo(1).link_preview_options).toMatchObject({ is_disabled: false });
    expect(sentTo(1).text).toContain('<b>Story refused</b>');
    const [row] = await rowsOf();
    expect(row).toMatchObject({ status: 'POSTED', messageId: 902, attempts: 1, error: 'image_dropped' });
    expect(logSpy.mock.calls.map((x) => String(x[0]))).toContain(`[telegram] page=${PAGE} campaign=${c.id} outcome=posted image=dropped kind=article`);
  });

  it('a photo refused with a non-400 4xx is NOT retried as text: FAILED; and the fallback that also fails is FAILED with its own code', async () => {
    await camp('r404', at(NOW, -6));
    script = () => bad('failed', 404, 'telegram_404');
    await tick();
    expect(calls).toHaveLength(1);
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: 'telegram_404' });
    calls = [];
    await prisma.telegramPost.deleteMany({ where: { page: PAGE } });
    script = (_n, r) => (r.method === 'sendPhoto' ? bad('failed', 400, 'telegram_400_photo_refused') : bad('failed', 400, 'telegram_400_cannot_parse'));
    await tick();
    expect(calls.map((x) => x.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: 'telegram_400_cannot_parse' });
  });
});

describe('4. Compose "Post to": an unticked channel is a SKIPPED row and no call; the list shows Telegram only when active', () => {
  it('socialSkip: ["telegram:<page>"] → a SKIPPED compose_skip row under the push\'s own key, no call; other pushes still post', async () => {
    const skipped = await camp('skipped', at(NOW, -20), { socialSkip: [`telegram:${PAGE}`] });
    const other = await camp('other', at(NOW, -10));
    const repeatOfSkipped = await camp('repeat', at(NOW, -5), { url: skipped.url });
    await ticks(4, NOW);
    const rows = await rowsOf();
    expect(rows.find((r) => r.campaignId === skipped.id)).toMatchObject({ status: 'SKIPPED', error: 'compose_skip', attempts: 0, pushKey: pushKey({ id: skipped.id, lastSentAt: skipped.lastSentAt! }) });
    expect(rows.find((r) => r.campaignId === other.id)?.status).toBe('POSTED');
    expect(rows.find((r) => r.campaignId === repeatOfSkipped.id)?.status).toBe('POSTED'); // a skip row never blocks another push of the same URL
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !String((c.body as { caption?: string; text?: string }).caption ?? (c.body as { text?: string }).text).includes('Story skipped'))).toBe(true);
    await ticks(3, at(NOW, 9));
    expect((await rowsOf()).filter((r) => r.campaignId === skipped.id)).toHaveLength(1); // written once
  });

  it('a skip for ANOTHER page\'s key does not skip this channel; a push before go-live gets no skip row', async () => {
    const c = await camp('other-key', at(NOW, -9), { socialSkip: ['facebook:taxscan', 'linkedin:taxscan', 'whatsapp'] });
    await camp('old-skip', at(FROM, -30), { socialSkip: [`telegram:${PAGE}`] });
    await ticks(2, NOW);
    const rows = await rowsOf();
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([[c.id, 'POSTED']]);
  });

  it('the Post-to list shows "Telegram · Taxscan" only while the channel is ACTIVE, after the Facebook pages and before WhatsApp', async () => {
    Object.assign(env.telegram, { enabled: false, config: null });
    expect(activeSocialPages().map((p) => p.key)).not.toContain('telegram:taxscan');
    Object.assign(env.telegram, { enabled: true, config: null });
    expect(activeSocialPages().map((p) => p.key)).not.toContain('telegram:taxscan');
    Object.assign(env.telegram, { enabled: true, config: { token: TOKEN, channel: CHANNEL, postFrom: FROM } });
    const pages = activeSocialPages();
    expect(pages).toContainEqual({ key: 'telegram:taxscan', label: 'Telegram · Taxscan' });
    const keys = pages.map((p) => p.key);
    const wa = keys.indexOf('whatsapp');
    if (wa >= 0) expect(keys.indexOf('telegram:taxscan')).toBeLessThan(wa);
    const fb = keys.filter((k) => k.startsWith('facebook:') || k.startsWith('linkedin:'));
    for (const k of fb) expect(keys.indexOf(k)).toBeLessThan(keys.indexOf('telegram:taxscan'));
    // the public endpoint serves the same list, and an unticked Telegram key is accepted on Compose only while active
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
    const r = await request(app).get('/api/social/pages').set('Cookie', adminCookie);
    expect(r.status).toBe(200);
    expect(r.body.pages).toContainEqual({ key: 'telegram:taxscan', label: 'Telegram · Taxscan' });
    Object.assign(env.telegram, { enabled: false, config: null });
    expect((await request(app).get('/api/social/pages').set('Cookie', adminCookie)).body.pages.map((p: { key: string }) => p.key)).not.toContain('telegram:taxscan');
  });
});

describe('5. errors: 429 retry_after, 5xx retries then FAILED, other 4xx FAILED with no retry', () => {
  it('429 with retry_after 30 → the next attempt is not before 30 s (and never sooner than the usual +1 min); a long retry_after is honoured', async () => {
    const c = await camp('rate', at(NOW, -5));
    script = () => bad('rate', 429, 'telegram_429', 30);
    await tick();
    let [row] = await rowsOf();
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, error: 'telegram_429' });
    expect(row!.nextAttemptAt!.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(30_000);
    // not due 30 s later, due after the wait: nothing is posted early
    await runTelegramTick(deps({ now: () => at(NOW, 0.5) }));
    expect(calls).toHaveLength(1);
    await prisma.telegramPost.deleteMany({ where: { page: PAGE } });
    calls = [];
    script = () => bad('rate', 429, 'telegram_429', 600);
    await tick();
    [row] = await rowsOf();
    expect(row!.nextAttemptAt!.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(600_000);
    expect(row!.campaignId).toBe(c.id);
  });

  it('429 then success: the retry posts once it is due', async () => {
    await camp('rate-ok', at(NOW, -5));
    script = (n) => (n === 1 ? bad('rate', 429, 'telegram_429', 30) : ok(88));
    await tick();
    await runTelegramTick(deps({ now: () => at(NOW, 2) }));
    expect(calls).toHaveLength(2);
    expect((await rowsOf())[0]).toMatchObject({ status: 'POSTED', messageId: 88, attempts: 2, error: null });
  });

  it('5xx → +1, +5, +15 minutes, then FAILED after the 4th attempt; Retry on the screen can post it later', async () => {
    await camp('five', at(NOW, -5));
    script = () => bad('transient', 502, 'telegram_502');
    const t0 = NOW;
    await runTelegramTick(deps({ now: () => t0 }));
    let [row] = await rowsOf();
    expect(row!.nextAttemptAt).toEqual(at(t0, 1));
    await runTelegramTick(deps({ now: () => at(t0, 1) }));
    [row] = await rowsOf();
    expect(row).toMatchObject({ attempts: 2, nextAttemptAt: at(t0, 6) });
    await runTelegramTick(deps({ now: () => at(t0, 6) }));
    [row] = await rowsOf();
    expect(row).toMatchObject({ attempts: 3, nextAttemptAt: at(t0, 21) });
    await runTelegramTick(deps({ now: () => at(t0, 21) }));
    [row] = await rowsOf();
    expect(row).toMatchObject({ status: 'FAILED', attempts: 4, nextAttemptAt: null, error: 'telegram_502' });
    expect(calls).toHaveLength(4);
    await ticks(10, at(t0, 22));
    expect(calls).toHaveLength(4); // FAILED rows are never retried by the worker
    script = () => ok(91);
    expect(await retryNow(row!.id, deps({ now: () => at(t0, 40) }))).toEqual({ ok: true, status: 'POSTED' });
    expect((await rowsOf())[0]).toMatchObject({ status: 'POSTED', messageId: 91, attempts: 1, error: null });
  });

  it('a network failure / timeout is retried like a 5xx', async () => {
    await camp('net', at(NOW, -5));
    script = () => ({ kind: 'transient', status: null, code: null, retryAfterSec: null, error: 'network_error' });
    await tick();
    expect((await rowsOf())[0]).toMatchObject({ status: 'PENDING', nextAttemptAt: at(NOW, 1), error: 'network_error' });
  });

  it('retries never fall in quiet hours: one due at 22:59 IST waits for 07:00', async () => {
    await camp('night', ist(22, 0));
    script = () => bad('transient', 500, 'telegram_500');
    const t = ist(22, 59);
    await runTelegramTick(deps({ now: () => t }));
    const [row] = await rowsOf();
    expect(row!.nextAttemptAt).toEqual(ist(7, 0, 11));
    await runTelegramTick(deps({ now: () => ist(23, 30) }));
    expect(calls).toHaveLength(1);
  });

  it('any other 4xx → FAILED with no retry, and it does not stop the channel or the next push', async () => {
    const a = await camp('four', at(NOW, -9));
    await camp('next', at(NOW, -8));
    script = (n) => (n === 1 ? bad('failed', 400, 'telegram_400') : ok(7));
    await ticks(3, NOW, { fetchCms: cmsWith({ coverImageUrl: null }) }); // a text post: a 400 on a PHOTO is the fallback case, tested above
    const rows = await rowsOf();
    expect(rows.find((r) => r.campaignId === a.id)).toMatchObject({ status: 'FAILED', attempts: 1, nextAttemptAt: null, error: 'telegram_400' });
    expect(rows.filter((r) => r.status === 'POSTED')).toHaveLength(1);
    expect(await channelStop(PAGE)).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe('6. the channel stop: 403 / chat not found stop posting, one alert per IST day, a banner, ADMIN Resume (audited)', () => {
  const STOPS: [string, TelegramResult][] = [
    ['403 bot removed', bad('stop', 403, 'telegram_403_bot_removed')],
    ['400 chat not found', bad('stop', 400, 'telegram_400_chat_not_found')],
    ['401 token revoked', bad('stop', 401, 'telegram_401')],
  ];
  it.each(STOPS)('%s → no further attempts, the push is kept, one alert email, the banner', async (_label, res) => {
    const a = await camp('s1', at(NOW, -9));
    await camp('s2', at(NOW, -8));
    script = () => res;
    await ticks(5, NOW);
    expect(calls).toHaveLength(1); // the one attempt that found the stop; nothing after
    const rows = await rowsOf();
    expect(rows).toHaveLength(1); // no row is made for the next push while stopped
    expect(rows[0]).toMatchObject({ campaignId: a.id, status: 'PENDING', attempts: 0, error: (res as { error: string }).error });
    expect(rows[0]!.nextAttemptAt).not.toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toMatch(/Telegram posting stopped/);
    expect(mails[0]!.to).toBe('admin@team.test');
    expect(await channelStop(PAGE)).toMatchObject({ status: (res as { status: number }).status, error: (res as { error: string }).error });
  });

  it('one alert per IST day: a Resume followed by another stop the same day is silent; the next IST day alerts again', async () => {
    await camp('d1', at(NOW, -9));
    script = () => bad('stop', 403, 'telegram_403');
    await tick();
    expect(mails).toHaveLength(1);
    expect(await resumeChannel(PAGE)).toBe(true);
    await runTelegramTick(deps({ now: () => at(NOW, 5) })); // resumed, stopped again at once
    expect(await channelStop(PAGE)).not.toBeNull();
    expect(mails).toHaveLength(1);
    expect(await resumeChannel(PAGE)).toBe(true);
    await runTelegramTick(deps({ now: () => at(NOW, 24 * 60) })); // the next IST day
    expect(mails).toHaveLength(2);
  });

  it('the stop survives a restart (it is in Postgres) and Resume posts the kept push, with no lost attempt', async () => {
    const c = await camp('kept', at(NOW, -9));
    script = () => bad('stop', 403, 'telegram_403');
    await tick();
    script = () => ok(66);
    await ticks(3, at(NOW, 1)); // "a restart": the module has no memory of it, the database does
    expect(calls).toHaveLength(1);
    expect(await resumeChannel(PAGE)).toBe(true);
    expect(await resumeChannel(PAGE)).toBe(false);
    await runTelegramTick(deps({ now: () => at(NOW, 5) }));
    expect(calls).toHaveLength(2);
    expect((await rowsOf())[0]).toMatchObject({ campaignId: c.id, status: 'POSTED', messageId: 66, attempts: 1, error: null });
  });

  it('while stopped Retry is refused, Compose skip rows are still written (DB only), and other pages are untouched', async () => {
    await camp('stopped-a', at(NOW, -9));
    script = () => bad('stop', 403, 'telegram_403');
    await tick();
    const failed = await prisma.telegramPost.create({ data: { page: PAGE, pushKey: `push:retry-${RUN}:1`, campaignId: 'x', status: 'FAILED', error: 'telegram_400', attempts: 1 } });
    expect(await retryNow(failed.id, deps())).toEqual({ ok: false, reason: 'stopped' });
    const skip = await camp('stopped-skip', at(NOW, -2), { socialSkip: [`telegram:${PAGE}`] });
    await runTelegramTick(deps({ now: () => at(NOW, 1) }));
    expect((await rowsOf()).find((r) => r.campaignId === skip.id)).toMatchObject({ status: 'SKIPPED', error: 'compose_skip' });
    const other = await prisma.digestSetting.findMany({ where: { OR: [{ key: { startsWith: 'facebook:' } }, { key: { startsWith: 'linkedin:' } }], updatedAt: { gte: new Date(Date.now() - 60_000) } } });
    expect(other.filter((s) => s.key.includes(PAGE))).toHaveLength(0);
  });

  it('a second channel keeps posting while the first is stopped', async () => {
    const PAGE2 = `${PAGE}b`;
    const PORTAL2 = `${PORTAL}-b`;
    const a = await camp('ch1', at(NOW, -9));
    const b = await prisma.campaign.create({ data: { portal: PORTAL2, title: 'ch2', body: 'b', url: `https://www.taxscan.in/gst/ch2-${RUN}-1`, target: {}, status: 'SENT', lastSentAt: at(NOW, -8) } as never });
    script = (_n, r) => ((r.body as { chat_id: string }).chat_id === CHANNEL && _n === 1 ? bad('stop', 403, 'telegram_403') : ok(5));
    try {
      await runTelegramTick(deps({ portals: { [PORTAL]: PAGE, [PORTAL2]: PAGE2 } }));
      expect((await channelStop(PAGE))?.error).toBe('telegram_403');
      expect(await channelStop(PAGE2)).toBeNull();
      expect((await prisma.telegramPost.findMany({ where: { page: PAGE2 } })).map((r) => [r.campaignId, r.status])).toEqual([[b.id, 'POSTED']]);
      expect((await rowsOf())[0]).toMatchObject({ campaignId: a.id, status: 'PENDING' });
    } finally {
      await prisma.telegramPost.deleteMany({ where: { page: PAGE2 } });
      await prisma.campaign.deleteMany({ where: { portal: PORTAL2 } });
    }
  });
});

describe('tick mechanics: at most 3 attempts a tick, oldest first, no double posts, stale rows closed', () => {
  it(`MAX_PER_TICK = ${MAX_PER_TICK}: five waiting pushes post three, then two, oldest first`, async () => {
    expect(MAX_PER_TICK).toBe(3);
    const cs = [];
    for (let i = 0; i < 5; i += 1) cs.push(await camp(`m${i}`, at(NOW, -50 + i)));
    const first = await tick();
    expect(first.posted).toBe(3);
    expect((await rowsOf()).map((r) => r.campaignId)).toEqual(cs.slice(0, 3).map((c) => c.id));
    const second = await runTelegramTick(deps({ now: () => at(NOW, 1) }));
    expect(second.posted).toBe(2);
    expect((await rowsOf()).map((r) => r.campaignId)).toEqual(cs.map((c) => c.id));
  });

  it('due retries use the budget first, then new pushes fill it', async () => {
    const a = await camp('retry-first', at(NOW, -60));
    script = () => bad('transient', 500, 'telegram_500');
    await tick();
    for (let i = 0; i < 4; i += 1) await camp(`fresh${i}`, at(NOW, -50 + i));
    script = () => ok();
    calls = [];
    const r = await runTelegramTick(deps({ now: () => at(NOW, 2) }));
    expect(r.posted).toBe(3);
    const rows = await rowsOf();
    expect(rows.find((x) => x.campaignId === a.id)).toMatchObject({ status: 'POSTED', attempts: 2 });
    expect(rows).toHaveLength(3); // the retry + two fresh pushes
  });

  it('two overlapping ticks never post the same push twice', async () => {
    for (let i = 0; i < 4; i += 1) await camp(`ov${i}`, at(NOW, -50 + i));
    await Promise.all([tick(), tick()]);
    await Promise.all([runTelegramTick(deps({ now: () => at(NOW, 1) })), runTelegramTick(deps({ now: () => at(NOW, 1) }))]);
    const rows = await rowsOf();
    expect(new Set(rows.map((r) => r.pushKey)).size).toBe(rows.length);
    const titles = calls.map((c) => String((c.body as { text?: string; caption?: string }).text ?? (c.body as { caption?: string }).caption).split('\n')[0]);
    expect(new Set(titles).size).toBe(titles.length);
    expect(rows.every((r) => r.status === 'POSTED' || r.status === 'PENDING')).toBe(true);
  });

  it('a row left in flight for 10 minutes with no result is FAILED "unknown", never re-posted', async () => {
    const c = await camp('stale', at(NOW, -30));
    const row = await prisma.telegramPost.create({ data: { page: PAGE, pushKey: pushKey({ id: c.id, lastSentAt: c.lastSentAt! }), campaignId: c.id, status: 'PENDING', attempts: 1 } });
    await prisma.telegramPost.update({ where: { id: row.id }, data: { updatedAt: at(NOW, -11) } }); // explicit value (a raw timestamptz parameter would be shifted by the session zone)
    const r = await tick();
    expect(r.staleClosed).toBe(1);
    expect(calls).toHaveLength(0);
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: UNKNOWN_ERROR });
  });

  it('an attempt that throws before a verdict is FAILED "unknown", not retried automatically', async () => {
    await camp('boom', at(NOW, -5));
    script = () => {
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendPhoto exploded`);
    };
    await ticks(3, NOW);
    expect(calls).toHaveLength(1);
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: UNKNOWN_ERROR });
  });
});

describe('the screen API: rows, statuses, Retry / Skip, Check, Resume (roles and audit)', () => {
  it('lists an IST day: WAITING, RETRYING, POSTED, FAILED, SKIPPED (compose) and NOT_POSTED, with the channel, the banner and the post link', async () => {
    const posted = await camp('lp', at(NOW, -60));
    const failed = await camp('lf', at(NOW, -50));
    const waiting = await camp('lw', at(NOW, -40));
    const composed = await camp('lc', at(NOW, -30), { socialSkip: [`telegram:${PAGE}`] });
    const before = await camp('lb', at(FROM, -20));
    await camp('lx-test-only', at(NOW, -20), { target: { type: 'topics', topics: [env.testSegmentTopic] } });
    const mk = (c: { id: string; lastSentAt: Date | null }, data: object) => prisma.telegramPost.create({ data: { page: PAGE, pushKey: pushKey({ id: c.id, lastSentAt: c.lastSentAt! }), campaignId: c.id, ...data } as never });
    await mk(posted, { status: 'POSTED', messageId: 321, postedAt: at(NOW, -59), attempts: 1 });
    await mk(failed, { status: 'FAILED', error: 'telegram_400', attempts: 1 });
    const app = appWith();
    const res = await api(app, 'get', '/api/telegram/posts', publisherCookie);
    expect(res.status).toBe(200);
    const by = Object.fromEntries((res.body.rows as { campaignId: string; status: string }[]).map((r) => [r.campaignId, r]));
    expect(by[posted.id]).toMatchObject({ status: 'POSTED', postUrl: 'https://t.me/taxscan_in/321' });
    expect(by[failed.id]).toMatchObject({ status: 'FAILED', error: 'telegram_400' });
    expect(by[waiting.id]).toMatchObject({ status: 'WAITING', id: null });
    expect(by[composed.id]).toMatchObject({ status: 'SKIPPED', skipReason: 'compose_skip' });
    expect(by[before.id]).toMatchObject({ status: 'NOT_POSTED' });
    expect(Object.keys(by)).toHaveLength(5); // the test-segment-only push is not a row
    expect(res.body).toMatchObject({ page: PAGE, channel: CHANNEL, stop: null, everyPushFrom: FROM.toISOString(), counts: { waiting: 1, posted: 1, failed: 1, skipped: 1, notPosted: 1, all: 5 } });
    expect((await api(app, 'get', '/api/telegram/posts?date=2026-11-09', publisherCookie)).body.rows).toEqual([]);
    expect((await api(app, 'get', '/api/telegram/posts?date=nonsense', publisherCookie)).status).toBe(400);
    expect((await request(app).get('/api/telegram/posts')).status).toBe(401);
  });

  it('shows the stop banner and Resume (ADMIN only, audited, not-stopped = 409) clears it', async () => {
    await camp('rs', at(NOW, -9));
    script = () => bad('stop', 403, 'telegram_403_bot_removed');
    await tick();
    const app = appWith();
    const list = await api(app, 'get', '/api/telegram/posts', adminCookie);
    expect(list.body.stop).toMatchObject({ status: 403, error: 'telegram_403_bot_removed' });
    expect(list.body.rows[0]).toMatchObject({ status: 'RETRYING' });
    expect((await api(app, 'post', '/api/telegram/resume', publisherCookie)).status).toBe(403);
    expect((await api(app, 'post', '/api/telegram/resume', adminCookie)).body).toEqual({ ok: true });
    expect((await api(app, 'post', '/api/telegram/resume', adminCookie)).status).toBe(409);
    expect((await api(app, 'get', '/api/telegram/posts', adminCookie)).body.stop).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { userId: admin.id, action: 'TELEGRAM_POSTING_RESUMED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ resourceType: 'telegram_channel', resourceId: PAGE });
    expect(JSON.stringify(audit[0]!.metadata)).toBe(JSON.stringify({ page: PAGE }));
  });

  it('Retry posts a FAILED row (staff), 409 for one that is not failed, 404 for an unknown id; Skip works on FAILED or a waiting retry', async () => {
    const c = await camp('rt', at(NOW, -9));
    script = () => bad('failed', 400, 'telegram_400');
    await tick();
    const [row] = await rowsOf();
    expect(row!.status).toBe('FAILED');
    const app = appWith();
    script = () => ok(404);
    const r = await api(app, 'post', `/api/telegram/posts/${row!.id}/retry`, publisherCookie);
    expect(r.body).toEqual({ ok: true, status: 'POSTED' });
    expect((await api(app, 'post', `/api/telegram/posts/${row!.id}/retry`, publisherCookie)).status).toBe(409);
    expect((await api(app, 'post', '/api/telegram/posts/nope/retry', publisherCookie)).status).toBe(404);
    expect((await api(app, 'post', `/api/telegram/posts/${row!.id}/skip`, publisherCookie)).status).toBe(409); // posted: not skippable
    const f = await prisma.telegramPost.create({ data: { page: PAGE, pushKey: `push:${c.id}:9`, campaignId: c.id, status: 'FAILED', error: 'telegram_400', attempts: 1 } });
    expect((await api(app, 'post', `/api/telegram/posts/${f.id}/skip`, publisherCookie)).body).toEqual({ ok: true, status: 'SKIPPED' });
    const w = await prisma.telegramPost.create({ data: { page: PAGE, pushKey: `push:${c.id}:10`, campaignId: c.id, status: 'PENDING', attempts: 1, nextAttemptAt: at(NOW, 5) } });
    expect((await api(app, 'post', `/api/telegram/posts/${w.id}/skip`, publisherCookie)).body).toEqual({ ok: true, status: 'SKIPPED' });
  });

  it('Check connection is ADMIN only, posts nothing, names the channel; a failure is a fixed class', async () => {
    const seen: string[] = [];
    const good = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ ok: true, result: { title: 'Taxscan' } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await api(appWith({}, good), 'post', '/api/telegram/check', publisherCookie)).status).toBe(403);
    const r = await api(appWith({}, good), 'post', '/api/telegram/check', adminCookie);
    expect(r.body).toEqual({ ok: true, name: 'Taxscan', message: 'Connected to channel: Taxscan' });
    expect(seen).toEqual([`https://api.telegram.org/bot${TOKEN}/getChat`]); // the fake saw it; the reply never repeats it
    const gone = (async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 })) as unknown as typeof fetch;
    expect((await api(appWith({}, gone), 'post', '/api/telegram/check', adminCookie)).body).toMatchObject({ ok: false, kind: 'stop', message: 'telegram_400_chat_not_found' });
    expect((await api(appWith({ config: null }, good), 'post', '/api/telegram/check', adminCookie)).body).toMatchObject({ ok: false, kind: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('the feature switch the menu reads is true while active', async () => {
    Object.assign(env.telegram, { enabled: true, config: { token: TOKEN, channel: CHANNEL, postFrom: FROM }, off: null });
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
    const me = await request(app).get('/api/auth/me').set('Cookie', adminCookie);
    expect(me.body.features.telegramPosting).toBe(true);
    replies.push(JSON.stringify(me.body));
  });
});

describe('Campaigns "Channels": a Telegram mark per push, only while the channel is active', () => {
  const PUBLIC = env.rss.portal; // the mark covers the taxscan portal
  it('PENDING until posted, then POSTED with a link; FAILED shows the code; SKIPPED for a Compose untick; null for a push the channel never posts', async () => {
    const from = new Date(Date.now() - 6 * 3600_000);
    Object.assign(env.telegram, { enabled: true, config: { token: TOKEN, channel: CHANNEL, postFrom: from }, off: null });
    const sentAt = new Date(Date.now() - 60_000);
    const mk = (key: string, o: { at?: Date; target?: object; socialSkip?: string[]; url?: string } = {}) =>
      prisma.campaign.create({
        data: { portal: PUBLIC, title: `Chan ${key}`, body: 'b', url: o.url ?? `https://www.taxscan.in/gst/tgchan-${key}-${RUN}`, target: (o.target ?? { type: 'all' }) as Prisma.InputJsonValue, status: 'SENT', lastSentAt: o.at ?? sentAt, ...(o.socialSkip ? { socialSkip: o.socialSkip } : {}) },
      });
    const [pending, posted, failed, skipped, testOnly, before] = await Promise.all([
      mk('pending'),
      mk('posted'),
      mk('failed'),
      mk('skipped', { socialSkip: ['telegram:taxscan'] }),
      mk('test', { target: { type: 'topics', topics: [env.testSegmentTopic] } }),
      mk('before', { at: new Date(from.getTime() - 3600_000) }),
    ]);
    const row = (c: { id: string; lastSentAt: Date | null }, data: object) => prisma.telegramPost.create({ data: { page: 'taxscan', pushKey: pushKey({ id: c.id, lastSentAt: c.lastSentAt! }), campaignId: c.id, ...data } as never });
    try {
      await row(posted, { status: 'POSTED', messageId: 77, postedAt: sentAt, attempts: 1 });
      await row(failed, { status: 'FAILED', error: 'telegram_400', attempts: 1 });
      const by = new Map((await listCampaigns(600)).map((r) => [r.id, r]));
      const mark = (c: { id: string }) => by.get(c.id)!.channels!.telegram;
      expect(mark(pending)).toBe('PENDING');
      expect(mark(posted)).toBe('POSTED');
      expect(by.get(posted.id)!.channelDetails!.telegram).toMatchObject({ postUrl: 'https://t.me/taxscan_in/77', error: null });
      expect(mark(failed)).toBe('FAILED');
      expect(by.get(failed.id)!.channelDetails!.telegram).toMatchObject({ error: 'telegram_400', postUrl: null });
      expect(mark(skipped)).toBe('SKIPPED');
      expect(by.get(skipped.id)!.channelDetails!.telegram).toMatchObject({ skipReason: 'compose_skip' });
      expect(mark(testOnly)).toBeNull();
      expect(mark(before)).toBeNull();
      // switched off: no key at all, the payload is what it was before
      Object.assign(env.telegram, { enabled: false, config: null });
      const off = new Map((await listCampaigns(600)).map((r) => [r.id, r]));
      expect(off.get(posted.id)!.channels === undefined || !('telegram' in (off.get(posted.id)!.channels as object))).toBe(true);
    } finally {
      await prisma.telegramPost.deleteMany({ where: { campaignId: { in: [pending, posted, failed, skipped, testOnly, before].map((c) => c.id) } } });
      await prisma.campaign.deleteMany({ where: { url: { contains: `tgchan-` }, AND: { url: { contains: RUN } } } });
    }
  });
});

describe('7a. the log redactor masks the exact bot token wherever it appears (not only in a URL)', () => {
  it('safeErrorLog of an error that quotes the bare token prints no token while it is the configured one', async () => {
    const { safeErrorLog } = await import('../lib/httpErrors');
    Object.assign(env.telegram, { enabled: true, config: { token: TOKEN, channel: CHANNEL, postFrom: FROM }, off: null });
    const text = inspect(safeErrorLog(new Error(`rejected credential ${TOKEN} for the channel`), { stack: true }), { depth: 6 });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN.split(':')[1]!);
    expect(text).toContain('rejected credential');
  });
});

describe('7. the bot token never appears in a log line, an error, an API reply, an audit entry, a column, an email or a screen', () => {
  it('after posts, retries, a stop, a resume, a thrown error carrying the URL, a Check and a Retry: nothing holds the token', async () => {
    const secret = TOKEN.split(':')[1]!;
    // as in production: the same token is also in the environment the log redactor reads
    Object.assign(env.telegram, { enabled: true, config: { token: TOKEN, channel: CHANNEL, postFrom: FROM }, off: null });
    await camp('t1', at(NOW, -40));
    await camp('t2', at(NOW, -39));
    await camp('t3', at(NOW, -38));
    script = (n) => {
      if (n === 1) throw new Error(`fetch failed: POST https://api.telegram.org/bot${TOKEN}/sendPhoto ECONNRESET`);
      if (n === 2) return bad('transient', 502, 'telegram_502');
      return bad('stop', 403, 'telegram_403');
    };
    await ticks(4, NOW);
    const boom = (async (u: string) => {
      throw new Error(`getaddrinfo ENOTFOUND for ${u}`); // the URL, token included, in a thrown message
    }) as unknown as typeof fetch;
    const app = appWith({}, boom);
    await api(app, 'get', '/api/telegram/posts', adminCookie);
    expect((await api(app, 'post', '/api/telegram/check', adminCookie)).body).toMatchObject({ ok: false, message: 'network_error' });
    await api(app, 'post', '/api/telegram/resume', adminCookie);
    const rows = await prisma.telegramPost.findMany({ where: { page: PAGE } });
    const settings = await prisma.digestSetting.findMany({ where: { key: { in: [stopKey(PAGE), alertKey(PAGE)] } } });
    const audit = await prisma.auditLog.findMany({ where: { userId: { in: userIds } } });
    const logs = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 12 }))).join(' '));
    // the error path really ran (a rejected attempt is logged) and still did not print the token
    expect(logs.some((l) => l.includes('[telegram] attempt failed'))).toBe(true);
    const everything = JSON.stringify({ rows, settings, audit, mails, replies }) + logs.join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/bot\d{5,}:/);
  });
});
