/**
 * CMS audience sync, task 4 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.1, §8; push-feed contract v1.2 §1–§3,
 * §8.1, §9): POST /api/integrations/cms/events — the fixed order of checks, the contract's answer
 * codes, the receipt in the same transaction as the apply, the latest-timestamp replay rule, the
 * Cloudflare-aware IP fence, logging.
 */
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, type AudienceEnv } from '../lib/env';
import { CMS_WEBHOOK_PATH, signCmsWebhook } from '../lib/cmsSignature';
import { cmsClientIp, isCloudflareIp } from '../lib/clientIp';
import { createIntegrationsRouter, type CmsEventsRouterOptions } from '../routes/cmsEvents';
import { CMS_EVENT_BODIES } from './fixtures/cms-feed-v1.3/payloads';
import * as ingest from '../services/audience/ingest';

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `w${RUN}-`;
const PORTAL = `test-cms-events-${RUN}`;
const SECRET = randomBytes(32).toString('hex');
const PREVIOUS = randomBytes(32).toString('hex');
const ALLOWED = '127.0.0.1';
const UNAUTH = { code: 'UNAUTHORISED' };

function cfgWith(over: NodeJS.ProcessEnv = {}): AudienceEnv {
  return parseAudienceEnv({
    AUDIENCE_SYNC_ENABLED: 'true',
    CMS_FEED_INBOUND_SECRET: SECRET,
    CMS_FEED_INBOUND_SECRET_PREVIOUS: PREVIOUS,
    CMS_FEED_ALLOWED_IPS: ALLOWED,
    ...over,
  });
}
const CFG = cfgWith();

function app(opts: CmsEventsRouterOptions = {}) {
  return createApp({ cmsEvents: { cfg: CFG, failuresPerMin: 100_000, portal: PORTAL, ...opts } });
}

let n = 0;
/** A fixture event as a body string with this run's ids and a fresh event_id. */
function body(key: keyof typeof CMS_EVENT_BODIES, over: Record<string, unknown> = {}): { raw: string; eventId: string; accountId: string } {
  const o = JSON.parse(CMS_EVENT_BODIES[key]) as Record<string, unknown>;
  const eventId = `evt_${RUN}_${++n}`;
  const accountId = `${P}${n}-${o.account_id as string}`; // one account per body unless overridden
  o.event_id = eventId;
  o.account_id = accountId;
  if (typeof o.email === 'string') o.email = (o.email as string).replace('@', `.${RUN}@`);
  const merged = { ...o, ...over };
  return { raw: JSON.stringify(merged), eventId: String(merged.event_id), accountId: String(merged.account_id) };
}

function post(a: express.Express, raw: string | Buffer, eventId: string, opts: { secret?: string; now?: Date; headers?: Record<string, string | undefined> } = {}) {
  const signed = signCmsWebhook(opts.secret ?? SECRET, raw, opts.now ?? new Date());
  const headers: Record<string, string | undefined> = { 'Content-Type': 'application/json', 'X-CMS-Event-Id': eventId, ...signed, ...opts.headers };
  let req = request(a).post(CMS_WEBHOOK_PATH);
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) req = req.set(k, v);
  return req.send(raw);
}

const receipt = (eventId: string) => prisma.cmsEventReceipt.findUnique({ where: { eventId } });
const account = (accountId: string) => prisma.cmsAccount.findUnique({ where: { accountId } });

const VECTOR_EVENT_ID = 'evt_01JB0Z7Q3M4N5P6R7S8T9V0W1X';
async function cleanVector() {
  await prisma.cmsEventReceipt.deleteMany({ where: { eventId: VECTOR_EVENT_ID } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: '900001' } });
}

beforeAll(cleanVector);
afterAll(async () => {
  await cleanVector();
  await prisma.cmsEventReceipt.deleteMany({ where: { eventId: { startsWith: `evt_${RUN}_` } } });
  await prisma.emailSuppression.deleteMany({ where: { accountId: { startsWith: P } } });
  const accs = await prisma.cmsAccount.findMany({ where: { accountId: { startsWith: P } }, select: { emailHash: true } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: accs.map((a) => a.emailHash).filter((h): h is string => !!h) } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

describe('the contract vector (A.6 §8.1), byte for byte', () => {
  it('the exact v1.2 POST verifies and applies; one changed byte does not', async () => {
    const raw = CMS_EVENT_BODIES['account.created_900001_seq1'];
    const cfg = { ...CFG, cms: { ...CFG.cms, inboundSecret: 'test-secret' } }; // the contract's fake secret
    const a = createApp({ cmsEvents: { cfg, clock: () => new Date(1792640705 * 1000), failuresPerMin: 100_000, portal: PORTAL } });
    const headers = {
      'Content-Type': 'application/json',
      'X-CMS-Event-Id': VECTOR_EVENT_ID,
      'X-CMS-Timestamp': '1792640705',
      'X-CMS-Signature': 'sha256=cec94bc31a9cf69b93b7a4866b594ed586ff84ac7edeeecfcdf13fa864104bab',
    };
    const tampered = raw.replace('"seq":1', '"seq":2');
    const bad = await request(a).post(CMS_WEBHOOK_PATH).set(headers).send(tampered);
    expect(bad.status).toBe(401);
    expect(await receipt(VECTOR_EVENT_ID)).toBeNull();
    const ok = await request(a).post(CMS_WEBHOOK_PATH).set(headers).send(raw);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, outcome: 'applied' });
    expect(await account('900001')).toMatchObject({ seq: 1n, status: 'free' });
    expect(await receipt(VECTOR_EVENT_ID)).toMatchObject({ event: 'account.created', outcome: 'applied', signedTs: 1792640705n });
  });
});

describe('step 1 — the flag (and a usable config): the same 401', () => {
  it.each([
    ['flag off', { AUDIENCE_SYNC_ENABLED: 'false' }],
    ['no webhook secret', { CMS_FEED_INBOUND_SECRET: '' }],
    ['a config problem', { CMS_FEED_ALLOWED_IPS: `${ALLOWED}, 10.0.0.0/8` }],
  ])('%s → 401, nothing stored', async (_name, over) => {
    const b = body('account.created_900001_seq1');
    const res = await post(app({ cfg: cfgWith(over) }), b.raw, b.eventId);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTH);
    expect(await receipt(b.eventId)).toBeNull();
    expect(await account(b.accountId)).toBeNull();
  });

  it('the default app (flags off in the test env) answers 401 too — mounted, never a 404 that reveals it', async () => {
    const b = body('account.created_900001_seq1');
    const res = await post(createApp(), b.raw, b.eventId);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTH);
  });
});

describe('step 2 — the IP fence', () => {
  it('an empty allow-list rejects everything', async () => {
    const b = body('account.created_900001_seq1');
    expect((await post(app({ cfg: cfgWith({ CMS_FEED_ALLOWED_IPS: '' }) }), b.raw, b.eventId)).status).toBe(401);
  });
  it('a caller not on the list is rejected', async () => {
    const b = body('account.created_900001_seq1');
    const res = await post(app({ cfg: cfgWith({ CMS_FEED_ALLOWED_IPS: '198.51.100.7' }) }), b.raw, b.eventId);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTH);
  });
  it('a direct caller presenting a CF-Connecting-IP header cannot borrow an allowed address', async () => {
    const b = body('account.created_900001_seq1');
    const res = await post(app({ cfg: cfgWith({ CMS_FEED_ALLOWED_IPS: '198.51.100.7' }) }), b.raw, b.eventId, { headers: { 'CF-Connecting-IP': '198.51.100.7' } });
    expect(res.status).toBe(401);
  });
});

describe('the fence refusal logs what the fence saw (brief 2026-10-29-cms-fence-diagnose)', () => {
  const lines = () => logs.filter((l) => l.includes('fence detail'));
  const reset = () => void logs.splice(0);
  const proxied = (over: Partial<CmsEventsRouterOptions> = {}) => {
    const a = express();
    a.set('trust proxy', 1);
    a.use('/api/integrations', createIntegrationsRouter({ cfg: cfgWith({ CMS_FEED_ALLOWED_IPS: '198.51.100.7' }), failuresPerMin: 100_000, portal: PORTAL, ...over }));
    return a;
  };
  const send = (a: express.Express, headers: Record<string, string>) => {
    const b = body('account.created_900001_seq1');
    return post(a, b.raw, b.eventId, { headers });
  };

  it('one line with the six fields, on a refusal', async () => {
    reset();
    const res = await send(proxied(), { 'X-Forwarded-For': '203.0.113.9, 10.1.2.3', 'CF-Connecting-IP': '148.113.0.114', 'X-Real-IP': '10.9.9.9' });
    expect(res.status).toBe(401);
    const l = lines();
    expect(l).toHaveLength(1);
    expect(l[0]).toBe('[audience] fence detail peer=10.1.2.3 peerIsCloudflare=false cfConnectingIp=148.113.0.114 xff=203.0.113.9, 10.1.2.3 xRealIp=10.9.9.9 remote=::ffff:127.0.0.1');
  });

  it('absent headers read "none"; a Cloudflare peer reads true; control characters are flattened', async () => {
    reset();
    await send(proxied(), { 'X-Forwarded-For': '173.245.48.5', 'X-Real-IP': 'a\tb' });
    const l = lines();
    expect(l).toHaveLength(1);
    expect(l[0]).toContain('peer=173.245.48.5 peerIsCloudflare=true cfConnectingIp=none xff=173.245.48.5 xRealIp=a?b');
  });

  it('a request that passes the fence logs no detail line', async () => {
    reset();
    const res = await send(proxied(), { 'X-Forwarded-For': '173.245.48.5', 'CF-Connecting-IP': '198.51.100.7' });
    expect(res.status).toBe(200);
    expect(lines()).toHaveLength(0);
  });

  it('other refusals (signature, off) log no detail line', async () => {
    reset();
    const b = body('account.created_900001_seq1');
    await post(proxied(), b.raw, b.eventId, { secret: 'wrong-secret', headers: { 'X-Forwarded-For': '173.245.48.5', 'CF-Connecting-IP': '198.51.100.7' } });
    await send(proxied({ cfg: cfgWith({ AUDIENCE_SYNC_ENABLED: 'false' }) }), { 'X-Forwarded-For': '203.0.113.9' });
    expect(lines()).toHaveLength(0);
  });

  it('at most 20 an hour; the window then reopens', async () => {
    reset();
    let t = Date.parse('2026-10-29T14:00:00Z');
    const a = proxied({ clock: () => new Date(t) });
    for (let i = 0; i < 25; i++) await send(a, { 'X-Forwarded-For': '203.0.113.9' });
    expect(lines()).toHaveLength(20);
    t += 3_600_000;
    await send(a, { 'X-Forwarded-For': '203.0.113.9' });
    expect(lines()).toHaveLength(21);
  });
});

describe('Cloudflare-aware client IP (behind trust proxy 1, as in production)', () => {
  const CMS_IP = '198.51.100.7';
  const CF_EDGE = '173.245.48.5';
  function proxied(allowed = CMS_IP) {
    const a = express();
    a.set('trust proxy', 1);
    a.use('/api/integrations', createIntegrationsRouter({ cfg: cfgWith({ CMS_FEED_ALLOWED_IPS: allowed }), failuresPerMin: 100_000, portal: PORTAL }));
    return a;
  }
  const send = (a: express.Express, xff: string, cf?: string) => {
    const b = body('account.created_900001_seq1');
    return post(a, b.raw, b.eventId, { headers: { 'X-Forwarded-For': xff, 'CF-Connecting-IP': cf } });
  };

  it('forged CF-Connecting-IP from a NON-Cloudflare peer (the Railway origin hit directly) → 401', async () => {
    expect((await send(proxied(), `${CMS_IP}, 203.0.113.9`, CMS_IP)).status).toBe(401);
  });
  it('a genuine Cloudflare peer + an allowed CF-Connecting-IP → accepted', async () => {
    const res = await send(proxied(), `${CMS_IP}, ${CF_EDGE}`, CMS_IP);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('applied');
  });
  it('a Cloudflare peer with a non-allowed or missing CF-Connecting-IP → 401', async () => {
    expect((await send(proxied(), `203.0.113.9, ${CF_EDGE}`, '203.0.113.9')).status).toBe(401);
    expect((await send(proxied(), `${CMS_IP}, ${CF_EDGE}`)).status).toBe(401);
    expect((await send(proxied(), `${CMS_IP}, ${CF_EDGE}`, 'not-an-ip')).status).toBe(401);
  });
  it('the CMS calling the Railway origin directly from an allowed address → accepted', async () => {
    expect((await send(proxied(), CMS_IP)).status).toBe(200);
  });
  it('IPv6: a Cloudflare IPv6 edge + a non-canonical allowed IPv6 client → accepted', async () => {
    expect((await send(proxied('2001:db8::7'), '2606:4700::6810:1', '2001:DB8:0:0::7')).status).toBe(200);
  });
  it('IPv4-mapped forms are the same address', async () => {
    expect((await send(proxied(), `::ffff:${CMS_IP}`)).status).toBe(200);
    expect((await send(proxied(), `::ffff:${CF_EDGE}`, `::ffff:${CMS_IP}`)).status).toBe(200);
  });

  it('cmsClientIp / isCloudflareIp units', () => {
    expect(isCloudflareIp(CF_EDGE)).toBe(true);
    expect(isCloudflareIp('104.16.0.1')).toBe(true);
    expect(isCloudflareIp('2a06:98c0::1')).toBe(true);
    expect(isCloudflareIp('::ffff:162.158.0.1')).toBe(true);
    expect(isCloudflareIp('203.0.113.9')).toBe(false);
    expect(isCloudflareIp('garbage')).toBe(false);
    expect(cmsClientIp('203.0.113.9', CMS_IP)).toBe('203.0.113.9');
    expect(cmsClientIp(CF_EDGE, CMS_IP)).toBe(CMS_IP);
    expect(cmsClientIp(CF_EDGE, undefined)).toBeNull();
    expect(cmsClientIp(undefined, CMS_IP)).toBeNull();
  });
});

describe('steps 3–6 — body, headers, signature, event id', () => {
  it('an empty body → 401', async () => {
    const signed = signCmsWebhook(SECRET, '');
    const res = await request(app()).post(CMS_WEBHOOK_PATH).set({ 'X-CMS-Event-Id': 'evt_x', ...signed });
    expect(res.status).toBe(401);
  });

  it('over 64 KB → 401 (never a 413 that echoes anything)', async () => {
    const b = body('account.created_900001_seq1', { pad: 'x'.repeat(70_000) });
    const res = await post(app(), b.raw, b.eventId);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTH);
  });

  it.each(['X-CMS-Event-Id', 'X-CMS-Timestamp', 'X-CMS-Signature'])('missing %s → 401', async (h) => {
    const b = body('account.created_900001_seq1');
    expect((await post(app(), b.raw, b.eventId, { headers: { [h]: undefined } })).status).toBe(401);
  });

  it('a wrong secret → 401, no receipt, no account', async () => {
    const b = body('account.created_900001_seq1');
    const res = await post(app(), b.raw, b.eventId, { secret: randomBytes(32).toString('hex') });
    expect(res.status).toBe(401);
    expect(await receipt(b.eventId)).toBeNull();
    expect(await account(b.accountId)).toBeNull();
  });

  it('the previous secret (rotation) → applied', async () => {
    const b = body('account.created_900001_seq1');
    expect((await post(app(), b.raw, b.eventId, { secret: PREVIOUS })).status).toBe(200);
  });

  it('skew: 301 s → 401; 299 s → applied', async () => {
    const b1 = body('account.created_900001_seq1');
    expect((await post(app(), b1.raw, b1.eventId, { now: new Date(Date.now() - 301_000) })).status).toBe(401);
    const b2 = body('account.created_900001_seq1');
    expect((await post(app(), b2.raw, b2.eventId, { now: new Date(Date.now() - 299_000) })).status).toBe(200);
  });

  it('the body changed by one byte after signing → 401', async () => {
    const b = body('account.created_900001_seq1');
    const signed = signCmsWebhook(SECRET, b.raw);
    const res = await request(app()).post(CMS_WEBHOOK_PATH).set({ 'Content-Type': 'application/json', 'X-CMS-Event-Id': b.eventId, ...signed }).send(b.raw.replace('"seq":1', '"seq":9'));
    expect(res.status).toBe(401);
  });

  it('X-CMS-Event-Id different from the body event_id → 401, nothing stored', async () => {
    const b = body('account.created_900001_seq1');
    const res = await post(app(), b.raw, `${b.eventId}x`);
    expect(res.status).toBe(401);
    expect(await receipt(b.eventId)).toBeNull();
    expect(await receipt(`${b.eventId}x`)).toBeNull();
  });

  it('a signed body that is not JSON → 401', async () => {
    expect((await post(app(), 'not json', `evt_${RUN}_nj`)).status).toBe(401);
  });

  it('any content type works: the raw parser sits ahead of the JSON parser', async () => {
    const b = body('account.created_900001_seq1');
    expect((await post(app(), b.raw, b.eventId, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(200);
  });
});

describe('step 7 — replay and retries (receipt keeps the LATEST timestamp)', () => {
  it('exact replay → 401; the CMS retry (new ts) → 200 duplicate, not applied; a copy of the retry → 401', async () => {
    const b = body('account.created_900001_seq1');
    const t1 = new Date(Date.now() - 120_000);
    const t2 = new Date(Date.now() - 60_000);
    const first = await post(app(), b.raw, b.eventId, { now: t1 });
    expect(first.body).toEqual({ ok: true, outcome: 'applied' });
    const replay = await post(app(), b.raw, b.eventId, { now: t1 });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual(UNAUTH);
    const apply = jest.spyOn(ingest, 'applyAccountSnapshot');
    const retry = await post(app(), b.raw, b.eventId, { now: t2 });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, duplicate: true });
    expect(apply).not.toHaveBeenCalled();
    apply.mockRestore();
    expect((await receipt(b.eventId))!.signedTs).toBe(BigInt(Math.floor(t2.getTime() / 1000)));
    expect((await post(app(), b.raw, b.eventId, { now: t2 })).status).toBe(401);
    // A copy of the FIRST delivery now differs from the stored timestamp: answered as a retry, never applied.
    expect((await post(app(), b.raw, b.eventId, { now: t1 })).body).toEqual({ ok: true, duplicate: true });
  });

  it('a failed apply leaves NO receipt, so the honest retry is processed', async () => {
    const b = body('subscription.started_900001_seq3');
    const real = ingest.applyAccountSnapshot;
    const spy = jest.spyOn(ingest, 'applyAccountSnapshot').mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new Error('storage blip');
    });
    const failed = await post(app(), b.raw, b.eventId);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ code: 'INTERNAL' });
    expect(await receipt(b.eventId)).toBeNull();
    expect(await account(b.accountId)).toBeNull(); // the apply rolled back with it
    spy.mockRestore();
    const retry = await post(app(), b.raw, b.eventId, { now: new Date(Date.now() + 1000) });
    expect(retry.body).toEqual({ ok: true, outcome: 'applied' });
    expect(await account(b.accountId)).toMatchObject({ status: 'active' });
    expect(logs.join('\n')).toMatch(/\[audience\] webhook store failed id=evt_/); // via safeErrorLog
    expect(logs.join('\n')).not.toMatch(/@example\.com/);
  });

  it('two deliveries of one event at once: exactly one applies, the other is a duplicate', async () => {
    const b = body('subscription.started_900001_seq3');
    const rs = await Promise.all([
      post(app(), b.raw, b.eventId, { now: new Date(Date.now() - 2000) }),
      post(app(), b.raw, b.eventId, { now: new Date(Date.now() - 1000) }),
    ]);
    const bodies = rs.map((r) => r.body);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(bodies.filter((x) => x.outcome === 'applied')).toHaveLength(1);
    expect(bodies.filter((x) => x.duplicate === true || x.outcome === 'stale_seq')).toHaveLength(1);
    expect(await prisma.cmsEventReceipt.count({ where: { eventId: b.eventId } })).toBe(1);
  });
});

describe('steps 8–9 — parse and apply', () => {
  it('an older seq → 200 stale_seq (the agreed "older seq, ignored")', async () => {
    const b3 = body('subscription.started_900001_seq3', { account_id: `${P}stale` });
    const b2 = body('account.updated_900001_seq2', { account_id: `${P}stale` });
    expect((await post(app(), b3.raw, b3.eventId)).body.outcome).toBe('applied');
    const res = await post(app(), b2.raw, b2.eventId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: 'stale_seq' });
    expect(await receipt(b2.eventId)).toMatchObject({ outcome: 'stale_seq' });
  });

  it('an unknown event type → 200, stored as unknown_type, not applied', async () => {
    const b = body('account.created_900001_seq1', { event: 'account.merged', account_id: `${P}unknown-type` });
    const res = await post(app(), b.raw, b.eventId);
    expect(res.body).toEqual({ ok: true, outcome: 'unknown_type' });
    expect(await receipt(b.eventId)).toMatchObject({ event: 'account.merged', outcome: 'unknown_type' });
    expect(await account(`${P}unknown-type`)).toBeNull();
  });

  it('a signed body that breaks the schema → 422 (dead at the CMS; the nightly list carries it)', async () => {
    const b = body('account.created_900001_seq1', { erasure: null, account_id: `${P}invalid` });
    const res = await post(app(), b.raw, b.eventId);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'INVALID' });
    expect(await receipt(b.eventId)).toMatchObject({ outcome: 'invalid' });
    expect(await account(`${P}invalid`)).toBeNull();
  });

  it('records the last webhook time for the send guard', async () => {
    const st = await prisma.audienceSyncState.findUnique({ where: { portal: PORTAL } });
    expect(st?.lastWebhookAt).toBeInstanceOf(Date);
  });

  it('every v1.2 A.5 event goes through the door in order', async () => {
    const order: (keyof typeof CMS_EVENT_BODIES)[] = [
      'account.created_900001_seq1', 'account.updated_900001_seq2', 'subscription.started_900001_seq3', 'account.email_changed_900001_seq4',
      'subscription.renewed_900002_seq3', 'subscription.cancelled_900002_seq4', 'subscription.ended_900002_seq5',
      'account.deleted_900002_seq6', 'account.deleted_900002_seq7', 'account.updated_900003_seq2',
    ];
    for (const key of order) {
      const o = JSON.parse(CMS_EVENT_BODIES[key]) as Record<string, unknown>;
      const b = body(key, { account_id: `${P}door-${o.account_id as string}` });
      const res = await post(app(), b.raw, b.eventId);
      expect([key, res.status, res.body.outcome]).toEqual([key, 200, 'applied']);
    }
    expect(await account(`${P}door-900002`)).toMatchObject({ status: 'deleted' });
    expect((await account(`${P}door-900002`))!.erasedAt).not.toBeNull();
  });
});

describe('rate limit on failures only', () => {
  it('refusals are limited (429); a valid delivery from the same IP still goes through', async () => {
    const a = app({ failuresPerMin: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const b = body('account.created_900001_seq1');
      statuses.push((await post(a, b.raw, b.eventId, { secret: randomBytes(32).toString('hex') })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const ok = body('account.created_900001_seq1');
    expect((await post(a, ok.raw, ok.eventId)).status).toBe(200);
  });
});

describe('routing and logging', () => {
  it('anything else under /api/integrations is a plain 404', async () => {
    expect((await request(app()).get(CMS_WEBHOOK_PATH)).status).toBe(404);
    const r = await request(app()).post('/api/integrations/other/secret-path');
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('secret-path');
  });

  it('log lines carry the event type and id only — no address, account id, secret, signature or body', async () => {
    const b = body('subscription.started_900001_seq3', { account_id: `${P}logcheck` });
    const signed = signCmsWebhook(SECRET, b.raw);
    logs.length = 0;
    await post(app(), b.raw, b.eventId);
    await post(app(), b.raw, b.eventId, { secret: PREVIOUS.replace(/./, '0') });
    const all = logs.join('\n');
    expect(all).toContain(`event=subscription.started id=${b.eventId} outcome=applied`);
    expect(all).toMatch(/webhook refused \(step=(signature|replay)\)/);
    expect(all).not.toMatch(/@example\.com/);
    expect(all).not.toContain(`${P}logcheck`);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(signed['X-CMS-Signature'].slice(7, 30));
    expect(all).not.toContain('premium_1y');
  });
});
