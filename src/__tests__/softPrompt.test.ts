/**
 * Soft-prompt v2 + funnel tracking (2026-10-15).
 *
 * - The SDK's arming rules (`promptTriggers`, a pure function exposed through
 *   the same __TAXSCAN_PUSH_TESTS_ENABLE__ hook cutover.test uses): v1 never
 *   asks on a reader's first page; v2 may, but only after real engagement.
 * - /api/track accepts the new funnel steps with a closed set of context tags
 *   and rejects anything free-form; /api/config tells the SDK which variant.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import request from 'supertest';
import { createApp } from '../app';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

type Trigger = { kind: string; ms?: number; ratio?: number };
type ScrollState = { ratio: number; scrollTop: number; clientHeight: number; scrollHeight: number; sawInput: boolean };
type Internals = {
  promptTriggers: (isLanding: boolean, variant: string) => Trigger[];
  scrollShouldShow: (realScroll: boolean, s: ScrollState) => boolean;
  isRealScrollInput: (type: string, isTrusted: boolean, key?: string) => boolean;
  visibleOk: (realScroll: boolean, visibilityState: string) => boolean;
};

function loadSdk(): Internals {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'taxscan-push.js'), 'utf8');
  const noop = () => undefined;
  const sandbox: Record<string, unknown> = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, Promise, URL, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    __TAXSCAN_PUSH_TESTS_ENABLE__: true,
    TAXSCAN_PUSH_CONFIG: { apiBase: 'http://localhost:3000' },
    PushManager: function () {},
    Notification: { permission: 'default', requestPermission: () => Promise.resolve('default') },
    navigator: { serviceWorker: { register: () => Promise.resolve({}), ready: Promise.resolve({}) } },
    document: { readyState: 'complete', addEventListener: noop },
    location: { origin: 'http://localhost:3000' },
    addEventListener: noop,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return (sandbox as { __taxscanPushTest__: Internals }).__taxscanPushTest__;
}

describe('SDK prompt arming (promptTriggers)', () => {
  const { promptTriggers } = loadSdk();
  const kinds = (t: Trigger[]) => t.map((x) => x.kind);

  it('v1 never asks on the first page of a visit', () => {
    expect(promptTriggers(true, 'v1')).toEqual([]);
  });

  it('v2 asks on a first page only after engagement: 60% scroll or 45 s', () => {
    const t = promptTriggers(true, 'v2');
    expect(kinds(t).sort()).toEqual(['dwell', 'scroll']);
    expect(t.find((x) => x.kind === 'dwell')?.ms).toBe(45000);
    expect(t.find((x) => x.kind === 'scroll')?.ratio).toBe(0.6);
    expect(kinds(t)).not.toContain('second-page');
  });

  it('a later page uses the original triggers in both variants', () => {
    for (const v of ['v1', 'v2']) {
      const t = promptTriggers(false, v);
      expect(kinds(t)).toEqual(['second-page', 'dwell', 'scroll']);
      expect(t[0].ms).toBe(2000);
      expect(t[1].ms).toBe(30000);
      expect(t[2].ratio).toBe(0.5);
    }
  });
});

describe('SDK real-scroll rules (SOFT_PROMPT_REAL_SCROLL)', () => {
  const { scrollShouldShow, isRealScrollInput, visibleOk } = loadSdk();
  // A 800px window on a 4000px page, scrolled to 2800px (70%).
  const base: ScrollState = { ratio: 0.6, scrollTop: 2800, clientHeight: 800, scrollHeight: 4000, sawInput: true };

  it('flag off: today\'s rule exactly (ratio only, no input needed, tiny pages pass)', () => {
    expect(scrollShouldShow(false, { ...base, sawInput: false })).toBe(true);
    // 1.2 windows tall, scrolled to the bottom: ratio 1.0 passes today.
    expect(scrollShouldShow(false, { ratio: 0.6, scrollTop: 160, clientHeight: 800, scrollHeight: 960, sawInput: false })).toBe(true);
    expect(scrollShouldShow(false, { ...base, scrollTop: 1000 })).toBe(false); // 31% < 60%
    expect(scrollShouldShow(false, { ...base, scrollHeight: 800 })).toBe(false); // nothing to scroll
  });

  it('flag on: no show without a prior trusted input', () => {
    expect(scrollShouldShow(true, { ...base, sawInput: false })).toBe(false);
  });

  it('flag on: after input, shows at >=60% AND >=1 window AND page >=2 windows', () => {
    expect(scrollShouldShow(true, base)).toBe(true);
    expect(scrollShouldShow(true, { ...base, scrollTop: 1500 })).toBe(false); // 47% < 60%
    // 60% reached but under one window scrolled: 1.9-window page, top 700 < 800... ratio 700/(1520-800)=0.97
    expect(scrollShouldShow(true, { ratio: 0.6, scrollTop: 700, clientHeight: 800, scrollHeight: 1520, sawInput: true })).toBe(false);
    // exactly 2 windows tall, scrolled one full window (= bottom): allowed
    expect(scrollShouldShow(true, { ratio: 0.6, scrollTop: 800, clientHeight: 800, scrollHeight: 1600, sawInput: true })).toBe(true);
  });

  it('flag on: a page 1.2 windows tall never shows by scroll', () => {
    for (let top = 0; top <= 160; top += 20) {
      expect(scrollShouldShow(true, { ratio: 0.6, scrollTop: top, clientHeight: 800, scrollHeight: 960, sawInput: true })).toBe(false);
    }
  });

  it('counts only trusted wheel / touchmove / pointerdown and scroll keys', () => {
    expect(isRealScrollInput('wheel', true)).toBe(true);
    expect(isRealScrollInput('touchmove', true)).toBe(true);
    expect(isRealScrollInput('pointerdown', true)).toBe(true);
    for (const k of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Home', 'End']) expect(isRealScrollInput('keydown', true, k)).toBe(true);
    expect(isRealScrollInput('keydown', true, 'a')).toBe(false);
    expect(isRealScrollInput('wheel', false)).toBe(false); // dispatchEvent / script
    expect(isRealScrollInput('scroll', true)).toBe(false);
  });

  it('hidden tab: flag on blocks every trigger until visible; flag off never blocks', () => {
    expect(visibleOk(true, 'hidden')).toBe(false);
    expect(visibleOk(true, 'prerender')).toBe(false);
    expect(visibleOk(true, 'visible')).toBe(true);
    expect(visibleOk(false, 'hidden')).toBe(true);
  });
});

describe('funnel tracking API', () => {
  const app = createApp();
  const created: string[] = [];
  afterAll(async () => {
    if (created.length) await prisma.event.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it('stores each new funnel step with its context tags', async () => {
    const since = new Date();
    const steps = ['PROMPT_ALLOW_CLICKED', 'PROMPT_DECLINED', 'PROMPT_BLOCKED', 'PROMPT_IGNORED'] as const;
    for (const type of steps) {
      const meta = { device: 'mobile', landing: true, variant: 'v2', trigger: 'scroll', ...(type === 'PROMPT_DECLINED' ? { how: 'no' } : {}) };
      await request(app).post('/api/track').send({ type, meta }).expect(204);
    }
    const rows = await prisma.event.findMany({ where: { type: { in: [...steps] }, createdAt: { gte: since } } });
    created.push(...rows.map((r) => r.id));
    expect(rows.map((r) => r.type).sort()).toEqual([...steps].sort());
    const declined = rows.find((r) => r.type === 'PROMPT_DECLINED');
    expect(declined?.meta).toEqual({ device: 'mobile', landing: true, variant: 'v2', trigger: 'scroll', how: 'no' });
  });

  it('rejects free-form or out-of-set context (public endpoint)', async () => {
    await request(app).post('/api/track').send({ type: 'PROMPT_SHOWN', meta: { page: '/some/url' } }).expect(400);
    await request(app).post('/api/track').send({ type: 'PROMPT_SHOWN', meta: { device: 'tablet' } }).expect(400);
    await request(app).post('/api/track').send({ type: 'PROMPT_DECLINED', meta: { how: 'swipe' } }).expect(400);
  });

  it('still accepts the original bare events (older SDKs in browser caches)', async () => {
    const t0 = new Date(Date.now() - 5000);
    await request(app).post('/api/track').send({ type: 'PROMPT_SHOWN' }).expect(204);
    // QA 2026-10-23: a bare PROMPT_SHOWN (no subscriber, no campaign) was left in the dev DB on every run.
    await prisma.event.deleteMany({ where: { type: 'PROMPT_SHOWN', subscriberId: null, campaignId: null, meta: { equals: Prisma.DbNull }, createdAt: { gte: t0 } } });
  });

  it('/api/config tells the SDK which prompt to show (v1 unless SOFT_PROMPT_V2)', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.promptVariant).toBe(process.env.SOFT_PROMPT_V2 === 'true' ? 'v2' : 'v1');
    expect(typeof res.body.vapidPublicKey).toBe('string');
  });

  it('/api/config carries promptRealScroll (boolean, off unless SOFT_PROMPT_REAL_SCROLL)', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.promptRealScroll).toBe(process.env.SOFT_PROMPT_REAL_SCROLL === 'true');
    expect(typeof res.body.promptRealScroll).toBe('boolean');
  });

  it('/api/track trigger enum is unchanged: no new value for the real-scroll rule', async () => {
    await request(app).post('/api/track').send({ type: 'PROMPT_SHOWN', meta: { trigger: 'real-scroll' } }).expect(400);
    await request(app).post('/api/track').send({ type: 'PROMPT_SHOWN', meta: { trigger: 'scroll-real' } }).expect(400);
  });
});
