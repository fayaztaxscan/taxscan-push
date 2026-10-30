import bcrypt from 'bcrypt';
import request from 'supertest';
import type { DigestAudience, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, awaitDigestAlerts, ensureRun } from '../services/digest/runner';
import { collapseRows, type DigestSelection, type FrozenItem } from '../services/digest/builder';
import {
  AdInputSchema,
  AdSlotError,
  assertPlacementsAllowed,
  assignAds,
  coverageOf,
  loadAdPool,
  pickAds,
  whyIneligible,
  type PoolAd,
} from '../services/digest/ads';
import { MAX_IMAGE_BYTES, MAX_IMAGE_WIDTH, imageId, validateImage } from '../services/digest/adImages';
import { imageWeight, renderDigestContent } from '../services/digest/content';
import { RenderError, renderDigest, type BuildContent, type RenderAd } from '../services/digest/renderer';
import { digestStatus } from '../services/digest/status';
import { alertCopy } from '../services/digest/alerts';
import { FakeSender } from './digestFakeSender';

/**
 * Email digest task 9 (docs/EMAIL_DIGEST_DESIGN.md §1 #11–16, §3, §4 ads.ts,
 * §6, §7 Ads, §9, §10): house ads. Every acceptance item, both directions where
 * a guard exists. Dev DB rows live under a unique `test-digest-ads-*` portal and
 * are removed afterwards; nothing is sent (FakeSender).
 */

const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-ads-';
const PASSWORD = 'digest-ads-test-pw-1';
const QUIET = { start: '23:00', end: '07:00' };
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const IST = (h: number, min = 0, day = 22) => new Date(Date.UTC(2026, 9, day, h, min) - (5 * 60 + 30) * 60_000);
const AT = IST(6, 30);
const RUN_DATE = new Date(Date.UTC(2026, 9, 22));

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, Kochi, Kerala 682001, India',
    ...over,
  });
}

let n = 0;
const newPortal = () => `${PORTAL_PREFIX}${RUN}-${++n}`;

/* ------------------------------------------------------------------ */
/* Pure fixtures                                                       */
/* ------------------------------------------------------------------ */

function ad(o: Partial<PoolAd> = {}): PoolAd {
  const id = o.id ?? `ad${++n}`;
  return {
    id,
    name: `Ad ${id}`,
    kind: 'HOUSE',
    headline: `Headline ${id}`,
    altText: `Alt ${id}`,
    body: null,
    ctaText: 'Buy now',
    linkUrl: `https://shop.taxscan.in/p/${id}`,
    audience: 'ALL',
    topic: null,
    slots: [],
    priority: 0,
    isSlotDefault: false,
    startsAt: null,
    endsAt: null,
    status: 'ACTIVE',
    imageId: null,
    image: null,
    lastPlacedAt: null,
    ...o,
  };
}

function item(i: number, o: Partial<FrozenItem> = {}): FrozenItem {
  return {
    rank: i,
    section: 'MAIN',
    articleKey: `article:${9000 + i}`,
    campaignId: null,
    title: `High Court ruling ${i} on assessment`,
    url: `https://www.taxscan.in/top-stories/ruling-${i}/${9000 + i}`,
    authority: 'Bombay High Court',
    category: 'Income Tax',
    excerpt: null,
    capturedAt: new Date('2026-10-21T10:00:00Z'),
    readRate: null,
    ...o,
  };
}
const items = (count: number, o: Partial<FrozenItem> = {}) => Array.from({ length: count }, (_, i) => item(i + 1, o));

const pick = (pool: PoolAd[], audience: DigestAudience = 'FREE', slots = [1, 2, 3], its: FrozenItem[] = []) =>
  pickAds({ slots, audience, items: its, at: AT, pool });
const idsBySlot = (p: ReturnType<typeof pick>) => Object.fromEntries(p.map((x) => [x.slot, x.ad.id]));

/* ------------------------------------------------------------------ */
/* DB fixtures                                                         */
/* ------------------------------------------------------------------ */

async function dbAd(portal: string, o: Partial<{ name: string; kind: string; audience: string; slots: number[]; priority: number; isSlotDefault: boolean; linkUrl: string; status: string; startsAt: Date | null; endsAt: Date | null; imageId: string | null; topic: string | null }> = {}) {
  return prisma.digestAd.create({
    data: {
      portal,
      name: o.name ?? `DB ad ${++n}`,
      kind: o.kind ?? 'HOUSE',
      headline: 'Learn GST litigation',
      altText: 'Course banner',
      ctaText: 'Enrol now',
      linkUrl: o.linkUrl ?? `https://academy.taxscan.in/course-${n}`,
      audience: o.audience ?? 'ALL',
      slots: o.slots ?? [],
      priority: o.priority ?? 0,
      isSlotDefault: o.isSlotDefault ?? false,
      status: o.status ?? 'ACTIVE',
      startsAt: o.startsAt ?? null,
      endsAt: o.endsAt ?? null,
      imageId: o.imageId ?? null,
      topic: o.topic ?? null,
    },
  });
}

function selection(perAudience: Record<DigestAudience, FrozenItem[]>): DigestSelection {
  return {
    windowStart: IST(6, 30, 21),
    windowEnd: AT,
    candidateCount: perAudience.FREE.length,
    outcome: 'ok',
    perAudience,
    mainCounts: { FREE: perAudience.FREE.length, PREMIUM: perAudience.PREMIUM.length },
    rows: collapseRows(perAudience),
    reads: { used: false, source: 'test', note: null },
    droppedDead: 0,
  };
}

async function buildRun(portal: string, its: FrozenItem[], c = cfg(), extra: { buildContent?: BuildContent; now?: Date } = {}) {
  const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
  const sender = new FakeSender();
  await advanceRun(run.id, 'cron', {
    sender,
    now: extra.now ?? AT,
    cfg: c,
    quiet: QUIET,
    alerts: false,
    selectItems: async () => selection({ FREE: its, PREMIUM: its }),
    ...(extra.buildContent ? { buildContent: extra.buildContent } : {}),
  });
  return { run, sender };
}

/** A minimal PNG: signature + IHDR (width × height). Only the header is read. */
function png(width: number, height = 100, pad = 200): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(pad, 7)]);
}
/** A minimal JPEG: SOI, an APP0 segment, then SOF0 with height/width, EOI. */
function jpeg(width: number, height = 100, pad = 200): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(pad, 1), Buffer.from([0xff, 0xd9])]);
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

const userIds: string[] = [];
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });

async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({
    data: { email: `digest-ads-${role.toLowerCase()}-${RUN}-${++n}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true },
  });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
const appFor = (portal: string, c = cfg()) =>
  createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: c, portal, clock: () => AT, sender: new FakeSender(), alerts: false } });

const createdImageIds = new Set<string>();

beforeAll(async () => {
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
});

afterAll(async () => {
  await awaitDigestAlerts();
  const ads = await prisma.digestAd.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true } });
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true } });
  const resourceIds = [...ads.map((a) => a.id), ...runs.map((r) => r.id)];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    if (resourceIds.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${resourceIds}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestAdPlacement.deleteMany({ where: { ad: { portal: { startsWith: PORTAL_PREFIX } } } });
  await prisma.digestAd.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestAdImage.deleteMany({ where: { id: { in: [...createdImageIds] } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/* ================================================================== */
/* pickAds: the rule                                                   */
/* ================================================================== */

describe('ACCEPT: Premium never receives a SUBSCRIPTION ad (both directions)', () => {
  const sub = () => ad({ id: 'sub', kind: 'SUBSCRIPTION', audience: 'ALL', priority: 100 });
  it('audience ALL + kind SUBSCRIPTION: placed for FREE (it wins on priority)', () => {
    const p = pick([sub(), ad({ id: 'h1' }), ad({ id: 'h2' })], 'FREE');
    expect(p.map((x) => x.ad.id)).toContain('sub');
  });
  it('the same pool for PREMIUM: never placed; the slot is filled from the pool instead', () => {
    const p = pick([sub(), ad({ id: 'h1' }), ad({ id: 'h2' }), ad({ id: 'h3' })], 'PREMIUM');
    expect(p.map((x) => x.ad.id)).not.toContain('sub');
    expect(p).toHaveLength(3);
  });
  it('even as a slot default, even audience PREMIUM_ONLY in the data: never for PREMIUM', () => {
    const pool = [ad({ id: 'subdef', kind: 'SUBSCRIPTION', audience: 'PREMIUM_ONLY', isSlotDefault: true })];
    expect(whyIneligible(pool[0], 'PREMIUM', 1, AT)).toBe('subscription_guard');
    expect(() => pick(pool, 'PREMIUM', [1])).toThrow(AdSlotError);
  });
  it('the check on finished placements refuses it too (render/freeze guard)', () => {
    expect(() => assertPlacementsAllowed('PREMIUM', [{ slot: 1, kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' }])).toThrow(/never go to Premium/);
    expect(() => assertPlacementsAllowed('FREE', [{ slot: 1, kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' }])).not.toThrow();
  });
  it('the renderer refuses to draw it for PREMIUM and draws it for FREE', () => {
    const ra: RenderAd = { slot: 3, adId: 'sub', kind: 'SUBSCRIPTION', headline: 'Subscribe', body: null, ctaText: 'Subscribe now', linkUrl: 'https://www.taxscan.in/subscribe', altText: 'x', image: null };
    const others: RenderAd[] = [{ ...ra, slot: 1, adId: 'h', kind: 'HOUSE' }];
    const base = { items: items(5), runDate: RUN_DATE, cfg: cfg(), ads: [...others, ra] };
    expect(() => renderDigest({ ...base, audience: 'PREMIUM' })).toThrow(RenderError);
    expect(renderDigest({ ...base, audience: 'FREE' }).html).toContain('Subscribe now');
  });
  it('save: SUBSCRIPTION + PREMIUM_ONLY is rejected as a contradiction', () => {
    const r = AdInputSchema.safeParse({ name: 'x', kind: 'SUBSCRIPTION', headline: 'h', altText: 'a', ctaText: 'c', linkUrl: 'https://www.taxscan.in/s', audience: 'PREMIUM_ONLY' });
    expect(r.success).toBe(false);
  });
});

describe('eligibility', () => {
  it('date window: not started / ended (end is exclusive) / inside', () => {
    const before = ad({ startsAt: new Date(AT.getTime() + 1) });
    const ended = ad({ endsAt: AT });
    const inside = ad({ startsAt: new Date(AT.getTime() - 1000), endsAt: new Date(AT.getTime() + 1000) });
    expect(whyIneligible(before, 'FREE', 1, AT)).toBe('not_started');
    expect(whyIneligible(ended, 'FREE', 1, AT)).toBe('ended');
    expect(whyIneligible(inside, 'FREE', 1, AT)).toBeNull();
  });
  it('status and audience', () => {
    expect(whyIneligible(ad({ status: 'PAUSED' }), 'FREE', 1, AT)).toBe('not_active');
    expect(whyIneligible(ad({ status: 'ARCHIVED' }), 'FREE', 1, AT)).toBe('not_active');
    expect(whyIneligible(ad({ audience: 'FREE_ONLY' }), 'PREMIUM', 1, AT)).toBe('audience');
    expect(whyIneligible(ad({ audience: 'PREMIUM_ONLY' }), 'FREE', 1, AT)).toBe('audience');
    expect(whyIneligible(ad({ audience: 'PREMIUM_ONLY' }), 'PREMIUM', 1, AT)).toBeNull();
  });
  it('slot allow-list: an ad for slot 3 never goes in slot 1; empty = any slot', () => {
    expect(whyIneligible(ad({ slots: [3] }), 'FREE', 1, AT)).toBe('slot');
    expect(whyIneligible(ad({ slots: [3] }), 'FREE', 3, AT)).toBeNull();
    const p = pick([ad({ id: 'only3', slots: [3], priority: 99 }), ad({ id: 'a' }), ad({ id: 'b' })]);
    expect(idsBySlot(p)[3]).toBe('only3');
    expect(AdInputSchema.safeParse({ name: 'x', kind: 'HOUSE', headline: 'h', altText: 'a', ctaText: 'c', linkUrl: 'https://www.taxscan.in/s', audience: 'ALL', slots: [4] }).success).toBe(false);
  });
  it('an off-allowlist link is DROPPED at render: the next ad fills the slot; alone, the build fails closed', () => {
    const evil = ad({ id: 'evil', linkUrl: 'https://evil.example.com/x', priority: 100 });
    expect(whyIneligible(evil, 'FREE', 1, AT)).toBe('link_not_allowed');
    expect(pick([evil, ad({ id: 'ok' })], 'FREE', [1]).map((x) => x.ad.id)).toEqual(['ok']);
    expect(() => pick([evil], 'FREE', [1])).toThrow(AdSlotError);
  });
  it('an ad whose image row is gone is not placed', () => {
    expect(whyIneligible(ad({ imageId: 'f'.repeat(64), image: null }), 'FREE', 1, AT)).toBe('image_missing');
  });
});

describe('ordering and rotation', () => {
  it('priority first', () => {
    const p = pick([ad({ id: 'low', priority: 1 }), ad({ id: 'high', priority: 9 }), ad({ id: 'mid', priority: 5 })], 'FREE', [1]);
    expect(p[0].ad.id).toBe('high');
  });
  it('same priority: least recently placed first, never-placed before any', () => {
    const recent = ad({ id: 'recent', lastPlacedAt: new Date(AT.getTime() - 3_600_000) });
    const old = ad({ id: 'old', lastPlacedAt: new Date(AT.getTime() - 86_400_000 * 3) });
    expect(pick([recent, old], 'FREE', [1])[0].ad.id).toBe('old');
    expect(pick([recent, old, ad({ id: 'never' })], 'FREE', [1])[0].ad.id).toBe('never');
  });
  it('priority beats rotation', () => {
    const p = pick([ad({ id: 'fresh-high', priority: 5, lastPlacedAt: AT }), ad({ id: 'stale-low', priority: 1 })], 'FREE', [1]);
    expect(p[0].ad.id).toBe('fresh-high');
  });
  it('topic match (lead stories\' category) beats priority; only the first 3 MAIN stories count', () => {
    const gst = ad({ id: 'gst', topic: 'gst', priority: 0 });
    const top = ad({ id: 'top', priority: 50 });
    const leadGst = [item(1, { category: 'GST' }), item(2), item(3)];
    expect(pick([gst, top], 'FREE', [1], leadGst)[0].ad.id).toBe('gst');
    const lateGst = [item(1), item(2), item(3), item(4, { category: 'GST' })];
    expect(pick([gst, top], 'FREE', [1], lateGst)[0].ad.id).toBe('top');
  });
  it('rotation through the DB: the ad left out of yesterday\'s email leads the next build', async () => {
    const portal = newPortal();
    const ads = [await dbAd(portal, { priority: 5 }), await dbAd(portal, { priority: 5 }), await dbAd(portal, { priority: 5 })];
    const { run } = await buildRun(portal, items(5)); // 5 stories → slots 1 and 3: two of three placed
    const placed = new Set((await prisma.digestAdPlacement.findMany({ where: { send: { runId: run.id, audience: 'FREE' } } })).map((p) => p.adId));
    expect(placed.size).toBe(2);
    const left = ads.find((a) => !placed.has(a.id))!;
    const next = pick(await loadAdPool(portal), 'FREE', [1]);
    expect(next[0].ad.id).toBe(left.id);
  });
});

describe('defaults, no duplicates, no empty slot', () => {
  it('nothing eligible → the slot default; a default never beats an eligible ad', () => {
    const def = ad({ id: 'def', isSlotDefault: true, priority: 100 });
    expect(pick([def, ad({ id: 'reg', priority: 0 })], 'FREE', [1])[0]).toMatchObject({ ad: { id: 'reg' }, viaDefault: false });
    expect(pick([def], 'FREE', [1])[0]).toMatchObject({ ad: { id: 'def' }, viaDefault: true });
  });
  it('an expired default is not used (its offer is over) → fail closed', () => {
    expect(() => pick([ad({ isSlotDefault: true, endsAt: AT })], 'FREE', [1])).toThrow(AdSlotError);
  });
  it('one ad is never placed twice in one email: one ad for three slots fails closed, naming the slots', () => {
    try {
      pick([ad({ id: 'solo', isSlotDefault: true })], 'FREE', [1, 2, 3]);
      throw new Error('expected AdSlotError');
    } catch (e) {
      expect(e).toBeInstanceOf(AdSlotError);
      expect((e as AdSlotError).problems).toHaveLength(2);
      expect((e as AdSlotError).problems.join(' ')).toMatch(/already used/);
    }
    expect(() => assertPlacementsAllowed('FREE', [{ slot: 1, kind: 'HOUSE', linkUrl: 'https://www.taxscan.in/', adId: 'x' }, { slot: 2, kind: 'HOUSE', linkUrl: 'https://www.taxscan.in/', adId: 'x' }])).toThrow(/twice/);
  });
  it('the most constrained slot is filled first: a slot-1-only ad is not starved by an any-slot ad', () => {
    const any = ad({ id: 'any', priority: 100 });
    const only1 = ad({ id: 'only1', slots: [1] });
    expect(idsBySlot(pick([any, only1], 'FREE', [1, 3]))).toEqual({ 1: 'only1', 3: 'any' });
  });
  it('empty pool: every slot named, in plain words', () => {
    try {
      pick([], 'PREMIUM', [1, 3]);
    } catch (e) {
      expect((e as AdSlotError).problems).toEqual(['Slot 1 — Premium: no eligible ad and no default', 'Slot 3 — Premium: no eligible ad and no default']);
    }
  });
});

describe('coverage check (the Ads screen; the same rule as the build)', () => {
  it('reports per slot and audience, and is ok only when every slot fills for both', () => {
    const pool = [ad({ id: 'sub', kind: 'SUBSCRIPTION' }), ad({ id: 'h1' }), ad({ id: 'h2' })];
    const c = coverageOf(pool, AT);
    expect(c.audiences.FREE.ok).toBe(true);
    expect(c.audiences.PREMIUM.ok).toBe(false);
    expect(c.problems).toEqual(['Slot 3 — Premium: its only ads are already used in other slots of the same email; add another ad or a default for this slot']);
    expect(coverageOf([...pool, ad({ id: 'h3' })], AT).ok).toBe(true);
  });
  it('checks every slot even when a short digest would draw only slots 1 and 3', () => {
    const results = assignAds({ slots: [1, 2, 3], audience: 'FREE', items: [], at: AT, pool: [ad({ slots: [1] }), ad({ slots: [3] })] });
    expect(results.map((r) => r.placement !== null)).toEqual([true, false, true]);
  });
});

/* ================================================================== */
/* Through the runner                                                  */
/* ================================================================== */

describe('ACCEPT: an unfillable slot fails the build closed', () => {
  it('no ads → BUILD_FAILED, config_invalid alert (source ads), nothing frozen, no draft; banner says so', async () => {
    const portal = newPortal();
    const { run, sender } = await buildRun(portal, items(5));
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id }, include: { sends: true, items: true } });
    expect(r.build).toBe('BUILD_FAILED');
    expect(r.sends).toHaveLength(0);
    expect(r.items).toHaveLength(0);
    const marker = (r.alerts as Record<string, { source?: string; problems?: string[] }>).config_invalid;
    expect(marker.source).toBe('ads');
    expect(marker.problems).toContain('Slot 1 — Free: no eligible ad and no default');
    expect(sender.calls).toHaveLength(0);
    const status = await digestStatus({ portal, cfg: cfg(), now: IST(6, 31) });
    expect(status.attention?.code).toBe('ads_unfillable');
    expect(alertCopy('config_invalid', marker, cfg()).todo).toMatch(/Admin → Ads/);
  });

  it('fixed on the Ads screen before the cut-off → the next attempt builds; still broken at 17:00 → SKIPPED config_invalid', async () => {
    const portal = newPortal();
    const { run } = await buildRun(portal, items(5));
    for (let i = 0; i < 3; i++) await dbAd(portal);
    const sender = new FakeSender();
    await advanceRun(run.id, 'retry', { sender, now: IST(6, 45), cfg: cfg(), quiet: QUIET, alerts: false, selectItems: async () => selection({ FREE: items(5), PREMIUM: items(5) }) });
    expect((await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } })).build).toBe('BUILT');

    const portal2 = newPortal();
    const b = await buildRun(portal2, items(5));
    await advanceRun(b.run.id, 'cron', { sender: new FakeSender(), now: IST(17, 0), cfg: cfg(), quiet: QUIET, alerts: false });
    expect(await prisma.digestRun.findUniqueOrThrow({ where: { id: b.run.id } })).toMatchObject({ build: 'SKIPPED', skipReason: 'config_invalid' });
  });

  it('only a SUBSCRIPTION ad for a slot: FREE fills, PREMIUM cannot → only PREMIUM is held back (follow-up 2026-10-23)', async () => {
    const portal = newPortal();
    await dbAd(portal, { kind: 'SUBSCRIPTION', slots: [3] });
    await dbAd(portal, { slots: [1] });
    const { run } = await buildRun(portal, items(5));
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id }, include: { sends: true } });
    expect(r.build).toBe('BUILT');
    expect(r.sends.find((s) => s.audience === 'FREE')).toMatchObject({ contentPendingAt: null });
    expect(r.sends.find((s) => s.audience === 'PREMIUM')).toMatchObject({ state: 'FAILED', html: null });
    expect(JSON.stringify(r.alerts)).toContain('Slot 3 — Premium');
  });
});

describe('placements are recorded per send and drawn with UTM', () => {
  it('FREE gets the SUBSCRIPTION ad, PREMIUM never; placements + utm_content ad-<id>-slot<N>; run detail lists them', async () => {
    const portal = newPortal();
    const sub = await dbAd(portal, { name: 'Subscribe', kind: 'SUBSCRIPTION', priority: 100, linkUrl: 'https://www.taxscan.in/subscribe' });
    for (let i = 0; i < 3; i++) await dbAd(portal, { priority: 10 - i });
    const { run, sender } = await buildRun(portal, items(10));
    const sends = await prisma.digestSend.findMany({ where: { runId: run.id }, include: { placements: { include: { ad: true } } } });
    expect(sends).toHaveLength(2);
    const free = sends.find((s) => s.audience === 'FREE')!;
    const premium = sends.find((s) => s.audience === 'PREMIUM')!;
    expect(free.placements.map((p) => p.slot).sort()).toEqual([1, 2, 3]);
    expect(premium.placements.map((p) => p.slot).sort()).toEqual([1, 2, 3]);
    expect(free.placements.some((p) => p.adId === sub.id)).toBe(true);
    expect(premium.placements.some((p) => p.ad.kind === 'SUBSCRIPTION')).toBe(false);
    expect(premium.html).not.toContain('/subscribe');
    for (const s of sends) {
      expect(new Set(s.placements.map((p) => p.adId)).size).toBe(3); // no ad twice in one email
      for (const p of s.placements) {
        expect(p.utmContent).toBe(`ad-${p.adId}-slot${p.slot}`);
        expect(s.html).toContain(`utm_content=ad-${p.adId}-slot${p.slot}`);
        expect(s.text).toContain(`utm_content=ad-${p.adId}-slot${p.slot}`);
      }
    }
    expect(sender.count('createDraft')).toBe(2);
    const res = await request(appFor(portal)).get(`/api/digest/runs/${run.id}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    const v = (res.body.variants as { audience: string; ads: { slot: number; kind: string }[] }[]).find((x) => x.audience === 'PREMIUM')!;
    expect(v.ads).toHaveLength(3);
    expect(v.ads.every((a) => a.kind !== 'SUBSCRIPTION')).toBe(true);
  });

  it('a short digest (5 stories) draws and records slots 1 and 3 only', async () => {
    const portal = newPortal();
    for (let i = 0; i < 3; i++) await dbAd(portal);
    const { run } = await buildRun(portal, items(5));
    const placed = await prisma.digestAdPlacement.findMany({ where: { send: { runId: run.id, audience: 'FREE' } } });
    expect(placed.map((p) => p.slot).sort()).toEqual([1, 3]);
  });

  it('freeze guard: a buildContent that hands PREMIUM a SUBSCRIPTION placement is refused (PREMIUM held back, never frozen with it)', async () => {
    const portal = newPortal();
    const sub = await dbAd(portal, { kind: 'SUBSCRIPTION' });
    const rogue: BuildContent = async ({ audience }) => ({
      subject: 's',
      preheader: 'p',
      html: '<html></html>',
      text: 't',
      placements: [{ adId: sub.id, slot: 1, utmContent: `ad-${sub.id}-slot1` }].filter(() => audience === 'PREMIUM'),
    });
    const { run } = await buildRun(portal, items(5), cfg(), { buildContent: rogue });
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id }, include: { sends: { include: { placements: true } } } });
    const premium = r.sends.find((s) => s.audience === 'PREMIUM')!;
    expect(premium).toMatchObject({ state: 'FAILED', html: null });
    expect(premium.contentPendingAt).not.toBeNull();
    expect(premium.placements).toHaveLength(0);
    expect(premium.lastError).toMatch(/^ads_unfillable: .*never go to Premium/);
    expect(JSON.stringify(r.alerts)).toMatch(/never go to Premium/);
  });

  it('freeze guard: the ad edited off-allowlist after the pick is refused at freeze', async () => {
    const portal = newPortal();
    const a = await dbAd(portal);
    const rogue: BuildContent = async () => {
      await prisma.digestAd.update({ where: { id: a.id }, data: { linkUrl: 'https://evil.example.com/' } });
      return { subject: 's', preheader: 'p', html: '<html></html>', text: 't', placements: [{ adId: a.id, slot: 1, utmContent: 'x' }] };
    };
    const { run } = await buildRun(portal, items(5), cfg(), { buildContent: rogue });
    expect((await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } })).build).toBe('BUILD_FAILED');
  });
});

describe('renderer: ad markup, size and image weight', () => {
  const ra = (slot: number, o: Partial<RenderAd> = {}): RenderAd => ({
    slot,
    adId: `ad${slot}`,
    kind: 'HOUSE',
    headline: 'Master GST appeals in 6 weeks',
    body: 'Live classes by practising advocates.',
    ctaText: 'Enrol now',
    linkUrl: 'https://academy.taxscan.in/gst-appeals?ref=x',
    altText: 'GST appeals course',
    image: { url: `https://push.taxscan.in/email-assets/${'a'.repeat(64)}.jpg`, width: 1200, height: 600 },
    ...o,
  });
  const slotRow = (html: string, slot: number) => new RegExp(`<td [^>]*data-ad-slot="${slot}"[\\s\\S]*?</td></tr>`).exec(html)![0];
  it('an ad WITH a picture is the linked banner only: alt text, width, UTM — no label, headline, body or button', () => {
    const r = renderDigest({ items: items(5), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads: [ra(1, { headline: 'A & B <x>' }), ra(3)] });
    const row = slotRow(r.html, 1);
    expect(row).toMatch(/<a href="[^"]*utm_content=ad-ad1-slot1[^"]*"[^>]*><img [^>]*alt="GST appeals course"/);
    expect(row).toMatch(/width="860" height="430"/);
    expect(row).toContain('ref=x');
    expect(row).toContain('data-ad-image="1"');
    expect(row).not.toMatch(/From Taxscan|A &amp; B|Enrol now|<h3|ts-btn|<p /);
    expect((row.match(/<a /g) ?? []).length).toBe(1);
    expect(r.text).toContain('Master GST appeals in 6 weeks'); // the plain-text part still names the offer
  });
  it('an ad WITHOUT a picture keeps the label, live-text headline (escaped), body and a real CTA button', () => {
    const r = renderDigest({ items: items(5), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads: [ra(1, { headline: 'A & B <x>', image: null }), ra(3)] });
    const row = slotRow(r.html, 1);
    expect(row).toContain('From Taxscan');
    expect(row).toContain('A &amp; B &lt;x&gt;');
    expect(row).toContain('>Enrol now</a>');
    expect(row).toContain('Live classes by practising advocates.');
    expect(row).not.toContain('<img');
    expect(row).toContain('utm_content=ad-ad1-slot1');
  });
  it('a drawn slot without an ad is refused (never an empty slot)', () => {
    expect(() => renderDigest({ items: items(5), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads: [ra(1)] })).toThrow(/no ad for slot 3/);
  });
  it('an off-allowlist ad link given to the renderer is refused', () => {
    expect(() => renderDigest({ items: items(5), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads: [ra(1, { linkUrl: 'https://evil.example.com/' }), ra(3)] })).toThrow(RenderError);
  });
  it('size: the 12-story worst case with 3 long ads stays under the 90 KB budget, and ad bytes are counted', () => {
    const long = (s: string, len: number) => s.repeat(Math.ceil(len / s.length)).slice(0, len);
    const its = items(12, { title: long('Supreme Court quashes reassessment notice under Section 148A ', 300), excerpt: long('A long summary of the ruling and its reasoning. ', 280) });
    const ads = [1, 2, 3].map((s) => ra(s, { headline: long('Headline ', 120), body: long('Body text ', 300), altText: long('Alt ', 150), adId: `c${'x'.repeat(24)}${s}` }));
    const without = renderDigest({ items: its, audience: 'FREE', runDate: RUN_DATE, cfg: cfg() });
    const withAds = renderDigest({ items: its, audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads });
    expect(withAds.budgetBytes).toBeGreaterThan(without.budgetBytes + 3 * 1000);
    expect(withAds.budgetBytes).toBeLessThan(90 * 1024);
  });
  it('image weight: distinct images summed; over DIGEST_MAX_IMAGE_KB the build logs a warning', async () => {
    const img = (id: string, size: number) => ({ id, mime: 'image/jpeg', width: 1200, height: 600, size });
    const placements = [
      { slot: 1, ad: ad({ image: img('i1', 140_000), imageId: 'i1' }), utmContent: 'x', viaDefault: false },
      { slot: 2, ad: ad({ image: img('i1', 140_000), imageId: 'i1' }), utmContent: 'x', viaDefault: false },
      { slot: 3, ad: ad({ image: img('i2', 100_000), imageId: 'i2' }), utmContent: 'x', viaDefault: false },
    ];
    expect(imageWeight(placements)).toBe(240_000);

    const portal = newPortal();
    const bytes = jpeg(800, 400, 3000);
    const id = imageId(bytes);
    createdImageIds.add(id);
    await prisma.digestAdImage.upsert({ where: { id }, create: { id, mime: 'image/jpeg', width: 800, height: 400, size: bytes.length, bytes: new Uint8Array(bytes) }, update: {} });
    for (let i = 0; i < 3; i++) await dbAd(portal, { imageId: id });
    logs.length = 0;
    const out = await renderDigestContent({ runId: 'r', runDate: RUN_DATE, audience: 'FREE', items: items(5), cfg: cfg({ DIGEST_MAX_IMAGE_KB: '1' }), portal, at: AT });
    expect(logs.join('\n')).toMatch(/ad images weigh \d+ KB \(budget 1 KB per email\)/);
    expect(out.html).toContain(`https://push.taxscan.in/email-assets/${id}.jpg`);
    logs.length = 0;
    await renderDigestContent({ runId: 'r', runDate: RUN_DATE, audience: 'FREE', items: items(5), cfg: cfg(), portal, at: AT });
    expect(logs.join('\n')).not.toMatch(/ad images weigh/);
  });
});

/* ================================================================== */
/* Images                                                              */
/* ================================================================== */

describe('image validation (real type from bytes, ≤ 1200 px wide, ≤ 150 KB)', () => {
  it('accepts a PNG and a JPEG and reads their size from the header', () => {
    expect(validateImage(png(1200, 630))).toEqual({ mime: 'image/png', width: 1200, height: 630 });
    expect(validateImage(jpeg(600, 300))).toEqual({ mime: 'image/jpeg', width: 600, height: 300 });
    expect(validateImage(jpeg(600, 300), { contentType: 'image/jpeg', filename: 'banner.JPG' }).mime).toBe('image/jpeg');
  });
  it('too wide', () => {
    expect(() => validateImage(png(MAX_IMAGE_WIDTH + 1))).toThrow(/1201 px wide/);
    expect(() => validateImage(jpeg(1080 * 2))).toThrow(expect.objectContaining({ code: 'too_wide' }));
  });
  it('too big', () => {
    expect(() => validateImage(png(600, 100, MAX_IMAGE_BYTES))).toThrow(expect.objectContaining({ code: 'too_big' }));
  });
  it('wrong type: GIF, SVG, HTML, empty', () => {
    expect(() => validateImage(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toThrow(expect.objectContaining({ code: 'wrong_type' }));
    expect(() => validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toThrow(expect.objectContaining({ code: 'wrong_type' }));
    expect(() => validateImage(Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'evil.png', contentType: 'image/png' })).toThrow(
      expect.objectContaining({ code: 'wrong_type' }),
    );
    expect(() => validateImage(Buffer.alloc(0))).toThrow(expect.objectContaining({ code: 'empty' }));
  });
  it('spoofed extension or type: PNG bytes named .jpg or sent as image/jpeg are refused', () => {
    expect(() => validateImage(png(600), { filename: 'banner.jpg' })).toThrow(expect.objectContaining({ code: 'type_mismatch' }));
    expect(() => validateImage(png(600), { contentType: 'image/jpeg' })).toThrow(expect.objectContaining({ code: 'type_mismatch' }));
    expect(() => validateImage(jpeg(600), { filename: 'banner.gif' })).toThrow(expect.objectContaining({ code: 'type_mismatch' }));
  });
  it('a JPEG/PNG magic number with an unreadable header is refused', () => {
    expect(() => validateImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(expect.objectContaining({ code: 'unreadable' }));
    expect(() => validateImage(Buffer.concat([png(10).subarray(0, 8), Buffer.from('XXXXXXXXXXXXXXXXXXXX')]))).toThrow(expect.objectContaining({ code: 'unreadable' }));
  });
});

describe('POST /api/digest/ad-images + public /email-assets', () => {
  it('upload stores by sha256, dedupes an identical upload, rejects bad files with our words', async () => {
    const portal = newPortal();
    const bytes = png(1000, 500, 1000 + (Date.now() % 997));
    const first = await request(appFor(portal)).post('/api/digest/ad-images').set('Cookie', adminCookie).set('Content-Type', 'image/png').set('X-Filename', 'banner.png').send(bytes);
    expect(first.status).toBe(201);
    createdImageIds.add(first.body.id);
    expect(first.body).toMatchObject({ id: imageId(bytes), width: 1000, height: 500, deduped: false, url: `https://push.taxscan.in/email-assets/${imageId(bytes)}.png` });
    const again = await request(appFor(portal)).post('/api/digest/ad-images').set('Cookie', adminCookie).set('Content-Type', 'image/png').send(bytes);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, deduped: true });
    expect(await prisma.digestAdImage.count({ where: { id: first.body.id } })).toBe(1);

    const wide = await request(appFor(portal)).post('/api/digest/ad-images').set('Cookie', adminCookie).set('Content-Type', 'image/png').send(png(1600));
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe('too_wide');
    const spoof = await request(appFor(portal)).post('/api/digest/ad-images').set('Cookie', adminCookie).set('Content-Type', 'image/png').set('X-Filename', 'x.png').send(Buffer.from('GIF89a......'));
    expect(spoof.body.error).toBe('wrong_type');
    const huge = await request(appFor(portal)).post('/api/digest/ad-images').set('Cookie', adminCookie).set('Content-Type', 'image/png').send(Buffer.alloc(320 * 1024, 1));
    expect(huge.status).toBe(413);
    expect(huge.body.error).toBe('too_big');
  });

  it('the asset route: right headers; 404 for anything that is not a stored image', async () => {
    const bytes = jpeg(700, 350, 500 + (Date.now() % 991));
    const id = imageId(bytes);
    createdImageIds.add(id);
    await prisma.digestAdImage.upsert({ where: { id }, create: { id, mime: 'image/jpeg', width: 700, height: 350, size: bytes.length, bytes: new Uint8Array(bytes) }, update: {} });
    const a = createApp();
    const ok = await request(a).get(`/email-assets/${id}.jpg`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(ok.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(ok.body).equals(bytes)).toBe(true);
    expect((await request(a).get(`/email-assets/${id}.jpg`).set('If-None-Match', `"${id}"`)).status).toBe(304);
    for (const bad of [`${id}.png`, `${id}.JPG`, `${'0'.repeat(64)}.jpg`, `${id}`, `${id}.jpg.html`, '..%2F..%2Fpackage.json', '..%2F.env', `${id.toUpperCase()}.jpg`]) {
      const r = await request(a).get(`/email-assets/${bad}`);
      expect(r.status).toBe(404);
      expect(r.headers['content-type']).not.toMatch(/image/);
    }
    expect((await request(a).get('/email-assets/../../package.json')).status).toBe(404);
  });
});

/* ================================================================== */
/* Routes: ADMIN only, validation, audit                               */
/* ================================================================== */

const validBody = (o: Record<string, unknown> = {}) => ({
  name: 'Academy GST course',
  kind: 'HOUSE',
  headline: 'Master GST appeals',
  altText: 'GST appeals course banner',
  body: 'Six weeks, live.',
  ctaText: 'Enrol now',
  linkUrl: 'https://academy.taxscan.in/gst-appeals?ref=digest',
  audience: 'ALL',
  slots: [1, 3],
  priority: 10,
  isSlotDefault: false,
  startsAt: null,
  endsAt: null,
  status: 'ACTIVE',
  ...o,
});

describe('routes: any signed-in staff user (ADMIN or PUBLISHER, owner 29 Oct)', () => {
  it('a publisher gets 2xx on every ads route (coverage and image upload included); no session gets 401; the bearer and an admin get through', async () => {
    const portal = newPortal();
    const a = await dbAd(portal);
    const app = appFor(portal);
    const calls: [string, () => request.Test][] = [
      ['GET /ads', () => request(app).get('/api/digest/ads')],
      ['GET /ads/coverage', () => request(app).get('/api/digest/ads/coverage')],
      ['POST /ads', () => request(app).post('/api/digest/ads').send(validBody())],
      ['PUT /ads/:id', () => request(app).put(`/api/digest/ads/${a.id}`).send(validBody())],
      ['POST /ads/:id/archive', () => request(app).post(`/api/digest/ads/${a.id}/archive`).send({ confirm: true })],
      ['POST /ad-images', () => request(app).post('/api/digest/ad-images').set('Content-Type', 'image/png').send(png(100))],
    ];
    for (const [name, c] of calls) {
      const status = (await c().set('Cookie', publisherCookie)).status;
      expect([name, status >= 200 && status < 300]).toEqual([name, true]);
    }
    for (const [name, c] of calls) expect([name, (await c()).status]).toEqual([name, 401]);
    expect((await request(app).get('/api/digest/ads').set('Cookie', adminCookie)).status).toBe(200);
    expect((await request(app).get('/api/digest/ads').set('Authorization', AUTH)).status).toBe(200);
  });

  it('what a publisher saves is audited with the publisher as the actor', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const created = await request(app).post('/api/digest/ads').set('Cookie', publisherCookie).send(validBody());
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await request(app).put(`/api/digest/ads/${id}`).set('Cookie', publisherCookie).send(validBody({ headline: 'Edited by a publisher' }));
    await request(app).post(`/api/digest/ads/${id}/archive`).set('Cookie', publisherCookie).send({ confirm: true });
    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'DigestAd', resourceId: id }, orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.userId === publisher.id)).toBe(true);
  });
});

describe('routes: save, archive, audit, coverage', () => {
  it('create → list shows it with a UTM preview and coverage; audit row holds the link host, never the URL', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const res = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(validBody());
    expect(res.status).toBe(201);
    const row = (res.body.ads as { id: string; utmExample: string; window: string }[]).find((x) => x.id === res.body.id)!;
    expect(row.window).toBe('live');
    expect(row.utmExample).toBe(`https://academy.taxscan.in/gst-appeals?ref=digest&utm_source=taxscan-digest&utm_medium=email&utm_campaign=digest-2026-10-22-free&utm_content=ad-${res.body.id}-slot1`);
    expect(res.body.coverage.ok).toBe(false);
    expect(res.body.coverage.problems).toContain('Slot 2 — Free: no eligible ad and no default');
    expect(res.body.slots).toEqual([1, 2, 3]);
    expect(res.body.topics).toContain('GST');
    const audit = await prisma.auditLog.findMany({ where: { resourceType: 'DigestAd', resourceId: res.body.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'DIGEST_AD_SAVED', userId: admin.id });
    expect(audit[0].metadata).toMatchObject({ linkHost: 'academy.taxscan.in', created: true, slots: [1, 3] });
    expect(JSON.stringify(audit[0].metadata)).not.toContain('gst-appeals');
    const stored = await prisma.digestAd.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored).toMatchObject({ portal, createdByUserId: admin.id, linkUrl: 'https://academy.taxscan.in/gst-appeals?ref=digest' });
  });

  it('ACCEPT: an off-allowlist link is rejected at save (create and update), and nothing is written', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    for (const linkUrl of ['https://evil.example.com/x', 'javascript:alert(1)', 'https://taxscan.in.evil.example/x', 'https://www.taxscan.in:8443/x', 'ftp://www.taxscan.in/x']) {
      const r = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(validBody({ linkUrl }));
      expect(r.status).toBe(400);
      expect(r.body.issues[0].message).toMatch(/ALLOWED_PUSH_HOSTS/);
    }
    expect(await prisma.digestAd.count({ where: { portal } })).toBe(0);
    const a = await dbAd(portal);
    const r = await request(app).put(`/api/digest/ads/${a.id}`).set('Cookie', adminCookie).send(validBody({ linkUrl: 'https://evil.example.com/' }));
    expect(r.status).toBe(400);
    expect((await prisma.digestAd.findUniqueOrThrow({ where: { id: a.id } })).linkUrl).toBe(a.linkUrl);
    expect(await prisma.auditLog.count({ where: { resourceType: 'DigestAd', resourceId: a.id } })).toBe(0);
  });

  it('other validation: required live text, utm_ in the link, end before start, unknown image', async () => {
    const app = appFor(newPortal());
    const bad = async (o: Record<string, unknown>, re: RegExp) => {
      const r = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(validBody(o));
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body.issues)).toMatch(re);
    };
    await bad({ headline: '  ' }, /Headline is required/);
    await bad({ altText: '' }, /Alt text is required/);
    await bad({ ctaText: undefined }, /Button text is required/);
    await bad({ linkUrl: 'https://www.taxscan.in/x?utm_source=fb' }, /utm_/);
    await bad({ startsAt: '2026-11-02T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' }, /End must be after start/);
    await bad({ imageId: 'e'.repeat(64) }, /image was not found/);
    await bad({ priority: 101 }, /0–100/);
  });

  it('update writes an audit row naming the changed fields; archive needs confirm, writes DIGEST_AD_ARCHIVED, then blocks edits', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const created = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(validBody());
    const id = created.body.id as string;
    const upd = await request(app).put(`/api/digest/ads/${id}`).set('Cookie', adminCookie).send(validBody({ priority: 50, headline: 'New headline' }));
    expect(upd.status).toBe(200);
    const saved = await prisma.auditLog.findMany({ where: { resourceId: id, action: 'DIGEST_AD_SAVED' }, orderBy: { createdAt: 'asc' } });
    expect(saved).toHaveLength(2);
    expect((saved[1].metadata as { changed: string[] }).changed.sort()).toEqual(['headline', 'priority']);

    expect((await request(app).post(`/api/digest/ads/${id}/archive`).set('Cookie', adminCookie).send({})).status).toBe(400);
    const arch = await request(app).post(`/api/digest/ads/${id}/archive`).set('Cookie', adminCookie).send({ confirm: true });
    expect(arch.status).toBe(200);
    expect((arch.body.ads as { id: string }[]).some((x) => x.id === id)).toBe(false);
    const archived = await prisma.auditLog.findMany({ where: { resourceId: id, action: 'DIGEST_AD_ARCHIVED' } });
    expect(archived).toHaveLength(1);
    expect(archived[0].metadata).toMatchObject({ status: 'ARCHIVED', from: 'ACTIVE', linkHost: 'academy.taxscan.in' });
    const listed = await request(app).get('/api/digest/ads?archived=1').set('Cookie', adminCookie);
    expect((listed.body.ads as { id: string; status: string }[]).find((x) => x.id === id)?.status).toBe('ARCHIVED');
    expect((await request(app).put(`/api/digest/ads/${id}`).set('Cookie', adminCookie).send(validBody())).status).toBe(409);
    // An archived ad is never placed.
    expect(whyIneligible(ad({ status: 'ARCHIVED' }), 'FREE', 1, AT)).toBe('not_active');
  });

  it('an ad of another portal is invisible here (404)', async () => {
    const other = await dbAd(newPortal());
    const r = await request(appFor(newPortal())).put(`/api/digest/ads/${other.id}`).set('Cookie', adminCookie).send(validBody());
    expect(r.status).toBe(404);
  });

  it('coverage endpoint turns green once every slot fills for both audiences', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    for (let i = 0; i < 3; i++) await dbAd(portal);
    const c = await request(app).get('/api/digest/ads/coverage').set('Cookie', adminCookie);
    expect(c.body.ok).toBe(true);
    expect(c.body.audiences.PREMIUM.slots).toHaveLength(3);
    // Checked for the next build (06:30 IST): AT is exactly 06:30, so the next one is tomorrow's.
    expect(c.body.checkedFor).toBe(IST(6, 30, 23).toISOString());
  });
});

/* ================================================================== */
/* QA verification of cd5a0e4 (adversarial)                            */
/* ================================================================== */

describe('QA verification of cd5a0e4', () => {
  it('a pool that CAN fill every slot is never refused because of rank order (greedy stranding)', () => {
    // slot 1 {A,B}, slot 2 {A,C}, slot 3 {B,C}; the only full assignments are 1=A,2=C,3=B and 1=B,2=A,3=C.
    // Ranked C > B > A, greedy took 1=B, 2=C and stranded slot 3.
    const pool = [ad({ id: 'qa-A', slots: [1, 2], priority: 1 }), ad({ id: 'qa-B', slots: [1, 3], priority: 2 }), ad({ id: 'qa-C', slots: [2, 3], priority: 3 })];
    const placed = pick(pool);
    expect(placed).toHaveLength(3);
    expect(new Set(placed.map((p) => p.ad.id)).size).toBe(3);
    for (const p of placed) expect(p.ad.slots).toContain(p.slot);
    // Coverage agrees with the build, whatever order the ads rank in.
    for (const prio of [[1, 2, 3], [3, 2, 1], [2, 3, 1]]) {
      const reordered = pool.map((a, i) => ({ ...a, priority: prio[i] }));
      expect(coverageOf(reordered, AT).ok).toBe(true);
      expect(() => pick(reordered)).not.toThrow();
    }
  });

  it('when greedy succeeds the search keeps its pick (rank order still decides)', () => {
    const pool = [ad({ id: 'qa-p1', priority: 9 }), ad({ id: 'qa-p2', priority: 5 }), ad({ id: 'qa-p3', priority: 1 }), ad({ id: 'qa-p4', priority: 0 })];
    expect(idsBySlot(pick(pool))).toEqual({ 1: 'qa-p1', 2: 'qa-p2', 3: 'qa-p3' });
  });

  it('a truly unfillable pool still fails closed, naming the slot', () => {
    const pool = [ad({ id: 'qa-only1', slots: [1] }), ad({ id: 'qa-only1b', slots: [1] }), ad({ id: 'qa-any' })];
    expect(() => pick(pool)).toThrow(AdSlotError);
  });

  it('a slot default that has not started yet is not used (the date window applies to defaults too)', () => {
    const pool = [ad({ id: 'qa-d1', isSlotDefault: true, startsAt: new Date(AT.getTime() + 60_000) }), ad({ id: 'qa-r1' }), ad({ id: 'qa-r2' })];
    expect(() => pick(pool)).toThrow(AdSlotError);
    const started = pool.map((a) => (a.id === 'qa-d1' ? { ...a, startsAt: new Date(AT.getTime() - 60_000) } : a));
    expect(pick(started).map((p) => p.ad.id).sort()).toEqual(['qa-d1', 'qa-r1', 'qa-r2']);
  });

  it('the SUBSCRIPTION guard is case-insensitive on kind (a row written outside the save path)', () => {
    for (const kind of ['subscription', ' Subscription ']) {
      expect(whyIneligible(ad({ kind }), 'PREMIUM', 1, AT)).toBe('subscription_guard');
      expect(whyIneligible(ad({ kind }), 'FREE', 1, AT)).toBeNull();
    }
  });

  it('a link with userinfo is rejected at save and dropped at pick, though its host is ours', () => {
    const base = validBody();
    for (const linkUrl of ['https://evil.com@www.taxscan.in/', 'https://user:pw@academy.taxscan.in/x']) {
      expect(AdInputSchema.safeParse({ ...base, linkUrl }).success).toBe(false);
      expect(whyIneligible(ad({ linkUrl }), 'FREE', 1, AT)).toBe('link_not_allowed');
    }
    expect(AdInputSchema.safeParse({ ...base, linkUrl: 'https://evil.com\\@www.taxscan.in/' }).success).toBe(false);
    expect(AdInputSchema.safeParse({ ...base, linkUrl: 'https://www.taxscan.in./' }).success).toBe(false);
    expect(AdInputSchema.safeParse({ ...base, linkUrl: 'https://WWW.TAXSCAN.IN/x' }).success).toBe(true);
  });

  it('image: a header claiming an absurd height is refused (was a DB Int overflow → 500)', async () => {
    expect(() => validateImage(png(100, 0xffffffff))).toThrow(expect.objectContaining({ code: 'too_tall' }));
    expect(() => validateImage(png(100, 65_535))).toThrow(expect.objectContaining({ code: 'too_tall_for_width' }));
    const r = await request(appFor(newPortal())).post('/api/digest/ad-images').set('Cookie', adminCookie).set('Content-Type', 'image/png').send(png(100, 0x80000000));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('too_tall');
  });

  it('image: random bytes behind a JPEG magic number never crash or hang the header walk', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const t0 = Date.now();
    for (let k = 0; k < 5000; k++) {
      const b = Buffer.alloc(3 + Math.floor(rnd() * 400));
      for (let i = 0; i < b.length; i++) b[i] = rnd() < 0.3 ? 0xff : Math.floor(rnd() * 256);
      b[0] = 0xff;
      b[1] = 0xd8;
      b[2] = 0xff;
      try {
        validateImage(b);
      } catch (e) {
        expect((e as Error).name).toBe('ImageRejected');
      }
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  });

});

/* ================================================================== */
/* Task 9 follow-ups (owner approved 2026-10-23)                       */
/* ================================================================== */

describe('follow-up 1: an unfillable ad slot fails only its own audience', () => {
  const c = cfg();
  const its = items(5);
  async function setup() {
    const portal = newPortal();
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    const sender = new FakeSender();
    const go = (trigger: 'cron' | 'retry', now: Date) =>
      advanceRun(run.id, trigger, { sender, now, cfg: c, quiet: QUIET, alerts: false, selectItems: async () => selection({ FREE: its, PREMIUM: its }) });
    const sends = async () => {
      const rows = await prisma.digestSend.findMany({ where: { runId: run.id }, include: { placements: { include: { ad: true } } } });
      return { FREE: rows.find((s) => s.audience === 'FREE')!, PREMIUM: rows.find((s) => s.audience === 'PREMIUM')! };
    };
    const markSent = async (a: DigestAudience) => {
      const id = (await sends())[a].mcCampaignId!;
      sender.campaigns.get(id)!.state = 'SENT';
    };
    return { portal, run, sender, go, sends, markSent };
  }

  it('Free is built and sent while Premium is blocked; alert and banner name Premium and the slot', async () => {
    const t = await setup();
    await dbAd(t.portal, { kind: 'SUBSCRIPTION', name: 'Subscribe', linkUrl: 'https://www.taxscan.in/subscribe' });
    await dbAd(t.portal, { name: 'House 1' });
    await t.go('cron', AT);

    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: t.run.id }, include: { items: true } });
    expect(r.build).toBe('BUILT');
    expect(r.items.length).toBeGreaterThan(0);
    const s = await t.sends();
    expect(s.FREE.state).toBe('CREATED');
    expect(s.FREE.html).toContain('High Court ruling 1');
    expect(s.PREMIUM).toMatchObject({ state: 'FAILED', html: null, mcCampaignId: null, createAttemptedAt: null });
    expect(s.PREMIUM.contentPendingAt).not.toBeNull();
    expect(s.PREMIUM.lastError).toMatch(/^ads_unfillable: Slot 3 — Premium/);
    expect(t.sender.draftInputs().map((d) => d.audience)).toEqual(['FREE']);

    const marker = (r.alerts as Record<string, Record<string, unknown>>).config_invalid;
    expect(marker).toMatchObject({ source: 'ads', audience: 'PREMIUM', audiences: ['PREMIUM'] });
    const copy = alertCopy('config_invalid', marker as never, c);
    expect(copy.what).toMatch(/The Premium digest has an ad slot no ad can fill: Slot 3 — Premium/);
    expect(copy.did).toMatch(/The Free digest was built and goes out as normal/);

    await t.go('cron', IST(7, 30));
    expect(t.sender.count('schedule')).toBe(1);
    expect((await t.sends()).FREE.state).toBe('SCHEDULED');
    expect((await t.sends()).PREMIUM.state).toBe('FAILED');

    const status = await digestStatus({ portal: t.portal, cfg: c, now: IST(7, 31) });
    expect(status.today?.state).toBe('failed');
    expect(status.attention?.code).toBe('ads_unfillable');
    expect(status.attention?.headline).toMatch(/The Premium digest is stopped: an ad slot cannot be filled \(Slot 3 — Premium.*\)\. The Free digest is not affected\./);

    const prev = await request(appFor(t.portal)).get(`/api/digest/runs/${t.run.id}/preview/premium`).set('Authorization', AUTH);
    expect(prev.status).toBe(409);
    expect(prev.text).toMatch(/Not built yet: an ad slot could not be filled/);
    expect(prev.headers['content-security-policy']).toMatch(/sandbox/);
    const detail = await request(appFor(t.portal)).get(`/api/digest/runs/${t.run.id}`).set('Authorization', AUTH);
    const pv = (detail.body.variants as { audience: string; contentPending: boolean; hasPreview: boolean }[]).find((v) => v.audience === 'PREMIUM')!;
    expect(pv).toMatchObject({ contentPending: true, hasPreview: false });
    expect(detail.body.actions.retry.show).toBe(true);
  });

  it('the reverse: Premium is built and sent while Free is blocked', async () => {
    const t = await setup();
    await dbAd(t.portal, { audience: 'PREMIUM_ONLY' });
    await dbAd(t.portal, { audience: 'PREMIUM_ONLY' });
    await t.go('cron', AT);
    const s = await t.sends();
    expect(s.PREMIUM.state).toBe('CREATED');
    expect(s.PREMIUM.placements.map((p) => p.slot).sort()).toEqual([1, 3]);
    expect(s.FREE).toMatchObject({ state: 'FAILED', html: null });
    expect(s.FREE.lastError).toMatch(/^ads_unfillable: Slot 1 — Free: no eligible ad and no default; Slot 3 — Free/);
    await t.go('cron', IST(7, 30));
    expect(t.sender.draftInputs().map((d) => d.audience)).toEqual(['PREMIUM']);
    expect(t.sender.count('schedule')).toBe(1);
    const status = await digestStatus({ portal: t.portal, cfg: c, now: IST(7, 31) });
    expect(status.attention?.headline).toMatch(/^The Free digest is stopped.*The Premium digest is not affected\.$/);
  });

  it('both blocked → as before: BUILD_FAILED, nothing frozen, the current cause recorded with a retry time', async () => {
    const t = await setup();
    await t.go('cron', AT);
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: t.run.id }, include: { sends: true, items: true } });
    expect(r).toMatchObject({ build: 'BUILD_FAILED', buildFailure: 'ads_unfillable', buildAttempts: 1 });
    expect(r.buildNextAttemptAt).toEqual(new Date(AT.getTime() + 60_000));
    expect(r.buildError).toMatch(/Slot 1 — Free: no eligible ad and no default.*Slot 1 — Premium/);
    expect(r.sends).toHaveLength(0);
    expect(r.items).toHaveLength(0);
    const status = await digestStatus({ portal: t.portal, cfg: c, now: IST(6, 31) });
    expect(status.attention?.code).toBe('ads_unfillable');
    expect(status.attention?.headline).toMatch(/Slot 1 — Free/);
  });

  it('recovery: ads fixed → the blocked variant is rendered from the FROZEN stories on its retry slot, then created and sent', async () => {
    const t = await setup();
    await dbAd(t.portal);
    await dbAd(t.portal, { kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' });
    await t.go('cron', AT);
    const frozenItems = await prisma.digestItem.count({ where: { runId: t.run.id } });
    await dbAd(t.portal, { name: 'House 2' });

    // The cron waits for the variant's retry slot (+1 min)…
    const early = await t.go('cron', new Date(AT.getTime() + 30_000));
    expect(early.steps).toContain('PREMIUM:render:waiting_retry');
    expect((await t.sends()).PREMIUM.state).toBe('FAILED');

    // …and then renders it: same frozen stories (no re-selection), ads as they are now.
    await t.go('cron', IST(6, 31));
    const s = await t.sends();
    expect(s.PREMIUM).toMatchObject({ state: 'CREATED', contentPendingAt: null, lastError: null, subject: s.FREE.subject });
    expect(s.PREMIUM.html).toContain('High Court ruling 5');
    expect(s.PREMIUM.placements.map((p) => p.slot).sort()).toEqual([1, 3]);
    expect(s.PREMIUM.placements.some((p) => p.ad.kind === 'SUBSCRIPTION')).toBe(false);
    expect(await prisma.digestItem.count({ where: { runId: t.run.id } })).toBe(frozenItems);
    expect(t.sender.draftInputs().map((d) => d.audience).sort()).toEqual(['FREE', 'PREMIUM']);

    await t.go('cron', IST(7, 30));
    expect(t.sender.count('schedule')).toBe(2);
    await t.markSent('FREE');
    await t.markSent('PREMIUM');
    const done = await t.go('cron', IST(7, 41));
    expect(done.state).toBe('sent');
    // A second pass never creates or schedules again (one per audience per day).
    await t.go('retry', IST(8, 0));
    expect(t.sender.count('createDraft')).toBe(2);
    expect(t.sender.count('schedule')).toBe(2);
  });

  it('recovery through Retry now skips the wait', async () => {
    const t = await setup();
    await dbAd(t.portal);
    await dbAd(t.portal, { kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' });
    await t.go('cron', AT);
    await dbAd(t.portal);
    await t.go('retry', new Date(AT.getTime() + 10_000));
    expect((await t.sends()).PREMIUM.state).toBe('CREATED');
  });

  it('still blocked after Free went out: Retry now is refused naming Premium and the slot; at the cut-off Premium is SKIPPED config_invalid', async () => {
    const t = await setup();
    await dbAd(t.portal);
    await dbAd(t.portal, { kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' });
    await t.go('cron', AT);
    await t.go('cron', IST(7, 30));
    await t.markSent('FREE');
    await t.go('cron', IST(7, 41));
    expect((await t.sends()).FREE.state).toBe('SENT');

    const r = await t.go('retry', IST(8, 0));
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/Premium digest still has an ad slot no ad can fill \(Slot 3 — Premium/);
    const pending = (await t.sends()).PREMIUM;
    // Attempts: the build, the 07:30 and 07:41 ticks, this press → the 4th slot, +75 min from the first.
    expect(pending.stepAttempts).toBe(4);
    expect(pending.nextAttemptAt).toEqual(new Date(AT.getTime() + 75 * 60_000));

    await t.go('cron', IST(17, 0));
    const s = await t.sends();
    expect(s.FREE.state).toBe('SENT');
    expect(s.PREMIUM.state).toBe('SKIPPED');
    const run = await prisma.digestRun.findUniqueOrThrow({ where: { id: t.run.id } });
    expect(run.skipReason).toBe('config_invalid');
    const skipped = (run.alerts as Record<string, Record<string, unknown>>).skipped;
    expect(skipped).toMatchObject({ reason: 'config_invalid', source: 'ads', audience: 'PREMIUM' });
    expect(alertCopy('skipped', skipped as never, c).what).toBe('The Premium digest was skipped because an ad slot could not be filled before the cut-off.');
    expect(t.sender.count('createDraft')).toBe(1);

    const status = await digestStatus({ portal: t.portal, cfg: c, now: IST(17, 1) });
    expect(status.today?.state).toBe('partially_sent');
    expect(status.attention?.code).toBe('variant_skipped');
    expect(status.attention?.headline).toBe('Only the Free digest went out today; the Premium digest was skipped because an ad slot could not be filled before the cut-off.');
  });
});

describe('follow-up 4: a failed build retries on the retry policy, not every tick', () => {
  it('+1, +5, +15, then +75, +135 min from the first failure; the cron waits in between, Retry now does not', async () => {
    const portal = newPortal();
    for (let i = 0; i < 3; i++) await dbAd(portal);
    const c = cfg();
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    let calls = 0;
    const selectItems = async (): Promise<DigestSelection> => {
      calls++;
      throw new Error('connection reset by peer');
    };
    const go = (trigger: 'cron' | 'retry', now: Date) => advanceRun(run.id, trigger, { sender: new FakeSender(), now, cfg: c, quiet: QUIET, alerts: false, selectItems });
    const min = (m: number) => new Date(AT.getTime() + m * 60_000);
    const state = () => prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });

    const expectNext = [
      [0, 1],
      [1, 5],
      [5, 15],
      [15, 75],
      [75, 135],
    ];
    for (const [at, next] of expectNext) {
      // One tick just before the due time does nothing.
      if (at > 0) {
        const r = await go('cron', new Date(min(at).getTime() - 1000));
        expect(r.steps).toEqual(['build:waiting_retry']);
      }
      const before = calls;
      await go('cron', min(at));
      expect(calls).toBe(before + 1);
      const s = await state();
      expect(s).toMatchObject({ build: 'BUILD_FAILED', buildFailure: 'build_error' });
      expect(s.buildNextAttemptAt).toEqual(min(next));
      expect(s.buildFirstFailureAt).toEqual(AT);
    }
    expect(calls).toBe(5);
    expect((await state()).buildError).toMatch(/connection reset/);

    // Retry now is not held back by the wait; the schedule stays anchored on the first failure.
    await go('retry', min(100));
    expect(calls).toBe(6);
    expect((await state()).buildNextAttemptAt).toEqual(min(195));
  });

  it('near the cut-off the wait runs to the cut-off (unchanged), where the run is skipped build_failed', async () => {
    const portal = newPortal();
    const c = cfg();
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    let calls = 0;
    const go = (now: Date) =>
      advanceRun(run.id, 'cron', { sender: new FakeSender(), now, cfg: c, quiet: QUIET, alerts: false, selectItems: async () => { calls++; throw new Error('db blip'); } });
    await go(IST(16, 50));
    await go(IST(16, 51));
    await go(IST(16, 55)); // the next slot (+15 = 17:05) is past the cut-off
    expect((await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } })).buildNextAttemptAt).toEqual(IST(17, 0));
    await go(IST(16, 59, 22));
    expect(calls).toBe(3);
    await go(IST(17, 0));
    expect(calls).toBe(3);
    expect(await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ build: 'SKIPPED', skipReason: 'build_failed' });
  });

  it('a successful build clears the failure bookkeeping', async () => {
    const portal = newPortal();
    for (let i = 0; i < 3; i++) await dbAd(portal);
    const c = cfg();
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    let fail = true;
    const selectItems = async () => {
      if (fail) throw new Error('blip');
      return selection({ FREE: items(5), PREMIUM: items(5) });
    };
    await advanceRun(run.id, 'cron', { sender: new FakeSender(), now: AT, cfg: c, quiet: QUIET, alerts: false, selectItems });
    fail = false;
    await advanceRun(run.id, 'cron', { sender: new FakeSender(), now: IST(6, 31), cfg: c, quiet: QUIET, alerts: false, selectItems });
    expect(await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      build: 'BUILT',
      buildFailure: null,
      buildError: null,
      buildNextAttemptAt: null,
    });
  });
});

describe('follow-up 5: the cut-off reason and the banner follow the CURRENT build failure (QA L5)', () => {
  it('ads fixed, then a non-ads failure: banner says build_failed and the cut-off skips build_failed, not config_invalid', async () => {
    const portal = newPortal();
    const c = cfg();
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    let broken = false;
    const selectItems = async () => {
      if (broken) throw new Error('db blip');
      return selection({ FREE: items(5), PREMIUM: items(5) });
    };
    const go = (trigger: 'cron' | 'retry', now: Date) => advanceRun(run.id, trigger, { sender: new FakeSender(), now, cfg: c, quiet: QUIET, alerts: false, selectItems });
    await go('cron', AT); // no ads at all → ads_unfillable
    let r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.buildFailure).toBe('ads_unfillable');
    expect((await digestStatus({ portal, cfg: c, now: IST(6, 31) })).attention?.code).toBe('ads_unfillable');

    for (let i = 0; i < 3; i++) await dbAd(portal); // fixed on the Ads screen…
    broken = true; // …but the next attempt fails for another reason
    await go('retry', IST(6, 40));
    r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.buildFailure).toBe('build_error');
    expect((r.alerts as Record<string, { source?: string }>).config_invalid?.source).toBe('ads'); // history stays
    const st = await digestStatus({ portal, cfg: c, now: IST(6, 41) });
    expect(st.attention?.code).toBe('build_failed');
    expect(st.today?.buildFailure).toBe('build_error');

    await go('cron', IST(17, 0));
    r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ build: 'SKIPPED', skipReason: 'build_failed' });
    expect((r.alerts as Record<string, { reason?: string; source?: string }>).skipped).toMatchObject({ reason: 'build_failed' });
    expect((r.alerts as Record<string, { source?: string }>).skipped.source).toBeUndefined();
  });

  it('the reverse: still ads at the cut-off → config_invalid with the ads banner wording', async () => {
    const portal = newPortal();
    const c = cfg();
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    const selectItems = async () => selection({ FREE: items(5), PREMIUM: items(5) });
    await advanceRun(run.id, 'cron', { sender: new FakeSender(), now: AT, cfg: c, quiet: QUIET, alerts: false, selectItems });
    await advanceRun(run.id, 'cron', { sender: new FakeSender(), now: IST(17, 0), cfg: c, quiet: QUIET, alerts: false, selectItems });
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ build: 'SKIPPED', skipReason: 'config_invalid' });
    expect((r.alerts as Record<string, { source?: string }>).skipped.source).toBe('ads');
    const st = await digestStatus({ portal, cfg: c, now: IST(17, 1) });
    expect(st.attention?.headline).toBe("Today's digest was skipped because an ad slot could not be filled before the cut-off.");
    expect(st.attention?.action).toMatch(/Open Ads/);
  });
});

describe('follow-up 2: ad links are https only (ads only; the push allowlist is unchanged)', () => {
  const base = { name: 'n', kind: 'HOUSE', headline: 'h', altText: 'a', ctaText: 'c', audience: 'ALL' };
  it('rejected at save', () => {
    const r = AdInputSchema.safeParse({ ...base, linkUrl: 'http://academy.taxscan.in/course' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/must start with https/);
    expect(AdInputSchema.safeParse({ ...base, linkUrl: 'https://academy.taxscan.in/course' }).success).toBe(true);
  });
  it('dropped at pick (an http ad saved earlier) — the next ad fills the slot; alone, fail closed', () => {
    const old = ad({ linkUrl: 'http://shop.taxscan.in/p/1', priority: 100 });
    const ok = ad();
    expect(whyIneligible(old, 'FREE', 1, AT)).toBe('link_not_https');
    expect(pick([old, ok], 'FREE', [1])[0].ad.id).toBe(ok.id);
    expect(() => pick([old], 'FREE', [1])).toThrow(AdSlotError);
    expect(() => assertPlacementsAllowed('FREE', [{ slot: 1, kind: 'HOUSE', linkUrl: 'http://shop.taxscan.in/p/1' }])).toThrow(/not https/);
  });
  it('refused at render', () => {
    const httpAd: RenderAd = { slot: 1, adId: 'x', kind: 'HOUSE', headline: 'h', body: null, ctaText: 'Go', linkUrl: 'http://academy.taxscan.in/c', altText: 'a', image: null };
    const ok3: RenderAd = { ...httpAd, slot: 3, adId: 'y', linkUrl: 'https://academy.taxscan.in/c' };
    expect(() => renderDigest({ items: items(5), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads: [httpAd, ok3] })).toThrow(/https/);
    expect(renderDigest({ items: items(5), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads: [{ ...httpAd, linkUrl: 'https://academy.taxscan.in/c' }, ok3] }).html).toContain('academy.taxscan.in');
  });
  it('article links over http still render (the rule is for ads only)', () => {
    const r = renderDigest({ items: items(5, { url: 'http://www.taxscan.in/top-stories/x/9001' }), audience: 'FREE', runDate: RUN_DATE, cfg: cfg() });
    expect(r.html).toContain('http://www.taxscan.in/top-stories/x/9001?');
  });
});

describe('follow-up 3: ad image height at most 2× its width', () => {
  it('1200 × 2400 is accepted; 1200 × 2401 and 600 × 1201 are refused with too_tall_for_width', async () => {
    expect(validateImage(png(1200, 2400))).toMatchObject({ width: 1200, height: 2400 });
    expect(validateImage(jpeg(600, 1200)).height).toBe(1200);
    expect(() => validateImage(png(1200, 2401))).toThrow(expect.objectContaining({ code: 'too_tall_for_width' }));
    expect(() => validateImage(jpeg(600, 1201))).toThrow(/at most 2× as tall as it is wide \(1200 px for this width\)/);
    const r = await request(appFor(newPortal())).post('/api/digest/ad-images').set('Cookie', adminCookie).set('Content-Type', 'image/png').send(png(500, 1001));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('too_tall_for_width');
  });
});

describe('follow-up 6: image weight counts only the slots actually drawn (QA L7)', () => {
  it('slot 2 is not drawn on a short digest, so its image is not counted', () => {
    const img = (id: string, size: number) => ({ id, mime: 'image/jpeg', width: 1200, height: 600, size });
    const placements = [1, 2, 3].map((slot) => ({ slot, ad: ad({ image: img(`w${slot}`, 100_000), imageId: `w${slot}` }), utmContent: 'x', viaDefault: false }));
    expect(imageWeight(placements)).toBe(300_000);
    expect(imageWeight(placements, [1, 3])).toBe(200_000);
    expect(imageWeight(placements, [1, 2, 3])).toBe(300_000);
  });
});

/* ================================================================== */
/* QA verification of 36503cb (pending variant + build backoff)        */
/* ================================================================== */

describe('QA verification of 36503cb: the pending variant', () => {
  const c = cfg();
  const its = items(5);
  async function setup(conf = c) {
    const portal = newPortal();
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: conf });
    const sender = new FakeSender();
    const go = (trigger: 'cron' | 'retry' | 'send_now' | 'health', now: Date, extra: { clock?: () => Date } = {}) =>
      advanceRun(run.id, trigger, { sender, now, cfg: conf, quiet: QUIET, alerts: false, selectItems: async () => selection({ FREE: its, PREMIUM: its }), ...extra });
    const sends = async () => {
      const rows = await prisma.digestSend.findMany({ where: { runId: run.id }, include: { placements: true } });
      return { FREE: rows.find((s) => s.audience === 'FREE')!, PREMIUM: rows.find((s) => s.audience === 'PREMIUM')! };
    };
    // Free fills (HOUSE + SUBSCRIPTION), Premium cannot (only one non-subscription ad).
    await dbAd(portal);
    await dbAd(portal, { kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' });
    return { portal, run, sender, go, sends };
  }

  it('cron and Retry now racing on the pending render: rendered once, one placement set, one draft per audience', async () => {
    const t = await setup();
    await t.go('cron', AT);
    await dbAd(t.portal, { name: 'fix' });
    const at = IST(6, 40);
    await Promise.all([t.go('cron', at), t.go('retry', at), t.go('cron', at), t.go('retry', at)]);
    const s = await t.sends();
    expect(s.PREMIUM.state).toBe('CREATED');
    expect(s.PREMIUM.placements.map((p) => p.slot).sort()).toEqual([1, 3]);
    expect(t.sender.draftInputs().map((d) => d.audience).sort()).toEqual(['FREE', 'PREMIUM']);
    expect(t.sender.count('createDraft')).toBe(2);
  });

  it('past the cut-off a pending variant is never rendered, on any door', async () => {
    const t = await setup();
    await t.go('cron', AT);
    await dbAd(t.portal, { name: 'fix' });
    for (const trig of ['retry', 'cron', 'health', 'send_now'] as const) await t.go(trig, IST(17, 0));
    const s = await t.sends();
    expect(s.PREMIUM).toMatchObject({ state: 'SKIPPED', html: null, mcCampaignId: null });
    expect(s.PREMIUM.placements).toHaveLength(0);
    expect(t.sender.draftInputs().map((d) => d.audience)).toEqual(['FREE']);
  });

  it('a render that straddles the cut-off never schedules (fresh clock), and the sweep skips it', async () => {
    const t = await setup();
    await t.go('cron', AT);
    await dbAd(t.portal, { name: 'fix' });
    const before = new Date(IST(17, 0).getTime() - 1000);
    await t.go('retry', before, { clock: () => new Date(IST(17, 0).getTime() + 1000) });
    expect(t.sender.count('schedule')).toBe(0);
    await t.go('cron', IST(17, 1));
    const s = await t.sends();
    expect(['SKIPPED']).toContain(s.PREMIUM.state);
    expect(t.sender.count('schedule')).toBe(0);
  });

  it('approval mode: the run approved while Premium was pending does NOT cover the Premium email rendered later (owner, 2026-10-23)', async () => {
    const conf = cfg({ DIGEST_APPROVAL_REQUIRED: 'true' });
    const t = await setup(conf);
    await t.go('cron', AT);
    await prisma.digestRun.update({ where: { id: t.run.id }, data: { approval: 'APPROVED', approvedAt: IST(6, 45) } });
    await dbAd(t.portal, { name: 'added after the approval' });
    await t.go('cron', IST(7, 30));
    let s = await t.sends();
    expect(s.FREE.state).toBe('SCHEDULED');
    expect(s.PREMIUM).toMatchObject({ state: 'CREATED', ownApprovalRequired: true, approvedAt: null });
    expect(t.sender.count('schedule')).toBe(1);
    // Its own approval releases it.
    await prisma.digestSend.update({ where: { id: s.PREMIUM.id }, data: { approvedAt: IST(7, 35) } });
    await t.go('cron', IST(7, 36));
    s = await t.sends();
    expect(s.PREMIUM.state).toBe('SCHEDULED');
    expect(t.sender.count('schedule')).toBe(2);
  });
});
