import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { listCampaigns } from '../services/metrics';
import { articleKey } from '../services/reports';

/**
 * Brief 2026-11-02-social-menu-channels-nudge, acceptance 2: the `channels` field on the Campaigns list. Seeded rows cover
 * WhatsApp POSTED / SKIPPED / TODO and LinkedIn POSTED / FAILED / PENDING, a re-push that shares its article's marks, a
 * test-segment-only campaign, an academy link, a draft, a push from before go-live, each switch off, and a constant query count.
 */
jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = env.rss.portal;
const FROM = new Date(Date.now() - 6 * 3600_000);
const NOW = new Date(Date.now() - 60_000);
const camps: Record<string, string> = {};
const urls: Record<string, string> = {};
/** The article key the marks are stored under: articleKey() (a trailing number counts as the taxscan id). */
const keys: Record<string, string> = {};
let userId = '';
const saved = { wa: env.whatsapp.queueEnabled, li: env.linkedin.enabled, from: env.linkedin.postFrom };

async function seed(key: string, o: { host?: string; status?: 'SENT' | 'DRAFT'; at?: Date; target?: object; url?: string } = {}) {
  const url = o.url ?? `https://${o.host ?? 'www.taxscan.in'}/gst/chan-${key}-${RUN}`;
  const c = await prisma.campaign.create({
    data: { portal: PORTAL, title: `Chan ${key}`, body: 'b', url, target: (o.target ?? { type: 'all' }) as Prisma.InputJsonValue, status: o.status ?? 'SENT', lastSentAt: o.at ?? NOW },
  });
  camps[key] = c.id;
  urls[key] = url;
  keys[key] = articleKey({ id: c.id, url });
  return c;
}
// a big page: other suites create campaigns at the same time and would push the seeded rows out of the newest 50
const byId = async (limit = 600) => new Map((await listCampaigns(limit)).map((r) => [r.id, r]));
const ch = async (key: string) => (await byId()).get(camps[key])!;

beforeAll(async () => {
  const u = await prisma.user.create({ data: { email: `chan-${RUN}@team.test`, passwordHash: await bcrypt.hash('x', 4), role: 'PUBLISHER', isActive: true } });
  userId = u.id;
  env.whatsapp.queueEnabled = true;
  env.linkedin.enabled = true;
  env.linkedin.postFrom = FROM;
  await seed('wa-posted');
  await seed('wa-skipped');
  await seed('wa-todo');
  await seed('li-posted');
  await seed('li-failed');
  await seed('li-pending');
  await seed('test-only', { target: { type: 'topics', topics: [env.testSegmentTopic] } });
  await seed('academy', { host: 'academy.taxscan.in' });
  await seed('draft', { status: 'DRAFT' });
  await seed('before-golive', { at: new Date(FROM.getTime() - 3600_000) });
  await seed('home', { url: 'https://www.taxscan.in/' });
  // a re-push of wa-posted / li-posted (same URL = same article)
  await seed('repush', { url: `https://www.taxscan.in/gst/chan-wa-posted-${RUN}` });
  const mkWa = (key: string, status: 'POSTED' | 'SKIPPED') => prisma.whatsAppPost.create({ data: { portal: PORTAL, articleKey: keys[key], campaignId: camps[key], status, actedByUserId: userId, actedAt: NOW } });
  await mkWa('wa-posted', 'POSTED');
  await mkWa('wa-skipped', 'SKIPPED');
  const mkLi = (key: string, status: 'POSTED' | 'FAILED', extra: object = {}) => prisma.linkedInPost.create({ data: { page: 'taxscan', articleKey: keys[key], campaignId: camps[key], status, attempts: 1, ...extra } });
  await mkLi('li-posted', 'POSTED', { linkedinPostId: 'urn:li:share:5', postedAt: NOW });
  await mkLi('li-failed', 'FAILED', { error: 'HTTP 422: invalid content' });
  // the re-push shares the original's marks only if it is the same article: li-posted's article also has a re-push
  await seed('li-repush', { url: urls['li-posted'] });
});

afterAll(async () => {
  Object.assign(env.whatsapp, { queueEnabled: saved.wa });
  env.linkedin.enabled = saved.li;
  env.linkedin.postFrom = saved.from;
  const mine = Object.values(keys);
  await prisma.whatsAppPost.deleteMany({ where: { articleKey: { in: mine } } });
  await prisma.linkedInPost.deleteMany({ where: { articleKey: { in: mine } } });
  await prisma.campaign.deleteMany({ where: { url: { contains: RUN } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${userId}`;
  });
  await prisma.userSession.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('2. channels on the Campaigns list', () => {
  it('WhatsApp: POSTED / SKIPPED / no row = TODO; LinkedIn: POSTED / FAILED / no row = PENDING', async () => {
    expect((await ch('wa-posted')).channels).toMatchObject({ whatsapp: 'POSTED', linkedin: 'PENDING' });
    expect((await ch('wa-skipped')).channels).toMatchObject({ whatsapp: 'SKIPPED' });
    expect((await ch('wa-todo')).channels).toEqual({ whatsapp: 'TODO', linkedin: 'PENDING' });
    expect((await ch('li-posted')).channels).toMatchObject({ linkedin: 'POSTED' });
    expect((await ch('li-failed')).channels).toMatchObject({ linkedin: 'FAILED' });
    expect((await ch('li-pending')).channels).toMatchObject({ linkedin: 'PENDING' });
  });
  it('the words behind a mark: who posted on WhatsApp, the LinkedIn failure reason and link, the IST day for the click-through', async () => {
    const wa = await ch('wa-posted');
    expect(wa.channelDetails?.whatsapp).toEqual({ by: `chan-${RUN}@team.test`, at: NOW.toISOString() });
    expect((await ch('li-failed')).channelDetails?.linkedin).toMatchObject({ error: 'HTTP 422: invalid content', postUrl: null });
    expect((await ch('li-posted')).channelDetails?.linkedin).toMatchObject({ postUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A5/' });
    expect(wa.channelDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('a re-push shares the marks of its original (same article)', async () => {
    expect((await ch('repush')).channels).toMatchObject({ whatsapp: 'POSTED' });
    expect((await ch('li-repush')).channels).toMatchObject({ linkedin: 'POSTED' });
  });
  it('a test-segment-only campaign, an academy link, a draft and the home page: both null; pushed before go-live: LinkedIn null', async () => {
    for (const k of ['test-only', 'academy', 'draft', 'home']) expect((await ch(k)).channels).toEqual({ whatsapp: null, linkedin: null });
    expect((await ch('before-golive')).channels).toEqual({ whatsapp: 'TODO', linkedin: null });
  });
  it('a switch off makes that channel null everywhere; both off removes the fields altogether', async () => {
    env.whatsapp.queueEnabled = false;
    const li = await ch('wa-posted');
    expect(li.channels).toEqual({ whatsapp: null, linkedin: 'PENDING' });
    env.whatsapp.queueEnabled = true;
    env.linkedin.enabled = false;
    expect((await ch('li-posted')).channels).toMatchObject({ linkedin: null, whatsapp: 'TODO' });
    env.whatsapp.queueEnabled = false;
    const off = await ch('wa-posted');
    expect(off.channels).toBeUndefined();
    expect(off.channelDetails).toBeUndefined();
    expect(off.channelDay).toBeUndefined();
    env.whatsapp.queueEnabled = true;
    env.linkedin.enabled = true;
  });
  it('the query count is constant: one batched query per channel for a 5-row page and a 50-row page', async () => {
    const extra: string[] = [];
    for (let i = 0; i < 45; i += 1) extra.push((await seed(`bulk-${i}`)).id);
    const wa = jest.spyOn(prisma.whatsAppPost, 'findMany');
    const li = jest.spyOn(prisma.linkedInPost, 'findMany');
    await listCampaigns(5);
    expect([wa.mock.calls.length, li.mock.calls.length]).toEqual([1, 1]);
    wa.mockClear();
    li.mockClear();
    const rows = await listCampaigns(50);
    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect([wa.mock.calls.length, li.mock.calls.length]).toEqual([1, 1]);
    wa.mockRestore();
    li.mockRestore();
    const keys = (wa.mock.calls[0]?.[0] as { where?: { articleKey?: { in?: string[] } } } | undefined)?.where?.articleKey?.in;
    void keys;
  });
});
