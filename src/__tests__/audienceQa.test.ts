/**
 * QA probes for CMS audience tasks 3–4 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4–§8; contract v1.2).
 * Independent oracles and adversarial cases the developer's tests do not cover:
 *  - memberRole over every status × consent × deleted × formerToFree, singly and in pairs;
 *  - erasure is final against EVERY door (equal-seq list row, higher-seq event, list row);
 *  - the consent lift: IST day boundary, MANUAL / ACCOUNT_DELETED never lifted by consent;
 *  - the webhook: Content-Encoding, duplicate CF-Connecting-IP, a forged X-Forwarded-For chain,
 *    erasure:true on a live event, the 401 shape on every refusal.
 */
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, type AudienceEnv } from '../lib/env';
import { CMS_WEBHOOK_PATH, signCmsWebhook } from '../lib/cmsSignature';
import { createIntegrationsRouter } from '../routes/cmsEvents';
import { createApp } from '../app';
import { CMS_EVENT_BODIES } from './fixtures/cms-feed-v1.2/payloads';
import { parseCmsEvent, parseCmsListRow, type AccountSnapshot } from '../services/audience/snapshot';
import { memberRole, type RuleAccount } from '../services/audience/rules';
import { applyAccountSnapshot, MAX_LIFTS_PER_DAY, type ApplyOptions, type SnapshotSource } from '../services/audience/ingest';

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `q${RUN}-`;
const PORTAL = `test-audience-qa-${RUN}`;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
const email = (local: string) => {
  const e = `${local}.${RUN}@example.com`;
  hashes.add(sha(e));
  return e;
};
const cfg: AudienceEnv = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' });

type Key = keyof typeof CMS_EVENT_BODIES;
function ev(key: Key, over: Record<string, unknown>, id: string): Record<string, unknown> {
  const o = JSON.parse(CMS_EVENT_BODIES[key]) as Record<string, unknown>;
  o.account_id = id;
  if (typeof o.email === 'string') o.email = email(`fx-${id}`);
  return { ...o, ...over };
}
function snapOf(body: Record<string, unknown>): AccountSnapshot {
  const p = parseCmsEvent(body);
  if (!p.ok || !('snapshot' in p)) throw new Error(`did not parse: ${JSON.stringify(p)}`);
  return p.snapshot;
}
/** The list-row form of an event body (drop event-only keys, add deleted_at / updated_at). */
function rowOf(body: Record<string, unknown>, deletedAt: string | null = null): AccountSnapshot {
  const rest: Record<string, unknown> = { ...body };
  for (const k of ['event_id', 'event', 'occurred_at', 'reactivated']) delete rest[k];
  const p = parseCmsListRow({ ...rest, deleted_at: deletedAt, updated_at: '2026-11-01T00:00:00Z' });
  if (!p.ok) throw new Error(`row did not parse: ${p.reason}`);
  return p.snapshot;
}
async function apply(snap: AccountSnapshot, source: SnapshotSource = 'webhook', opts: ApplyOptions = {}) {
  return prisma.$transaction((tx) => applyAccountSnapshot(tx, snap, source, { cfg, portal: PORTAL, ...opts }), { timeout: 20_000 });
}
const account = (id: string) => prisma.cmsAccount.findUnique({ where: { accountId: id } });
const member = (addr: string) => prisma.audienceMember.findUnique({ where: { emailHash: sha(addr) } });

afterAll(async () => {
  const hs = [...hashes];
  await prisma.emailEvent.deleteMany({ where: { OR: [{ emailHash: { in: hs } }, { dedupeKey: { startsWith: `qcap-${RUN}` } }] } });
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.cmsEventReceipt.deleteMany({ where: { eventId: { startsWith: `evt_q${RUN}` } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

// ─── memberRole: an independent oracle over every combination ──────────────

describe('memberRole — exhaustive table against an oracle written from design §4 + owner Q1–Q3', () => {
  const STATUSES = ['free', 'active', 'cancelled', 'ended', 'deleted', 'paused', 'ACTIVE', ''];
  const CONSENTS = [true, false, null] as const;
  const DELETED = [null, new Date('2026-01-01T00:00:00Z')];
  const all: RuleAccount[] = [];
  for (const status of STATUSES) for (const consentValue of CONSENTS) for (const deletedAt of DELETED) all.push({ status, consentValue, deletedAt });

  function oracle(accts: RuleAccount[], formerToFree: boolean) {
    const live = accts.filter((a) => a.deletedAt === null && a.status !== 'deleted');
    const premium = live.some((a) => a.status === 'active' || a.status === 'cancelled'); // exact, case-sensitive
    const former = !premium && formerToFree && live.some((a) => a.status === 'ended' && a.consentValue !== false);
    const noMarketing = live.some((a) => a.consentValue === false) || (accts.length > 0 && live.length === 0);
    return { role: premium ? 'PREMIUM' : former ? 'FORMER' : 'NONE', noMarketing };
  }

  it(`single accounts (${all.length} × 2 settings) and every pair (${all.length ** 2} × 2)`, () => {
    let checked = 0;
    for (const formerToFree of [true, false]) {
      for (const a of all) {
        expect([a, memberRole([a], { formerToFree })]).toEqual([a, oracle([a], formerToFree)]);
        checked += 1;
        for (const b of all) {
          const got = memberRole([a, b], { formerToFree });
          if (got.role !== oracle([a, b], formerToFree).role || got.noMarketing !== oracle([a, b], formerToFree).noMarketing) {
            throw new Error(`mismatch for ${JSON.stringify([a, b])} formerToFree=${formerToFree}: ${JSON.stringify(got)}`);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(2 * (all.length + all.length ** 2));
  });

  it('Premium is granted ONLY by active|cancelled on a live account (never by an unknown, a case variant or a deleted one)', () => {
    for (const a of all) {
      const premium = memberRole([a], { formerToFree: true }).role === 'PREMIUM';
      expect(premium).toBe(a.deletedAt === null && (a.status === 'active' || a.status === 'cancelled'));
    }
  });

  it('an explicit consent=false on a live non-Premium account always excludes Free (FORMER never granted)', () => {
    for (const a of all.filter((x) => x.consentValue === false && x.deletedAt === null && x.status !== 'deleted')) {
      const r = memberRole([a], { formerToFree: true });
      expect(r.noMarketing).toBe(true);
      expect(r.role === 'FORMER').toBe(false);
    }
  });
});

// ─── erasure is final against every door ────────────────────────────────────

describe('erasure is final', () => {
  it('after erasure:true, no live snapshot revives it — higher-seq event, higher-seq list row, EQUAL-seq list row', async () => {
    const id = `${P}erase-final`;
    const live = ev('subscription.started_900001_seq3', { seq: 3 }, id);
    const addr = live.email as string;
    await apply(snapOf(live));
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' } });
    const erased = ev('account.deleted_900002_seq7', { seq: 4 }, id);
    expect((await apply(snapOf(erased))).erasureQueued).toBe(true);

    // The address is gone from every suppression row; the hash stays.
    const sup = await prisma.emailSuppression.findMany({ where: { emailHash: sha(addr) } });
    expect(sup.map((s) => s.email)).toEqual([null]);

    for (const [name, snap, source] of [
      ['event seq 5 reactivated', snapOf(ev('account.created_900001_seq1', { seq: 5, reactivated: true, email: addr, status: 'active', plan: 'x' }, id)), 'webhook'],
      ['list row seq 9', rowOf(ev('subscription.started_900001_seq3', { seq: 9, email: addr }, id)), 'pull_full'],
      ['list row EQUAL seq 4, live', rowOf(ev('subscription.started_900001_seq3', { seq: 4, email: addr }, id)), 'pull_full'],
    ] as const) {
      const r = await apply(snap, source as SnapshotSource);
      expect([name, r.outcome]).toEqual([name, 'erased']);
      const acc = await account(id);
      expect([name, acc!.erasedAt !== null, acc!.deletedAt !== null, acc!.seq]).toEqual([name, true, true, 4n]);
    }
    // The member is held only for the pending erase: never Premium again.
    const m = await member(addr);
    expect(m).toMatchObject({ desiredRole: 'NONE', noMarketing: true });
    expect(m!.eraseRequestedAt).not.toBeNull();
    // Still no address back on the suppression.
    expect((await prisma.emailSuppression.findMany({ where: { emailHash: sha(addr) } })).map((s) => s.email)).toEqual([null]);
  });

  it('an erasure:false deletion AFTER the erasure (higher seq) never clears erasedAt', async () => {
    const id = `${P}erase-then-del`;
    await apply(snapOf(ev('subscription.started_900001_seq3', { seq: 1 }, id)));
    await apply(snapOf(ev('account.deleted_900002_seq7', { seq: 2 }, id)));
    await apply(snapOf(ev('account.deleted_900002_seq6', { seq: 3 }, id)));
    expect((await account(id))!.erasedAt).not.toBeNull();
    expect((await apply(snapOf(ev('account.created_900001_seq1', { seq: 4, reactivated: true }, id)))).outcome).toBe('erased');
  });

  it('a Mailercloud opt-out after the erasure keeps the hash-only row hash-only (no address comes back)', async () => {
    const { handleMailercloudWebhook } = await import('../services/digest/webhook');
    const id = `${P}erase-mc`;
    const live = ev('subscription.started_900001_seq3', { seq: 1 }, id);
    const addr = live.email as string;
    await apply(snapOf(live));
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' } });
    await apply(snapOf(ev('account.deleted_900002_seq7', { seq: 2 }, id)));
    await handleMailercloudWebhook({ event: 'spam', email: addr.toUpperCase(), campaign_id: `${P}c1`, time: '2026-11-01T00:00:00Z' });
    const rows = await prisma.emailSuppression.findMany({ where: { emailHash: sha(addr) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: null, reason: 'SPAM' });
  });
});

// ─── ACCOUNT_DELETED vs real opt-outs ───────────────────────────────────────

describe('ACCOUNT_DELETED ranks lowest and can never lift a real opt-out', () => {
  it('a consent opt-in never lifts ACCOUNT_DELETED or MANUAL; a revival lifts ACCOUNT_DELETED only', async () => {
    const id = `${P}acctdel`;
    const live = ev('subscription.started_900001_seq3', { seq: 1 }, id);
    const addr = live.email as string;
    await apply(snapOf(live));
    await prisma.emailSuppression.create({ data: { email: addr, accountId: id, reason: 'MANUAL', source: 'admin', lastSeenAt: new Date('2026-01-01T00:00:00Z') } });
    await apply(snapOf(ev('account.deleted_900002_seq6', { seq: 2 }, id)));
    const reasons = async () => (await prisma.emailSuppression.findMany({ where: { accountId: id }, orderBy: { reason: 'asc' } })).map((r) => r.reason);
    expect(await reasons()).toEqual(['ACCOUNT_DELETED', 'MANUAL']);
    // Revival with an explicit opt-in dated after both rows.
    const r = await apply(
      snapOf(ev('account.created_900001_seq1', { seq: 3, reactivated: true, email: addr, status: 'active', plan: 'premium_1y', marketing_consent: { value: true, at: new Date().toISOString() } }, id)),
    );
    expect(r).toMatchObject({ revived: true, lifted: 0 });
    expect(await reasons()).toEqual(['MANUAL']);
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM', suppressed: true });
  });

  it('a Mailercloud opt-out for the same person never merges into (or downgrades to) the ACCOUNT_DELETED row', async () => {
    const { handleMailercloudWebhook } = await import('../services/digest/webhook');
    const id = `${P}acctdel-mc`;
    const live = ev('subscription.started_900001_seq3', { seq: 1 }, id);
    const addr = live.email as string;
    await apply(snapOf(live));
    await apply(snapOf(ev('account.deleted_900002_seq6', { seq: 2 }, id)));
    await handleMailercloudWebhook({ event: 'unsubscribe', email: addr, campaign_id: `${P}c2`, time: '2026-11-01T00:00:00Z' });
    // Revival deletes ACCOUNT_DELETED only; the unsubscribe survives.
    await apply(snapOf(ev('account.created_900001_seq1', { seq: 3, reactivated: true, email: addr }, id)));
    const rows = await prisma.emailSuppression.findMany({ where: { OR: [{ accountId: id }, { emailHash: sha(addr) }] } });
    expect(rows.map((x) => x.reason)).toEqual(['UNSUBSCRIBE']);
  });
});

// ─── the consent lift: the IST day boundary ─────────────────────────────────

describe('consent lift cap — the IST day boundary', () => {
  it(`${MAX_LIFTS_PER_DAY} lifts at 23:59 IST fill the day; one at 00:00:30 IST the next day goes through`, async () => {
    // 2033-04-04 23:59 IST = 2033-04-04T18:29:00Z.
    const late = new Date('2033-04-04T18:29:00Z');
    await prisma.emailEvent.createMany({
      data: Array.from({ length: MAX_LIFTS_PER_DAY }, (_, i) => ({ provider: 'cms', type: 'RESUBSCRIBE', dedupeKey: `qcap-${RUN}-${i}`, receivedAt: late })),
    });
    const id = `${P}cap-ist`;
    const addr = email('cap-ist');
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook', lastSeenAt: new Date('2033-01-01T00:00:00Z') } });
    const body = ev('account.updated_900001_seq2', { email: addr, marketing_consent: { value: true, at: '2033-02-01T00:00:00Z' } }, id);
    // 23:59:59 IST — still the same IST day: deferred.
    expect(await apply(snapOf(body), 'webhook', { now: new Date('2033-04-04T18:29:59Z') })).toMatchObject({ lifted: 0, liftsDeferred: 1 });
    // 00:00:30 IST next day (18:30:30Z): a fresh day's room.
    expect(await apply(snapOf(body), 'pull_full', { now: new Date('2033-04-04T18:30:30Z') })).toMatchObject({ outcome: 'repaired', lifted: 1 });
  });
});

describe('consent lift cap — counts only THIS IST day', () => {
  it('RESUBSCRIBE rows stamped on a LATER day never use up today\'s room', async () => {
    const tomorrow = new Date('2035-06-07T06:00:00Z');
    await prisma.emailEvent.createMany({
      data: Array.from({ length: MAX_LIFTS_PER_DAY }, (_, i) => ({ provider: 'cms', type: 'RESUBSCRIBE', dedupeKey: `qcap-${RUN}-t${i}`, receivedAt: tomorrow })),
    });
    const id = `${P}cap-upper`;
    const addr = email('cap-upper');
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook', lastSeenAt: new Date('2035-01-01T00:00:00Z') } });
    const body = ev('account.updated_900001_seq2', { email: addr, marketing_consent: { value: true, at: '2035-02-01T00:00:00Z' } }, id);
    expect(await apply(snapOf(body), 'webhook', { now: new Date('2035-06-06T06:00:00Z') })).toMatchObject({ lifted: 1 });
  });
});

// ─── equal-seq list row repair: never resurrects, flags a conflict ─────────

describe('equal-seq list row with different content (the CMS "repair" rule)', () => {
  it('Premium → a free row at the SAME seq is re-applied AND flagged seqConflict (the downgrade is the CMS\'s word)', async () => {
    const id = `${P}eqseq`;
    const live = ev('subscription.started_900001_seq3', { seq: 7 }, id);
    await apply(snapOf(live));
    const r = await apply(rowOf(ev('account.updated_900001_seq2', { seq: 7, email: live.email }, id)), 'pull_full');
    expect(r).toMatchObject({ outcome: 'repaired', seqConflict: true });
    expect(await member(live.email as string)).toBeNull();
  });
});

// ─── webhook route probes ───────────────────────────────────────────────────

describe('webhook route — adversarial', () => {
  const SECRET = randomBytes(32).toString('hex');
  const CMS_IP = '198.51.100.7';
  const CF_EDGE = '173.245.48.5';
  const wcfg = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true', CMS_FEED_INBOUND_SECRET: SECRET, CMS_FEED_ALLOWED_IPS: `127.0.0.1,${CMS_IP}` });
  let k = 0;
  const fresh = (over: Record<string, unknown> = {}) => {
    const o = JSON.parse(CMS_EVENT_BODIES['subscription.started_900001_seq3']) as Record<string, unknown>;
    k += 1;
    o.event_id = `evt_q${RUN}_${k}`;
    o.account_id = `${P}w${k}`;
    o.email = email(`w${k}`);
    const merged = { ...o, ...over };
    return { raw: JSON.stringify(merged), eventId: String(merged.event_id), accountId: String(merged.account_id) };
  };
  const plain = () => createApp({ cmsEvents: { cfg: wcfg, failuresPerMin: 100_000, portal: PORTAL } });
  function proxied() {
    const a = express();
    a.set('trust proxy', 1);
    a.use('/api/integrations', createIntegrationsRouter({ cfg: wcfg, failuresPerMin: 100_000, portal: PORTAL }));
    a.use(express.json());
    return a;
  }
  /** One raw HTTP/1.1 request on a socket (repeated headers, exact body bytes); returns the status + logged step. */
  async function rawPost(a: express.Express, headers: [string, string][], payload: Buffer): Promise<{ status: number; step: string | null }> {
    const net = await import('node:net');
    const server = a.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const head = [`POST ${CMS_WEBHOOK_PATH} HTTP/1.1`, 'Host: localhost', 'Connection: close', ...headers.map(([k, v]) => `${k}: ${v}`), `Content-Length: ${payload.length}`].join('\r\n');
      const before = logs.length;
      const reply = await new Promise<string>((resolve, reject) => {
        let out = '';
        const sock = net.connect(port, '127.0.0.1', () => sock.write(Buffer.concat([Buffer.from(`${head}\r\n\r\n`), payload])));
        sock.on('data', (d) => (out += d.toString()));
        sock.on('end', () => resolve(out));
        sock.on('error', reject);
      });
      const step = logs.slice(before).map((l) => /step=(\w+)/.exec(l)?.[1]).find(Boolean) ?? null;
      return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1]), step };
    } finally {
      server.close();
    }
  }
  const signedHeaders = (b: { raw: string; eventId: string }): [string, string][] => {
    const s = signCmsWebhook(SECRET, b.raw);
    return [
      ['Content-Type', 'application/json'],
      ['X-CMS-Event-Id', b.eventId],
      ['X-CMS-Timestamp', s['X-CMS-Timestamp']],
      ['X-CMS-Signature', s['X-CMS-Signature']],
    ];
  };

  it('Content-Encoding gzip (signature over the plain JSON): refused at the body step — fails closed', async () => {
    const b = fresh();
    const gz = await rawPost(plain(), [...signedHeaders(b), ['Content-Encoding', 'gzip']], gzipSync(Buffer.from(b.raw)));
    expect(gz).toEqual({ status: 401, step: 'body' });
    expect(await account(b.accountId)).toBeNull();
    // Control: the same bytes uncompressed on the same socket path are accepted.
    const ok = await rawPost(plain(), signedHeaders(b), Buffer.from(b.raw));
    expect(ok.status).toBe(200);
  });

  it('an unsupported Content-Encoding → the same 401, nothing echoed', async () => {
    const b = fresh();
    const res = await request(plain())
      .post(CMS_WEBHOOK_PATH)
      .set({ 'Content-Type': 'application/json', 'Content-Encoding': 'x-evil', 'X-CMS-Event-Id': b.eventId, ...signCmsWebhook(SECRET, b.raw) })
      .send(b.raw);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'UNAUTHORISED' });
    // identity is the absence of an encoding: still accepted.
    const b2 = fresh();
    expect((await rawPost(plain(), [...signedHeaders(b2), ['Content-Encoding', 'identity']], Buffer.from(b2.raw))).status).toBe(200);
  });

  it('a failure AFTER the receipt insert (at commit) rolls the receipt back with the apply: the retry is processed', async () => {
    const b = fresh();
    const orig = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, o?: unknown) =>
      orig(async (tx) => {
        await fn(tx);
        throw new Error('commit failed');
      }, o)) as never);
    const failed = await rawPost(plain(), signedHeaders(b), Buffer.from(b.raw));
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect(await prisma.cmsEventReceipt.findUnique({ where: { eventId: b.eventId } })).toBeNull();
    expect(await account(b.accountId)).toBeNull();
    // The CMS's retry (a new signed timestamp) is applied, not answered as a duplicate.
    const s = signCmsWebhook(SECRET, b.raw, new Date(Date.now() + 1000));
    const retry = await rawPost(plain(), [['Content-Type', 'application/json'], ['X-CMS-Event-Id', b.eventId], ['X-CMS-Timestamp', s['X-CMS-Timestamp']], ['X-CMS-Signature', s['X-CMS-Signature']]], Buffer.from(b.raw));
    expect(retry.status).toBe(200);
    expect(await account(b.accountId)).toMatchObject({ status: 'active' });
  });

  it('erasure:true on a live (non-deletion) signed event → 422, nothing applied', async () => {
    const b = fresh({ erasure: true });
    const res = await request(plain()).post(CMS_WEBHOOK_PATH).set({ 'Content-Type': 'application/json', 'X-CMS-Event-Id': b.eventId, ...signCmsWebhook(SECRET, b.raw) }).send(b.raw);
    expect(res.status).toBe(422);
    expect(await account(b.accountId)).toBeNull();
  });

  it('a direct caller forging an X-Forwarded-For chain that ends in a Cloudflare edge (Railway appends the real peer) → 401', async () => {
    const b = fresh();
    // Railway appends the real peer (203.0.113.9) AFTER whatever the client sent.
    const res = await request(proxied())
      .post(CMS_WEBHOOK_PATH)
      .set({ 'Content-Type': 'application/json', 'X-CMS-Event-Id': b.eventId, ...signCmsWebhook(SECRET, b.raw) })
      .set('X-Forwarded-For', `${CMS_IP}, ${CF_EDGE}, 203.0.113.9`)
      .set('CF-Connecting-IP', CMS_IP)
      .send(b.raw);
    expect(res.status).toBe(401);
  });

  it('two CF-Connecting-IP headers behind a Cloudflare peer → 401 (never the first or the last)', async () => {
    const b = fresh();
    const two = await rawPost(proxied(), [...signedHeaders(b), ['X-Forwarded-For', CF_EDGE], ['CF-Connecting-IP', CMS_IP], ['CF-Connecting-IP', '203.0.113.9']], Buffer.from(b.raw));
    expect(two).toEqual({ status: 401, step: 'fence' });
    const rev = await rawPost(proxied(), [...signedHeaders(b), ['X-Forwarded-For', CF_EDGE], ['CF-Connecting-IP', '203.0.113.9'], ['CF-Connecting-IP', CMS_IP]], Buffer.from(b.raw));
    expect(rev).toEqual({ status: 401, step: 'fence' });
    // Control: one header, same socket path → accepted.
    const one = await rawPost(proxied(), [...signedHeaders(b), ['X-Forwarded-For', CF_EDGE], ['CF-Connecting-IP', CMS_IP]], Buffer.from(b.raw));
    expect(one.status).toBe(200);
  });

  it('a Cloudflare IPv6 edge (2a06:98c0::/29 boundary) is trusted; just outside it is not', async () => {
    const { isCloudflareIp } = await import('../lib/clientIp');
    expect(isCloudflareIp('2a06:98c7:ffff::1')).toBe(true);
    expect(isCloudflareIp('2a06:98c8::1')).toBe(false);
    expect(isCloudflareIp('::ffff:104.16.0.1')).toBe(true);
    expect(isCloudflareIp('::ffff:6810:1')).toBe(true); // hex-mapped 104.16.0.1
    expect(isCloudflareIp('64:ff9b::6810:1')).toBe(false); // NAT64 form is NOT the IPv4 edge
  });

  it('every refusal is byte-identical (status, body, no step-revealing header)', async () => {
    const b = fresh();
    const good = signCmsWebhook(SECRET, b.raw);
    const off = createApp({ cmsEvents: { cfg: parseAudienceEnv({}), failuresPerMin: 100_000, portal: PORTAL } });
    const variants = await Promise.all([
      request(off).post(CMS_WEBHOOK_PATH).set({ 'X-CMS-Event-Id': b.eventId, ...good }).send(b.raw),
      request(plain()).post(CMS_WEBHOOK_PATH).set({ 'X-CMS-Event-Id': b.eventId }).send(b.raw),
      request(plain()).post(CMS_WEBHOOK_PATH).set({ 'X-CMS-Event-Id': b.eventId, ...good, 'X-CMS-Signature': `sha256=${'0'.repeat(64)}` }).send(b.raw),
      request(plain()).post(CMS_WEBHOOK_PATH).set({ 'X-CMS-Event-Id': `${b.eventId}z`, ...good }).send(b.raw),
    ]);
    const shapes = variants.map((r) => [r.status, r.text, r.headers['content-type'], r.headers['content-length']]);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0][0]).toBe(401);
  });
});
