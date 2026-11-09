import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseNoticesEnv, type AudienceEnv, type NoticesEnv } from '../lib/env';
import { CMS_HEADERS, CMS_NOTICES_PATH, buildCanonicalQuery, newNonce, signCmsNoticesGet, signatureHeader, unixSeconds, verifyCmsNoticesGet } from '../lib/cmsSignature';
import { emailHash } from '../services/digest/webhook';
import { noticesEtag } from '../services/audience/notices';

/**
 * Brief 2026-11-09-digest-notice-list, acceptance 3, 4, 5, 6: door N, `GET /api/integrations/cms/digest-notices`. The CMS's signed GET
 * (`signCmsNoticesGet`, the CMS side) against the real route: the 200 payload exactly, every authentication failure the same 401, the
 * previous secret, ETag / 304, the flag (404), freshness (503), the empty list, the rate limit, single-use nonces, and that door W is
 * untouched. Accounts live on a unique portal with run-unique addresses. No CMS or Mailercloud call.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `nd${RUN}-`;
const PORTAL = `test-notices-door-${RUN}`;
const SECRET = randomBytes(32).toString('hex');
const PREVIOUS = randomBytes(32).toString('hex');
const ALLOWED = '127.0.0.1';
const UNAUTH = { code: 'UNAUTHORISED' };
const T0 = new Date('2027-03-01T10:00:00Z');
let clockNow = T0;

const noticesCfg = (over: NodeJS.ProcessEnv = {}): NoticesEnv =>
  parseNoticesEnv({ DIGEST_NOTICES_ENABLED: 'true', CMS_FEED_NOTICES_SECRET: SECRET, CMS_FEED_NOTICES_SECRET_PREVIOUS: PREVIOUS, ...over });
const audCfg: AudienceEnv = parseAudienceEnv({ CMS_FEED_ALLOWED_IPS: ALLOWED });

function app(over: { cfg?: NoticesEnv; perHour?: number } = {}) {
  return createApp({
    rateLimit: { publicPerMin: 100_000, loginPerMin: 100_000 },
    cmsNotices: { cfg: over.cfg ?? noticesCfg(), audience: audCfg, clock: () => clockNow, portal: PORTAL, perHour: over.perHour ?? 100_000 },
  });
}

/** A correctly SIGNED GET that also carries a body (supertest cannot send one): a plain Node request with a Content-Length. */
function getWithBody(a: ReturnType<typeof app>, body: string): Promise<{ status: number; body: unknown }> {
  const server = a.listen(0);
  const { port } = server.address() as AddressInfo;
  const signed = signCmsNoticesGet({ secret: SECRET, now: clockNow });
  usedNonces.push(signed.nonce);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: signed.pathAndQuery, headers: { ...signed.headers, 'X-Forwarded-For': ALLOWED, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || 'null') });
        });
      },
    );
    req.on('error', (e) => {
      server.close();
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

const usedNonces: string[] = [];
type CallOpts = { secret?: string; now?: Date; nonce?: string; ip?: string | null; headers?: Record<string, string | undefined>; ifNoneMatch?: string };
function call(a: ReturnType<typeof app>, o: CallOpts = {}) {
  const signed = signCmsNoticesGet({ secret: o.secret ?? SECRET, now: o.now ?? clockNow, nonce: o.nonce });
  usedNonces.push(signed.nonce);
  let req = request(a).get(signed.pathAndQuery);
  const headers: Record<string, string | undefined> = { ...signed.headers, ...(o.ip === null ? {} : { 'X-Forwarded-For': o.ip ?? ALLOWED }), ...o.headers };
  if (o.ifNoneMatch !== undefined) headers['If-None-Match'] = o.ifNoneMatch;
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) req = req.set(k, v);
  return req;
}
/** A GET signed by hand: for a query the helper refuses to build (no nonce, an extra parameter, a duplicate key, a bad nonce). */
function raw(a: ReturnType<typeof app>, rawQuery: string, over: { secret?: string; now?: Date } = {}) {
  const ts = unixSeconds(over.now ?? clockNow);
  const sig = signatureHeader(over.secret ?? SECRET, ts, 'GET', CMS_NOTICES_PATH, rawQuery);
  return request(a)
    .get(`${CMS_NOTICES_PATH}${rawQuery ? `?${rawQuery}` : ''}`)
    .set('X-Forwarded-For', ALLOWED)
    .set(CMS_HEADERS.timestamp, ts)
    .set(CMS_HEADERS.signature, sig);
}

let bad: { accountId: string; email: string };
let unsub: { accountId: string; email: string };
async function account(key: string, o: { fatal?: boolean; reason?: string } = {}) {
  const email = `${key}.${RUN}@example.org`;
  const h = emailHash(email);
  const accountId = `${P}${key}`;
  await prisma.cmsAccount.create({ data: { accountId, portal: PORTAL, seq: 1n, status: 'active', plan: 'premium_1y', emailHash: h, lastSource: 'pull_full' } });
  await prisma.audienceMember.create({ data: { emailHash: h, email, desiredRole: 'PREMIUM', lastErrorKind: o.fatal ? 'FATAL' : null } });
  if (o.reason) await prisma.emailSuppression.create({ data: { email, emailHash: h, reason: o.reason, source: 'mailercloud_webhook' } });
  return { accountId, email };
}
const ready = (over: Record<string, unknown> = {}) =>
  prisma.audienceSyncState.upsert({
    where: { portal: PORTAL },
    create: { portal: PORTAL, lastFullOkAt: new Date(clockNow.getTime() - 3_600_000), ...over },
    update: { lastFullOkAt: new Date(clockNow.getTime() - 3_600_000), breakerOpenAt: null, breakerReason: null, ...over },
  });

async function wipe() {
  const accs = await prisma.cmsAccount.findMany({ where: { accountId: { startsWith: P } }, select: { emailHash: true } });
  const hs = accs.map((a) => a.emailHash).filter((h): h is string => !!h);
  await prisma.emailSuppression.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: PORTAL } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: usedNonces.map((n) => `cms-notices:nonce:${n}`) } } });
}
beforeEach(async () => {
  await wipe();
  clockNow = T0;
  logs.length = 0;
  bad = await account('bad', { fatal: true });
  unsub = await account('unsub', { reason: 'UNSUBSCRIBE' });
  await ready();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe('3. a valid signature: 200 with the contract\'s payload, exactly', () => {
  it('shape, order, headers, and nothing but account ids and reasons', async () => {
    const r = await call(app());
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['as_of', 'portal', 'count', 'items']);
    expect(r.body).toEqual({
      as_of: T0.toISOString(),
      portal: PORTAL,
      count: 2,
      items: [
        { account_id: bad.accountId, reason: 'bad_address' },
        { account_id: unsub.accountId, reason: 'unsubscribed' },
      ],
    });
    for (const i of r.body.items) expect(Object.keys(i)).toEqual(['account_id', 'reason']);
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(r.body)).not.toContain('@');
    expect(logs.join('\n')).toContain('[audience] digest notices served count=2');
  });

  it('the previous secret is accepted during a rotation; a secret that is neither is not; with no previous set, the old one is refused', async () => {
    expect((await call(app(), { secret: PREVIOUS })).status).toBe(200);
    expect((await call(app(), { secret: randomBytes(32).toString('hex') })).status).toBe(401);
    expect((await call(app({ cfg: noticesCfg({ CMS_FEED_NOTICES_SECRET_PREVIOUS: '' }) }), { secret: PREVIOUS })).status).toBe(401);
  });

  it('the timestamp may be up to 300 s either side of our clock', async () => {
    for (const dt of [-300, 0, 300]) expect((await call(app(), { now: new Date(T0.getTime() + dt * 1000) })).status).toBe(200);
  });
});

describe('3. every authentication failure is the SAME 401', () => {
  const same = (r: { status: number; body: unknown }) => expect([r.status, r.body]).toEqual([401, UNAUTH]);

  it('a wrong secret, a skew over 300 s either way, a reused nonce', async () => {
    same(await call(app(), { secret: randomBytes(32).toString('hex') }));
    same(await call(app(), { now: new Date(T0.getTime() - 301_000) }));
    same(await call(app(), { now: new Date(T0.getTime() + 301_000) }));
    const nonce = newNonce();
    const a = app();
    expect((await call(a, { nonce })).status).toBe(200);
    same(await call(a, { nonce })); // a fresh signature, the same nonce
    same(await call(app(), { nonce })); // another app instance: the store is the database, not memory
  });

  it('a missing, malformed or duplicated nonce; an extra signed parameter; a body on GET', async () => {
    const a = app();
    same(await raw(a, '')); // signed, no nonce at all
    same(await raw(a, `nonce=${newNonce().toUpperCase()}`));
    same(await raw(a, `nonce=${newNonce().slice(0, 31)}`));
    same(await raw(a, `nonce=${newNonce()}&nonce=${newNonce()}`));
    same(await raw(a, `${buildCanonicalQuery({ nonce: newNonce(), extra: '1' })}`)); // signed, but nothing else may be in the query
    same(await getWithBody(a, '{"x":1}'));
    same(await getWithBody(a, 'x'));
  });

  it('missing or malformed headers; an unsigned GET', async () => {
    const a = app();
    same(await call(a, { headers: { [CMS_HEADERS.signature]: undefined } }));
    same(await call(a, { headers: { [CMS_HEADERS.timestamp]: undefined } }));
    same(await call(a, { headers: { [CMS_HEADERS.signature]: 'sha256=zz' } }));
    same(await call(a, { headers: { [CMS_HEADERS.timestamp]: '12.5' } }));
    same(await request(a).get(`${CMS_NOTICES_PATH}?nonce=${newNonce()}`).set('X-Forwarded-For', ALLOWED));
    same(await call(a, { headers: { [CMS_HEADERS.signature]: signCmsNoticesGet({ secret: SECRET, now: T0 }).headers[CMS_HEADERS.signature] } })); // a signature for ANOTHER nonce
  });

  it('a client outside the IP fence, or none readable, never reaches the signature check', async () => {
    const a = app();
    same(await call(a, { ip: '203.0.113.9' }));
    same(await call(a, { ip: null }));
    same(await call(app({ cfg: noticesCfg() }), { ip: '127.0.0.2' }));
    // an EMPTY fence rejects everything (never allow-all)
    const open = createApp({ cmsNotices: { cfg: noticesCfg(), audience: parseAudienceEnv({}), clock: () => clockNow, portal: PORTAL } });
    same(await call(open as ReturnType<typeof app>));
  });

  it('the route verifies the CONSTANT path: a signature made for another path is refused', () => {
    const wrong = signatureHeader(SECRET, unixSeconds(T0), 'GET', '/api/integrations/cms/events', `nonce=${newNonce()}`);
    const v = verifyCmsNoticesGet({ secrets: [SECRET], rawQuery: `nonce=${newNonce()}`, timestampHeader: unixSeconds(T0), signatureHeader: wrong, now: T0 });
    expect(v.ok).toBe(false);
  });

  it('with no secret configured at all every request is refused', async () => {
    same(await call(app({ cfg: noticesCfg({ CMS_FEED_NOTICES_SECRET: '', CMS_FEED_NOTICES_SECRET_PREVIOUS: '' }) })));
  });

  it('the log says only WHY (a step code): no signature, nonce, secret, header or address', async () => {
    await call(app(), { secret: randomBytes(32).toString('hex') });
    await call(app(), { ip: '203.0.113.9' });
    const text = logs.join('\n');
    expect(text).toContain('[audience] digest notices refused (step=signature)');
    expect(text).toContain('[audience] digest notices refused (step=fence)');
    for (const n of usedNonces) expect(text).not.toContain(n);
    for (const s of [SECRET, PREVIOUS, bad.email, unsub.email, '203.0.113.9', 'sha256=']) expect(text).not.toContain(s);
  });

  it('only GET: a POST to the door path is not an answer (404 from the integrations router), and door W is untouched', async () => {
    const a = app();
    expect((await request(a).post(CMS_NOTICES_PATH).set('X-Forwarded-For', ALLOWED).send({})).status).toBe(404);
    expect((await request(a).get('/api/integrations/cms/other')).status).toBe(404);
    // door W (default env: the audience sync is off) still answers its own 401 to an unsigned POST
    const w = await request(a).post('/api/integrations/cms/events').send({});
    expect([w.status, w.body]).toEqual([401, UNAUTH]);
  });
});

describe('4. ETag and 304', () => {
  it('the same list gives the same ETag; If-None-Match with it is 304 with no body; weak, listed and * forms too', async () => {
    const a = app();
    const first = await call(a);
    const etag = first.headers.etag as string;
    expect(etag).toBe(`"${noticesEtag([{ accountId: bad.accountId, reason: 'bad_address' }, { accountId: unsub.accountId, reason: 'unsubscribed' }])}"`);
    expect((await call(a)).headers.etag).toBe(etag);
    for (const inm of [etag, `W/${etag}`, `"zzz", ${etag}`, '*']) {
      const r = await call(a, { ifNoneMatch: inm });
      expect([r.status, r.text, r.headers.etag]).toEqual([304, '', etag]);
    }
    const other = await call(a, { ifNoneMatch: '"0000"' });
    expect(other.status).toBe(200);
  });

  it('one row changes → a new ETag, and the old one no longer matches', async () => {
    const a = app();
    const etag = (await call(a)).headers.etag as string;
    await account('later', { reason: 'HARD_BOUNCE' });
    const again = await call(a, { ifNoneMatch: etag });
    expect(again.status).toBe(200);
    expect(again.headers.etag).not.toBe(etag);
    expect(again.body.count).toBe(3);
    // a reason changing on an existing row changes it too
    const e3 = again.headers.etag as string;
    await prisma.emailSuppression.update({ where: { emailHash: emailHash(unsub.email) }, data: { reason: 'HARD_BOUNCE' } });
    expect((await call(a, { ifNoneMatch: e3 })).status).toBe(200);
  });

  it('the ETag does not depend on the time: as_of moves, the ETag does not', async () => {
    const a = app();
    const first = await call(a);
    clockNow = new Date(T0.getTime() + 30 * 60_000);
    const second = await call(a);
    expect(second.body.as_of).not.toBe(first.body.as_of);
    expect(second.headers.etag).toBe(first.headers.etag);
  });
});

describe('5. the flag and freshness', () => {
  it('flag off → 404 for everyone, signed or not, inside the fence or not (as if the door did not exist)', async () => {
    const off = app({ cfg: noticesCfg({ DIGEST_NOTICES_ENABLED: 'false' }) });
    for (const r of [await call(off), await call(off, { ip: '203.0.113.9' }), await request(off).get(CMS_NOTICES_PATH)]) expect([r.status, r.body]).toEqual([404, { error: 'not_found' }]);
    expect(logs.join('\n')).not.toContain('digest notices refused'); // nothing even logged
  });

  it('503 {"error":"not_ready"} with no complete full load, a load 49 h old, or an open breaker; never a 200 and never an empty list', async () => {
    const a = app();
    await prisma.audienceSyncState.deleteMany({ where: { portal: PORTAL } });
    for (const label of ['no state', 'stale', 'breaker']) {
      if (label === 'stale') await ready({ lastFullOkAt: new Date(T0.getTime() - 49 * 3_600_000) });
      if (label === 'breaker') await ready({ breakerOpenAt: new Date(T0.getTime() - 60_000), breakerReason: 'truncated_load' });
      const r = await call(a);
      expect([label, r.status, r.body, r.headers['cache-control']]).toEqual([label, 503, { error: 'not_ready' }, 'no-store']);
    }
    await ready();
    expect((await call(a)).status).toBe(200);
  });

  it('a matching If-None-Match is still a 503 while not ready: the CMS keeps its copy and we do not vouch', async () => {
    const a = app();
    const etag = (await call(a)).headers.etag as string;
    await ready({ breakerOpenAt: new Date(T0.getTime() - 60_000), breakerReason: 'change_too_large' });
    const r = await call(a, { ifNoneMatch: etag });
    expect([r.status, r.body]).toEqual([503, { error: 'not_ready' }]);
  });

  it('the nonce of a verified request is spent even when the answer is 503', async () => {
    const a = app();
    await prisma.audienceSyncState.deleteMany({ where: { portal: PORTAL } });
    const nonce = newNonce();
    expect((await call(a, { nonce })).status).toBe(503);
    await ready();
    expect((await call(a, { nonce })).status).toBe(401);
  });
});

describe('6. an empty list is a real answer', () => {
  it('200 with count 0 and no items: nobody should see a notice', async () => {
    await wipeAccounts();
    await ready();
    const r = await call(app());
    expect([r.status, r.body.count, r.body.items]).toEqual([200, 0, []]);
    expect(r.body.portal).toBe(PORTAL);
    expect(r.headers.etag).toBe(`"${noticesEtag([])}"`);
  });
});

async function wipeAccounts() {
  const accs = await prisma.cmsAccount.findMany({ where: { accountId: { startsWith: P } }, select: { emailHash: true } });
  const hs = accs.map((x) => x.emailHash).filter((h): h is string => !!h);
  await prisma.emailSuppression.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
}

describe('rate limit and the nonce store', () => {
  it('30 requests an hour per client by default; the next is 429; a client outside the fence never uses the budget', async () => {
    const a = app({ perHour: 3 });
    for (let i = 0; i < 10; i++) expect((await call(a, { ip: '203.0.113.9' })).status).toBe(401); // outside the fence: not counted
    for (let i = 0; i < 3; i++) expect((await call(a)).status).toBe(200);
    const r = await call(a);
    expect([r.status, r.body]).toEqual([429, { error: 'rate_limited' }]);
  });

  it('a failing signature from the fenced address counts too', async () => {
    const a = app({ perHour: 2 });
    expect((await call(a, { secret: randomBytes(32).toString('hex') })).status).toBe(401);
    expect((await call(a, { secret: randomBytes(32).toString('hex') })).status).toBe(401);
    expect((await call(a)).status).toBe(429);
  });

  it('the default is 30 an hour', async () => {
    const a = createApp({ cmsNotices: { cfg: noticesCfg(), audience: audCfg, clock: () => clockNow, portal: PORTAL } });
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call(a as ReturnType<typeof app>)).status;
    expect(last).toBe(429);
  });

  it('a nonce is single-use for 10 minutes: the same nonce signed afresh 11 minutes later is accepted', async () => {
    const a = app();
    const nonce = newNonce();
    expect((await call(a, { nonce })).status).toBe(200);
    clockNow = new Date(T0.getTime() + 5 * 60_000);
    expect((await call(a, { nonce })).status).toBe(401);
    clockNow = new Date(T0.getTime() + 11 * 60_000);
    expect((await call(a, { nonce })).status).toBe(200);
  });

  it('five concurrent requests with one nonce: exactly one is answered', async () => {
    const a = app();
    const nonce = newNonce();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => call(a, { nonce })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(4);
  });
});
