import bcrypt from 'bcrypt';
import cron from 'node-cron';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { buildBackup } from '../services/backup';
import { runLinkedInTick, resetLinkedInStops, loginProblem, authKey, type WorkerDeps } from '../services/linkedin/worker';
import {
  ACCESS_TOKEN_URL, INTROSPECT_URL, activeAccessToken, decryptSecret, encryptSecret, keyBytes, renewalConfigProblem, resetTokenCache, runTokenCheck,
  sha256, startLinkedInTokenRenewal, tokenStatus, type TokenDeps,
} from '../services/linkedin/token';

/**
 * Brief 2026-11-02-linkedin-token-refresh: the access token renews itself (LinkedIn HTTP mocked throughout), is stored
 * encrypted, never leaks, and never reaches the backup. Rows live under the private page `litoken`.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PAGE = 'litoken';
const PORTAL = `test-lt-${RUN}`;
const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 10, 3, 5, 0)); // 3 Nov 2026 10:30 IST
const at = (days: number, base = NOW) => new Date(base.getTime() + days * DAY);

const KEY = randomBytes(32).toString('base64');
const SECRETS = {
  envAccess: `ENV-ACCESS-${RUN}-aaaaaaaa`,
  envRefresh: `ENV-REFRESH-${RUN}-bbbbbbbb`,
  newAccess: `NEW-ACCESS-${RUN}-cccccccc`,
  newAccess2: `NEW-ACCESS2-${RUN}-dddddddd`,
  newRefresh: `NEW-REFRESH-${RUN}-eeeeeeee`,
  clientSecret: `CLIENT-SECRET-${RUN}-ffffffff`,
};
const saved = { tr: { ...env.linkedin.tokenRefresh }, page: env.linkedin.pages[PAGE], enabled: env.linkedin.enabled };

type Call = { url: string; body: URLSearchParams };
let calls: Call[] = [];
let introDays: number | null = 40;
let introActive = true;
let refreshReply: (n: number) => { status: number; json: Record<string, unknown> } = () => ({ status: 200, json: { access_token: SECRETS.newAccess, expires_in: 5_184_000, refresh_token: SECRETS.envRefresh, refresh_token_expires_in: 30_000_000 } });
const response = (status: number, json: unknown) => ({ status, json: async () => json }) as unknown as Response;
const fetchMock = (async (url: string, init: RequestInit) => {
  const body = new URLSearchParams(String(init.body));
  calls.push({ url, body });
  if (url === INTROSPECT_URL) return introDays === null ? response(500, {}) : response(200, { active: introActive, status: introActive ? 'active' : 'expired', expires_at: Math.floor(at(introDays).getTime() / 1000) });
  const r = refreshReply(calls.filter((c) => c.url === ACCESS_TOKEN_URL).length);
  return response(r.status, r.json);
}) as unknown as typeof fetch;
const refreshCalls = () => calls.filter((c) => c.url === ACCESS_TOKEN_URL);

let mails: { to: string; subject: string; text: string }[] = [];
const deps = (now: Date = NOW, over: TokenDeps = {}): TokenDeps => ({
  now: () => now,
  fetch: fetchMock,
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  pages: [PAGE],
  ...over,
});
const row = () => prisma.linkedInToken.findUnique({ where: { page: PAGE } });

function configure(over: Partial<typeof env.linkedin.tokenRefresh> = {}) {
  Object.assign(env.linkedin.tokenRefresh, { enabled: true, clientId: 'client-id-1', clientSecret: SECRETS.clientSecret, key: KEY, ...over });
  env.linkedin.pages[PAGE] = { orgUrn: 'urn:li:organization:77', accessToken: SECRETS.envAccess, refreshToken: SECRETS.envRefresh, refreshExpiresAt: null };
}

const userIds: string[] = [];
let admin: User;
let cookie = '';
beforeAll(async () => {
  admin = await prisma.user.create({ data: { email: `lt-${RUN}@team.test`, passwordHash: await bcrypt.hash('lt-pw-1-test', 4), role: 'ADMIN', isActive: true } });
  userIds.push(admin.id);
  const res = await request(createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } })).post('/api/auth/login').send({ email: admin.email, password: 'lt-pw-1-test' });
  cookie = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie'] as unknown as string]).map((l) => l.split(';')[0]).join('; ');
});
beforeEach(async () => {
  calls = [];
  mails = [];
  logs.length = 0;
  introDays = 40;
  introActive = true;
  refreshReply = () => ({ status: 200, json: { access_token: SECRETS.newAccess, expires_in: 5_184_000, refresh_token: SECRETS.envRefresh, refresh_token_expires_in: 30_000_000 } });
  configure();
  resetTokenCache();
  resetLinkedInStops();
  await prisma.linkedInToken.deleteMany({ where: { page: PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [`linkedin:token:state:${PAGE}`, authKey(PAGE)] } } });
  await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
  await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
});
afterAll(async () => {
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  env.linkedin.enabled = saved.enabled;
  if (saved.page) env.linkedin.pages[PAGE] = saved.page;
  else delete env.linkedin.pages[PAGE];
  await prisma.linkedInToken.deleteMany({ where: { page: PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [`linkedin:token:state:${PAGE}`, authKey(PAGE)] } } });
  await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
  await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('encryption', () => {
  it('v1:<iv>:<tag>:<ciphertext>, a fresh IV per value, authenticated: tampering or another key decrypts to nothing', () => {
    const key = keyBytes(KEY)!;
    const a = encryptSecret('hello token', key);
    const b = encryptSecret('hello token', key);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('hello token');
    expect(Buffer.from(a.split(':')[1], 'base64')).toHaveLength(12);
    expect(decryptSecret(a, key)).toBe('hello token');
    expect(decryptSecret(a, keyBytes(randomBytes(32).toString('base64'))!)).toBeNull();
    const parts = a.split(':');
    expect(decryptSecret([parts[0], parts[1], parts[2], Buffer.from('xx').toString('base64')].join(':'), key)).toBeNull();
    expect(decryptSecret('v2:a:b:c', key)).toBeNull();
    expect(keyBytes(randomBytes(31).toString('base64'))).toBeNull();
    expect(keyBytes('')).toBeNull();
  });
});

describe('1. which token is used', () => {
  it('a stored row with a matching fingerprint → the stored token; no row → env; the env token changed → env wins and the row is dropped', async () => {
    expect(await activeAccessToken(PAGE)).toBe(SECRETS.envAccess);
    await prisma.linkedInToken.create({ data: { page: PAGE, accessTokenEnc: encryptSecret(SECRETS.newAccess, keyBytes(KEY)!), envFingerprint: sha256(SECRETS.envAccess) } });
    expect(await activeAccessToken(PAGE)).toBe(SECRETS.newAccess);
    env.linkedin.pages[PAGE] = { ...env.linkedin.pages[PAGE], accessToken: `${SECRETS.envAccess}-pasted-later` };
    expect(await activeAccessToken(PAGE)).toBe(`${SECRETS.envAccess}-pasted-later`);
    expect(await row()).toBeNull();
  });
  it('renewal off, or the key missing / the wrong length → the env token (a stored row is ignored)', async () => {
    await prisma.linkedInToken.create({ data: { page: PAGE, accessTokenEnc: encryptSecret(SECRETS.newAccess, keyBytes(KEY)!), envFingerprint: sha256(SECRETS.envAccess) } });
    env.linkedin.tokenRefresh.enabled = false;
    expect(await activeAccessToken(PAGE)).toBe(SECRETS.envAccess);
    env.linkedin.tokenRefresh.enabled = true;
    env.linkedin.tokenRefresh.key = randomBytes(16).toString('base64');
    expect(await activeAccessToken(PAGE)).toBe(SECRETS.envAccess);
    env.linkedin.tokenRefresh.key = '';
    expect(await activeAccessToken(PAGE)).toBe(SECRETS.envAccess);
    expect(await row()).not.toBeNull(); // not dropped: nothing says it is stale
  });
});

describe('2. renewal', () => {
  it('20 days left → no refresh call; 13 days left → exactly one, with the right form body; the new token is stored encrypted', async () => {
    introDays = 20;
    await runTokenCheck(deps());
    expect(refreshCalls()).toHaveLength(0);
    expect(logs.join('\n')).toMatch(new RegExp(`\\[linkedin-token\\] page=${PAGE} access_left_days=20 refresh_left_days=\\S+ action=none`));
    introDays = 13;
    await runTokenCheck(deps());
    expect(refreshCalls()).toHaveLength(1);
    const body = refreshCalls()[0].body;
    expect(Object.fromEntries(body.entries())).toEqual({ grant_type: 'refresh_token', refresh_token: SECRETS.envRefresh, client_id: 'client-id-1', client_secret: SECRETS.clientSecret });
    const r = (await row())!;
    expect(r.accessTokenEnc).not.toContain(SECRETS.newAccess);
    expect(r.accessTokenEnc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(r.accessTokenEnc, keyBytes(KEY)!)).toBe(SECRETS.newAccess);
    expect(r.accessExpiresAt!.getTime()).toBe(NOW.getTime() + 5_184_000 * 1000);
    expect(r.refreshExpiresAt!.getTime()).toBe(NOW.getTime() + 30_000_000 * 1000);
    expect(r.renewedAt).not.toBeNull();
    expect(r.lastError).toBeNull();
    expect(r.envFingerprint).toBe(sha256(SECRETS.envAccess));
    expect(logs.join('\n')).toMatch(/action=renewed/);
    expect(await activeAccessToken(PAGE)).toBe(SECRETS.newAccess);
  });
  it('the next worker post uses the renewed token', async () => {
    const c = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Renewed token story', body: 'b', url: `https://www.taxscan.in/gst/lt-${RUN}`, target: {}, status: 'SENT', lastSentAt: at(0, new Date(NOW.getTime() - 5 * 60_000)) } });
    introDays = 13;
    await runTokenCheck(deps());
    const used: string[] = [];
    const wd: WorkerDeps = {
      now: () => NOW,
      post: async (r) => {
        used.push(r.accessToken);
        return { kind: 'posted', postId: 'urn:li:share:1' };
      },
      fetchCms: async () => null,
      portals: { [PORTAL]: PAGE },
      postFrom: at(-1),
      quiet: { start: '23:00', end: '07:00' },
    };
    await runLinkedInTick(wd);
    expect(used).toEqual([SECRETS.newAccess]);
    await prisma.linkedInPost.deleteMany({ where: { campaignId: c.id } });
  });
  it('introspection unavailable → the stored expiry from the last renewal is used; with neither, nothing is done', async () => {
    introDays = 13;
    await runTokenCheck(deps()); // renews, stores accessExpiresAt = now + 60 days
    calls = [];
    introDays = null; // introspection answers 500
    await runTokenCheck(deps(at(50))); // 10 days before the stored expiry → renew from the stored date
    expect(refreshCalls()).toHaveLength(1);
    await prisma.linkedInToken.deleteMany({ where: { page: PAGE } });
    calls = [];
    await runTokenCheck(deps()); // no stored expiry, no introspection: unknown
    expect(refreshCalls()).toHaveLength(0);
    expect(logs.join('\n')).toContain('access_left_days=unknown');
  });
  it('an expired / revoked token (introspection says inactive) is renewed at once', async () => {
    introDays = 30;
    introActive = false;
    await runTokenCheck(deps());
    expect(refreshCalls()).toHaveLength(1);
  });
});

describe('3. a new refresh token', () => {
  it('is stored encrypted and used on the next renewal (the env value is only the fallback)', async () => {
    refreshReply = (n) => ({ status: 200, json: { access_token: n === 1 ? SECRETS.newAccess : SECRETS.newAccess2, expires_in: 5_184_000, refresh_token: SECRETS.newRefresh, refresh_token_expires_in: 30_000_000 } });
    introDays = 13;
    await runTokenCheck(deps());
    const r = (await row())!;
    expect(r.refreshTokenEnc).not.toBeNull();
    expect(r.refreshTokenEnc).not.toContain(SECRETS.newRefresh);
    expect(decryptSecret(r.refreshTokenEnc!, keyBytes(KEY)!)).toBe(SECRETS.newRefresh);
    await runTokenCheck(deps(at(1)));
    expect(refreshCalls()).toHaveLength(2);
    expect(refreshCalls()[0].body.get('refresh_token')).toBe(SECRETS.envRefresh);
    expect(refreshCalls()[1].body.get('refresh_token')).toBe(SECRETS.newRefresh);
    expect(await activeAccessToken(PAGE)).toBe(SECRETS.newAccess2);
  });
});

describe('4. failures', () => {
  it('a 400 / 401 stops all refresh calls until an env value changes, with ONE admin email per IST day', async () => {
    refreshReply = () => ({ status: 400, json: { error: 'invalid_request', error_description: `The provided authorization grant or refresh token is invalid, expired or revoked ${SECRETS.envRefresh}` } });
    introDays = 12;
    await runTokenCheck(deps());
    expect(refreshCalls()).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain('LinkedIn token could not be renewed (12 days left)');
    expect(mails[0].text).toContain('railway variable set LINKEDIN_TAXSCAN_ACCESS_TOKEN="$(pbpaste)" -s taxscan-push');
    expect(mails[0].text).toContain('LINKEDIN_TAXSCAN_REFRESH_TOKEN');
    expect((await row())!.lastError).toMatch(/refresh token rejected/);
    await runTokenCheck(deps(at(0.2))); // same IST day
    expect(refreshCalls()).toHaveLength(1);
    expect(mails).toHaveLength(1);
    await runTokenCheck(deps(at(1))); // next IST day: still no call, one more email
    expect(refreshCalls()).toHaveLength(1);
    expect(mails).toHaveLength(2);
    env.linkedin.pages[PAGE] = { ...env.linkedin.pages[PAGE], refreshToken: `${SECRETS.envRefresh}-new` }; // the owner pastes new values
    refreshReply = () => ({ status: 200, json: { access_token: SECRETS.newAccess, expires_in: 5_184_000 } });
    await runTokenCheck(deps(at(1.1)));
    expect(refreshCalls()).toHaveLength(2);
    expect((await row())!.lastError).toBeNull();
  });
  it('a 401 behaves the same', async () => {
    refreshReply = () => ({ status: 401, json: { error: 'invalid_client' } });
    introDays = 5;
    await runTokenCheck(deps());
    await runTokenCheck(deps(at(1)));
    expect(refreshCalls()).toHaveLength(1);
  });
  it('a 5xx or a network error is retried at the next tick, and the admins are told once per IST day', async () => {
    refreshReply = () => ({ status: 503, json: {} });
    introDays = 10;
    await runTokenCheck(deps());
    await runTokenCheck(deps(at(0.1)));
    expect(refreshCalls()).toHaveLength(2); // not blocked: tries again
    expect(mails).toHaveLength(1);
    expect((await row())!.lastError).toMatch(/will retry at the next daily check/);
    await runTokenCheck(deps(at(1)));
    expect(refreshCalls()).toHaveLength(3);
    expect(mails).toHaveLength(2);
    refreshReply = () => ({ status: 200, json: { access_token: SECRETS.newAccess, expires_in: 5_184_000 } });
    await runTokenCheck(deps(at(2)));
    expect((await row())!.lastError).toBeNull();
    expect(logs.join('\n')).toMatch(/action=renewed/);
  });
});

describe('5. the yearly sign-in', () => {
  it('a refresh token 29 days from expiry → the email, at most once per 7 days', async () => {
    env.linkedin.pages[PAGE] = { ...env.linkedin.pages[PAGE], refreshExpiresAt: at(29) };
    introDays = 40;
    await runTokenCheck(deps());
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^Yearly LinkedIn sign-in due by /);
    expect(mails[0].text).toContain('OAuth 2.0 tools');
    await runTokenCheck(deps(at(1)));
    await runTokenCheck(deps(at(6.9)));
    expect(mails).toHaveLength(1);
    await runTokenCheck(deps(at(7.1)));
    expect(mails).toHaveLength(2);
  });
  it('31 days from expiry → no email', async () => {
    env.linkedin.pages[PAGE] = { ...env.linkedin.pages[PAGE], refreshExpiresAt: at(31) };
    await runTokenCheck(deps());
    expect(mails).toHaveLength(0);
  });
});

describe('6. a renewal resumes posting after a login stop, no restart', () => {
  it('the worker stopped on the old token; the renewal ends the stop and clears the banner', async () => {
    const c = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Stopped then renewed', body: 'b', url: `https://www.taxscan.in/gst/lt-stop-${RUN}`, target: {}, status: 'SENT', lastSentAt: at(0, new Date(NOW.getTime() - 5 * 60_000)) } });
    const used: string[] = [];
    let reject = true;
    const wd: WorkerDeps = {
      now: () => NOW,
      post: async (r) => {
        used.push(r.accessToken);
        return reject ? { kind: 'auth', status: 401, error: 'HTTP 401' } : { kind: 'posted', postId: 'urn:li:share:2' };
      },
      fetchCms: async () => null,
      emailSender: async () => ({ ok: true }),
      isEmailConfigured: () => false,
      portals: { [PORTAL]: PAGE },
      postFrom: at(-1),
      quiet: { start: '23:00', end: '07:00' },
    };
    expect((await runLinkedInTick(wd)).authStopped).toBe(true);
    expect(await loginProblem(PAGE)).not.toBeNull();
    await runLinkedInTick(wd);
    expect(used).toEqual([SECRETS.envAccess]); // stopped: no second call
    reject = false;
    introDays = 12;
    await runTokenCheck(deps());
    expect(await loginProblem(PAGE)).toBeNull(); // banner cleared
    await runLinkedInTick({ ...wd, now: () => at(0.001) }); // no restart, no reset
    expect(used).toEqual([SECRETS.envAccess, SECRETS.newAccess]);
    expect((await prisma.linkedInPost.findMany({ where: { campaignId: c.id } }))[0]).toMatchObject({ status: 'POSTED' });
  });
});

describe('7. no secret leaves the server', () => {
  it('not in logs, lastError, emails, the screen API, the DB state rows or the backup output', async () => {
    refreshReply = (n) =>
      n === 1
        ? { status: 400, json: { error_description: `bad: ${SECRETS.envAccess} ${SECRETS.envRefresh} ${SECRETS.clientSecret} ${KEY}` } }
        : { status: 200, json: { access_token: SECRETS.newAccess, expires_in: 5_184_000, refresh_token: SECRETS.newRefresh, refresh_token_expires_in: 30_000_000 } };
    introDays = 6;
    await runTokenCheck(deps()); // fails (400) with the secrets echoed
    env.linkedin.pages[PAGE] = { ...env.linkedin.pages[PAGE], refreshToken: `${SECRETS.envRefresh}-2` };
    await runTokenCheck(deps(at(1))); // succeeds, stores a new refresh token
    env.linkedin.enabled = true;
    const list = await request(createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGE }), postFrom: () => at(-1) } }))
      .get('/api/linkedin/posts?date=2026-11-03')
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.token).toMatchObject({ autoRenew: true, renewalFailed: false });
    const backup = (await buildBackup({ now: NOW })).body.toString('utf8'); // NDJSON; gzip happens at upload
    const everything = JSON.stringify({
      logs,
      mails,
      row: await row(),
      state: await prisma.digestSetting.findMany({ where: { key: { startsWith: 'linkedin:' } } }),
      api: list.body,
    });
    const plaintexts = [...Object.values(SECRETS), KEY, `${SECRETS.envRefresh}-2`];
    for (const s of plaintexts) {
      expect(everything).not.toContain(s);
      expect(backup).not.toContain(s);
    }
    expect(backup).not.toContain('"LinkedInToken"');
  });
  it('the screen block is dates and a status only', async () => {
    introDays = 6;
    await runTokenCheck(deps());
    const t = (await tokenStatus(PAGE, NOW))!;
    expect(Object.keys(t).sort()).toEqual(['autoRenew', 'refreshUntil', 'renewalFailed', 'renewedAt', 'status', 'validUntil']);
    expect(t.status).toBe('ok');
    introDays = 10;
    await prisma.linkedInToken.updateMany({ where: { page: PAGE }, data: { accessExpiresAt: at(10) } });
    expect((await tokenStatus(PAGE, NOW))!.status).toBe('amber');
    await prisma.linkedInToken.updateMany({ where: { page: PAGE }, data: { lastError: 'renewal failed (HTTP 503)' } });
    expect((await tokenStatus(PAGE, NOW))!.status).toBe('red');
  });
});

describe('8. the key', () => {
  it('missing or not 32 bytes → renewal refuses with a log line, and posting with the env token still works', async () => {
    for (const bad of ['', randomBytes(16).toString('base64'), 'not base64 !!']) {
      logs.length = 0;
      env.linkedin.tokenRefresh.key = bad;
      const r = await runTokenCheck(deps());
      expect(r.refused).toMatch(/LINKEDIN_TOKEN_KEY/);
      expect(logs.join('\n')).toContain('[linkedin-token] refusing to run: LINKEDIN_TOKEN_KEY');
      expect(refreshCalls()).toHaveLength(0);
    }
    expect(renewalConfigProblem([PAGE])).toMatch(/LINKEDIN_TOKEN_KEY/);
    const c = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Env token story', body: 'b', url: `https://www.taxscan.in/gst/lt-env-${RUN}`, target: {}, status: 'SENT', lastSentAt: at(0, new Date(NOW.getTime() - 5 * 60_000)) } });
    const used: string[] = [];
    await runLinkedInTick({ now: () => NOW, post: async (r) => (used.push(r.accessToken), { kind: 'posted', postId: 'urn:li:share:3' }), fetchCms: async () => null, portals: { [PORTAL]: PAGE }, postFrom: at(-1), quiet: { start: '23:00', end: '07:00' } });
    expect(used).toEqual([SECRETS.envAccess]);
    await prisma.linkedInPost.deleteMany({ where: { campaignId: c.id } });
  });
  it('the other variables are checked too: client id / secret and the page\'s refresh token', () => {
    env.linkedin.tokenRefresh.clientId = '';
    expect(renewalConfigProblem([PAGE])).toMatch(/LINKEDIN_CLIENT_ID/);
    env.linkedin.tokenRefresh.clientId = 'x';
    env.linkedin.tokenRefresh.clientSecret = '';
    expect(renewalConfigProblem([PAGE])).toMatch(/LINKEDIN_CLIENT_SECRET/);
    env.linkedin.tokenRefresh.clientSecret = 's';
    env.linkedin.pages[PAGE] = { ...env.linkedin.pages[PAGE], refreshToken: '' };
    expect(renewalConfigProblem([PAGE])).toMatch(/LINKEDIN_LITOKEN_REFRESH_TOKEN/);
  });
});

describe('9. the flag', () => {
  it('off → no cron is scheduled, the daily run does nothing and the screen API has no token block; on but incomplete → refuses to start', async () => {
    const schedule = jest.spyOn(cron, 'schedule');
    env.linkedin.tokenRefresh.enabled = false;
    startLinkedInTokenRenewal();
    expect(schedule).not.toHaveBeenCalled();
    expect((await runTokenCheck(deps())).refused).toMatch(/off/);
    expect(calls).toHaveLength(0);
    expect(await tokenStatus(PAGE, NOW)).toBeNull();
    const list = await request(createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGE }), postFrom: () => at(-1) } }))
      .get('/api/linkedin/posts?date=2026-11-03')
      .set('Cookie', cookie);
    expect(list.body.token).toBeUndefined();
    env.linkedin.tokenRefresh.enabled = true;
    env.linkedin.tokenRefresh.clientSecret = '';
    logs.length = 0;
    startLinkedInTokenRenewal();
    expect(logs.join('\n')).toContain('[linkedin-token] refusing to start:');
    schedule.mockRestore();
  });
});
