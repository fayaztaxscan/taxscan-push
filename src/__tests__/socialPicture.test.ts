import request from 'supertest';
import { createApp } from '../app';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { imageId } from '../services/digest/adImages';
import { SOCIAL_PICTURE_RULES, socialImageUrl, validateSocialPicture } from '../services/social/picture';
import { commentaryWithLink, escapeLittleText } from '../services/linkedin/post';
import { postBody, type LinkedInResult } from '../services/linkedin/client';
import { postForm, photosUrl, feedUrl, type FacebookResult } from '../services/facebook/client';
import { captionWithLink } from '../services/facebook/post';
import { runLinkedInTick, resetLinkedInStops, authKey as liAuthKey, type WorkerDeps as LiDeps } from '../services/linkedin/worker';
import { runFacebookTick, resetFacebookStops, authKey as fbAuthKey, policyKey, type WorkerDeps as FbDeps } from '../services/facebook/worker';
import { cloneForResend } from '../services/pacer';
import { dispatchCampaign } from '../services/send';

/**
 * Brief 2026-11-08-social-picture: a picture uploaded on Compose goes on the push's LinkedIn + Facebook posts. Acceptance 1–9.
 * All LinkedIn / Facebook HTTP is mocked. Rows live under a private portal + private pages per run.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PORTAL = `test-pic-${RUN}`;
const LI_PAGE = `pictestli${Math.floor(Math.random() * 1e9)}`;
const FB_PAGE = `pictestfb${Math.floor(Math.random() * 1e9)}`;
const TOKEN = 'SECRET-TOKEN-pic-777';
const BEARER = `Bearer ${process.env.ADMIN_TOKEN}`;
const IST_MS = (5 * 60 + 30) * 60_000;
const NOW = new Date(Date.UTC(2026, 10, 9, 10, 0) - IST_MS); // 9 Nov 2026 10:00 IST
const FROM = new Date(NOW.getTime() - 6 * 3_600_000);

/* ---------- image bytes (headers are all the checks read; a per-call tail makes each file unique) ---------- */
let uniq = 0;
const tail = () => Buffer.from(`${RUN}-${++uniq}`);
function png(w: number, h: number, pad = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr, Buffer.alloc(pad), tail()]);
}
function jpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03]);
  return Buffer.concat([sof, Buffer.alloc(16), tail()]);
}
const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20), tail()]);

const imageIds = new Set<string>();
const app = (enabled: boolean) => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, socialPicture: { enabled: () => enabled, assetBaseUrl: () => 'https://push.example.test' } });
async function upload(buf: Buffer, o: { type?: string; name?: string; enabled?: boolean } = {}) {
  const res = await request(app(o.enabled ?? true))
    .post('/api/social-picture')
    .set('Authorization', BEARER)
    .set('Content-Type', o.type ?? 'application/octet-stream')
    .set(o.name ? { 'X-Filename': encodeURIComponent(o.name) } : {})
    .send(buf);
  if (res.body?.id) imageIds.add(res.body.id);
  return res;
}

const savedEnabled = env.social.pictureEnabled;
afterAll(async () => {
  env.social.pictureEnabled = savedEnabled;
  delete env.linkedin.pages[LI_PAGE];
  delete env.facebook.pages[FB_PAGE];
  await prisma.linkedInPost.deleteMany({ where: { page: LI_PAGE } });
  await prisma.facebookPost.deleteMany({ where: { page: FB_PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [liAuthKey(LI_PAGE), fbAuthKey(FB_PAGE), policyKey(FB_PAGE)] } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.socialImage.deleteMany({ where: { id: { in: [...imageIds] } } });
  await prisma.$disconnect();
});

/* ---------- 2, 3: upload rules ---------- */

describe('upload (acceptance 2, 3)', () => {
  it('2. accepts a 1080×1080 JPEG and a 1200×627 PNG', async () => {
    const a = await upload(jpeg(1080, 1080), { type: 'image/jpeg', name: 'diwali.jpg' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ width: 1080, height: 1080, mime: 'image/jpeg', deduped: false });
    expect(a.body.url).toBe(`https://push.example.test/social-images/${a.body.id}.jpg`);
    const b = await upload(png(1200, 627), { type: 'image/png', name: 'wide.png' });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ width: 1200, height: 627, mime: 'image/png' });
    // 4:5 portrait is the tallest accepted
    expect(validateSocialPicture(png(1080, 1350))).toMatchObject({ width: 1080, height: 1350 });
  });

  it('2. refuses 900 px wide, 1080×1600, 3 MB, a GIF and a text file renamed .png, each with a plain reason', async () => {
    const cases: [Buffer, Record<string, string>, string, RegExp][] = [
      [png(900, 900), { type: 'image/png' }, 'too_narrow', /900 px wide; it must be at least 1080 px/],
      [png(1080, 1600), { type: 'image/png' }, 'too_tall', /taller than 4:5/],
      [png(1200, 1200, 3 * 1024 * 1024), { type: 'image/png' }, 'too_big', /limit is 2 MB/],
      [gif(), { type: 'image/gif' }, 'wrong_type', /Only JPEG or PNG/],
      [Buffer.from(`just some text, not a picture ${RUN}`), { type: 'image/png', name: 'fake.png' }, 'wrong_type', /Only JPEG or PNG/],
      [png(2000, 1000), { type: 'image/png' }, 'too_wide_shape', /wider than 1\.91:1/],
      [jpeg(1080, 1080), { type: 'image/png', name: 'x.png' }, 'type_mismatch', /really a JPEG/],
    ];
    for (const [buf, o, code, msg] of cases) {
      const r = await upload(buf, o);
      expect([r.status, r.body.error]).toEqual([400, code]);
      expect(r.body.message).toMatch(msg);
    }
    expect(SOCIAL_PICTURE_RULES).toMatch(/1080 × 1080.*1200 × 627/);
  });

  it('3. the same bytes twice make one SocialImage row (sha256 id)', async () => {
    const buf = jpeg(1080, 1080);
    const a = await upload(buf, { type: 'image/jpeg' });
    const b = await upload(buf, { type: 'image/jpeg' });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.deduped).toBe(true);
    expect(a.body.id).toBe(imageId(buf));
    expect(await prisma.socialImage.count({ where: { id: a.body.id } })).toBe(1);
  });

  it('the upload needs a staff login; off = 404', async () => {
    expect((await request(app(true)).post('/api/social-picture').set('Content-Type', 'image/png').send(png(1080, 1080))).status).toBe(401);
    const off = await upload(png(1080, 1080), { enabled: false });
    expect([off.status, off.body.error]).toEqual([404, 'social_picture_off']);
    const cfg = await request(app(true)).get('/api/social-picture').set('Authorization', BEARER);
    expect(cfg.body).toMatchObject({ enabled: true, maxBytes: 2 * 1024 * 1024, minWidth: 1080 });
  });
});

/* ---------- 8: the public URL ---------- */

describe('public image URL (acceptance 8)', () => {
  it('serves the bytes with the right type and no login; an unknown id or a wrong extension is 404', async () => {
    const buf = png(1200, 627);
    const up = await upload(buf, { type: 'image/png' });
    const got = await request(app(false)).get(`/social-images/${up.body.id}.png`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toMatch(/immutable/);
    expect(got.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.compare(got.body as Buffer, buf)).toBe(0);
    expect((await request(app(true)).get(`/social-images/${'0'.repeat(64)}.png`)).status).toBe(404);
    expect((await request(app(true)).get(`/social-images/${up.body.id}.jpg`)).status).toBe(404);
    expect((await request(app(true)).get('/social-images/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });
});

/* ---------- 1, 6, 9: Compose / send / schedule / backfill / test device ---------- */

describe('send path (acceptance 1, 6, 9)', () => {
  const sendBody = (over: Record<string, unknown> = {}) => ({
    portal: PORTAL,
    title: `Pic push ${RUN}`,
    body: 'b',
    url: 'https://www.taxscan.in/pricing',
    target: { type: 'all' },
    scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    ...over,
  });
  let pic: string;
  beforeAll(async () => {
    pic = (await upload(jpeg(1080, 1080), { type: 'image/jpeg' })).body.id;
  });

  it('6. a scheduled Compose push keeps its picture; a morning-backfill clone carries the same socialImageId', async () => {
    env.social.pictureEnabled = true;
    const res = await request(app(true)).post('/api/send').set('Authorization', BEARER).send(sendBody({ socialImageId: pic }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SCHEDULED');
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.campaignId } });
    expect(c.socialImageId).toBe(pic);
    const clone = await cloneForResend(c);
    expect(clone.socialImageId).toBe(pic);
    expect(clone.status).toBe('DRAFT');
    // an immediate dispatch stores it too (no subscribers in this portal: nothing is sent)
    const d = await dispatchCampaign({ portal: PORTAL, title: 't', body: 'b', url: 'https://www.taxscan.in/pricing', target: { type: 'all' }, breaking: true, socialImageId: pic }, { sender: async () => ({ ok: true }) as never });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: d.campaignId } })).socialImageId).toBe(pic);
    // an id that was never uploaded is refused
    const bad = await request(app(true)).post('/api/send').set('Authorization', BEARER).send(sendBody({ socialImageId: 'a'.repeat(64) }));
    expect([bad.status, bad.body.error]).toEqual([400, 'unknown_picture']);
  });

  it('1. setting off: /api/send ignores socialImageId (stored as null), /me says off', async () => {
    env.social.pictureEnabled = false;
    const res = await request(app(false)).post('/api/send').set('Authorization', BEARER).send(sendBody({ socialImageId: pic }));
    expect(res.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.campaignId } })).socialImageId).toBeNull();
    // an unknown id is not even looked at while off
    const unknown = await request(app(false)).post('/api/send').set('Authorization', BEARER).send(sendBody({ socialImageId: 'b'.repeat(64) }));
    expect(unknown.status).toBe(200);
  });

  it('9. Test on this device with a picture attached creates no campaign and no social post rows', async () => {
    env.social.pictureEnabled = true;
    const title = `Test device pic ${RUN}`;
    const before = await Promise.all([prisma.campaign.count(), prisma.linkedInPost.count(), prisma.facebookPost.count()]);
    const t = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, sender: async () => ({ ok: true }) as never });
    const res = await request(t)
      .post('/api/send/test-device')
      .set('Authorization', BEARER)
      .send({ subscription: { endpoint: 'https://push.example.test/ep', keys: { p256dh: 'p', auth: 'a' } }, title, body: 'b', url: 'https://www.taxscan.in/pricing', socialImageId: pic });
    expect(res.status).toBeLessThan(500);
    expect(await prisma.campaign.count({ where: { title } })).toBe(0);
    const after = await Promise.all([prisma.campaign.count(), prisma.linkedInPost.count(), prisma.facebookPost.count()]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });
});

/* ---------- 4, 5, 7, 1: the workers ---------- */

let seq = 0;
async function camp(o: { picture?: string | null; url?: string } = {}) {
  return prisma.campaign.create({
    data: {
      portal: PORTAL,
      title: 'Supreme Court [Read Order] rules on ITC (2)',
      body: 'Body of the push',
      url: o.url ?? `https://www.taxscan.in/gst/pic-story-${RUN}-${++seq}`,
      target: {},
      status: 'SENT',
      lastSentAt: new Date(NOW.getTime() - 5 * 60_000),
      authority: 'Supreme Court',
      categories: ['GST'],
      socialImageId: o.picture ?? null,
    },
  });
}

describe('LinkedIn (acceptance 4, 7, 1)', () => {
  let calls: Parameters<NonNullable<LiDeps['post']>>[0][] = [];
  let uploads: { bytes: Uint8Array; contentType: string }[] = [];
  let script: (n: number) => LinkedInResult = () => ({ kind: 'posted', postId: 'urn:li:share:1' });
  let uploadAnswer: Awaited<ReturnType<NonNullable<LiDeps['uploadImage']>>> = { kind: 'ok', urn: 'urn:li:image:PIC1' };
  const deps = (over: LiDeps = {}): LiDeps => ({
    now: () => NOW,
    post: async (r) => {
      calls.push(r);
      return script(calls.length);
    },
    uploadImage: async (r) => {
      uploads.push({ bytes: r.bytes, contentType: r.contentType });
      return uploadAnswer;
    },
    waitImage: async () => ({ ok: true }),
    fetchCms: async () => null,
    fetchImage: async () => ({ ok: false, reason: 'host' }),
    emailSender: async () => ({ ok: true }),
    isEmailConfigured: () => true,
    recipients: async () => [],
    portals: { [PORTAL]: LI_PAGE },
    postFrom: FROM,
    quiet: { start: '23:00', end: '07:00' },
    ...over,
  });
  let pic: string;
  let picBytes: Buffer;
  beforeAll(async () => {
    picBytes = jpeg(1080, 1080);
    pic = (await upload(picBytes, { type: 'image/jpeg' })).body.id;
  });
  beforeEach(async () => {
    env.linkedin.pages[LI_PAGE] = { orgUrn: 'urn:li:organization:77', accessToken: TOKEN };
    resetLinkedInStops();
    calls = [];
    uploads = [];
    script = () => ({ kind: 'posted', postId: 'urn:li:share:1' });
    uploadAnswer = { kind: 'ok', urn: 'urn:li:image:PIC1' };
    await prisma.linkedInPost.deleteMany({ where: { page: LI_PAGE } });
    await prisma.campaign.deleteMany({ where: { portal: PORTAL, status: 'SENT' } });
  });
  const row = () => prisma.linkedInPost.findFirstOrThrow({ where: { page: LI_PAGE } });

  it('4. picture set: uploads OUR bytes and creates an image post whose commentary holds the tagged link', async () => {
    await camp({ picture: pic });
    await runLinkedInTick(deps({ socialPicture: true }));
    expect(uploads).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(uploads[0].bytes), picBytes)).toBe(0);
    expect(uploads[0].contentType).toBe('image/jpeg');
    expect(calls).toHaveLength(1);
    expect(calls[0].image).toBe('urn:li:image:PIC1');
    expect(calls[0].commentary).toContain(escapeLittleText(calls[0].link));
    expect(calls[0].link).toMatch(/utm_source=taxscan-linkedin/);
    // the link line sits before the hashtags
    expect(calls[0].commentary.indexOf(escapeLittleText(calls[0].link))).toBeLessThan(calls[0].commentary.indexOf('{hashtag|'));
    const body = postBody(calls[0]);
    expect(body.content).toEqual({ media: { id: 'urn:li:image:PIC1', altText: 'Supreme Court [Read Order] rules on ITC (2)' } });
    expect((await row()).status).toBe('POSTED');
    expect((await row()).error).toBeNull();
  });

  it('4 + 1. no picture, or the setting off with a picture stored: the request is byte-for-byte today’s', async () => {
    const c = await camp({ picture: pic });
    await runLinkedInTick(deps({ socialPicture: false }));
    const off = calls[0];
    expect(uploads).toHaveLength(0);
    expect(off.image).toBeUndefined();
    // the same campaign without a picture, setting on
    await prisma.linkedInPost.deleteMany({ where: { page: LI_PAGE } });
    await prisma.campaign.update({ where: { id: c.id }, data: { socialImageId: null } });
    calls = [];
    await runLinkedInTick(deps({ socialPicture: true }));
    expect(uploads).toHaveLength(0);
    expect(JSON.stringify(postBody(calls[0]))).toBe(JSON.stringify(postBody(off)));
    expect(calls[0]).toEqual(off);
  });

  it('7. a failed image upload falls back to today’s link post and says why; a 4xx on the image post does too', async () => {
    await camp({ picture: pic });
    uploadAnswer = { kind: 'soft', reason: 'put_http_500' };
    await runLinkedInTick(deps({ socialPicture: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0].image).toBeUndefined();
    const r = await row();
    expect(r.status).toBe('POSTED');
    expect(r.error).toMatch(/posted as a link post.*put_http_500/);

    await prisma.linkedInPost.deleteMany({ where: { page: LI_PAGE } });
    calls = [];
    uploadAnswer = { kind: 'ok', urn: 'urn:li:image:PIC2' };
    script = (n) => (n === 1 ? { kind: 'failed', status: 400, error: 'HTTP 400' } : { kind: 'posted', postId: 'urn:li:share:2' });
    await runLinkedInTick(deps({ socialPicture: true }));
    expect(calls).toHaveLength(2);
    expect(calls[0].image).toBe('urn:li:image:PIC2');
    expect(calls[1].image).toBeUndefined();
    expect((await row()).error).toMatch(/rejected_400/);
  });

  it('a picture that is gone (e.g. after a restore) posts the ordinary link post', async () => {
    await camp({ picture: 'c'.repeat(64) });
    await runLinkedInTick(deps({ socialPicture: true }));
    expect(uploads).toHaveLength(0);
    expect(calls[0].image).toBeUndefined();
    expect((await row()).status).toBe('POSTED');
  });

  it('commentaryWithLink: before the hashtags, escaped; null when too long', () => {
    const link = 'https://www.taxscan.in/a?utm_source=x_y';
    expect(commentaryWithLink('Head\n\n{hashtag|\\#|taxscan}', link)).toBe(`Head\n\n${escapeLittleText(link)}\n\n{hashtag|\\#|taxscan}`);
    expect(commentaryWithLink('Head only', link)).toBe(`Head only\n\n${escapeLittleText(link)}`);
    expect(commentaryWithLink('x'.repeat(2990), link)).toBeNull();
  });
});

describe('Facebook (acceptance 5, 1)', () => {
  let calls: Parameters<NonNullable<FbDeps['post']>>[0][] = [];
  let script: (n: number) => FacebookResult = () => ({ kind: 'posted', postId: '1_2' });
  const deps = (over: FbDeps = {}): FbDeps => ({
    now: () => NOW,
    post: async (r) => {
      calls.push(r);
      return script(calls.length);
    },
    fetchCms: async () => null,
    emailSender: async () => ({ ok: true }),
    isEmailConfigured: () => true,
    recipients: async () => [],
    portals: { [PORTAL]: FB_PAGE },
    postFrom: FROM,
    quiet: { start: '23:00', end: '07:00' },
    minGapMinutes: 0,
    dailyCap: 30,
    ...over,
  });
  let pic: string;
  beforeAll(async () => {
    pic = (await upload(png(1200, 627), { type: 'image/png' })).body.id;
  });
  beforeEach(async () => {
    env.facebook.pages[FB_PAGE] = { pageId: '555000', accessToken: TOKEN };
    resetFacebookStops();
    calls = [];
    script = () => ({ kind: 'posted', postId: '1_2' });
    await prisma.facebookPost.deleteMany({ where: { page: FB_PAGE } });
    await prisma.campaign.deleteMany({ where: { portal: PORTAL, status: 'SENT' } });
  });
  const row = () => prisma.facebookPost.findFirstOrThrow({ where: { page: FB_PAGE } });

  it('5. picture set: /photos with url = our public image URL and the caption holding the tagged link', async () => {
    await camp({ picture: pic });
    await runFacebookTick(deps({ socialPicture: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0].photoUrl).toBe(socialImageUrl({ id: pic, mime: 'image/png' }));
    expect(calls[0].message).toContain(calls[0].link);
    expect(calls[0].link).toMatch(/utm_source=taxscan-facebook/);
    const form = new URLSearchParams(postForm(calls[0]));
    expect(form.get('url')).toBe(calls[0].photoUrl);
    expect(form.get('caption')).toBe(calls[0].message);
    expect(form.get('link')).toBeNull();
    expect(photosUrl('555000')).toMatch(/\/555000\/photos$/);
    expect((await row()).status).toBe('POSTED');
  });

  it('5 + 1. no picture, or the setting off: today’s /feed call, unchanged', async () => {
    const c = await camp({ picture: pic });
    await runFacebookTick(deps({ socialPicture: false }));
    const off = calls[0];
    expect(off.photoUrl).toBeUndefined();
    const form = new URLSearchParams(postForm(off));
    expect([...form.keys()].sort()).toEqual(['access_token', 'link', 'message']);
    expect(feedUrl('555000')).toMatch(/\/555000\/feed$/);
    await prisma.facebookPost.deleteMany({ where: { page: FB_PAGE } });
    await prisma.campaign.update({ where: { id: c.id }, data: { socialImageId: null } });
    calls = [];
    await runFacebookTick(deps({ socialPicture: true }));
    expect(calls[0]).toEqual(off);
  });

  it('a photo post refused with a plain 4xx is repeated once as today’s link post, and the row says why', async () => {
    await camp({ picture: pic });
    script = (n) => (n === 1 ? { kind: 'failed', status: 400, code: 324, subcode: null, error: 'HTTP 400 code 324' } : { kind: 'posted', postId: '1_3' });
    await runFacebookTick(deps({ socialPicture: true }));
    expect(calls).toHaveLength(2);
    expect(calls[0].photoUrl).toBeDefined();
    expect(calls[1].photoUrl).toBeUndefined();
    const r = await row();
    expect(r.status).toBe('POSTED');
    expect(r.error).toMatch(/posted as a link post.*rejected_400_code_324/);
  });

  it('captionWithLink puts the link before the hashtags', () => {
    expect(captionWithLink('Head\n\n#GST #taxscan', 'https://x.test/a')).toBe('Head\n\nhttps://x.test/a\n\n#GST #taxscan');
    expect(captionWithLink('Head', 'https://x.test/a')).toBe('Head\n\nhttps://x.test/a');
  });
});
