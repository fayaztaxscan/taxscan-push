import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, type AudienceEnv } from '../lib/env';
import { FakeMailercloud, type FakeContact } from './audienceFakeMailercloud';
import { ContactError, McContactClient, RESUBSCRIBE_CONSENT_SOURCE, safeConsentSource } from '../services/audience/mcContacts';
import { flushPending, resetWriterForTests, retryDelayMin, RESUBSCRIBE_CONSENT_MAX_AGE_MS, type WriterDeps } from '../services/audience/writer';

/**
 * Brief 2026-11-12-resubscribe-endpoint: the lift path re-subscribes through Mailercloud's POST /v1/contacts/resubscribe (the PUT with a
 * status was ignored by Mailercloud and never worked). A fake Mailercloud models the documented answers; NO real Mailercloud call anywhere.
 * Acceptance 1–9 (10 = the existing audience tests, run unchanged apart from the deliberate PUT → POST in audienceWriter.test.ts).
 */
const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const KEY = 'k'.repeat(40);
const P = `rs${RUN}-`;
const PORTAL = `test-audience-resub-${RUN}`;
const T = { premium: `tp-${RUN}`, former: `tf-${RUN}`, noMarketing: `tn-${RUN}` };
const NAME = { [T.premium]: 'TS Premium (auto)', [T.former]: 'TS Former (auto)', [T.noMarketing]: 'TS No marketing (auto)' };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const DAY = 24 * 3_600_000;
const MIN = 60_000;
const hashes = new Set<string>();
let seq = 0;
const addr = (local: string) => {
  const e = `${local}.${++seq}.${RUN}@example.com`;
  hashes.add(sha(e));
  return e;
};
const baseEnv = {
  AUDIENCE_SYNC_ENABLED: 'true',
  AUDIENCE_SYNC_WRITE_MAILERCLOUD: 'true',
  MAILERCLOUD_SYNC_API_KEY: KEY,
  AUDIENCE_MC_LIST_ID: 'list-1',
  AUDIENCE_MC_TAG_PREMIUM: T.premium,
  AUDIENCE_MC_TAG_FORMER: T.former,
  AUDIENCE_MC_TAG_NO_MARKETING: T.noMarketing,
};
const cfgWith = (over: Record<string, string> = {}): AudienceEnv => parseAudienceEnv({ ...baseEnv, ...over });
const rfc3339 = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

let now = new Date('2027-03-01T10:00:00Z'); // 15:30 IST: outside the 07:10–08:00 send window
let fake: FakeMailercloud;
let base: string;
const noSleep = () => Promise.resolve();

function deps(over: Partial<WriterDeps> & { resubscribe?: boolean } = {}): WriterDeps {
  const { resubscribe, ...rest } = over;
  return {
    client: new McContactClient({ apiKey: KEY, baseV1: base, resubscribeWrites: resubscribe === true }),
    cfg: cfgWith(resubscribe ? { AUDIENCE_RESUBSCRIBE_WRITES: 'true' } : {}),
    digestCfg: { sendAt: '07:30' },
    portal: PORTAL,
    now: () => now,
    sleep: noSleep,
    sendAlerts: false,
    ...rest,
  };
}
const client = () => new McContactClient({ apiKey: KEY, baseV1: base, resubscribeWrites: true });
const row = (h: string) => prisma.audienceMember.findUnique({ where: { emailHash: h } });
const state = () => prisma.audienceSyncState.findUnique({ where: { portal: PORTAL } });
const resubRequests = () => fake.requests.filter((r) => r.path === '/v1/contacts/resubscribe');

async function seedState() {
  await prisma.audienceSyncState.upsert({
    where: { portal: PORTAL },
    create: { portal: PORTAL, lastFullOkAt: new Date(now.getTime() - 3_600_000) },
    update: { lastFullOkAt: new Date(now.getTime() - 3_600_000), breakerOpenAt: null, breakerReason: null, alerts: {} },
  });
}

type Account = { consentValue?: boolean | null; consentAt?: Date | null; deletedAt?: Date | null; outOfScopeAt?: Date | null };
type Lift = {
  flag?: boolean;
  suppressed?: boolean;
  /** The member's CMS accounts (default: one live consent-true account, consent given right now). */
  accounts?: Account[];
  /** The contact in Mailercloud (default: unsubscribed; false = none at all). */
  contact?: false | { status?: FakeContact['status']; unsubscribedAt?: Date };
};
/** A member whose suppression ingest lifted (resubscribePending), the accounts it holds, its Mailercloud contact, and one writer tick. */
async function lifting(o: Lift = {}) {
  const email = addr('lift');
  const h = sha(email);
  await prisma.audienceMember.create({
    data: { emailHash: h, email, desiredRole: 'NONE', resubscribePending: true, suppressed: o.suppressed ?? false, nextAttemptAt: new Date(now.getTime() - 1000) },
  });
  let i = 0;
  for (const a of o.accounts ?? [{ consentValue: true, consentAt: now }]) {
    await prisma.cmsAccount.create({
      data: {
        accountId: `${P}${h.slice(0, 8)}-${++i}`,
        seq: 1n,
        status: 'free',
        lastSource: 'webhook',
        emailHash: h,
        consentValue: a.consentValue === undefined ? true : a.consentValue,
        consentAt: a.consentAt === undefined ? null : a.consentAt,
        deletedAt: a.deletedAt ?? null,
        outOfScopeAt: a.outOfScopeAt ?? null,
      },
    });
  }
  if (o.contact !== false) fake.addContact(email, { status: o.contact?.status ?? 'unsubscribed', unsubscribedAt: o.contact?.unsubscribedAt });
  fake.clock = () => now;
  const r = await flushPending(deps({ onlyHashes: [h], resubscribe: o.flag ?? true }));
  return { email, h, r };
}

beforeAll(async () => {
  await seedState();
});
beforeEach(async () => {
  resetWriterForTests();
  logs.length = 0;
  now = new Date('2027-03-01T10:00:00Z');
  fake = new FakeMailercloud(KEY);
  fake.tags = [
    { id: T.premium, tag_name: NAME[T.premium] },
    { id: T.former, tag_name: NAME[T.former] },
    { id: T.noMarketing, tag_name: NAME[T.noMarketing] },
  ];
  base = await fake.start();
  await seedState();
});
afterEach(async () => {
  await fake.stop();
});
afterAll(async () => {
  const hs = [...hashes];
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* The client                                                          */
/* ------------------------------------------------------------------ */

describe('the client: POST /v1/contacts/resubscribe', () => {
  const consent = () => ({ source: RESUBSCRIBE_CONSENT_SOURCE, at: now });

  it('1. refused before any request unless built with the flag, and with no valid consent time', async () => {
    const off = new McContactClient({ apiKey: KEY, baseV1: base });
    await expect(off.resubscribe('a@example.com', consent())).rejects.toMatchObject({ kind: 'FATAL' });
    await expect(client().resubscribe('a@example.com', { source: 'x', at: new Date('nope') })).rejects.toMatchObject({ kind: 'FATAL' });
    expect(fake.requests).toHaveLength(0);
  });

  it('2. 200 changed:true → "subscribed": one POST with {email, consent_source, consent_at} and nothing else; the key is sent without "Bearer"', async () => {
    fake.clock = () => now;
    fake.addContact('reader@example.com', { status: 'unsubscribed' });
    expect(await client().resubscribe('reader@example.com', consent())).toBe('subscribed');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/v1/contacts/resubscribe' });
    expect(fake.requests[0].body).toEqual({ email: 'reader@example.com', consent_source: 'taxscan account settings', consent_at: '2027-03-01T10:00:00Z' });
    expect(fake.contacts.get('reader@example.com')!.status).toBe('active');
    expect(JSON.stringify(fake.requests)).not.toContain('contact_type');
  });

  it('3. 200 changed:false → "already"; 202 → "pending_confirmation" (and the contact is not subscribed yet)', async () => {
    fake.clock = () => now;
    fake.addContact('active@example.com', { status: 'active' });
    expect(await client().resubscribe('active@example.com', consent())).toBe('already');
    fake.addContact('double@example.com', { status: 'unsubscribed' });
    fake.doubleOptIn = true;
    expect(await client().resubscribe('double@example.com', consent())).toBe('pending_confirmation');
    expect(fake.contacts.get('double@example.com')!.status).toBe('unsubscribed');
  });

  it('4. 404, 409 (bounced / spam) and 422 are NOT_RESUBSCRIBABLE: final, with the status and Mailercloud\'s code words only', async () => {
    fake.clock = () => now;
    fake.addContact('bounced@example.com', { status: 'bounced' });
    fake.addContact('late@example.com', { status: 'unsubscribed' });
    const errs: ContactError[] = [];
    for (const [email, at] of [
      ['gone@example.com', now], // 404
      ['bounced@example.com', now], // 409
      ['late@example.com', new Date(now.getTime() - 91 * DAY)], // 422: older than 90 days
      ['late@example.com', new Date(now.getTime() + MIN)], // 422: in the future
    ] as [string, Date][]) {
      const e = await client().resubscribe(email, { source: 'x', at }).then(() => null, (err: unknown) => err as ContactError);
      expect(e).toBeInstanceOf(ContactError);
      errs.push(e!);
    }
    expect(errs.map((e) => [e.kind, e.http, e.op])).toEqual([
      ['NOT_RESUBSCRIBABLE', 404, 'resubscribe'],
      ['NOT_RESUBSCRIBABLE', 409, 'resubscribe'],
      ['NOT_RESUBSCRIBABLE', 422, 'resubscribe'],
      ['NOT_RESUBSCRIBABLE', 422, 'resubscribe'],
    ]);
    expect(errs[0].message).toBe('mailercloud contacts resubscribe: HTTP 404 contact_not_found');
    expect(errs[1].message).toBe('mailercloud contacts resubscribe: HTTP 409 contact_not_resubscribable (bounced)');
    expect(errs[2].message).toBe('mailercloud contacts resubscribe: HTTP 422 invalid');
  });

  it('5. 429, 5xx, a refused connection and a silent server are RETRYABLE; 401 and 403 quota_exceeded are FATAL', async () => {
    fake.clock = () => now;
    fake.addContact('r@example.com', { status: 'unsubscribed' });
    const kindOf = async (c: McContactClient) => (await c.resubscribe('r@example.com', consent()).then(() => 'ok', (e: ContactError) => `${e.kind}:${e.http}`));
    for (const status of [429, 500, 502, 503]) {
      fake.resubscribeAnswer = () => ({ status, body: { code: 'rate_limited' } });
      expect(await kindOf(client())).toBe(`RETRYABLE:${status}`);
    }
    fake.resubscribeAnswer = () => ({ status: 403, body: { code: 'quota_exceeded' } });
    expect(await kindOf(client())).toBe('FATAL:403');
    fake.resubscribeAnswer = null;
    expect(await kindOf(new McContactClient({ apiKey: 'wrong-key', baseV1: base, resubscribeWrites: true }))).toBe('FATAL:401');
    expect(await kindOf(new McContactClient({ apiKey: KEY, baseV1: 'http://127.0.0.1:1/v1', resubscribeWrites: true }))).toBe('RETRYABLE:null');
    // a server that never answers: the client's own timeout, retryable
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (silent.address() as { port: number }).port;
      expect(await kindOf(new McContactClient({ apiKey: KEY, baseV1: `http://127.0.0.1:${port}/v1`, timeoutMs: 150, resubscribeWrites: true }))).toBe('RETRYABLE:null');
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('7. consent_source: anything outside letters, digits, spaces and . , : - _ / @ + is REMOVED, cut to 100, never empty', () => {
    expect(safeConsentSource('taxscan account settings')).toBe('taxscan account settings');
    expect(safeConsentSource('A b.c,d:e-f_g/h@i+j9')).toBe('A b.c,d:e-f_g/h@i+j9'); // the whole allowed set survives
    expect(safeConsentSource('taxscan [account] settings')).toBe('taxscan account settings'); // brackets (the live 422)
    expect(safeConsentSource('a"b\'c<d>e{f}g|h\\i^j`k~l(m)n;o=p&q?r!s#t$u%v*w')).toBe('abcdefghijklmnopqrstuvw');
    expect(safeConsentSource('a\nb\tc\u0000d')).toBe('abcd');
    expect(safeConsentSource('Café ✓ ok')).toBe('Caf  ok');
    expect(safeConsentSource('x'.repeat(150))).toBe('x'.repeat(100));
    expect(safeConsentSource(`${'y'.repeat(99)} zzz`)).toBe('y'.repeat(99)); // cut at 100, then the trailing space is trimmed
    for (const empty of ['', '   ', '[[]]', '✓✓', null, undefined]) expect(safeConsentSource(empty)).toBe(RESUBSCRIBE_CONSENT_SOURCE);
    for (const raw of ['taxscan [account] settings', 'x'.repeat(150), 'Café ✓ ok']) expect(safeConsentSource(safeConsentSource(raw))).toBe(safeConsentSource(raw));
    for (const raw of ['a[b', 'z'.repeat(300), 'éé']) expect(safeConsentSource(raw)).toMatch(/^[A-Za-z0-9 .,:\-_/@+]{1,100}$/);
  });

  it('7b. the source goes through the helper even when a caller passes something unsafe', async () => {
    fake.clock = () => now;
    fake.addContact('s@example.com', { status: 'unsubscribed' });
    await client().resubscribe('s@example.com', { source: 'from [settings] page', at: now });
    expect(resubRequests()[0].body).toMatchObject({ consent_source: 'from settings page' });
  });

  it('9. no error message carries an address or the key, even when Mailercloud echoes the address in its text', async () => {
    fake.clock = () => now;
    fake.addContact('secret.reader@example.com', { status: 'unsubscribed' });
    const messages: string[] = [];
    for (const answer of [
      { status: 422, body: { code: 'invalid', message: 'invalid consent for secret.reader@example.com' } },
      { status: 409, body: { code: 'contact_not_resubscribable', current_status: 'secret.reader@example.com', message: `key ${KEY}` } },
      { status: 404, body: { error: { message: 'No contact secret.reader@example.com' } } },
      { status: 403, body: { message: `quota for secret.reader@example.com ${KEY}` } },
      { status: 500, body: { message: 'secret.reader@example.com' } },
    ]) {
      fake.resubscribeAnswer = () => answer;
      const e = await client().resubscribe('secret.reader@example.com', consent()).then(() => null, (err: ContactError) => err);
      messages.push(e!.message);
    }
    for (const m of messages) {
      expect(m).not.toContain('secret.reader');
      expect(m).not.toContain('@example.com');
      expect(m).not.toContain(KEY);
    }
    expect(messages[1]).toBe('mailercloud contacts resubscribe: HTTP 409 contact_not_resubscribable'); // a free-text "current_status" is dropped
  });
});

/* ------------------------------------------------------------------ */
/* The writer's lift                                                   */
/* ------------------------------------------------------------------ */

describe('the writer: a lifted member is re-subscribed with the reader\'s own consent', () => {
  it('1. flag off: no request, counted as skipped, the lift is handled', async () => {
    const { h, r } = await lifting({ flag: false });
    expect(r).toMatchObject({ resubscribed: 0, resubscribeSkipped: 1, resubscribeConsentTooOld: 0, done: 1 });
    expect(resubRequests()).toHaveLength(0);
    expect(await row(h)).toBeNull();
  });

  it('2. 200 changed:true → resubscribed; the request is exactly {email, consent_source, consent_at}; pending is cleared; nothing is sent twice', async () => {
    const { email, h, r } = await lifting();
    expect(r).toMatchObject({ resubscribed: 1, resubscribeAlready: 0, resubscribePending: 0, resubscribeRefused: 0, resubscribeSkipped: 0, done: 1, fatal: 0, retry: 0 });
    expect(resubRequests()).toHaveLength(1);
    expect(resubRequests()[0].body).toEqual({ email, consent_source: 'taxscan account settings', consent_at: rfc3339(now) });
    expect(JSON.stringify(fake.requests)).not.toContain('contact_type');
    expect(fake.contacts.get(email)!.status).toBe('active');
    expect(await row(h)).toBeNull(); // handled: no flag left, no address kept
    await flushPending(deps({ onlyHashes: [h], resubscribe: true }));
    expect(resubRequests()).toHaveLength(1);
  });

  it('3. 200 changed:false → resubscribeAlready, cleared', async () => {
    const { h, r } = await lifting({ contact: { status: 'active' } });
    expect(r).toMatchObject({ resubscribed: 0, resubscribeAlready: 1, done: 1 });
    expect(resubRequests()).toHaveLength(1);
    expect(await row(h)).toBeNull();
  });

  it('3. 202 → resubscribePending (the reader must confirm by e-mail), cleared: the next tick sends no second request', async () => {
    fake.doubleOptIn = true;
    const { h, r } = await lifting();
    expect(r).toMatchObject({ resubscribed: 0, resubscribePending: 1, done: 1 });
    expect(await row(h)).toBeNull();
    await flushPending(deps({ onlyHashes: [h], resubscribe: true }));
    expect(resubRequests()).toHaveLength(1);
  });

  type Refusal = Lift & { answer?: { status: number; body: unknown } };
  it.each<[string, Refusal]>([
    ['a contact that bounced (409 from Mailercloud)', { contact: { status: 'bounced' } }],
    ['a contact that reported spam (409)', { contact: { status: 'spam' } }],
    ['a consent that is not after the unsubscribe (422)', { contact: { status: 'unsubscribed', unsubscribedAt: new Date('2027-03-01T09:00:00Z') }, accounts: [{ consentValue: true, consentAt: new Date('2027-03-01T08:00:00Z') }] }],
    ['a 404 from the endpoint itself (the contact vanished after our own GET)', { answer: { status: 404, body: { code: 'contact_not_found' } } }],
    ['a 409 contact_not_resubscribable', { answer: { status: 409, body: { code: 'contact_not_resubscribable', current_status: 'suppressed' } } }],
    ['a 422 invalid', { answer: { status: 422, body: { code: 'invalid' } } }],
  ])('4. %s: handled, counted as refused, never retried, no alert', async (_label, over) => {
    const { answer, ...lift } = over;
    if (answer) fake.resubscribeAnswer = () => answer;
    const { h, r } = await lifting(lift);
    expect(r).toMatchObject({ resubscribed: 0, resubscribeRefused: 1, resubscribeSkipped: 0, done: 1, fatal: 0, retry: 0 });
    expect(resubRequests()).toHaveLength(1); // one request, never repeated
    expect(await row(h)).toBeNull(); // the lift is handled: not retried tomorrow either
    const alerts = ((await state())?.alerts ?? {}) as Record<string, unknown>;
    expect(Object.keys(alerts)).not.toContain('audience_writer_fatal');
    expect(logs.join('\n')).not.toMatch(/writer refused/); // no per-member refusal line: one counted refusal, like a refused row
  });

  it('4. a contact that does not exist in Mailercloud is skipped before any call (our own GET said 404): counted skipped, still handled', async () => {
    const { h, r } = await lifting({ contact: false });
    expect(r).toMatchObject({ resubscribeRefused: 0, resubscribeSkipped: 1, done: 1, fatal: 0 });
    expect(resubRequests()).toHaveLength(0);
    expect(await row(h)).toBeNull();
  });

  it.each([429, 500, 503])('5. a %s is RETRYABLE: the member stays pending and is retried on the existing schedule, then goes through', async (status) => {
    fake.resubscribeAnswer = () => ({ status, body: { code: 'rate_limited' } });
    const { h, r } = await lifting();
    expect(r).toMatchObject({ resubscribed: 0, retry: 1, fatal: 0, done: 0 });
    const held = (await row(h))!;
    expect(held).toMatchObject({ resubscribePending: true, attempts: 1, lastErrorKind: 'RETRYABLE' });
    expect(held.nextAttemptAt!.getTime()).toBe(now.getTime() + retryDelayMin(1) * MIN);
    // Mailercloud recovers; the next due tick re-subscribes
    fake.resubscribeAnswer = null;
    now = new Date(now.getTime() + 2 * MIN);
    fake.clock = () => now;
    const again = await flushPending(deps({ onlyHashes: [h], resubscribe: true }));
    expect(again).toMatchObject({ resubscribed: 1, done: 1 });
    expect(await row(h)).toBeNull();
  });

  it('5. 403 quota_exceeded is FATAL as today: the member stops, one fatal alert state, still pending for a fix', async () => {
    fake.resubscribeAnswer = () => ({ status: 403, body: { code: 'quota_exceeded' } });
    const { h, r } = await lifting();
    expect(r).toMatchObject({ resubscribed: 0, fatal: 1, done: 0 });
    expect(await row(h)).toMatchObject({ resubscribePending: true, lastErrorKind: 'FATAL', nextAttemptAt: null });
  });

  it('6. consent_at is the LATEST consentAt of the live consent-true accounts, as RFC 3339; a later one on a deleted / out-of-scope / consent-false account is ignored', async () => {
    const early = new Date(now.getTime() - 30 * DAY);
    const latest = new Date(now.getTime() - 3 * DAY + 123); // milliseconds are cut, never rounded up
    const { email, r } = await lifting({
      accounts: [
        { consentValue: true, consentAt: early },
        { consentValue: true, consentAt: latest },
        { consentValue: true, consentAt: new Date(now.getTime() - 1 * DAY), deletedAt: new Date(now.getTime() - DAY / 2) },
        { consentValue: true, consentAt: new Date(now.getTime() - 1 * DAY), outOfScopeAt: new Date(now.getTime() - DAY / 2) },
        { consentValue: false, consentAt: new Date(now.getTime() - 1 * DAY) },
      ],
    });
    expect(r).toMatchObject({ resubscribed: 1 });
    expect(resubRequests()[0].body).toMatchObject({ email, consent_at: rfc3339(latest) });
    expect(rfc3339(latest)).toBe(new Date(Math.floor(latest.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z'));
  });

  it('6. a consent in the future, older than 90 days, or with no time at all → NO call, consent_too_old, the lift handled; 89 days and exactly 90 days are sent', async () => {
    const cases: [string, Date | null, boolean][] = [
      ['91 days old', new Date(now.getTime() - 91 * DAY), false],
      ['in the future', new Date(now.getTime() + MIN), false],
      ['missing', null, false],
      ['89 days old', new Date(now.getTime() - 89 * DAY), true],
      ['exactly 90 days old', new Date(now.getTime() - RESUBSCRIBE_CONSENT_MAX_AGE_MS), true],
    ];
    for (const [label, consentAt, sent] of cases) {
      fake.requests.length = 0;
      const { h, r } = await lifting({ accounts: [{ consentValue: true, consentAt }] });
      expect([label, resubRequests().length]).toEqual([label, sent ? 1 : 0]);
      if (sent) expect(r).toMatchObject({ resubscribed: 1, resubscribeConsentTooOld: 0 });
      else expect(r).toMatchObject({ resubscribed: 0, resubscribeSkipped: 1, resubscribeConsentTooOld: 1, done: 1 });
      expect(await row(h)).toBeNull(); // handled either way
    }
  });

  it('6. no live consent-true account at all is the old plain skip (not consent_too_old); a suppressed member is skipped; neither sends a request', async () => {
    const none = await lifting({ accounts: [{ consentValue: false, consentAt: now }] });
    expect(none.r).toMatchObject({ resubscribeSkipped: 1, resubscribeConsentTooOld: 0, resubscribed: 0 });
    const suppressed = await lifting({ suppressed: true });
    expect(suppressed.r).toMatchObject({ resubscribeSkipped: 1, resubscribed: 0 });
    expect(resubRequests()).toHaveLength(0);
  });

  it('9. the writer log line carries the new counts and no address and no key, through every outcome', async () => {
    const a = await lifting(); // subscribed
    await lifting({ contact: { status: 'active' } }); // already
    fake.doubleOptIn = true;
    await lifting(); // pending
    fake.doubleOptIn = false;
    await lifting({ contact: { status: 'bounced' } }); // refused
    await lifting({ accounts: [{ consentValue: true, consentAt: new Date(now.getTime() - 100 * DAY) }] }); // too old
    fake.resubscribeAnswer = () => ({ status: 429, body: { message: 'slow down' } });
    const retried = await lifting(); // retryable
    const writerLines = logs.filter((l) => l.startsWith('[audience] writer members='));
    expect(writerLines).toHaveLength(6);
    expect(writerLines[0]).toContain('resubscribed=1');
    expect(writerLines[1]).toContain('already=1');
    expect(writerLines[2]).toContain('pending=1');
    expect(writerLines[3]).toContain('resubRefused=1');
    expect(writerLines[4]).toContain('consentTooOld=1');
    const all = logs.join('\n');
    for (const email of [a.email, retried.email]) expect(all).not.toContain(email);
    expect(all).not.toContain('@example.com');
    expect(all).not.toContain(KEY);
  });
});

/* ------------------------------------------------------------------ */
/* Source scan                                                         */
/* ------------------------------------------------------------------ */

describe('8. source scan of src/services/audience', () => {
  const dir = path.join(__dirname, '../services/audience');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('`contact_type` appears nowhere in the audience services (code or comments)', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect([f, readFileSync(path.join(dir, f), 'utf8').includes('contact_type')]).toEqual([f, false]);
  });

  it('`/contacts/resubscribe` is requested only by resubscribe(), nowhere else in the audience services', () => {
    const hits = files.filter((f) => strip(readFileSync(path.join(dir, f), 'utf8')).includes('/contacts/resubscribe'));
    expect(hits).toEqual(['mcContacts.ts']);
    const code = strip(readFileSync(path.join(dir, 'mcContacts.ts'), 'utf8'));
    expect(code.match(/\/contacts\/resubscribe/g)).toHaveLength(1);
    expect(code.indexOf('/contacts/resubscribe')).toBeGreaterThan(code.indexOf('async resubscribe('));
    expect(code.indexOf('/contacts/resubscribe')).toBeLessThan(code.indexOf('async listTags('));
  });
});
