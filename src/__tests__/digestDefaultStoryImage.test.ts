import bcrypt from 'bcrypt';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { validateImage } from '../services/digest/adImages';
import { clearDefaultStoryImage, defaultStoryKey, resolveDefaultStoryImageUrl, setDefaultStoryImage } from '../services/digest/defaultStoryImage';
import { renderDigestContent } from '../services/digest/content';
import * as renderer from '../services/digest/renderer';
import type { FrozenItem } from '../services/digest/builder';
import { buildBackup } from '../services/backup';
import { ensureTestAds, deleteTestAds } from './digestAdFixtures';
import { FakeSender } from './digestFakeSender';

/**
 * Brief 2026-10-30-digest-polish-old-look, decision A (backend): the default story picture. Exactly 1600 x 840,
 * JPEG/PNG, <= 250 KB; bytes in DigestAdImage, choice in DigestSetting; ADMIN + PUBLISHER; audited; resolved and
 * frozen at the build; backed up.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-story-';
const PASSWORD = 'digest-story-test-pw-1';
const AT = new Date(Date.UTC(2026, 9, 22, 1, 0));
const RUN_DATE = new Date(Date.UTC(2026, 9, 22));
let n = 0;
const newPortal = () => `${PORTAL_PREFIX}${RUN}-${++n}`;

const cfg = (): DigestEnv =>
  parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, Kochi, Kerala 682001, India',
  });

const png = (width: number, height: number, pad = 200, fill = 7): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(pad, fill)]);
};
const jpeg = (width: number, height: number, pad = 200, fill = 1): Buffer => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(pad, fill), Buffer.from([0xff, 0xd9])]);
};
/** A unique-by-bytes valid story picture. */
let salt = Date.now() % 100000;
const story = () => jpeg(1600, 840, 400 + ++salt);

const items = (count: number): FrozenItem[] =>
  Array.from({ length: count }, (_, k) => ({
    rank: k + 1,
    section: 'MAIN' as const,
    articleKey: `k${k + 1}`,
    campaignId: null,
    title: `Headline number ${k + 1} about a High Court ruling`,
    url: `https://www.taxscan.in/gst/story-${k + 1}/${5000 + k + 1}`,
    authority: null,
    category: 'GST',
    excerpt: `Summary ${k + 1}.`,
    capturedAt: new Date(AT),
    readRate: null,
    imageUrl: null,
  }));

const userIds: string[] = [];
const imageIds = new Set<string>();
const cookies: Record<string, string> = {};
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const appFor = (portal: string) =>
  createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: cfg(), portal, clock: () => AT, sender: new FakeSender(), alerts: false } });

async function loginAs(role: UserRole): Promise<string> {
  const u: User = await prisma.user.create({ data: { email: `digest-story-${role.toLowerCase()}-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}

beforeAll(async () => {
  for (const role of ['ADMIN', 'PUBLISHER'] as UserRole[]) cookies[role] = await loginAs(role);
});

afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestSetting.deleteMany({ where: { key: { startsWith: PORTAL_PREFIX } } });
  await deleteTestAds(PORTAL_PREFIX);
  await prisma.digestAdImage.deleteMany({ where: { id: { in: [...imageIds] } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const upload = async (portal: string, bytes: Buffer, role: string = 'ADMIN', type = 'image/jpeg') => {
  const r = await request(appFor(portal)).post('/api/digest/default-story-image').set('Cookie', cookies[role]).set('Content-Type', type).send(bytes);
  const id = r.body?.image?.id;
  if (id) imageIds.add(id);
  return r;
};
const get = (portal: string, role = 'ADMIN') => request(appFor(portal)).get('/api/digest/default-story-image').set('Cookie', cookies[role]);
const del = (portal: string, role = 'ADMIN') => request(appFor(portal)).delete('/api/digest/default-story-image').set('Cookie', cookies[role]);

describe('validation (pure)', () => {
  it('accepts exactly 1600 x 840 as JPEG or PNG', () => {
    expect(validateImage(jpeg(1600, 840), {}, 'story')).toMatchObject({ mime: 'image/jpeg', width: 1600, height: 840 });
    expect(validateImage(png(1600, 840), {}, 'story')).toMatchObject({ mime: 'image/png', width: 1600, height: 840 });
  });
  it('refuses 1600 x 841 and 1200 x 628, naming the required and the actual size', () => {
    expect(() => validateImage(jpeg(1600, 841), {}, 'story')).toThrow(/exactly 1600 × 840 px.*1600 × 841 px/);
    expect(() => validateImage(jpeg(1200, 628), {}, 'story')).toThrow(/exactly 1600 × 840 px.*1200 × 628 px/);
  });
});

describe('the route', () => {
  it('GET with nothing set: image null and the requirement', async () => {
    const r = await get(newPortal());
    expect(r.status).toBe(200);
    expect(r.body.image).toBeNull();
    expect(r.body.required).toMatchObject({ width: 1600, height: 840, maxKb: 250 });
  });

  it('ADMIN and PUBLISHER can upload, replace and remove; anonymous cannot', async () => {
    const portal = newPortal();
    const a = await upload(portal, story(), 'ADMIN');
    expect(a.status).toBe(201);
    expect(a.body.image).toMatchObject({ width: 1600, height: 840, mime: 'image/jpeg' });
    expect(a.body.image.url).toMatch(/\/email-assets\/[a-f0-9]{64}\.jpg$/);
    const b = await upload(portal, png(1600, 840, 500 + ++salt), 'PUBLISHER', 'image/png');
    expect(b.status).toBe(200);
    expect(b.body.image.id).not.toBe(a.body.image.id);
    expect((await get(portal, 'PUBLISHER')).body.image.id).toBe(b.body.image.id);
    expect((await del(portal, 'PUBLISHER')).body.image).toBeNull();
    expect((await get(portal)).body.image).toBeNull();
    expect((await request(appFor(portal)).get('/api/digest/default-story-image')).status).toBe(401);
    expect((await request(appFor(portal)).post('/api/digest/default-story-image').send(story())).status).toBe(401);
    expect((await request(appFor(portal)).delete('/api/digest/default-story-image')).status).toBe(401);
  });

  it('refuses wrong sizes, a file over 250 KB and a file over the body limit; nothing is stored', async () => {
    const portal = newPortal();
    const w841 = await upload(portal, jpeg(1600, 841, 300 + ++salt));
    expect(w841.status).toBe(400);
    expect(w841.body.error).toBe('wrong_size');
    expect(w841.body.message).toMatch(/exactly 1600 × 840 px.*1600 × 841 px/);
    const w1200 = await upload(portal, jpeg(1200, 628, 300 + ++salt));
    expect(w1200.body.message).toMatch(/exactly 1600 × 840 px.*1200 × 628 px/);
    const big = await upload(portal, jpeg(1600, 840, 255 * 1024));
    expect(big.status).toBe(400);
    expect(big.body.error).toBe('too_big');
    expect(big.body.message).toMatch(/limit is 250 KB/);
    const huge = await upload(portal, Buffer.alloc(320 * 1024, 1));
    expect(huge.status).toBe(413);
    expect(huge.body.message).toMatch(/250 KB/);
    const gif = await upload(portal, Buffer.from('GIF89a' + 'x'.repeat(100)));
    expect(gif.status).toBe(400);
    expect((await get(portal)).body.image).toBeNull();
  });

  it('is audited (DIGEST_TEMPLATE_SAVED, resourceType DigestSetting) with no URL in the metadata', async () => {
    const portal = newPortal();
    await upload(portal, story());
    await del(portal);
    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'DigestSetting', resourceId: defaultStoryKey(portal) }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => (r.metadata as { action: string }).action)).toEqual(['set', 'removed']);
    expect(rows.every((r) => r.action === 'DIGEST_TEMPLATE_SAVED')).toBe(true);
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/https?:/);
  });

  it('is per portal', async () => {
    const p1 = newPortal();
    const p2 = newPortal();
    await upload(p1, story());
    expect((await get(p2)).body.image).toBeNull();
  });
});

describe('freeze at the build', () => {
  const build = async (portal: string) => {
    const spy = jest.spyOn(renderer, 'renderDigest');
    try {
      await renderDigestContent({ runId: 'r1', runDate: RUN_DATE, audience: 'FREE', items: items(5), cfg: cfg(), portal, at: AT });
      return spy.mock.calls[0][0].defaultStoryImageUrl;
    } finally {
      spy.mockRestore();
    }
  };

  it('none set -> null; set -> the URL; a later upload or removal does not change what was built', async () => {
    const portal = newPortal();
    await ensureTestAds(portal);
    expect(await build(portal)).toBeNull();

    const first = await setDefaultStoryImage(portal, story(), {}, null);
    imageIds.add(first.stored.id);
    const builtUrl = await build(portal);
    expect(builtUrl).toMatch(new RegExp(`/email-assets/${first.stored.id}\\.jpg$`));

    const second = await setDefaultStoryImage(portal, story(), {}, null);
    imageIds.add(second.stored.id);
    expect(second.previousId).toBe(first.stored.id);
    // the built run's html is stored once and never re-rendered: its URL is still the first image, which stays servable
    expect(await prisma.digestAdImage.count({ where: { id: first.stored.id } })).toBe(1);
    expect(await resolveDefaultStoryImageUrl(portal, 'https://push.taxscan.in')).toContain(second.stored.id);
    expect(builtUrl).toContain(first.stored.id);

    expect(await clearDefaultStoryImage(portal)).toBe(second.stored.id);
    expect(await build(portal)).toBeNull();
    expect(await prisma.digestAdImage.count({ where: { id: second.stored.id } })).toBe(1);
  });
});

describe('backup', () => {
  it('carries the DigestSetting row', async () => {
    const portal = newPortal();
    const s = await setDefaultStoryImage(portal, story(), {}, null);
    imageIds.add(s.stored.id);
    const { body } = await buildBackup({ now: AT });
    const lines = body.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].tables).toContain('DigestSetting');
    expect(lines[0].version).toBe(2);
    const row = lines.find((l) => l._table === 'DigestSetting' && l.key === defaultStoryKey(portal));
    expect(row).toMatchObject({ value: s.stored.id });
  });
});
