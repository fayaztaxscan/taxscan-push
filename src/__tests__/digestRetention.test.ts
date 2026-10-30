import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv } from '../lib/env';
import { digestSendStats } from '../services/digest/stats';
import { sweepDigestRetention } from '../sweepers/digestRetention';
import { BACKUP_TABLES, buildBackup } from '../services/backup';

/**
 * Task 11 (docs/EMAIL_DIGEST_DESIGN.md §3 lifecycle, §13 task 11; docs/DIGEST_RETENTION.md):
 * the nightly fold of EmailEvent into DigestSend.rolled*, html nulled after 30 days, and
 * the digest tables in the backup.
 *
 * Isolation: the sweep is global, so every instant here is FIXED in mid-2026 (runs dated
 * June, "now" 15 July). Rows other suites write (October-dated runs, events received at the
 * real clock) are newer than both cut-offs and are never touched by these sweeps.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-retention-';
const NOW = new Date('2026-07-15T00:00:00Z'); // 05:30 IST on 15 July
const OLD = new Date('2026-04-01T10:00:00Z'); // > 90 days before NOW
const RECENT = new Date('2026-07-01T10:00:00Z'); // < 90 days before NOW
const suppressionEmails: string[] = [];
const imageIds: string[] = [];
let n = 0;

afterAll(async () => {
  await prisma.emailEvent.deleteMany({ where: { dedupeKey: { startsWith: `test-ret-${RUN}` } } });
  await prisma.digestAdPlacement.deleteMany({ where: { ad: { portal: { startsWith: PORTAL_PREFIX } } } });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestAd.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestTemplate.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestAdImage.deleteMany({ where: { id: { in: imageIds } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { in: suppressionEmails } } });
  await prisma.$disconnect();
});

/** A run on `runDate` (IST date) with one SENT variant per audience. */
async function runWithSends(runDate: string) {
  const portal = `${PORTAL_PREFIX}${RUN}-${++n}`;
  const run = await prisma.digestRun.create({
    data: { portal, runDate: new Date(`${runDate}T00:00:00Z`), windowStart: OLD, build: 'BUILT', builtAt: OLD },
  });
  const mk = (audience: 'FREE' | 'PREMIUM') =>
    prisma.digestSend.create({
      data: {
        runId: run.id,
        audience,
        state: 'SENT',
        subject: `Subject ${audience}`,
        preheader: 'Plus 4 more',
        html: `<html>frozen ${audience}</html>`,
        text: `frozen ${audience}`,
        htmlBytes: 24,
        mcCampaignName: `TS-DIGEST-RET-${run.id}-${audience}`,
        mcCampaignId: `mc-ret-${run.id}-${audience}`,
        sendAfter: OLD,
        sentConfirmedAt: OLD,
        sentVia: 'status_poll',
      },
    });
  return { portal, run, free: await mk('FREE'), premium: await mk('PREMIUM') };
}

async function event(type: string, at: Date, o: { sendId?: string | null; mcCampaignId?: string | null; hash?: boolean } = {}) {
  return prisma.emailEvent.create({
    data: {
      type,
      receivedAt: at,
      sendId: o.sendId ?? null,
      mcCampaignId: o.mcCampaignId ?? null,
      emailHash: o.hash === false ? null : createHash('sha256').update(randomUUID()).digest('hex'),
      dedupeKey: `test-ret-${RUN}-${++n}`,
    },
  });
}

describe('EmailEvent fold (rolled + live parity)', () => {
  it('counts are identical before and after the fold; proof survives; NO_ADDRESS and account-wide rows go unfolded', async () => {
    const a = await runWithSends('2026-06-01');
    const b = await runWithSends('2026-06-02');
    const c = await runWithSends('2026-06-03');

    // a.free: proved by a campaign_sent carrying only the provider campaign id (old → deleted).
    await event('CAMPAIGN_SENT', OLD, { mcCampaignId: a.free.mcCampaignId, hash: false });
    for (const t of ['UNSUBSCRIBE', 'UNSUBSCRIBE', 'HARD_BOUNCE', 'SPAM']) await event(t, OLD, { sendId: a.free.id, mcCampaignId: a.free.mcCampaignId });
    await event('UNSUBSCRIBE', RECENT, { sendId: a.free.id, mcCampaignId: a.free.mcCampaignId }); // live, stays
    // a.premium: proved by a RECENT campaign_error linked by sendId (kept), old feedback folded.
    await event('CAMPAIGN_ERROR', RECENT, { sendId: a.premium.id, hash: false });
    await event('SPAM', OLD, { sendId: a.premium.id });
    // b.free: proof by sendId, old; zero feedback → real 0s, before and after.
    await event('CAMPAIGN_SENT', OLD, { sendId: b.free.id, hash: false });
    // c.free: feedback but NO proof → "—" before and after (folding it must not create proof).
    await event('UNSUBSCRIBE', OLD, { sendId: c.free.id });
    await event('HARD_BOUNCE', OLD, { sendId: c.free.id });
    // Unfolded noise: an account-wide opt-out (no send of ours) and the NO_ADDRESS counter.
    await event('UNSUBSCRIBE', OLD, {});
    const noAddr = await event('NO_ADDRESS', OLD, { hash: false });

    const ids = [a, b, c].flatMap((r) => [r.free.id, r.premium.id]);
    const before = Object.fromEntries(await digestSendStats(ids));
    expect(before[a.free.id]).toEqual({ unsubscribes: 3, bounces: 1, complaints: 1 });
    expect(before[a.premium.id]).toEqual({ unsubscribes: 0, bounces: 0, complaints: 1 });
    expect(before[b.free.id]).toEqual({ unsubscribes: 0, bounces: 0, complaints: 0 });
    expect(before[c.free.id]).toBeUndefined(); // "—", not 0
    expect(before[b.premium.id]).toBeUndefined();
    const suppressionsBefore = await prisma.emailSuppression.count();

    const r = await sweepDigestRetention({ now: NOW, batchSize: 3, maxBatches: 0 });
    expect(r.batches).toBeGreaterThan(1); // several transactions, same outcome
    const after = Object.fromEntries(await digestSendStats(ids));
    expect(after).toEqual(before);

    const rows = await prisma.digestSend.findMany({ where: { id: { in: ids } } });
    const row = (id: string) => rows.find((x) => x.id === id)!;
    expect(row(a.free.id)).toMatchObject({ rolledUnsub: 2, rolledBounce: 1, rolledSpam: 1, webhookProofAt: NOW });
    expect(row(a.premium.id)).toMatchObject({ rolledSpam: 1, webhookProofAt: null }); // its proof is still live
    expect(row(b.free.id)).toMatchObject({ rolledUnsub: 0, webhookProofAt: NOW });
    expect(row(c.free.id)).toMatchObject({ rolledUnsub: 1, rolledBounce: 1, webhookProofAt: null });

    const left = await prisma.emailEvent.findMany({ where: { dedupeKey: { startsWith: `test-ret-${RUN}` } }, select: { type: true, receivedAt: true } });
    expect(left.every((e) => e.receivedAt.getTime() === RECENT.getTime())).toBe(true);
    expect(left).toHaveLength(2);
    expect(await prisma.emailEvent.findUnique({ where: { id: noAddr.id } })).toBeNull();
    expect(await prisma.emailSuppression.count()).toBe(suppressionsBefore); // never touched

    // A second night changes nothing.
    await sweepDigestRetention({ now: NOW, maxBatches: 0 });
    expect(Object.fromEntries(await digestSendStats(ids))).toEqual(before);
    expect((await prisma.digestSend.findUniqueOrThrow({ where: { id: a.free.id } })).rolledUnsub).toBe(2);

    // And once the live half ages out too, the totals still hold.
    const later = new Date('2026-10-15T00:00:00Z');
    await sweepDigestRetention({ now: later, htmlDays: 3650, maxBatches: 0 });
    expect(Object.fromEntries(await digestSendStats(ids))).toEqual(before);
  });

  it('dry run counts and writes nothing', async () => {
    const a = await runWithSends('2026-06-05');
    await event('UNSUBSCRIBE', OLD, { sendId: a.free.id });
    await event('NO_ADDRESS', OLD, { hash: false });
    const r = await sweepDigestRetention({ now: NOW, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.deleted.UNSUBSCRIBE).toBeGreaterThanOrEqual(1);
    expect(r.folded).toBeGreaterThanOrEqual(1);
    expect(r.htmlNulled).toBeGreaterThanOrEqual(2);
    const s = await prisma.digestSend.findUniqueOrThrow({ where: { id: a.free.id } });
    expect(s).toMatchObject({ rolledUnsub: 0, htmlPurgedAt: null });
    expect(s.html).not.toBeNull();
    expect(await prisma.emailEvent.count({ where: { sendId: a.free.id } })).toBe(1);
    await sweepDigestRetention({ now: NOW, maxBatches: 0 }); // tidy for the next test
  });
});

describe('html nulled after 30 days', () => {
  it('nulls html/text of runs older than the window, keeps the rest, and the preview says "no longer stored"', async () => {
    const old = await runWithSends('2026-06-10'); // 35 days before NOW (IST)
    const fresh = await runWithSends('2026-06-20'); // 25 days before
    await prisma.digestItem.create({
      data: { runId: old.run.id, rank: 1, section: 'MAIN', articleKey: 'k1', title: 't', url: 'https://www.taxscan.in/x/1', category: 'GST', capturedAt: OLD },
    });
    const r = await sweepDigestRetention({ now: NOW });
    expect(r.htmlKeepFrom.toISOString().slice(0, 10)).toBe('2026-06-15');
    const o = await prisma.digestSend.findUniqueOrThrow({ where: { id: old.free.id } });
    expect(o).toMatchObject({ html: null, text: null, htmlPurgedAt: NOW, subject: 'Subject FREE', htmlBytes: 24 });
    const f = await prisma.digestSend.findUniqueOrThrow({ where: { id: fresh.free.id } });
    expect(f.html).toBe('<html>frozen FREE</html>');
    expect(await prisma.digestItem.count({ where: { runId: old.run.id } })).toBe(1); // stories are kept

    const c = parseDigestEnv({ DIGEST_ENABLED: 'true', DIGEST_POSTAL_ADDRESS: 'x' });
    const app = createApp({ digest: { cfg: c, clock: () => NOW, portal: old.portal, alerts: false } });
    const res = await request(app).get(`/api/digest/runs/${old.run.id}/preview/free`).set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(res.status).toBe(410);
    expect(res.text).toMatch(/^No longer stored/);
    const detail = await request(app).get(`/api/digest/runs/${old.run.id}`).set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    expect(detail.status).toBe(200);
    expect(detail.body.variants.map((v: { hasPreview: boolean }) => v.hasPreview)).toEqual([false, false]);
  });
});

describe('backup includes the digest tables', () => {
  it('EmailSuppression, templates, ads and images (bytes as base64) are exported in FK order', async () => {
    expect(BACKUP_TABLES).toEqual(
      expect.arrayContaining(['EmailSuppression', 'DigestTemplate', 'DigestAdImage', 'DigestSetting', 'DigestAd', 'DigestRun', 'DigestSend', 'DigestItem', 'DigestAdPlacement', 'EmailEvent']),
    );
    const idx = (t: string) => BACKUP_TABLES.indexOf(t as never);
    expect(idx('DigestAdImage')).toBeLessThan(idx('DigestAd'));
    expect(idx('DigestRun')).toBeLessThan(idx('DigestSend'));
    expect(idx('DigestSend')).toBeLessThan(idx('DigestAdPlacement'));
    expect(idx('DigestAd')).toBeLessThan(idx('DigestAdPlacement'));
    expect(idx('Campaign')).toBeLessThan(idx('DigestItem'));

    const email = `restore-check-${RUN}@example.invalid`;
    suppressionEmails.push(email);
    await prisma.emailSuppression.create({ data: { email, reason: 'UNSUBSCRIBE', source: 'manual' } });
    const bytes = gzipSync(Buffer.from(`fake-image-${RUN}`)); // any bytes
    const id = createHash('sha256').update(bytes).digest('hex');
    imageIds.push(id);
    await prisma.digestAdImage.create({ data: { id, mime: 'image/png', width: 10, height: 10, size: bytes.length, bytes } });

    const { body, result } = await buildBackup({ now: NOW });
    const lines = body.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].version).toBe(2);
    expect(result.tables.EmailSuppression).toBeGreaterThanOrEqual(1);
    const sup = lines.find((l) => l._table === 'EmailSuppression' && l.email === email);
    expect(sup).toMatchObject({ reason: 'UNSUBSCRIBE' });
    const img = lines.find((l) => l._table === 'DigestAdImage' && l.id === id);
    expect(Object.keys(img.bytes)).toEqual(['$base64']);
    expect(Buffer.from(img.bytes.$base64, 'base64').equals(bytes)).toBe(true);
    expect(gunzipSync(Buffer.from(img.bytes.$base64, 'base64')).toString()).toBe(`fake-image-${RUN}`);
  });
});

/*
 * QA additions (2026-10-23). Each of these guards survived a mutation run against the
 * tests above: the window judged on the UTC date, the window off by one day, and a
 * sweeper that deletes EmailSuppression rows (the earlier check compared 0 with 0).
 */
describe('QA: retention boundaries and what is never touched', () => {
  it('the 30-day html window is the IST date at the cron’s own hour (03:45 IST = 22:15 UTC the day before), and is exact to the day', async () => {
    const at = new Date('2026-07-14T22:15:00Z'); // 03:45 IST on 15 July; still 14 July in UTC
    const gone = await runWithSends('2026-06-14'); // 31 IST days before → nulled
    const kept = await runWithSends('2026-06-15'); // 30 IST days before → kept
    const r = await sweepDigestRetention({ now: at, maxBatches: 0 });
    expect(r.htmlKeepFrom.toISOString().slice(0, 10)).toBe('2026-06-15');
    expect(await prisma.digestSend.findUniqueOrThrow({ where: { id: gone.free.id } })).toMatchObject({ html: null, text: null, htmlPurgedAt: at });
    expect(await prisma.digestSend.findUniqueOrThrow({ where: { id: kept.free.id } })).toMatchObject({ html: '<html>frozen FREE</html>', htmlPurgedAt: null });
  });

  it('an EmailSuppression row older than every window is left exactly as it was', async () => {
    const a = await runWithSends('2026-06-06');
    const email = `qa-old-suppression-${RUN}@example.invalid`;
    suppressionEmails.push(email);
    const row = await prisma.emailSuppression.create({ data: { email, reason: 'HARD_BOUNCE', source: 'mailercloud_webhook', firstSeenAt: OLD, lastSeenAt: OLD } });
    await event('HARD_BOUNCE', OLD, { sendId: a.free.id }); // so a fold batch really runs
    const r = await sweepDigestRetention({ now: NOW, maxBatches: 0 });
    expect(r.batches).toBeGreaterThanOrEqual(1);
    expect(await prisma.emailSuppression.findUnique({ where: { email } })).toEqual(row);
  });
});
