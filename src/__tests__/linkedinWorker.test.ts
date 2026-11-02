import bcrypt from 'bcrypt';
import cron from 'node-cron';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { postToLinkedIn, uploadImage, waitForImage, type LinkedInResult } from '../services/linkedin/client';
import type { CmsArticle } from '../services/linkedin/post';
import { runLinkedInTick, retryNow, startLinkedInWorker, resetLinkedInStops, loginProblem, authKey, pushOutOfQuietHours, UNKNOWN_ERROR, MAX_PER_TICK, type WorkerDeps } from '../services/linkedin/worker';

/**
 * Brief 2026-11-02-linkedin-page-posting, acceptance 4–8: the worker (LinkedIn HTTP mocked), crash safety, retries,
 * quiet hours, the login stop + alert, the token never leaking, the flag, and the screen's API. Rows live under a unique
 * `test-li-*` portal mapped to a private page `litest`, so nothing touches the real `taxscan` page state.
 */
const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL = `test-li-${RUN}`;
const PAGE = 'litest';
const TOKEN = 'SECRET-TOKEN-4f9a1c';
const PASSWORD = 'li-worker-test-pw-1';
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 3) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const NOW = ist(10, 0); // 3 Nov 2026 10:00 IST
const FROM = ist(4, 0);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);

const posted = (id = 'urn:li:share:1'): LinkedInResult => ({ kind: 'posted', postId: id });
const retry429: LinkedInResult = { kind: 'retry', status: 429, error: 'HTTP 429' };
const auth401: LinkedInResult = { kind: 'auth', status: 401, error: 'HTTP 401' };

let calls: { orgUrn: string; accessToken: string; commentary: string; title: string; link: string; description?: string; thumbnail?: string }[] = [];
let script: (n: number) => LinkedInResult | Promise<LinkedInResult> = () => posted();
const post: NonNullable<WorkerDeps['post']> = async (r) => {
  calls.push(r);
  return script(calls.length);
};
let mails: { to: string; subject: string; text: string }[] = [];
const deps = (over: WorkerDeps = {}): WorkerDeps => ({
  now: () => NOW,
  post,
  fetchCms: async () => null,
  waitImage: async () => ({ ok: true }), // never reach LinkedIn's status endpoint from a test
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: PAGE },
  postFrom: FROM,
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});

let seq = 0;
const campIds: string[] = [];
async function camp(slug: string, lastSentAt: Date, o: { host?: string; status?: 'SENT' | 'DRAFT'; title?: string; portal?: string; extra?: Record<string, unknown> } = {}) {
  const c = await prisma.campaign.create({
    data: { portal: o.portal ?? PORTAL, title: o.title ?? `Story ${slug}`, body: 'b', url: `https://${o.host ?? 'www.taxscan.in'}/gst/${slug}-${RUN}-${++seq}`, target: {}, status: o.status ?? 'SENT', lastSentAt, authority: 'Supreme Court', categories: ['GST'], ...(o.extra ?? {}) } as never,
  });
  campIds.push(c.id);
  return c;
}
const rowsOf = () => prisma.linkedInPost.findMany({ where: { page: PAGE }, orderBy: { createdAt: 'asc' } });

const userIds: string[] = [];
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `li-${role.toLowerCase()}-${RUN}-${++seq}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}

const savedPage = env.linkedin.pages[PAGE];
beforeAll(async () => {
  env.linkedin.pages[PAGE] = { orgUrn: 'urn:li:organization:99', accessToken: TOKEN };
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
});
beforeEach(async () => {
  calls = [];
  mails = [];
  script = () => posted();
  env.linkedin.pages[PAGE] = { orgUrn: 'urn:li:organization:99', accessToken: TOKEN };
  resetLinkedInStops();
  await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: authKey(PAGE) } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  logSpy.mockClear();
  errSpy.mockClear();
});
afterAll(async () => {
  if (savedPage) env.linkedin.pages[PAGE] = savedPage;
  else delete env.linkedin.pages[PAGE];
  await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: authKey(PAGE) } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('4. the worker posts what was pushed, in order, three at a time', () => {
  it('SENT taxscan articles after LINKEDIN_POST_FROM, in lastSentAt order, ≤ 3 per tick; never before go-live, academy/shop, drafts, or a second push', async () => {
    const before = await camp('before-golive', at(FROM, -30));
    const c1 = await camp('one', at(NOW, -50), { title: 'First [Read Order]' });
    const c2 = await camp('two', at(NOW, -40));
    const c3 = await camp('three', at(NOW, -30));
    const c4 = await camp('four', at(NOW, -20));
    const c5 = await camp('five', at(NOW, -10));
    await camp('academy', at(NOW, -45), { host: 'academy.taxscan.in' });
    await camp('draft', at(NOW, -44), { status: 'DRAFT' });
    await camp('other-portal', at(NOW, -43), { portal: `${PORTAL}-x` });
    // the same article pushed again later (a manual re-push): same URL → same article
    await prisma.campaign.create({ data: { portal: PORTAL, title: 'again', body: 'b', url: c2.url, target: {}, status: 'SENT', lastSentAt: at(NOW, -5) } });
    // a re-push AFTER go-live of an article first pushed BEFORE go-live: not new
    await prisma.campaign.create({ data: { portal: PORTAL, title: 'old again', body: 'b', url: before.url, target: {}, status: 'SENT', lastSentAt: at(NOW, -2) } });

    const t1 = await runLinkedInTick(deps());
    expect(t1.posted).toBe(MAX_PER_TICK);
    expect(calls.map((x) => x.title)).toEqual(['First [Read Order]', 'Story two', 'Story three']);
    const t2 = await runLinkedInTick(deps());
    expect(t2.posted).toBe(2);
    expect(calls.map((x) => x.title).slice(3)).toEqual(['Story four', 'Story five']);
    const t3 = await runLinkedInTick(deps());
    expect(t3.posted).toBe(0);
    expect(calls).toHaveLength(5);
    const rows = await rowsOf();
    expect(rows.map((r) => r.campaignId)).toEqual([c1.id, c2.id, c3.id, c4.id, c5.id]);
    expect(rows.every((r) => r.status === 'POSTED' && r.linkedinPostId === 'urn:li:share:1' && r.attempts === 1)).toBe(true);
  });
  it('the request carries the page, the escaped commentary with hashtags, an article card and the LinkedIn UTM link', async () => {
    await camp('shape', at(NOW, -5), { title: 'Order (2) [Read Order]' });
    await runLinkedInTick(deps());
    expect(calls).toHaveLength(1);
    const r = calls[0];
    expect(r.orgUrn).toBe('urn:li:organization:99');
    expect(r.commentary).toBe('Order \\(2\\) \\[Read Order\\]\n\n{hashtag|\\#|SupremeCourt} {hashtag|\\#|GST} {hashtag|\\#|taxscan}');
    const u = new URL(r.link);
    expect(u.searchParams.get('utm_source')).toBe('taxscan-linkedin');
    expect(u.searchParams.get('utm_campaign')).toBe('linkedin-litest');
    expect(u.searchParams.get('utm_content')).toMatch(/^shape-/);
    expect(r.title).toBe('Order (2) [Read Order]');
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/\[linkedin\] page=litest campaign=\S+ outcome=posted hashtags=fallback/);
  });
  it('nothing older than 24 h is posted', async () => {
    await camp('stale', at(NOW, -25 * 60));
    expect((await runLinkedInTick(deps({ postFrom: at(NOW, -30 * 60) }))).posted).toBe(0);
  });
});

describe('H. manual sends post like pacer sends; test sends never do (follow-up 1)', () => {
  it('H1: a pacer send, a Compose send (createdByUserId, target All), a Compose send to a topic and a scheduled Compose send marked SENT by the sweeper all post, in lastSentAt order', async () => {
    await camp('h-pacer', at(NOW, -40), { extra: { sendQueue: 'QUALIFIED', authority: 'Supreme Court', reviewedAt: null } });
    await camp('h-compose-all', at(NOW, -30), { extra: { createdByUserId: admin.id, target: { type: 'all' } } });
    await camp('h-compose-topic', at(NOW, -20), { extra: { createdByUserId: publisher.id, target: { type: 'topics', topics: ['gst'] } } });
    await camp('h-scheduled', at(NOW, -10), { extra: { createdByUserId: admin.id, scheduledAt: at(NOW, -11), target: { type: 'all' } } });
    await runLinkedInTick(deps());
    expect(calls.map((c) => c.title)).toEqual(['Story h-pacer', 'Story h-compose-all', 'Story h-compose-topic', 'Story h-scheduled'].slice(0, MAX_PER_TICK));
    await runLinkedInTick(deps());
    expect(calls.map((c) => c.title)).toEqual(['Story h-pacer', 'Story h-compose-all', 'Story h-compose-topic', 'Story h-scheduled']);
  });
  it('H2: a SENT campaign targeted ONLY at the test-segment topic is not posted; one that also names a real topic is', async () => {
    await camp('h-test-only', at(NOW, -30), { extra: { createdByUserId: admin.id, target: { type: 'topics', topics: [env.testSegmentTopic] } } });
    await camp('h-test-twice', at(NOW, -25), { extra: { target: { type: 'topics', topics: [env.testSegmentTopic, env.testSegmentTopic.toUpperCase()] } } });
    await camp('h-test-and-real', at(NOW, -20), { extra: { target: { type: 'topics', topics: [env.testSegmentTopic, 'gst'] } } });
    await runLinkedInTick(deps());
    expect(calls.map((c) => c.title)).toEqual(['Story h-test-and-real']);
    expect((await rowsOf()).length).toBe(1);
  });
  it('a Compose send to a non-article taxscan.in URL (home, a section page) or to academy / shop stays excluded', async () => {
    for (const [i, url] of ['https://www.taxscan.in/', 'https://www.taxscan.in/income-tax', 'https://academy.taxscan.in/c/course', 'https://shop.taxscan.in/products/book'].entries()) {
      const c = await camp(`h-not-article-${i}`, at(NOW, -30 + i), { extra: { createdByUserId: admin.id } });
      await prisma.campaign.update({ where: { id: c.id }, data: { url } });
    }
    await runLinkedInTick(deps());
    expect(calls).toHaveLength(0);
  });
});

describe('I. the link card carries the article\'s picture and a description (fail-open)', () => {
  const COVER = 'https://documents.taxscan.in/cms/media/cover-1.jpg';
  const EXCERPT = `${'An editor\'s one-line summary of the ruling. '.repeat(8)}`.trim(); // ~350 characters
  const cmsWith = (over: Partial<CmsArticle> = {}): NonNullable<WorkerDeps['fetchCms']> => async () => ({ keywords: [], courts: [], category: null, coverImageUrl: COVER, excerpt: EXCERPT, ...over });
  const okImage: NonNullable<WorkerDeps['fetchImage']> = async () => ({ ok: true, bytes: new Uint8Array([0xff, 0xd8, 1, 2]), contentType: 'image/jpeg' });
  const outcomeLine = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  let imageCalls = 0;
  let uploadCalls = 0;
  const countingImage = (inner: NonNullable<WorkerDeps['fetchImage']>): NonNullable<WorkerDeps['fetchImage']> => async (u) => (imageCalls++, inner(u));
  const countingUpload = (inner: NonNullable<WorkerDeps['uploadImage']>): NonNullable<WorkerDeps['uploadImage']> => async (r) => (uploadCalls++, inner(r));
  beforeEach(() => {
    imageCalls = 0;
    uploadCalls = 0;
  });

  it('1: the CMS gives cover + excerpt → fetch → register → upload → the post carries thumbnail and the excerpt cut to ≤ 200; the line says image=ok', async () => {
    await camp('thumb-happy', at(NOW, -5), { extra: { body: 'The campaign body.' } });
    await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: countingImage(okImage), uploadImage: countingUpload(async () => ({ kind: 'ok', urn: 'urn:li:image:C9ZZ' })) }));
    expect(calls).toHaveLength(1);
    expect(calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
    expect(calls[0].description!.length).toBeLessThanOrEqual(200);
    expect(calls[0].description!.endsWith('…')).toBe(true);
    expect(EXCERPT.startsWith(calls[0].description!.slice(0, -1))).toBe(true);
    expect(outcomeLine()).toMatch(/outcome=posted hashtags=fallback image=ok/);
    expect((await rowsOf())[0].status).toBe('POSTED');
    expect([imageCalls, uploadCalls]).toEqual([1, 1]);
  });

  it.each([['http_404'], ['timeout'], ['type'], ['size'], ['network']] as const)('2: the picture fetch fails (%s) → posted WITHOUT a thumbnail, description kept, image=none:%s, status POSTED, no retry', async (reason) => {
    await camp(`thumb-fetch-${reason}`, at(NOW, -5));
    await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: async () => ({ ok: false, reason }), uploadImage: countingUpload(async () => ({ kind: 'ok', urn: 'urn:li:image:NOPE' })) }));
    expect(calls).toHaveLength(1);
    expect(calls[0].thumbnail).toBeUndefined();
    expect(calls[0].description).toBeTruthy();
    expect(outcomeLine()).toContain(`outcome=posted hashtags=fallback image=none:${reason}`);
    expect(uploadCalls).toBe(0);
    expect((await rowsOf())[0]).toMatchObject({ status: 'POSTED', attempts: 1 });
  });

  it('3: registering or uploading fails → posted without a thumbnail (image=none:<reason>); a 401 from the registration is an auth-stop with NO post call', async () => {
    await camp('thumb-upload-soft', at(NOW, -5));
    await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: async () => ({ kind: 'soft', reason: 'init_http_500' }) }));
    expect(calls).toHaveLength(1);
    expect(calls[0].thumbnail).toBeUndefined();
    expect(outcomeLine()).toContain('image=none:init_http_500');
    expect((await rowsOf())[0].status).toBe('POSTED');

    await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
    calls = [];
    logSpy.mockClear();
    await camp('thumb-upload-put', at(NOW, -4));
    await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: async () => ({ kind: 'soft', reason: 'put_http_500' }) }));
    expect(calls[calls.length - 1].thumbnail).toBeUndefined();
    expect(outcomeLine()).toContain('image=none:put_http_500');

    await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
    await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
    calls = [];
    logSpy.mockClear();
    resetLinkedInStops();
    await camp('thumb-upload-auth', at(NOW, -3));
    const t = await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: async () => ({ kind: 'auth', status: 401, error: 'HTTP 401 (image upload)' }) }));
    expect(t.authStopped).toBe(true);
    expect(calls).toHaveLength(0); // the token is bad for everything: the post is not attempted
    expect(outcomeLine()).toMatch(/outcome=auth_stop status=401 image=/);
    expect(await loginProblem(PAGE)).toMatchObject({ status: 401 });
    expect(mails).toHaveLength(1); // the same once-a-day admin alert as for the post's own 401
  });

  it('4: a disallowed host (http, another domain) → no fetch at all, image=none:host, still posted', async () => {
    const globalFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
    try {
      for (const [i, url] of ['http://documents.taxscan.in/cms/media/x.jpg', 'https://cdn.example.org/x.jpg'].entries()) {
        await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
        calls = [];
        logSpy.mockClear();
        await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
        await camp(`thumb-host-${i}`, at(NOW, -5));
        await runLinkedInTick(deps({ fetchCms: cmsWith({ coverImageUrl: url }), uploadImage: countingUpload(async () => ({ kind: 'ok', urn: 'urn:li:image:NOPE' })) }));
        expect(calls).toHaveLength(1);
        expect(calls[0].thumbnail).toBeUndefined();
        expect(outcomeLine()).toContain('image=none:host');
      }
      expect(globalFetch).not.toHaveBeenCalled();
      expect(uploadCalls).toBe(0);
    } finally {
      globalFetch.mockRestore();
    }
  });

  it('5: the CMS fetch failed → no picture attempt; the description falls back to the campaign body', async () => {
    await camp('thumb-nocms', at(NOW, -5), { extra: { body: 'The campaign body line.' } });
    await runLinkedInTick(deps({ fetchCms: async () => null, fetchImage: countingImage(okImage), uploadImage: countingUpload(async () => ({ kind: 'ok', urn: 'urn:li:image:NOPE' })) }));
    expect([imageCalls, uploadCalls]).toEqual([0, 0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].thumbnail).toBeUndefined();
    expect(calls[0].description).toBe('The campaign body line.');
    expect(outcomeLine()).toContain('image=none:no_cover');
  });

  describe('follow-up 1: wait for the image, and a post rejected because of the thumbnail still goes out', () => {
    const upload = (urn = 'urn:li:image:C9ZZ'): NonNullable<WorkerDeps['uploadImage']> => async () => ({ kind: 'ok', urn });
    /** A fake status endpoint: answers the given statuses in order (the last one repeats) and records every GET. */
    function statusFetch(statuses: string[]) {
      const urls: string[] = [];
      const f = (async (url: string) => {
        urls.push(url);
        const status = statuses[Math.min(urls.length - 1, statuses.length - 1)];
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 'urn:li:image:C9ZZ', status }) } as unknown as Response;
      }) as unknown as typeof fetch;
      return { f, urls };
    }
    const wait = (f: typeof fetch): NonNullable<WorkerDeps['waitImage']> => (r) => waitForImage(r, f, async () => undefined);

    it('T1: the image stays PROCESSING for all 4 looks → posted WITHOUT a thumbnail, image=none:processing, status POSTED', async () => {
      await camp('t1', at(NOW, -5));
      const s = statusFetch(['PROCESSING']);
      await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload(), waitImage: wait(s.f) }));
      expect(s.urls).toHaveLength(4);
      expect(s.urls[0]).toBe('https://api.linkedin.com/rest/images/urn:li:image:C9ZZ');
      expect(calls).toHaveLength(1);
      expect(calls[0].thumbnail).toBeUndefined();
      expect(outcomeLine()).toContain('image=none:processing');
      expect((await rowsOf())[0].status).toBe('POSTED');
    });

    it('T2: PROCESSING, then AVAILABLE → posted WITH the thumbnail after two looks, image=ok', async () => {
      await camp('t2', at(NOW, -5));
      const s = statusFetch(['PROCESSING', 'AVAILABLE']);
      await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload(), waitImage: wait(s.f) }));
      expect(s.urls).toHaveLength(2);
      expect(calls).toHaveLength(1);
      expect(calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
      expect(outcomeLine()).toContain('image=ok');
    });

    it('an error from the status call, or a failed processing → posted without the thumbnail (image=none:status_<code> / processing_failed)', async () => {
      await camp('t-status-err', at(NOW, -5));
      await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload(), waitImage: async () => ({ ok: false, reason: 'status_404' }) }));
      expect(calls[0].thumbnail).toBeUndefined();
      expect(outcomeLine()).toContain('image=none:status_404');
      expect((await rowsOf())[0].status).toBe('POSTED');
    });

    it('T3: the post WITH a thumbnail → 422; the repeat WITHOUT → posted: exactly 2 post calls, the second without thumbnail, description kept, image=dropped:422', async () => {
      await camp('t3', at(NOW, -5));
      script = (n) => (n === 1 ? { kind: 'failed', status: 422, error: 'HTTP 422: thumbnail not available' } : posted());
      await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload() }));
      expect(calls).toHaveLength(2);
      expect(calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
      expect(calls[1].thumbnail).toBeUndefined();
      expect(calls[1].description).toBe(calls[0].description);
      expect(calls[1].commentary).toBe(calls[0].commentary);
      expect(outcomeLine()).toContain('outcome=posted hashtags=fallback image=dropped:422');
      expect((await rowsOf())[0]).toMatchObject({ status: 'POSTED', attempts: 1, error: null });
    });

    it('T3b: the repeat is the attempt\'s verdict: if it fails too, the row is FAILED with that error (still only 2 calls)', async () => {
      await camp('t3b', at(NOW, -5));
      script = (n) => ({ kind: 'failed', status: n === 1 ? 422 : 400, error: n === 1 ? 'HTTP 422' : 'HTTP 400: bad title' });
      await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload() }));
      expect(calls).toHaveLength(2);
      expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: 'HTTP 400: bad title' });
      expect(outcomeLine()).toContain('image=dropped:422');
    });

    it('T4: the post WITH a thumbnail → 500 → the normal retry: no immediate repeat (1 post call), the thumbnail stays for the retry', async () => {
      await camp('t4', at(NOW, -5));
      script = () => ({ kind: 'retry', status: 500, error: 'HTTP 500' });
      await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload() }));
      expect(calls).toHaveLength(1);
      expect(calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
      expect((await rowsOf())[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(outcomeLine()).toContain('outcome=retry');
      expect(outcomeLine()).not.toContain('image=dropped');
    });

    it('T4b: a 429 or a network error is not repeated either', async () => {
      for (const [i, r] of ([{ kind: 'retry', status: 429, error: 'HTTP 429' }, { kind: 'retry', status: null, error: 'network error' }] as LinkedInResult[]).entries()) {
        await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
        await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
        calls = [];
        await camp(`t4b-${i}`, at(NOW, -5));
        script = () => r;
        await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload() }));
        expect(calls).toHaveLength(1);
      }
    });

    it('T5: the post WITH a thumbnail → 401 → auth-stop, no repeat (1 post call)', async () => {
      await camp('t5', at(NOW, -5));
      script = () => auth401;
      const t = await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: upload() }));
      expect(t.authStopped).toBe(true);
      expect(calls).toHaveLength(1);
      expect(outcomeLine()).toContain('outcome=auth_stop');
      expect(outcomeLine()).not.toContain('image=dropped');
    });

    it('a client error on a post that had NO thumbnail is not repeated (nothing to drop)', async () => {
      await camp('t-nothumb', at(NOW, -5));
      script = () => ({ kind: 'failed', status: 422, error: 'HTTP 422' });
      await runLinkedInTick(deps({ fetchCms: async () => null }));
      expect(calls).toHaveLength(1);
      expect((await rowsOf())[0].status).toBe('FAILED');
    });

    it('waitForImage: at most 4 looks, 1.5 s apart (an injected clock, no real waiting), the right headers, and a fixed reason for every failure', async () => {
      const sleeps: number[] = [];
      const sleep = async (ms: number) => void sleeps.push(ms);
      const s = statusFetch(['WAITING_UPLOAD', 'PROCESSING', 'PROCESSING', 'PROCESSING', 'AVAILABLE']);
      expect(await waitForImage({ urn: 'urn:li:image:C9ZZ', accessToken: TOKEN }, s.f, sleep)).toEqual({ ok: false, reason: 'processing' });
      expect(s.urls).toHaveLength(4); // the 5th (AVAILABLE) is never looked at
      expect(sleeps).toEqual([1500, 1500, 1500]);
      const seen: RequestInit[] = [];
      await waitForImage({ urn: 'urn:li:image:C9ZZ', accessToken: TOKEN }, (async (_u: string, i: RequestInit) => (seen.push(i), { ok: true, status: 200, json: async () => ({ status: 'AVAILABLE' }) } as unknown as Response)) as never, sleep);
      expect(seen[0].method).toBe('GET');
      expect(seen[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'LinkedIn-Version': env.linkedin.apiVersion, 'X-Restli-Protocol-Version': '2.0.0' });
      const err = (status: number) => (async () => ({ ok: false, status, json: async () => ({ message: `echo ${TOKEN}` }) }) as unknown as Response) as never;
      expect(await waitForImage({ urn: 'urn:li:image:C9ZZ', accessToken: TOKEN }, err(404), sleep)).toEqual({ ok: false, reason: 'status_404' });
      expect(await waitForImage({ urn: 'urn:li:image:C9ZZ', accessToken: TOKEN }, err(403), sleep)).toEqual({ ok: false, reason: 'status_403' });
      expect(await waitForImage({ urn: 'urn:li:image:C9ZZ', accessToken: TOKEN }, (async () => { throw new Error('reset'); }) as never, sleep)).toEqual({ ok: false, reason: 'status_network' });
      expect(await waitForImage({ urn: 'urn:li:image:C9ZZ', accessToken: TOKEN }, statusFetch(['PROCESSING_FAILED']).f, sleep)).toEqual({ ok: false, reason: 'processing_failed' });
      expect(await waitForImage({ urn: 'not-a-urn', accessToken: TOKEN }, err(200), sleep)).toEqual({ ok: false, reason: 'status_network' });
    });
  });

  it('a retryable post failure after a successful upload retries the whole attempt (a fresh upload is fine, never a loop inside one attempt)', async () => {
    await camp('thumb-retry', at(NOW, -5));
    let uploads = 0;
    const d = deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: async () => ({ kind: 'ok', urn: `urn:li:image:U${++uploads}` }) });
    script = () => retry429;
    await runLinkedInTick(d);
    expect(uploads).toBe(1); // one upload in the attempt, then the 429
    expect((await rowsOf())[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
    script = () => posted();
    await runLinkedInTick({ ...d, now: () => at(NOW, 1) });
    expect(uploads).toBe(2);
    expect(calls[calls.length - 1].thumbnail).toBe('urn:li:image:U2');
    expect((await rowsOf())[0].status).toBe('POSTED');
  });

  it('6: the token never appears in the logs, the rows or the mails across the new calls (the real upload code, a server that echoes it)', async () => {
    await camp('thumb-secrets', at(NOW, -5));
    const echo = (async (url: string) => {
      if (String(url).includes('/rest/images')) return { status: 200, ok: true, headers: new Headers(), json: async () => ({ value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/x', image: 'urn:li:image:C1' } }) } as unknown as Response;
      return { status: 500, ok: false, headers: new Headers(), json: async () => ({ message: `Bearer ${TOKEN} ${TOKEN}` }) } as unknown as Response; // the PUT fails and echoes the token
    }) as unknown as typeof fetch;
    await runLinkedInTick(deps({ fetchCms: cmsWith(), fetchImage: okImage, uploadImage: (r) => uploadImage(r, echo) }));
    const everything = JSON.stringify({ logs: [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls], rows: await rowsOf(), mails, calls: calls.map((c) => ({ ...c, accessToken: undefined })) });
    expect(everything).not.toContain(TOKEN);
    expect(outcomeLine()).toContain('image=none:put_http_500');
  });
});

describe('5. crash safety', () => {
  it('an in-flight row older than 10 minutes becomes FAILED "unknown" and is never re-posted', async () => {
    const c = await camp('crash', at(NOW, -30));
    await prisma.linkedInPost.create({ data: { page: PAGE, articleKey: c.url, campaignId: c.id, status: 'PENDING', attempts: 1 } });
    const later = new Date(Date.now() + 11 * MIN);
    const t = await runLinkedInTick(deps({ now: () => later }));
    expect(t.staleClosed).toBe(1);
    expect(calls).toHaveLength(0);
    const [row] = await rowsOf();
    expect(row).toMatchObject({ status: 'FAILED', error: UNKNOWN_ERROR });
    await runLinkedInTick(deps({ now: () => new Date(later.getTime() + 5 * MIN) }));
    expect(calls).toHaveLength(0);
  });
  it('a tick only closes stale in-flight rows of ITS OWN pages (another page, or another test file, is left alone)', async () => {
    // Regression for an intermittent failure in linkedinToken.test.ts: the stale-row recovery used to be table-wide, so with a fixed
    // future clock a tick in one file closed an in-flight row that belonged to another file's page while its post was in the air.
    const other = await prisma.linkedInPost.create({ data: { page: `${PAGE}-other`, articleKey: `other-${RUN}`, campaignId: 'c-other', status: 'PENDING', attempts: 1 } });
    const mine = await prisma.linkedInPost.create({ data: { page: PAGE, articleKey: `mine-${RUN}`, campaignId: 'c-mine', status: 'PENDING', attempts: 1 } });
    try {
      const t = await runLinkedInTick(deps({ now: () => new Date(Date.now() + 11 * MIN) }));
      expect(t.staleClosed).toBe(1);
      expect((await prisma.linkedInPost.findUnique({ where: { id: mine.id } }))!.status).toBe('FAILED');
      expect((await prisma.linkedInPost.findUnique({ where: { id: other.id } }))!.status).toBe('PENDING');
    } finally {
      await prisma.linkedInPost.deleteMany({ where: { id: { in: [other.id, mine.id] } } });
    }
  });
  it('a row that is only a minute old is left alone (still in flight)', async () => {
    const c = await camp('fresh', at(NOW, -30));
    await prisma.linkedInPost.create({ data: { page: PAGE, articleKey: c.url, campaignId: c.id, status: 'PENDING', attempts: 1 } });
    expect((await runLinkedInTick(deps({ now: () => new Date(Date.now() + MIN) }))).staleClosed).toBe(0);
    expect(calls).toHaveLength(0);
  });
  it('two overlapping ticks never post the same article (the unique row is created first)', async () => {
    await camp('race-a', at(NOW, -30));
    await camp('race-b', at(NOW, -20));
    script = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return posted();
    };
    await Promise.all([runLinkedInTick(deps()), runLinkedInTick(deps())]);
    expect(calls.map((c) => c.title).sort()).toEqual(['Story race-a', 'Story race-b']);
    expect(await rowsOf()).toHaveLength(2);
  });
  it('a crash inside the call (an exception) leaves the row FAILED "unknown", not retried', async () => {
    await camp('boom', at(NOW, -5));
    script = () => {
      throw new Error('process died');
    };
    await runLinkedInTick(deps());
    const [row] = await rowsOf();
    expect(row).toMatchObject({ status: 'FAILED', error: UNKNOWN_ERROR });
    await runLinkedInTick(deps({ now: () => at(NOW, 30) }));
    expect(calls).toHaveLength(1);
  });
});

describe('6. retries, quiet hours, the login stop', () => {
  it('429 retries at +1, +5, +15 minutes, then FAILED (four calls in all)', async () => {
    const c = await camp('limited', at(NOW, -5));
    script = () => retry429;
    await runLinkedInTick(deps());
    let row = (await rowsOf())[0];
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, error: 'HTTP 429' });
    expect(row.nextAttemptAt!.getTime()).toBe(at(NOW, 1).getTime());
    await runLinkedInTick(deps({ now: () => at(NOW, 0.5) })); // not due yet
    expect(calls).toHaveLength(1);
    await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    row = (await rowsOf())[0];
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt!.getTime()).toBe(at(NOW, 1 + 5).getTime());
    await runLinkedInTick(deps({ now: () => at(NOW, 6) }));
    row = (await rowsOf())[0];
    expect(row.attempts).toBe(3);
    expect(row.nextAttemptAt!.getTime()).toBe(at(NOW, 6 + 15).getTime());
    await runLinkedInTick(deps({ now: () => at(NOW, 21) }));
    row = (await rowsOf())[0];
    expect(row).toMatchObject({ status: 'FAILED', attempts: 4, nextAttemptAt: null, campaignId: c.id });
    expect(calls).toHaveLength(4);
    await runLinkedInTick(deps({ now: () => at(NOW, 90) }));
    expect(calls).toHaveLength(4);
  });
  it('a 5xx or a network error retries too; a 400 is FAILED at once', async () => {
    await camp('flaky', at(NOW, -5));
    script = () => ({ kind: 'retry', status: 503, error: 'HTTP 503' });
    await runLinkedInTick(deps());
    expect((await rowsOf())[0].status).toBe('PENDING');
    await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
    script = () => ({ kind: 'failed', status: 422, error: 'HTTP 422: invalid content' });
    await runLinkedInTick(deps());
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: 'HTTP 422: invalid content', attempts: 1 });
  });
  it('a first attempt goes out at any hour; a retry due in quiet hours waits until 07:00 IST', async () => {
    const night = ist(2, 0);
    await camp('night-owl', at(night, -5));
    script = () => ({ kind: 'posted', postId: 'urn:li:share:9' });
    await runLinkedInTick(deps({ now: () => night, postFrom: at(night, -120) }));
    expect(calls).toHaveLength(1); // 02:00 IST, first attempt: posts
    await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
    calls = [];
    const late = at(ist(22, 59), 0.5); // 22:59:30 IST: +1 min lands at 23:00:30, inside quiet hours
    await prisma.campaign.updateMany({ where: { portal: PORTAL }, data: { lastSentAt: at(late, -5) } });
    script = () => retry429;
    await runLinkedInTick(deps({ now: () => late }));
    const row = (await rowsOf())[0];
    expect(row.nextAttemptAt!.getTime()).toBe(ist(7, 0, 4).getTime());
    script = () => posted();
    await runLinkedInTick(deps({ now: () => ist(23, 30) }));
    await runLinkedInTick(deps({ now: () => ist(3, 0, 4) }));
    expect(calls).toHaveLength(1); // only the failed first call so far
    await runLinkedInTick(deps({ now: () => ist(7, 0, 4) }));
    expect(calls).toHaveLength(2);
    expect((await rowsOf())[0].status).toBe('POSTED');
    expect(pushOutOfQuietHours(ist(12, 0), { start: '23:00', end: '07:00' }).getTime()).toBe(ist(12, 0).getTime());
  });
  it('401 stops posting for the page: one alert email per IST day, banner data on the API, resumes on a new token', async () => {
    await camp('auth-a', at(NOW, -30));
    await camp('auth-b', at(NOW, -20));
    script = () => auth401;
    const t = await runLinkedInTick(deps());
    expect(t.authStopped).toBe(true);
    expect(calls).toHaveLength(1); // the first call hit the login error: no further call
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'admin@team.test' });
    expect(mails[0].subject).toContain('LinkedIn posting stopped');
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(rows[0].nextAttemptAt).not.toBeNull();
    expect(await loginProblem(PAGE)).toMatchObject({ status: 401 });
    await runLinkedInTick(deps({ now: () => at(NOW, 3) }));
    await runLinkedInTick(deps({ now: () => at(NOW, 6) }));
    expect(calls).toHaveLength(1); // stopped: no calls at all
    expect(mails).toHaveLength(1);
    // a restart the same day tries once, fails again, and does NOT email again
    resetLinkedInStops();
    await runLinkedInTick(deps({ now: () => at(NOW, 9) }));
    expect(calls).toHaveLength(2);
    expect(mails).toHaveLength(1);
    // a restart the next IST day: one more email
    resetLinkedInStops();
    await runLinkedInTick(deps({ now: () => ist(10, 0, 4) }));
    expect(mails).toHaveLength(2);
    // a new token deployed: posting resumes (no restart needed) and the banner clears
    env.linkedin.pages[PAGE] = { orgUrn: 'urn:li:organization:99', accessToken: `${TOKEN}-new` };
    script = () => posted();
    await runLinkedInTick(deps({ now: () => ist(10, 5, 4), postFrom: at(NOW, -60 * 24) }));
    expect(calls.length).toBeGreaterThan(2);
    expect(calls[calls.length - 1].accessToken).toBe(`${TOKEN}-new`);
    expect(await loginProblem(PAGE)).toBeNull();
  });
  it('403 is a login error too', async () => {
    await camp('forbidden', at(NOW, -5));
    script = () => ({ kind: 'auth', status: 403, error: 'HTTP 403' });
    expect((await runLinkedInTick(deps())).authStopped).toBe(true);
    expect(await loginProblem(PAGE)).toMatchObject({ status: 403 });
  });
});

describe('7. the token never leaves the building', () => {
  it('the client scrubs it from the error text it returns, and sends it only in the Authorization header', async () => {
    let sent: { headers: Record<string, string>; body: string } | null = null;
    const f = (async (_u: string, init: RequestInit) => {
      sent = { headers: init.headers as Record<string, string>, body: String(init.body) };
      return { status: 400, headers: new Headers(), json: async () => ({ message: `bad request for Bearer ${TOKEN} / ${TOKEN}` }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await postToLinkedIn({ orgUrn: 'urn:li:organization:1', accessToken: TOKEN, commentary: 'c', title: 't', link: 'https://www.taxscan.in/a/b' }, f);
    expect(r.kind).toBe('failed');
    if (r.kind !== 'posted') expect(r.error).not.toContain(TOKEN);
    expect(sent!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent!.body).not.toContain(TOKEN);
    expect(sent!.headers['LinkedIn-Version']).toBe(env.linkedin.apiVersion);
    expect(sent!.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
  });
  it('not in any log line, row, alert email or API response across success, retry and login failures', async () => {
    await camp('leak-a', at(NOW, -30));
    await camp('leak-b', at(NOW, -20));
    await camp('leak-c', at(NOW, -10));
    script = (n) => (n === 1 ? posted() : n === 2 ? { kind: 'retry', status: 500, error: 'HTTP 500' } : auth401);
    await runLinkedInTick(deps());
    const a = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGE }), postFrom: () => FROM, worker: deps() } });
    const list = await request(a).get('/api/linkedin/posts?date=2026-11-03').set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    const everything = JSON.stringify({
      logs: [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls],
      rows: await rowsOf(),
      setting: await prisma.digestSetting.findMany({ where: { key: authKey(PAGE) } }),
      mails,
      api: list.body,
    });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('SECRET-TOKEN');
  });
});

describe('8. the flag', () => {
  it('off: the cron is not started and the API answers 404 on every endpoint; the menu flag is false', async () => {
    const schedule = jest.spyOn(cron, 'schedule');
    const was = env.linkedin.enabled;
    env.linkedin.enabled = false;
    startLinkedInWorker();
    expect(schedule).not.toHaveBeenCalled();
    const a = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => false } });
    expect((await request(a).get('/api/linkedin/posts').set('Cookie', adminCookie)).status).toBe(404);
    expect((await request(a).post('/api/linkedin/posts/x/retry').set('Cookie', adminCookie)).status).toBe(404);
    expect((await request(a).post('/api/linkedin/posts/x/skip').set('Cookie', adminCookie)).status).toBe(404);
    const me = await request(loginApp).get('/api/auth/me').set('Cookie', adminCookie);
    expect(me.body.features.linkedinPosting).toBe(env.linkedin.enabled);
    env.linkedin.enabled = was;
    schedule.mockRestore();
  });
  it('on without LINKEDIN_POST_FROM (or without the page config): refuses to start and says why', () => {
    const schedule = jest.spyOn(cron, 'schedule');
    const was = { enabled: env.linkedin.enabled, from: env.linkedin.postFrom, tax: env.linkedin.pages.taxscan };
    env.linkedin.enabled = true;
    env.linkedin.postFrom = null;
    startLinkedInWorker();
    expect(schedule).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('[linkedin] refusing to start: LINKEDIN_POST_FROM');
    env.linkedin.postFrom = new Date();
    env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
    startLinkedInWorker();
    expect(schedule).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('ACCESS_TOKEN are not both set');
    env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:1', accessToken: 'x' };
    startLinkedInWorker();
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    Object.assign(env.linkedin, { enabled: was.enabled, postFrom: was.from });
    env.linkedin.pages.taxscan = was.tax;
    schedule.mockRestore();
  });
  it('the tick itself refuses (does nothing) without a go-live time', async () => {
    await camp('no-from', at(NOW, -5));
    const t = await runLinkedInTick(deps({ postFrom: null }));
    expect(t.refused).toContain('LINKEDIN_POST_FROM');
    expect(calls).toHaveLength(0);
  });
});

describe('9. the screen\'s API', () => {
  const appWith = (over: WorkerDeps = {}) => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGE }), postFrom: () => FROM, worker: deps(over) } });
  it('lists the day in push order with every status, links to posted items, and the banner data', async () => {
    const a1 = await camp('s-posted', at(NOW, -50));
    const a2 = await camp('s-failed', at(NOW, -45));
    const a3 = await camp('s-unknown', at(NOW, -40));
    const a4 = await camp('s-retrying', at(NOW, -35));
    const a5 = await camp('s-skipped', at(NOW, -30));
    await camp('s-waiting', at(NOW, -2));
    await camp('s-old', at(FROM, -90)); // pushed before go-live: not posted
    const mk = (c: { id: string; url: string }, data: object) => prisma.linkedInPost.create({ data: { page: PAGE, articleKey: c.url, campaignId: c.id, attempts: 1, ...data } as never });
    await mk(a1, { status: 'POSTED', linkedinPostId: 'urn:li:share:77', postedAt: at(NOW, -49) });
    await mk(a2, { status: 'FAILED', error: 'HTTP 422: invalid content' });
    await mk(a3, { status: 'FAILED', error: UNKNOWN_ERROR });
    await mk(a4, { status: 'PENDING', nextAttemptAt: at(NOW, 5), error: 'HTTP 429' });
    await mk(a5, { status: 'SKIPPED' });
    await prisma.digestSetting.create({ data: { key: authKey(PAGE), value: JSON.stringify({ stoppedAt: NOW.toISOString(), alertedDay: '2026-11-03', status: 401 }) } });
    const res = await request(appWith()).get('/api/linkedin/posts').set('Cookie', publisherCookie);
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-11-03');
    expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual(['NOT_POSTED', 'POSTED', 'FAILED', 'FAILED', 'RETRYING', 'SKIPPED', 'WAITING']);
    const [, p, f, u, rt] = res.body.rows;
    expect(p.postUrl).toBe('https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A77/');
    expect(f).toMatchObject({ error: 'HTTP 422: invalid content', unknownOutcome: false });
    expect(u.unknownOutcome).toBe(true);
    expect(rt).toMatchObject({ nextAttemptTime: '10:05', error: 'HTTP 429' });
    expect(res.body.counts).toMatchObject({ waiting: 2, posted: 1, failed: 2, skipped: 1, notPosted: 1, all: 7 });
    expect(res.body.login).toMatchObject({ status: 401 });
    const yesterday = await request(appWith()).get('/api/linkedin/posts?date=2026-11-02').set('Cookie', adminCookie);
    expect(yesterday.body.rows).toEqual([]); // nothing was pushed on the 2nd
  });
  it('Retry posts one failed row now (one call, then answers); Skip skips; both only on the right rows', async () => {
    const c = await camp('r-failed', at(NOW, -30));
    const row = await prisma.linkedInPost.create({ data: { page: PAGE, articleKey: c.url, campaignId: c.id, status: 'FAILED', attempts: 4, error: 'HTTP 429' } });
    const a = appWith();
    const r = await request(a).post(`/api/linkedin/posts/${row.id}/retry`).set('Cookie', adminCookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: 'POSTED' });
    expect(calls).toHaveLength(1);
    expect(await prisma.linkedInPost.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'POSTED', linkedinPostId: 'urn:li:share:1', error: null });
    expect((await request(a).post(`/api/linkedin/posts/${row.id}/retry`).set('Cookie', adminCookie)).status).toBe(409); // not failed any more
    expect((await request(a).post(`/api/linkedin/posts/${row.id}/skip`).set('Cookie', adminCookie)).status).toBe(409);
    expect((await request(a).post('/api/linkedin/posts/nope/retry').set('Cookie', adminCookie)).status).toBe(404);
    const c2 = await camp('r-skip', at(NOW, -20));
    const row2 = await prisma.linkedInPost.create({ data: { page: PAGE, articleKey: c2.url, campaignId: c2.id, status: 'FAILED', attempts: 1, error: 'x' } });
    expect((await request(a).post(`/api/linkedin/posts/${row2.id}/skip`).set('Cookie', publisherCookie)).body).toEqual({ ok: true, status: 'SKIPPED' });
    expect(calls).toHaveLength(1);
  });
  it('a Retry whose call fails again says so, and never double-posts when two taps race', async () => {
    const c = await camp('r-race', at(NOW, -30));
    const row = await prisma.linkedInPost.create({ data: { page: PAGE, articleKey: c.url, campaignId: c.id, status: 'FAILED', attempts: 4, error: 'HTTP 500' } });
    script = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return posted();
    };
    const out = await Promise.all([retryNow(row.id, deps()), retryNow(row.id, deps())]);
    expect(out.filter((o) => o.ok).length).toBe(1);
    expect(calls).toHaveLength(1);
  });
  it('roles: ADMIN and PUBLISHER read and act; no session is 401; a bad date is 400', async () => {
    const a = appWith();
    for (const cookie of [adminCookie, publisherCookie]) expect((await request(a).get('/api/linkedin/posts').set('Cookie', cookie)).status).toBe(200);
    expect((await request(a).get('/api/linkedin/posts')).status).toBe(401);
    expect((await request(a).post('/api/linkedin/posts/x/retry')).status).toBe(401);
    expect((await request(a).get('/api/linkedin/posts?date=2026-11-04').set('Cookie', adminCookie)).status).toBe(400);
    expect((await request(a).get('/api/linkedin/posts?date=2026-10-01').set('Cookie', adminCookie)).status).toBe(400);
  });
});
