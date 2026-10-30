import request from 'supertest';
import bcrypt from 'bcrypt';
import type { Request } from 'express';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { clientIpFrom, cmsClientIp, requestClientIp } from '../lib/clientIp';
import { clientKey } from '../lib/rateLimit';

/**
 * The real client address (src/lib/clientIp.ts → requestClientIp) and what depends on it: the public and login rate
 * limiters (one bucket per real client, not per Railway hop) and the audit log's ipAddress. Fixtures are the
 * production header shapes seen 29–30 Oct (see cmsEvents.test.ts).
 */

const errors: string[] = [];
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));

// Production shape through Cloudflare: `<cloudflare edge>, <railway hop>`; the client is in CF-Connecting-IP.
const VIA_CF = '172.70.142.102, 152.233.15.121';
const fakeReq = (headers: Record<string, string | undefined>, remote?: string): Pick<Request, 'header' | 'socket'> =>
  ({ header: (n: string) => headers[n.toLowerCase()], socket: { remoteAddress: remote } }) as unknown as Pick<Request, 'header' | 'socket'>;

describe('clientIpFrom / requestClientIp', () => {
  it('two-hop Cloudflare (production) → CF-Connecting-IP; the 79.127 hop too', () => {
    expect(clientIpFrom(VIA_CF, '148.113.0.114')).toBe('148.113.0.114');
    expect(clientIpFrom('172.70.142.102, 79.127.228.17', '198.51.100.9')).toBe('198.51.100.9');
  });
  it('single-hop Cloudflare (the older shape) → CF-Connecting-IP', () => {
    expect(clientIpFrom('173.245.48.5', '198.51.100.9')).toBe('198.51.100.9');
    expect(clientIpFrom('1.2.3.4, 173.245.48.5', '198.51.100.9')).toBe('198.51.100.9');
  });
  it('direct to origin: forged left part and forged CF-Connecting-IP are ignored', () => {
    expect(clientIpFrom('148.113.0.114, 203.0.113.9, 152.233.15.121', '148.113.0.114')).toBe('203.0.113.9');
    expect(clientIpFrom('203.0.113.9', '148.113.0.114')).toBe('203.0.113.9');
  });
  it('IPv6: a Cloudflare IPv6 edge and an IPv6 client, canonicalised', () => {
    expect(clientIpFrom('2606:4700::6810:1, 152.233.15.121', '2001:DB8:0:0::7')).toBe('2001:db8::7');
  });
  it('garbage / missing → null; Cloudflare hop without CF-Connecting-IP → null', () => {
    for (const bad of [undefined, null, '', ' , ', 'garbage', '203.0.113.9, garbage']) expect(clientIpFrom(bad, '198.51.100.9')).toBeNull();
    expect(clientIpFrom(VIA_CF, undefined)).toBeNull();
  });
  it('cmsClientIp is the same derivation', () => {
    expect(cmsClientIp).toBe(clientIpFrom);
  });

  it('the request wrapper reads the headers; XFF present but garbage is null, never the socket', () => {
    expect(requestClientIp(fakeReq({ 'x-forwarded-for': VIA_CF, 'cf-connecting-ip': '198.51.100.9' }, '10.0.0.1'))).toBe('198.51.100.9');
    expect(requestClientIp(fakeReq({ 'x-forwarded-for': 'garbage' }, '10.0.0.1'))).toBeNull();
  });
  it('no XFF: the socket address outside production (IPv4-mapped → IPv4), null in production', () => {
    const was = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      expect(requestClientIp(fakeReq({}, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
      expect(requestClientIp(fakeReq({}, undefined))).toBeNull();
      process.env.NODE_ENV = 'production';
      expect(requestClientIp(fakeReq({}, '::ffff:127.0.0.1'))).toBeNull();
      expect(requestClientIp(fakeReq({ 'x-forwarded-for': VIA_CF, 'cf-connecting-ip': '198.51.100.9' }))).toBe('198.51.100.9');
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});

describe('clientKey (the rate-limit bucket)', () => {
  const key = (h: Record<string, string | undefined>, remote?: string) => clientKey(fakeReq(h, remote) as Request);
  it('IPv4 as is; IPv6 grouped by /56; unreadable → one shared bucket', () => {
    expect(key({ 'x-forwarded-for': VIA_CF, 'cf-connecting-ip': '198.51.100.9' })).toBe('198.51.100.9');
    expect(key({ 'x-forwarded-for': VIA_CF, 'cf-connecting-ip': '2001:db8:abcd:ff01::1' })).toBe(key({ 'x-forwarded-for': VIA_CF, 'cf-connecting-ip': '2001:db8:abcd:ff02::5' }));
    expect(key({ 'x-forwarded-for': VIA_CF, 'cf-connecting-ip': '2001:db8:abcd:ff01::1' })).not.toBe(key({ 'x-forwarded-for': VIA_CF, 'cf-connecting-ip': '2001:db8:abcd:fe01::1' }));
    expect(key({ 'x-forwarded-for': 'garbage' })).toBe('unknown');
  });
});

describe('the public limiter counts the real client', () => {
  const hit = (a: ReturnType<typeof createApp>, h: Record<string, string>) => {
    let r = request(a).get('/api/config');
    for (const [k, v] of Object.entries(h)) r = r.set(k, v);
    return r;
  };
  const cf = (client: string) => ({ 'X-Forwarded-For': VIA_CF, 'CF-Connecting-IP': client });

  it('two readers behind the same Railway hop get separate buckets: A is limited at 61, B is not', async () => {
    const a = createApp({ rateLimit: { publicPerMin: 60, loginPerMin: 5 } });
    for (let i = 0; i < 60; i++) expect((await hit(a, cf('198.51.100.1'))).status).toBe(200);
    expect((await hit(a, cf('198.51.100.1'))).status).toBe(429);
    expect((await hit(a, cf('198.51.100.2'))).status).toBe(200);
  });

  it('a direct caller forging a new CF-Connecting-IP (and left part) each time stays in ONE bucket', async () => {
    const a = createApp({ rateLimit: { publicPerMin: 60, loginPerMin: 5 } });
    const forged = (i: number) => ({ 'X-Forwarded-For': `10.9.${i}.1, 203.0.113.9, 152.233.15.121`, 'CF-Connecting-IP': `198.51.100.${(i % 200) + 1}` });
    for (let i = 0; i < 60; i++) expect((await hit(a, forged(i))).status).toBe(200);
    expect((await hit(a, forged(61))).status).toBe(429);
  });

  it('IPv6 clients in the same /56 share a bucket, another /56 does not; no validation warning is logged', async () => {
    errors.length = 0;
    const a = createApp({ rateLimit: { publicPerMin: 3, loginPerMin: 5 } });
    for (let i = 0; i < 3; i++) expect((await hit(a, cf('2001:db8:abcd:ff01::1'))).status).toBe(200);
    expect((await hit(a, cf('2001:db8:abcd:ff02::5'))).status).toBe(429);
    expect((await hit(a, cf('2001:db8:abcd:fe00::1'))).status).toBe(200);
    expect(errors.filter((l) => /ERR_ERL|ValidationError|express-rate-limit/i.test(l))).toEqual([]);
  });

  it('dev/test with no X-Forwarded-For: the socket address is the key', async () => {
    const a = createApp({ rateLimit: { publicPerMin: 2, loginPerMin: 5 } });
    expect((await hit(a, {})).status).toBe(200);
    expect((await hit(a, {})).status).toBe(200);
    expect((await hit(a, {})).status).toBe(429);
  });
});

describe('the login limiter and the audit log use the real client', () => {
  const userIds: string[] = [];
  const login = (a: ReturnType<typeof createApp>, client: string | null, email: string) => {
    let r = request(a).post('/api/auth/login');
    if (client) r = r.set('X-Forwarded-For', VIA_CF).set('CF-Connecting-IP', client);
    return r.send({ email, password: 'WrongPasswordABC123' });
  };

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function makeUser(): Promise<{ id: string; email: string }> {
    const email = `real-ip-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.com`;
    const u = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash('RealPasswordABC123', 4), role: 'PUBLISHER', isActive: true } });
    userIds.push(u.id);
    return u;
  }

  it('editor A’s failures do not block editor B behind the same hop (5/min)', async () => {
    const a = createApp({ rateLimit: { publicPerMin: 1000, loginPerMin: 5 } });
    const u = await makeUser();
    for (let i = 0; i < 5; i++) expect((await login(a, '198.51.100.1', u.email)).status).toBe(401);
    expect((await login(a, '198.51.100.1', u.email)).status).toBe(429);
    expect((await login(a, '198.51.100.2', u.email)).status).toBe(401);
  });

  it('a failed login writes LOGIN_FAILED with the CF-Connecting-IP address, not Railway’s', async () => {
    const a = createApp({ rateLimit: { publicPerMin: 1000, loginPerMin: 1000 } });
    const u = await makeUser();
    expect((await login(a, '198.51.100.77', u.email)).status).toBe(401);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { userId: u.id, action: 'LOGIN_FAILED' } });
    expect(row.ipAddress).toBe('198.51.100.77');
  });

  it('dev/test with no X-Forwarded-For: the audit row records the socket address', async () => {
    const a = createApp({ rateLimit: { publicPerMin: 1000, loginPerMin: 1000 } });
    const u = await makeUser();
    expect((await login(a, null, u.email)).status).toBe(401);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { userId: u.id, action: 'LOGIN_FAILED' } });
    expect(row.ipAddress).toBe('127.0.0.1');
  });
});
