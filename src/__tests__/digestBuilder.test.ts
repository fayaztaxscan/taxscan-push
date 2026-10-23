import type { CampaignStatus, DigestAudience, DigestSendState, SendQueue } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import {
  digestWindow,
  rankDigest,
  selectDigest,
  type RankInput,
  type SelectDeps,
} from '../services/digest/builder';
import { gaLastSyncAt, gaReadsSource, type ReadsSource } from '../services/digest/readsSource';
import { advanceRun, ensureRun } from '../services/digest/runner';
import { istDateOf } from '../services/digest/retryPolicy';
import { FakeSender } from './digestFakeSender';
import { deleteTestAds, ensureTestAds } from './digestAdFixtures';

/**
 * Email digest task 4 (docs/EMAIL_DIGEST_DESIGN.md §4.1): selection, ranking,
 * roll-forward, guards and freeze. Every row lives under a unique
 * `test-digest-builder-*` portal (Campaign, DigestRun, ArticleReadStat) and is
 * removed afterwards. No network: the link check and the reads source are injected.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-builder-';
const HOUR = 3_600_000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
/** UTC instant of IST wall-clock h:min on `day` Oct 2026. */
function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MS);
}
const NOW = ist(6, 30);
const QUIET = { start: '23:00', end: '07:00' };

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    DIGEST_MIN_ITEMS: '1',
    ...over,
  });
}

let n = 0;
function newPortal(): string {
  return `${PORTAL_PREFIX}${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;
}
let idSeq = 900_000_000 + Math.floor(Math.random() * 90_000_000);
function articleUrl(id = ++idSeq, section = 'income-tax'): string {
  return `https://www.taxscan.in/${section}/test-story-${id}`;
}

type CampOpts = {
  title?: string;
  url?: string;
  queue?: SendQueue | null;
  authority?: string | null;
  createdAt?: Date;
  status?: CampaignStatus;
  categories?: string[];
};
async function camp(portal: string, o: CampOpts = {}) {
  return prisma.campaign.create({
    data: {
      portal,
      title: o.title ?? `Story ${idSeq}`,
      body: 'An excerpt of the story.',
      url: o.url ?? articleUrl(),
      target: { type: 'all' },
      sendQueue: o.queue === undefined ? 'QUALIFIED' : o.queue,
      authority: o.authority === undefined ? 'High Court' : o.authority,
      createdAt: o.createdAt ?? new Date(NOW.getTime() - HOUR * 3),
      status: o.status ?? 'DRAFT',
      categories: o.categories ?? [],
    },
  });
}

/** A run on an earlier IST day with frozen items and the given variant states. */
async function pastRun(
  portal: string,
  day: number,
  opts: {
    build?: 'BUILT' | 'SKIPPED';
    builtAt?: Date;
    sends?: Partial<Record<DigestAudience, DigestSendState>>;
    items?: { key: string; url?: string; rank?: number; section?: string; audience?: DigestAudience | null }[];
  },
) {
  const runDate = istDateOf(ist(6, 30, day));
  return prisma.digestRun.create({
    data: {
      portal,
      runDate,
      windowStart: new Date(ist(6, 30, day).getTime() - 24 * HOUR),
      builtAt: opts.builtAt ?? ist(6, 30, day),
      build: opts.build ?? 'BUILT',
      sends: {
        create: Object.entries(opts.sends ?? {}).map(([audience, state]) => ({
          audience: audience as DigestAudience,
          state,
          subject: 's',
          preheader: 'p',
          htmlBytes: 1,
          mcCampaignName: `TS-DIGEST-TEST-${portal}-${day}-${audience}`,
          sendAfter: ist(7, 30, day),
        })),
      },
      items: {
        create: (opts.items ?? []).map((it, i) => ({
          rank: it.rank ?? i + 1,
          section: it.section ?? 'MAIN',
          audience: it.audience ?? null,
          articleKey: it.key,
          title: `Past ${it.key}`,
          url: it.url ?? articleUrl(Number(it.key.replace('article:', ''))),
          category: 'Income Tax',
          capturedAt: new Date(ist(6, 30, day).getTime() - 5 * HOUR),
        })),
      },
    },
  });
}

/** Today's run row (not via ensureRun, so the window is the builder's own). */
function todayRun(portal: string) {
  return prisma.digestRun.create({ data: { portal, runDate: istDateOf(NOW), windowStart: NOW } });
}

const noReads: ReadsSource = { name: 'ga', organicReads: async () => ({ fresh: false, reason: 'ga_reads_disabled', byKey: new Map() }) };
function deps(over: Partial<SelectDeps> = {}): SelectDeps {
  return { cfg: cfg(), linkCheck: false, readsSource: noReads, ...over };
}
const keyOf = (url: string) => `article:${/-(\d+)$/.exec(url)![1]}`;

afterAll(async () => {
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await deleteTestAds(PORTAL_PREFIX);
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.articleReadStat.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe('window', () => {
  it('previous builtAt exclusive, now inclusive', async () => {
    const portal = newPortal();
    const prevBuilt = ist(6, 30, 22);
    await pastRun(portal, 22, { builtAt: prevBuilt, sends: { FREE: 'SENT', PREMIUM: 'SENT' } });
    const atStart = await camp(portal, { createdAt: prevBuilt });
    const justAfter = await camp(portal, { createdAt: new Date(prevBuilt.getTime() + 1) });
    const atNow = await camp(portal, { createdAt: NOW });
    const future = await camp(portal, { createdAt: new Date(NOW.getTime() + 1) });
    const sel = await selectDigest(await todayRun(portal), NOW, deps());
    const ids = sel.perAudience.FREE.map((i) => i.campaignId);
    expect(ids).toEqual(expect.arrayContaining([justAfter.id, atNow.id]));
    expect(ids).not.toContain(atStart.id);
    expect(ids).not.toContain(future.id);
    expect(sel.windowStart).toEqual(prevBuilt);
    expect(sel.windowEnd).toEqual(NOW);
  });

  it('caps at 72 h and opens with 24 h on the first-ever run (pure)', () => {
    const old = new Date(NOW.getTime() - 100 * HOUR);
    expect(digestWindow(old, NOW).start).toEqual(new Date(NOW.getTime() - 72 * HOUR));
    expect(digestWindow(null, NOW).start).toEqual(new Date(NOW.getTime() - 24 * HOUR));
    const recent = new Date(NOW.getTime() - 20 * HOUR);
    expect(digestWindow(recent, NOW).start).toEqual(recent);
  });

  it('first-ever run takes the last 24 h only; a stale previous run is capped at 72 h', async () => {
    const portal = newPortal();
    const in24 = await camp(portal, { createdAt: new Date(NOW.getTime() - 23 * HOUR) });
    const out24 = await camp(portal, { createdAt: new Date(NOW.getTime() - 25 * HOUR) });
    let sel = await selectDigest(await todayRun(portal), NOW, deps());
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([in24.id]);
    expect(out24.id).toBeTruthy();

    const p2 = newPortal();
    await pastRun(p2, 15, { sends: { FREE: 'SENT', PREMIUM: 'SENT' } }); // 8 days ago
    const in72 = await camp(p2, { createdAt: new Date(NOW.getTime() - 71 * HOUR) });
    await camp(p2, { createdAt: new Date(NOW.getTime() - 73 * HOUR) });
    sel = await selectDigest(await todayRun(p2), NOW, deps());
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([in72.id]);
  });
});

describe('candidates', () => {
  it('REVIEW is excluded; an approved item (moved to QUALIFIED) is included; DRAFT/SENT/EXPIRED all eligible', async () => {
    const portal = newPortal();
    const review = await camp(portal, { queue: 'REVIEW', authority: null });
    const approved = await camp(portal, { queue: 'REVIEW', authority: null });
    await prisma.campaign.update({ where: { id: approved.id }, data: { sendQueue: 'QUALIFIED', reviewedAt: NOW } });
    const sent = await camp(portal, { status: 'SENT' });
    const expired = await camp(portal, { status: 'EXPIRED', queue: 'FALLBACK', authority: 'ITAT' });
    const failed = await camp(portal, { status: 'FAILED' });
    const manual = await camp(portal, { queue: null, authority: null });
    const academy = await camp(portal, { url: 'https://academy.taxscan.in/course/gst-123456' });
    const offsite = await camp(portal, { url: 'https://example.com/story-1234567' });
    const ids = (await selectDigest(await todayRun(portal), NOW, deps())).perAudience.FREE.map((i) => i.campaignId);
    expect(ids).toEqual(expect.arrayContaining([approved.id, sent.id, expired.id]));
    for (const x of [review, failed, manual, academy, offsite]) expect(ids).not.toContain(x.id);
  });

  it('re-GUID / re-capture: the same articleKey twice appears once (original capture kept)', async () => {
    const portal = newPortal();
    const id = ++idSeq;
    const original = await camp(portal, { url: articleUrl(id, 'top-stories'), createdAt: new Date(NOW.getTime() - 5 * HOUR) });
    await camp(portal, { url: articleUrl(id, 'income-tax'), createdAt: new Date(NOW.getTime() - 1 * HOUR) }); // re-GUID, new path
    await camp(portal, { url: articleUrl(id, 'income-tax'), createdAt: new Date(NOW.getTime() - 30 * 60_000) }); // backfill clone
    const sel = await selectDigest(await todayRun(portal), NOW, deps());
    expect(sel.perAudience.FREE).toHaveLength(1);
    expect(sel.perAudience.FREE[0].campaignId).toBe(original.id);
    expect(sel.candidateCount).toBe(1);
  });

  it('drops keys already in a SENT/PARTIALLY_SENT digest for that audience within 90 days, per audience', async () => {
    const portal = newPortal();
    const a = await camp(portal);
    const b = await camp(portal);
    const c = await camp(portal);
    const d = await camp(portal);
    // Day 20: FREE sent, PREMIUM failed. a → both; b → FREE only row.
    await pastRun(portal, 20, {
      sends: { FREE: 'SENT', PREMIUM: 'FAILED' },
      items: [{ key: keyOf(a.url) }, { key: keyOf(b.url), audience: 'FREE' }],
    });
    // Day 21: PREMIUM partially sent with c. Skipped run's d does NOT count as sent.
    await pastRun(portal, 21, { sends: { FREE: 'SKIPPED', PREMIUM: 'PARTIALLY_SENT' }, items: [{ key: keyOf(c.url), audience: 'PREMIUM' }] });
    const old = await camp(portal);
    // > 90 days ago: no longer excludes.
    await prisma.digestRun.create({
      data: {
        portal,
        runDate: istDateOf(new Date(NOW.getTime() - 95 * 24 * HOUR)),
        windowStart: NOW,
        builtAt: new Date(NOW.getTime() - 95 * 24 * HOUR),
        build: 'BUILT',
        sends: { create: [{ audience: 'FREE', state: 'SENT', subject: 's', preheader: 'p', htmlBytes: 1, mcCampaignName: `TS-OLD-${portal}`, sendAfter: NOW }] },
        items: { create: [{ rank: 1, section: 'MAIN', articleKey: keyOf(old.url), title: 't', url: old.url, category: 'x', capturedAt: NOW }] },
      },
    });
    await pastRun(portal, 22, { build: 'SKIPPED', items: [{ key: keyOf(d.url) }] });
    // Stories were captured after day 22's build so they are in today's window.
    const sel = await selectDigest(await todayRun(portal), NOW, deps());
    const free = sel.perAudience.FREE.filter((i) => i.section === 'MAIN').map((i) => i.campaignId);
    const prem = sel.perAudience.PREMIUM.filter((i) => i.section === 'MAIN').map((i) => i.campaignId);
    expect(free.sort()).toEqual([c.id, d.id, old.id].sort());
    expect(prem.sort()).toEqual([a.id, b.id, d.id, old.id].sort()); // PREMIUM failed on day 20, so a was never sent to it
  });
});

describe('re-captures (first capture before the window start)', () => {
  it('a re-capture of an older article is excluded from MAIN; first-seen inside the window is kept', async () => {
    const portal = newPortal();
    const prevBuilt = ist(6, 30, 22);
    await pastRun(portal, 22, { builtAt: prevBuilt, sends: { FREE: 'SENT', PREMIUM: 'SENT' } });
    // Old article first captured 10 days ago (any status), re-captured today under a new path.
    const oldId = ++idSeq;
    await camp(portal, { url: articleUrl(oldId, 'top-stories'), createdAt: new Date(NOW.getTime() - 10 * 24 * HOUR), status: 'SENT' });
    const recap = await camp(portal, { url: articleUrl(oldId, 'income-tax'), createdAt: new Date(NOW.getTime() - 2 * HOUR) });
    // First captured exactly AT the window start (previous window's), re-captured inside.
    const edgeId = ++idSeq;
    await camp(portal, { url: articleUrl(edgeId), createdAt: prevBuilt, queue: 'REVIEW', authority: null });
    const edge = await camp(portal, { url: articleUrl(edgeId), createdAt: new Date(NOW.getTime() - 1 * HOUR) });
    // First seen inside the window as a REVIEW row (not a candidate), then a QUALIFIED capture.
    const newId = ++idSeq;
    await camp(portal, { url: articleUrl(newId), createdAt: new Date(NOW.getTime() - 6 * HOUR), queue: 'REVIEW', authority: null });
    const fresh = await camp(portal, { url: articleUrl(newId), createdAt: new Date(NOW.getTime() - 2 * HOUR) });
    // First capture beyond the 90-day lookback: counts as new again.
    const ancientId = ++idSeq;
    await camp(portal, { url: articleUrl(ancientId), createdAt: new Date(NOW.getTime() - 100 * 24 * HOUR) });
    const ancient = await camp(portal, { url: articleUrl(ancientId), createdAt: new Date(NOW.getTime() - 3 * HOUR) });

    const sel = await selectDigest(await todayRun(portal), NOW, deps());
    const ids = sel.perAudience.FREE.map((i) => i.campaignId);
    expect(ids).not.toContain(recap.id);
    expect(ids).not.toContain(edge.id);
    expect(ids.sort()).toEqual([fresh.id, ancient.id].sort());
    expect(sel.perAudience.FREE.find((i) => i.campaignId === fresh.id)!.capturedAt).toEqual(new Date(NOW.getTime() - 6 * HOUR));
    // The sanity figure still counts the re-captures (a re-platform storm must still hold the run).
    expect(sel.candidateCount).toBe(4);
  });

  it('a re-capture with big lifetime reads no longer beats a genuinely fresh story; rate is from the FIRST capture', async () => {
    const portal = newPortal();
    const fresh = gaReadsSource({ enabled: true, portal, lastSyncAt: async () => new Date(NOW.getTime() - HOUR) });
    const put = async (url: string, total: number) =>
      prisma.articleReadStat.create({
        data: { portal, pagePath: new URL(url).pathname, date: new Date(Date.UTC(2026, 9, 22)), totalViews: total, pushViews: 0 },
      });
    const oldId = ++idSeq;
    await camp(portal, { url: articleUrl(oldId), createdAt: new Date(NOW.getTime() - 30 * 24 * HOUR), status: 'SENT' });
    await camp(portal, { url: articleUrl(oldId), createdAt: new Date(NOW.getTime() - 3 * HOUR) });
    await put(articleUrl(oldId), 3000); // would have scored 1,000/h
    // In-window first capture as REVIEW 10 h ago; the QUALIFIED row is 4 h old. 400 reads → 40/h, not 100/h.
    const kId = ++idSeq;
    await camp(portal, { url: articleUrl(kId), createdAt: new Date(NOW.getTime() - 10 * HOUR), queue: 'REVIEW', authority: null });
    const k = await camp(portal, { url: articleUrl(kId), createdAt: new Date(NOW.getTime() - 4 * HOUR) });
    await put(articleUrl(kId), 400);
    const genuine = await camp(portal, { createdAt: new Date(NOW.getTime() - 3 * HOUR) });
    await put(genuine.url, 600); // 200/h
    const sel = await selectDigest(await todayRun(portal), NOW, deps({ readsSource: fresh }));
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([genuine.id, k.id]);
    expect(sel.perAudience.FREE[1].readRate).toBeCloseTo(40);
  });
});

describe('90-day exclusion is per audience', () => {
  it('a FREE-only item in a run sent to both stays eligible for PREMIUM, and vice versa', async () => {
    const portal = newPortal();
    const f = await camp(portal);
    const p = await camp(portal);
    await pastRun(portal, 21, {
      sends: { FREE: 'SENT', PREMIUM: 'SENT' },
      items: [
        { key: keyOf(f.url), audience: 'FREE' },
        { key: keyOf(p.url), audience: 'PREMIUM' },
      ],
    });
    const sel = await selectDigest(await todayRun(portal), NOW, deps());
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([p.id]);
    expect(sel.perAudience.PREMIUM.map((i) => i.campaignId)).toEqual([f.id]);
  });
});

describe('rankDigest', () => {
  const t = (h: number) => new Date(NOW.getTime() - h * HOUR);
  const item = (id: string, sendQueue: SendQueue, authority: string | null, createdAt: Date, organicReads: number | null = null): RankInput => ({
    id,
    sendQueue,
    authority,
    createdAt,
    organicReads,
  });
  const order = (xs: RankInput[]) => rankDigest(xs, NOW).map((x) => x.id);

  it.each([
    ['SC > priority HC > HC > regulatory', [item('reg', 'QUALIFIED', 'CBDT', t(1)), item('hc', 'QUALIFIED', 'High Court', t(1)), item('bom', 'QUALIFIED', 'Bombay High Court', t(1)), item('sc', 'QUALIFIED', 'Supreme Court', t(1))], ['sc', 'bom', 'hc', 'reg']],
    ['QUALIFIED > FALLBACK even for a lower tier', [item('fb-sc', 'FALLBACK', 'Supreme Court', t(1)), item('q-reg', 'QUALIFIED', null, t(5))], ['q-reg', 'fb-sc']],
    ['newest first within a tier', [item('old', 'QUALIFIED', 'High Court', t(9)), item('new', 'QUALIFIED', 'High Court', t(1)), item('mid', 'QUALIFIED', 'High Court', t(4))], ['new', 'mid', 'old']],
    ['a yesterday-evening SC beats a this-morning regulatory note', [item('reg-0600', 'QUALIFIED', 'CBDT', ist(6, 0)), item('sc-2000', 'QUALIFIED', 'Supreme Court', ist(20, 0, 22))], ['sc-2000', 'reg-0600']],
  ])('%s', (_name, xs, expected) => {
    expect(order(xs)).toEqual(expected);
  });

  it('within a tier, organic read RATE decides (per hour since capture), ties newest first', () => {
    // older: 100 reads / 10 h = 10/h; younger: 60 reads / 3 h = 20/h; tie pair at 5/h.
    const xs = [
      item('older-more-reads', 'QUALIFIED', 'High Court', t(10), 100),
      item('younger-faster', 'QUALIFIED', 'High Court', t(3), 60),
      item('tie-old', 'QUALIFIED', 'High Court', t(8), 40),
      item('tie-new', 'QUALIFIED', 'High Court', t(4), 20),
    ];
    const r = rankDigest(xs, NOW);
    expect(r.map((x) => x.id)).toEqual(['younger-faster', 'older-more-reads', 'tie-new', 'tie-old']);
    expect(r[0].readRate).toBeCloseTo(20);
  });

  it('a heavily read HC never outranks a lightly read SC; FALLBACK never outranks QUALIFIED', () => {
    const xs = [
      item('hc-hot', 'QUALIFIED', 'High Court', t(3), 100_000),
      item('sc-cold', 'QUALIFIED', 'Supreme Court', t(20), 1),
      item('fb-hot', 'FALLBACK', 'Supreme Court', t(3), 100_000),
      item('reg-cold', 'QUALIFIED', 'CBDT', t(20), 0),
    ];
    expect(order(xs)).toEqual(['sc-cold', 'hc-hot', 'reg-cold', 'fb-hot']);
  });

  it('items younger than 2 h sort as if at the median rate of their group (neither buried nor boosted)', () => {
    // Rated: 30/h, 20/h, 10/h → median 20/h. Fresh item (1 h old, huge reads) is not judged by them.
    const xs = [
      item('r30', 'QUALIFIED', 'High Court', t(4), 120),
      item('r20', 'QUALIFIED', 'High Court', t(5), 100),
      item('r10', 'QUALIFIED', 'High Court', t(6), 60),
      item('fresh', 'QUALIFIED', 'High Court', t(1), 9_999),
    ];
    const r = rankDigest(xs, NOW);
    // Ties with r20 at 20/h → newest first, so fresh comes before r20.
    expect(r.map((x) => x.id)).toEqual(['r30', 'fresh', 'r20', 'r10']);
    expect(r.find((x) => x.id === 'fresh')!.readRate).toBeNull();
  });

  it('no read rows and < 8 h old: unrated, placed at the group median — not last', () => {
    // Rated: 30/h, 20/h, 10/h → median 20/h. 'pending' is 4 h old with no GA rows yet.
    const pending = { ...item('pending', 'QUALIFIED', 'High Court', t(4), 0), noReadData: true };
    const xs = [item('r30', 'QUALIFIED', 'High Court', t(4.5), 135), item('r20', 'QUALIFIED', 'High Court', t(5), 100), item('r10', 'QUALIFIED', 'High Court', t(6), 60), pending];
    const r = rankDigest(xs, NOW);
    expect(r.map((x) => x.id)).toEqual(['r30', 'pending', 'r20', 'r10']);
    expect(r.find((x) => x.id === 'pending')!.readRate).toBeNull();
  });

  it('no read rows and >= 8 h old: 0 reads, ranks below rated peers', () => {
    const silent = { ...item('silent', 'QUALIFIED', 'High Court', t(20), 0), noReadData: true };
    const xs = [silent, item('r1', 'QUALIFIED', 'High Court', t(30), 30), item('r2', 'QUALIFIED', 'High Court', t(25), 10)];
    const r = rankDigest(xs, NOW);
    expect(r.map((x) => x.id)).toEqual(['r1', 'r2', 'silent']);
    expect(r[2].readRate).toBe(0);
  });

  it('cross-tier invariant holds with unrated items: an unrated HC never outranks a cold SC', () => {
    const xs = [
      { ...item('hc-pending', 'QUALIFIED', 'High Court', t(3), 0), noReadData: true },
      item('hc-hot', 'QUALIFIED', 'High Court', t(5), 1_000),
      item('sc-cold', 'QUALIFIED', 'Supreme Court', t(20), 0),
      { ...item('sc-silent', 'QUALIFIED', 'Supreme Court', t(30), 0), noReadData: true },
    ];
    // hc-pending takes the HC median (hc-hot's rate) and wins the tie as newer — but stays below both SCs.
    expect(order(xs)).toEqual(['sc-cold', 'sc-silent', 'hc-pending', 'hc-hot']);
  });

  it('with reads unused (null) the order is exactly newest-first within tier', () => {
    const xs = [item('a', 'QUALIFIED', 'High Court', t(9)), item('b', 'QUALIFIED', 'High Court', t(1)), item('c', 'QUALIFIED', 'Supreme Court', t(30))];
    const r = rankDigest(xs, NOW);
    expect(r.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(r.every((x) => x.readRate === null)).toBe(true);
  });
});

describe('reads source (GA via ArticleReadStat)', () => {
  async function reads(portal: string, url: string, total: number, push: number, daysAgo = 0) {
    const path = new URL(url).pathname;
    const d = new Date(NOW.getTime() - daysAgo * 24 * HOUR);
    await prisma.articleReadStat.create({
      data: { portal, pagePath: path, date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), totalViews: total, pushViews: push },
    });
  }
  const fresh = (portal: string) => gaReadsSource({ enabled: true, portal, lastSyncAt: async () => new Date(NOW.getTime() - HOUR) });

  it('push views are excluded: a mostly-pushed story does not jump ahead', async () => {
    const portal = newPortal();
    const pushed = await camp(portal, { createdAt: new Date(NOW.getTime() - 4 * HOUR) });
    const organic = await camp(portal, { createdAt: new Date(NOW.getTime() - 5 * HOUR) });
    await reads(portal, pushed.url, 1000, 980); // 20 organic → 5/h
    await reads(portal, organic.url, 300, 0, 0);
    await reads(portal, organic.url, 100, 50, 1); // 350 organic → 70/h
    const sel = await selectDigest(await todayRun(portal), NOW, deps({ readsSource: fresh(portal) }));
    expect(sel.reads).toEqual({ used: true, source: 'ga', note: null });
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([organic.id, pushed.id]);
    expect(sel.perAudience.FREE[0].readRate).toBeCloseTo(70);
  });

  it('reads under an older path of the same article (re-GUID) are counted, and organic is clamped at 0', async () => {
    const portal = newPortal();
    const id = ++idSeq;
    const a = await camp(portal, { url: articleUrl(id, 'top-stories'), createdAt: new Date(NOW.getTime() - 10 * HOUR) });
    await camp(portal, { url: articleUrl(id, 'income-tax'), createdAt: new Date(NOW.getTime() - 9 * HOUR) });
    const b = await camp(portal, { createdAt: new Date(NOW.getTime() - 3 * HOUR) });
    await reads(portal, articleUrl(id, 'top-stories'), 50, 0);
    await reads(portal, articleUrl(id, 'income-tax'), 150, 0); // 200 / 10 h = 20/h
    await reads(portal, b.url, 5, 50); // negative → 0
    const sel = await selectDigest(await todayRun(portal), NOW, deps({ readsSource: fresh(portal) }));
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([a.id, b.id]);
    expect(sel.perAudience.FREE[0].readRate).toBeCloseTo(20);
    expect(sel.perAudience.FREE[1].readRate).toBe(0);
  });

  it('end to end: a 4 h-old article with no rows is placed at the median, a 20 h-old one with no rows is last', async () => {
    const portal = newPortal();
    const mk = (h: number) => camp(portal, { createdAt: new Date(NOW.getTime() - h * HOUR) });
    const r30 = await mk(5);
    const r20 = await mk(6);
    const r10 = await mk(7);
    const pending = await mk(4);
    const silent = await mk(20);
    await reads(portal, r30.url, 150, 0);
    await reads(portal, r20.url, 120, 0);
    await reads(portal, r10.url, 70, 0);
    const sel = await selectDigest(await todayRun(portal), NOW, deps({ readsSource: fresh(portal) }));
    // Rated: 30, 20, 10 and silent's 0/h (no rows at 20 h = genuinely 0) → median 15/h,
    // so pending sits between r20 and r10: in the middle, not last.
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([r30.id, r20.id, pending.id, r10.id, silent.id]);
    expect(sel.perAudience.FREE[2].readRate).toBeNull();
    expect(sel.perAudience.FREE[4].readRate).toBe(0);
  });

  it('stale or missing data: identical to newest-first and readsUsed=false with the reason', async () => {
    const portal = newPortal();
    const older = await camp(portal, { createdAt: new Date(NOW.getTime() - 10 * HOUR) });
    const newer = await camp(portal, { createdAt: new Date(NOW.getTime() - 3 * HOUR) });
    await reads(portal, older.url, 10_000, 0);
    const run = await todayRun(portal);
    const stale = gaReadsSource({ enabled: true, portal, lastSyncAt: async () => new Date(NOW.getTime() - 7 * HOUR) });
    const none = gaReadsSource({ enabled: true, portal, lastSyncAt: async () => null });
    const off = gaReadsSource({ enabled: false, portal });
    for (const [src, note] of [[stale, /^stale_since_/], [none, /^no_read_data$/], [off, /^ga_reads_disabled$/]] as const) {
      const sel = await selectDigest(run, NOW, deps({ readsSource: src }));
      expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([newer.id, older.id]);
      expect(sel.reads.used).toBe(false);
      expect(sel.reads.note).toMatch(note);
      expect(sel.perAudience.FREE.every((i) => i.readRate === null)).toBe(true);
    }
  });

  it('gaLastSyncAt reads the newest fetchedAt of recent dates', async () => {
    const portal = newPortal();
    expect(await gaLastSyncAt(portal, new Date())).toBeNull();
    const now = new Date();
    await prisma.articleReadStat.create({
      data: { portal, pagePath: '/x/test-1', date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), totalViews: 1 },
    });
    const last = await gaLastSyncAt(portal, now);
    expect(last).not.toBeNull();
    expect(Math.abs(last!.getTime() - now.getTime())).toBeLessThan(60_000);
  });
});

describe('roll-forward', () => {
  it('a skipped day rolls its top 3 into ICYMI, inside the cap, excluding today\'s list and already-sent keys', async () => {
    const portal = newPortal();
    const sentBefore = ++idSeq;
    await pastRun(portal, 20, { sends: { FREE: 'SENT', PREMIUM: 'SENT' }, items: [{ key: `article:${sentBefore}` }] });
    const todayDup = await camp(portal);
    const k = [++idSeq, ++idSeq, ++idSeq, ++idSeq, ++idSeq];
    await pastRun(portal, 22, {
      build: 'SKIPPED',
      items: [
        { key: `article:${sentBefore}`, rank: 1 }, // already in day 20's sent digest
        { key: keyOf(todayDup.url), rank: 2, url: todayDup.url }, // in today's candidates
        { key: `article:${k[0]}`, rank: 3 },
        { key: `article:${k[1]}`, rank: 4 },
        { key: `article:${k[2]}`, rank: 5 },
        { key: `article:${k[3]}`, rank: 6 },
      ],
    });
    for (let i = 0; i < 12; i++) await camp(portal);
    const sel = await selectDigest(await todayRun(portal), NOW, deps());
    for (const a of ['FREE', 'PREMIUM'] as const) {
      const list = sel.perAudience[a];
      expect(list).toHaveLength(12);
      const icymi = list.filter((i) => i.section === 'ICYMI');
      expect(icymi.map((i) => i.articleKey)).toEqual([`article:${k[0]}`, `article:${k[1]}`, `article:${k[2]}`]);
      expect(list.slice(-3).every((i) => i.section === 'ICYMI')).toBe(true);
      expect(list.filter((i) => i.articleKey === keyOf(todayDup.url))).toHaveLength(1);
      expect(list.map((i) => i.rank)).toEqual(list.map((_, i) => i + 1));
    }
    expect(sel.mainCounts).toEqual({ FREE: 9, PREMIUM: 9 });
  });

  it('a partial send rolls forward to the affected audience only; a fully sent day rolls nothing', async () => {
    const portal = newPortal();
    const k1 = ++idSeq;
    await pastRun(portal, 22, { sends: { FREE: 'SENT', PREMIUM: 'PARTIALLY_SENT' }, items: [{ key: `article:${k1}` }] });
    await camp(portal);
    const sel = await selectDigest(await todayRun(portal), NOW, deps());
    expect(sel.perAudience.FREE.some((i) => i.section === 'ICYMI')).toBe(false);
    expect(sel.perAudience.PREMIUM.filter((i) => i.section === 'ICYMI').map((i) => i.articleKey)).toEqual([`article:${k1}`]);
    // DB rows: the shared MAIN item is one row (audience null); ICYMI is PREMIUM-only.
    expect(sel.rows.filter((r) => r.audience === null)).toHaveLength(1);
    expect(sel.rows.filter((r) => r.section === 'ICYMI').map((r) => r.audience)).toEqual(['PREMIUM']);
  });
});

describe('link check', () => {
  it('drops 404/410 only and keeps items whose check errors; refills from the next candidate', async () => {
    const portal = newPortal();
    const gone = await camp(portal, { authority: 'Supreme Court' });
    const flaky = await camp(portal, { authority: 'Supreme Court', createdAt: new Date(NOW.getTime() - 4 * HOUR) });
    const ok = await camp(portal, { createdAt: new Date(NOW.getTime() - 5 * HOUR) });
    const spare = await camp(portal, { createdAt: new Date(NOW.getTime() - 6 * HOUR) });
    const checked: string[] = [];
    const isUrlDead = async (u: string) => {
      checked.push(u);
      if (u === gone.url) return true;
      if (u === flaky.url) throw new Error('timeout');
      return false;
    };
    const sel = await selectDigest(await todayRun(portal), NOW, deps({ linkCheck: true, isUrlDead, cfg: cfg({ DIGEST_MAX_ITEMS: '3' }) }));
    expect(sel.perAudience.FREE.map((i) => i.campaignId)).toEqual([flaky.id, ok.id, spare.id]);
    expect(sel.droppedDead).toBe(1);
    expect(new Set(checked).size).toBe(checked.length); // each URL checked once across both audiences

    const off = await selectDigest(await todayRun(newPortal()), NOW, deps({ linkCheck: false, isUrlDead: async () => true }));
    expect(off.droppedDead).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Through the runner                                                  */
/* ------------------------------------------------------------------ */

describe('runner integration', () => {
  async function advance(runId: string, now: Date, c: DigestEnv, sender = new FakeSender(), calls = { n: 0 }) {
    await ensureTestAds((await prisma.digestRun.findUniqueOrThrow({ where: { id: runId } })).portal);
    return advanceRun(runId, 'cron', {
      sender,
      now,
      cfg: c,
      quiet: QUIET,
      selectItems: (run, at) => {
        calls.n++;
        return selectDigest(run, at, deps({ cfg: c }));
      },
    });
  }

  it('too little news: run SKIPPED too_little_news, items frozen with builtAt, no variants; they roll forward next day', async () => {
    const portal = newPortal();
    const c = cfg({ DIGEST_MIN_ITEMS: '5' });
    for (let i = 0; i < 3; i++) await camp(portal, { createdAt: new Date(ist(6, 30, 22).getTime() - (i + 1) * HOUR) });
    const day1 = await ensureRun({ portal, now: ist(6, 30, 22), cfg: c });
    const r1 = await advance(day1.id, ist(6, 30, 22), c);
    const run1 = await prisma.digestRun.findUniqueOrThrow({ where: { id: day1.id }, include: { items: true, sends: true } });
    expect(r1.steps).toContain('build:skipped:too_little_news');
    expect(run1.build).toBe('SKIPPED');
    expect(run1.skipReason).toBe('too_little_news');
    expect(run1.builtAt).toEqual(ist(6, 30, 22));
    expect(run1.items).toHaveLength(3);
    expect(run1.sends).toHaveLength(0);

    for (let i = 0; i < 6; i++) await camp(portal, { createdAt: new Date(NOW.getTime() - (i + 1) * HOUR) });
    const day2 = await ensureRun({ portal, now: NOW, cfg: c });
    await advance(day2.id, NOW, c);
    const run2 = await prisma.digestRun.findUniqueOrThrow({ where: { id: day2.id }, include: { items: true } });
    expect(run2.build).toBe('BUILT');
    expect(run2.windowStart).toEqual(ist(6, 30, 22));
    expect(run2.items.filter((i) => i.section === 'ICYMI').map((i) => i.articleKey).sort()).toEqual(run1.items.map((i) => i.articleKey).sort());
    expect(run2.items.filter((i) => i.section === 'MAIN')).toHaveLength(6);
    expect(run2.readsUsed).toBe(false);
    expect(run2.readsSource).toBe('ga');
  });

  it('> sanity limit: held for an editor even with approval off; approve releases it; at the cut-off sanity_hold_expired', async () => {
    const portal = newPortal();
    const c = cfg({ DIGEST_SANITY_MAX_CANDIDATES: '3' });
    for (let i = 0; i < 4; i++) await camp(portal);
    const run = await ensureRun({ portal, now: NOW, cfg: c });
    const sender = new FakeSender();
    await advance(run.id, NOW, c, sender);
    let r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.candidateCount).toBe(4);
    expect(r.approval).toBe('PENDING');
    expect((r.alerts as Record<string, unknown>).sanity_hold).toBeDefined();
    const res = await advance(run.id, ist(7, 31), c, sender);
    expect(res.steps.some((s) => s.endsWith('sanity_hold'))).toBe(true);
    expect(sender.count('schedule')).toBe(0);

    // Cut-off: skipped as sanity_hold_expired.
    await advance(run.id, ist(17, 0), c, sender);
    r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.skipReason).toBe('sanity_hold_expired');

    // Another run: approving releases the send.
    const p2 = newPortal();
    for (let i = 0; i < 4; i++) await camp(p2);
    const run2 = await ensureRun({ portal: p2, now: NOW, cfg: c });
    const s2 = new FakeSender();
    await advance(run2.id, NOW, c, s2);
    await prisma.digestRun.update({ where: { id: run2.id }, data: { approval: 'APPROVED' } });
    await advance(run2.id, ist(7, 31), c, s2);
    expect(s2.count('schedule')).toBe(2);
  });

  it('freeze is immutable: a later advance never re-selects or changes items, even when new stories arrive', async () => {
    const portal = newPortal();
    const c = cfg();
    for (let i = 0; i < 3; i++) await camp(portal);
    const run = await ensureRun({ portal, now: NOW, cfg: c });
    const calls = { n: 0 };
    const sender = new FakeSender();
    await advance(run.id, NOW, c, sender, calls);
    const snap = async () =>
      (await prisma.digestItem.findMany({ where: { runId: run.id }, orderBy: [{ audience: 'asc' }, { rank: 'asc' }] })).map((i) => ({ ...i }));
    const before = await snap();
    const html = (await prisma.digestSend.findFirstOrThrow({ where: { runId: run.id, audience: 'FREE' } })).html;
    expect(before).toHaveLength(3);
    expect(html).toContain('test-story-');

    await camp(portal, { authority: 'Supreme Court', createdAt: new Date(NOW.getTime() + 10 * 60_000) });
    await advance(run.id, ist(6, 45), c, sender, calls);
    await advance(run.id, ist(7, 31), c, sender, calls);
    expect(calls.n).toBe(1);
    expect(await snap()).toEqual(before);
    expect((await prisma.digestSend.findFirstOrThrow({ where: { runId: run.id, audience: 'FREE' } })).html).toBe(html);
  });

  it('a build failure in selection marks BUILD_FAILED and writes no items', async () => {
    const portal = newPortal();
    const c = cfg();
    const run = await ensureRun({ portal, now: NOW, cfg: c });
    await advanceRun(run.id, 'cron', {
      sender: new FakeSender(),
      now: NOW,
      cfg: c,
      quiet: QUIET,
      selectItems: async () => {
        throw new Error('db blip');
      },
    });
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id }, include: { items: true } });
    expect(r.build).toBe('BUILD_FAILED');
    expect(r.builtAt).toBeNull();
    expect(r.items).toHaveLength(0);
  });
});
