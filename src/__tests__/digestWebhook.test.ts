import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun } from '../services/digest/runner';
import { alertCopy } from '../services/digest/alerts';
import { digestAttention, digestStatus } from '../services/digest/status';
import { digestHistory } from '../services/digest/screen';
import { checkWebhookLiveness, webhookHealth, WEBHOOK_SILENT_AFTER_MS } from '../services/digest/webhookLiveness';
import { escalateReason, handleMailercloudWebhook, normaliseEvent, SUPPRESSION_RANK, webhookTokenMatches } from '../services/digest/webhook';
import { istDateOf } from '../services/digest/retryPolicy';
import { FakeSender } from './digestFakeSender';

/**
 * Email digest task 8 (docs/EMAIL_DIGEST_DESIGN.md §6, §8, §9, §13 task 8):
 * the Mailercloud webhook route, EmailEvent (hashed, deduped),
 * EmailSuppression, the campaign_sent poll nudge and the liveness check.
 * Every address here is a fake on a reserved TLD; nothing is ever sent.
 */

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-webhook-';
const CAMP = `wh-test-${RUN}`; // every test campaign id starts with this
const TOKEN = randomBytes(32).toString('hex');
const OLD_TOKEN = randomBytes(32).toString('hex');
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const ADDR_LOCAL = `reader.webhook.${RUN}`;
const ADDRESS = `${ADDR_LOCAL}@example.invalid`;
const URL_OK = `/api/webhooks/mailercloud/${TOKEN}`;

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_WEBHOOKS_ENABLED: 'true',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    MAILERCLOUD_API_KEY: 'mc-fake-key-0123456789abcdef',
    MAILERCLOUD_WEBHOOK_TOKEN: TOKEN,
    ...over,
  });
}

function app(c: DigestEnv = cfg(), portal?: string, limits: { invalidPerMin?: number; validPerMin?: number } = {}) {
  return createApp({ webhooks: { cfg: c, invalidPerMin: 10_000, ...limits }, digest: { cfg: c, ...(portal ? { portal } : {}) } });
}

let n = 0;
const camp = () => `${CAMP}-${++n}`;
const addr = (tag: string) => `${ADDR_LOCAL}.${tag}@Example.INVALID`;
const norm = (a: string) => a.trim().toLowerCase();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function eventsFor(mcCampaignId: string) {
  return prisma.emailEvent.findMany({ where: { mcCampaignId } });
}

/** A run with one SCHEDULED/SENT variant, written directly (no provider). */
async function runWithSend(over: Partial<{ state: 'SCHEDULED' | 'SENT'; sentConfirmedAt: Date | null; nextAttemptAt: Date | null }> = {}) {
  const now = new Date();
  const portal = `${PORTAL_PREFIX}${RUN}-${++n}`;
  const runDate = istDateOf(now);
  const mcCampaignId = camp();
  const run = await prisma.digestRun.create({
    data: { portal, runDate, windowStart: new Date(now.getTime() - 86_400_000), build: 'BUILT', builtAt: now },
  });
  const send = await prisma.digestSend.create({
    data: {
      runId: run.id,
      audience: 'FREE',
      state: over.state ?? 'SENT',
      subject: 's',
      preheader: 'p',
      htmlBytes: 1,
      mcCampaignName: `TS-DIGEST-TEST-${run.id}`,
      mcCampaignId,
      sendAfter: now,
      scheduledAt: new Date(now.getTime() - 4 * 3_600_000),
      sentConfirmedAt: over.sentConfirmedAt === undefined ? new Date(now.getTime() - 3 * 3_600_000) : over.sentConfirmedAt,
      sentVia: (over.state ?? 'SENT') === 'SENT' ? 'status_poll' : null,
      nextAttemptAt: over.nextAttemptAt ?? null,
    },
  });
  return { run, send, mcCampaignId, portal };
}

// NO_ADDRESS rows carry no campaign or address to scope by; on the local dev DB
// only this file writes them, so they are cleared before and after.
beforeAll(async () => {
  await prisma.emailEvent.deleteMany({ where: { type: 'NO_ADDRESS' } });
});

afterAll(async () => {
  await prisma.emailEvent.deleteMany({ where: { type: 'NO_ADDRESS' } });
  await prisma.emailEvent.deleteMany({ where: { mcCampaignId: { startsWith: CAMP } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { startsWith: ADDR_LOCAL } } });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.$disconnect();
});

describe('route gate: 404 unless enabled + right token', () => {
  const body = () => ({ event: 'unsubscribe', email: addr('gate'), campaign_id: camp() });

  it('flag off → 404, nothing stored', async () => {
    const b = body();
    const res = await request(app(cfg({ DIGEST_WEBHOOKS_ENABLED: 'false' }))).post(URL_OK).send(b);
    expect(res.status).toBe(404);
    expect(await eventsFor(b.campaign_id)).toHaveLength(0);
  });

  it('token unset or too short → 404 for every token', async () => {
    for (const t of ['', 'short-token']) {
      const b = body();
      const a = app(cfg({ MAILERCLOUD_WEBHOOK_TOKEN: t }));
      expect((await request(a).post(`/api/webhooks/mailercloud/${t || 'x'}`).send(b)).status).toBe(404);
      expect((await request(a).post(URL_OK).send(b)).status).toBe(404);
      expect(await eventsFor(b.campaign_id)).toHaveLength(0);
    }
  });

  it('wrong token (same length or not) → 404 that never echoes the path', async () => {
    const b = body();
    const wrong = randomBytes(32).toString('hex');
    for (const t of [wrong, `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const res = await request(app()).post(`/api/webhooks/mailercloud/${t}`).send(b);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(t);
    }
    expect(await eventsFor(b.campaign_id)).toHaveLength(0);
  });

  it('right token → 200; other methods/paths → 404', async () => {
    const b = body();
    expect((await request(app()).post(URL_OK).send(b)).status).toBe(200);
    expect(await eventsFor(b.campaign_id)).toHaveLength(1);
    expect((await request(app()).get(URL_OK)).status).toBe(404);
    expect((await request(app()).post('/api/webhooks/other')).status).toBe(404);
  });

  it('the previous token is accepted during a rotation, and only when set', async () => {
    const rotating = cfg({ MAILERCLOUD_WEBHOOK_TOKEN_PREVIOUS: OLD_TOKEN });
    expect(webhookTokenMatches(OLD_TOKEN, rotating)).toBe(true);
    expect(webhookTokenMatches(TOKEN, rotating)).toBe(true);
    expect(webhookTokenMatches(OLD_TOKEN, cfg())).toBe(false);
    const b = body();
    expect((await request(app(rotating)).post(`/api/webhooks/mailercloud/${OLD_TOKEN}`).send(b)).status).toBe(200);
  });
});

describe('storing events', () => {
  it('a replayed payload is counted once (event + suppression)', async () => {
    const b = { event: 'unsubscribe', email: addr('replay'), campaign_id: camp(), ts_event: 1761200000 };
    const first = await request(app()).post(URL_OK).send(b);
    const again = await request(app()).post(URL_OK).send(b);
    const supp0 = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(b.email) } });
    // A retry with a new delivery time, in a field the normaliser actually reads (ts_event).
    const third = await request(app()).post(URL_OK).send({ ...b, ts: 1761209999, ts_event: 1761209999 });
    expect(first.body).toMatchObject({ ok: true, stored: 1, duplicates: 0 });
    expect(again.body).toMatchObject({ ok: true, stored: 0, duplicates: 1 });
    expect(third.body).toMatchObject({ stored: 0, duplicates: 1 });
    expect(await eventsFor(b.campaign_id)).toHaveLength(1);
    expect(await prisma.emailSuppression.count({ where: { email: norm(b.email) } })).toBe(1);
    // A replay re-asserts the suppression row but does not move lastSeenAt.
    const supp1 = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(b.email) } });
    expect(supp1.lastSeenAt.getTime()).toBe(supp0.lastSeenAt.getTime());
  });

  it('campaign events count once per campaign, whatever reader fields ride along', async () => {
    const id = camp();
    await request(app()).post(URL_OK).send({ event: 'campaign_sent', campaign_id: id, email: addr('cs1') });
    const again = await request(app()).post(URL_OK).send({ event: 'campaign_sent', campaign_id: id, email: addr('cs2') });
    expect(again.body).toMatchObject({ stored: 0, duplicates: 1 });
    expect(await eventsFor(id)).toHaveLength(1);
  });

  it('a NUL byte never turns a delivery into a permanent 500', async () => {
    const id = camp();
    const nulAddr = await request(app()).post(URL_OK).send({ event: 'unsubscribe', email: `${ADDR_LOCAL}.nul\u0000@example.invalid`, campaign_id: id });
    expect(nulAddr.status).toBe(200);
    expect(nulAddr.body).toMatchObject({ stored: 0, ignored: 1 });
    const nulText = await request(app())
      .post(URL_OK)
      .send({ event: 'campaign_error', campaign_id: `${id}\u0000`, description: 'quota\u0000 exceeded' });
    expect(nulText.status).toBe(200);
    const [ev] = await eventsFor(id);
    expect(ev.type).toBe('CAMPAIGN_ERROR');
    expect((ev.meta as { error: string }).error).toBe('quota exceeded');
  });

  it('concurrent duplicates still insert once', async () => {
    const b = { event: 'spam', email: addr('race'), campaign_id: camp() };
    const results = await Promise.all([1, 2, 3].map(() => request(app()).post(URL_OK).send(b)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await eventsFor(b.campaign_id)).toHaveLength(1);
    expect(await prisma.emailSuppression.count({ where: { email: norm(b.email) } })).toBe(1);
  });

  it('no address anywhere in the raw EmailEvent row — only its sha256', async () => {
    const id = camp();
    const email = `  ${ADDRESS.toUpperCase()} `;
    await request(app()).post(URL_OK).send({
      event: 'hard_bounce',
      email,
      campaign_id: id,
      description: `550 mailbox ${ADDRESS} does not exist`,
      contact: { email: ADDRESS, name: 'Reader' },
    });
    const rows = await prisma.$queryRaw<{ j: string }[]>`
      SELECT row_to_json(e)::text AS j FROM "EmailEvent" e WHERE "mcCampaignId" = ${id}`;
    expect(rows).toHaveLength(1);
    const raw = rows[0].j.toLowerCase();
    expect(raw).not.toContain(ADDR_LOCAL.toLowerCase());
    expect(raw).not.toContain('example.invalid');
    expect(raw).not.toContain('550 mailbox'); // a bounce's text is not kept at all
    const ev = (await eventsFor(id))[0];
    expect(ev.emailHash).toBe(sha(ADDRESS.toLowerCase()));
    expect(ev.type).toBe('HARD_BOUNCE');
  });

  it('campaign_error keeps a redacted error text, never an address', async () => {
    const id = camp();
    await request(app()).post(URL_OK).send({ event: 'campaign_error', campaign_id: id, description: `quota hit sending to ${ADDRESS}` });
    const [ev] = await eventsFor(id);
    expect(ev.type).toBe('CAMPAIGN_ERROR');
    expect(JSON.stringify(ev.meta)).toContain('[email]');
    expect(JSON.stringify(ev.meta)).not.toContain(ADDR_LOCAL);
    expect(ev.emailHash).toBeNull();
  });

  it('suppression: one row per normalised address; a hard bounce upgrades an unsubscribe, lastSeenAt moves', async () => {
    const raw = addr('supp');
    await request(app()).post(URL_OK).send({ event: 'unsubscribe', email: raw, campaign_id: camp() });
    const a = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(raw) } });
    expect(a).toMatchObject({ reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' });
    await new Promise((r) => setTimeout(r, 15));
    await request(app()).post(URL_OK).send({ event: 'hard_bounce', email: raw.toUpperCase(), campaign_id: camp() });
    const b = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(raw) } });
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('HARD_BOUNCE');
    expect(b.lastSeenAt.getTime()).toBeGreaterThan(a.lastSeenAt.getTime());
    expect(b.firstSeenAt.getTime()).toBe(a.firstSeenAt.getTime());
  });

  it('opened / clicked / unknown types → 200 and nothing stored', async () => {
    for (const event of ['campaign_opened', 'campaign_clicked', 'soft_bounce', 'something_new', '']) {
      const id = camp();
      const res = await request(app()).post(URL_OK).send({ event, email: addr('ign'), campaign_id: id });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ stored: 0, ignored: 1 });
      expect(await eventsFor(id)).toHaveLength(0);
    }
    expect(await prisma.emailSuppression.count({ where: { email: norm(addr('ign')) } })).toBe(0);
    // An empty body (e.g. a provider "test" ping) is acknowledged too.
    expect((await request(app()).post(URL_OK)).status).toBe(200);
  });

  it('events missing what they need are ignored, not stored', () => {
    expect(normaliseEvent({ event: 'unsubscribe', campaign_id: 'x' })).toMatchObject({ ignored: true, reason: 'no_address' });
    expect(normaliseEvent({ event: 'unsubscribe', email: 'not-an-address', campaign_id: 'x' })).toMatchObject({ ignored: true, reason: 'no_address' });
    expect(normaliseEvent({ event: 'campaign_sent' })).toMatchObject({ ignored: true, reason: 'no_campaign' });
  });

  it('malformed body → 400 that echoes nothing', async () => {
    const secret = `not json ${ADDRESS}`;
    const bad = await request(app()).post(URL_OK).set('Content-Type', 'application/json').send(secret);
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain(ADDR_LOCAL);
    for (const v of ['null', '"just a string"', '42']) {
      const res = await request(app()).post(URL_OK).set('Content-Type', 'application/json').send(v);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'malformed' });
    }
  });

  it('accepts an array, an {events:[…]} envelope, nested fields and a form post', async () => {
    const [a, b, c, d] = [camp(), camp(), camp(), camp()];
    const r1 = await request(app())
      .post(URL_OK)
      .send([
        { event: 'unsubscribe', email: addr('arr1'), campaign_id: a },
        { event_type: 'Spam Complaint', data: { email_address: addr('arr2') }, campaign: { id: b, name: 'Weekly' } },
      ]);
    expect(r1.body).toMatchObject({ stored: 2 });
    const r2 = await request(app()).post(URL_OK).send({ events: [{ type: 'campaign_sent', campaignId: c }] });
    expect(r2.body).toMatchObject({ stored: 1 });
    const r3 = await request(app()).post(URL_OK).type('form').send({ event: 'unsubscribe', email: addr('form'), campaign_id: d });
    expect(r3.body).toMatchObject({ stored: 1 });
    expect((await eventsFor(b))[0].type).toBe('SPAM');
    expect((await eventsFor(c))[0].type).toBe('CAMPAIGN_SENT');
    expect((await eventsFor(d))[0].type).toBe('UNSUBSCRIBE');
  });
});

describe('our digest campaigns', () => {
  it('links sendId; campaign_sent only brings the poll forward — state is unchanged', async () => {
    const later = new Date(Date.now() + 50 * 60_000);
    const { send, mcCampaignId } = await runWithSend({ state: 'SCHEDULED', sentConfirmedAt: null, nextAttemptAt: later });
    const before = Date.now();
    await request(app()).post(URL_OK).send({ event: 'campaign_sent', campaign_id: mcCampaignId });
    const [ev] = await eventsFor(mcCampaignId);
    expect(ev.sendId).toBe(send.id);
    const s = await prisma.digestSend.findUniqueOrThrow({ where: { id: send.id } });
    expect(s.state).toBe('SCHEDULED');
    expect(s.sentVia).toBeNull();
    expect(s.sentConfirmedAt).toBeNull();
    expect(s.nextAttemptAt!.getTime()).toBeLessThan(later.getTime());
    expect(s.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a campaign_sent for a SENT variant changes nothing on it', async () => {
    const { send, mcCampaignId } = await runWithSend();
    const before = await prisma.digestSend.findUniqueOrThrow({ where: { id: send.id } });
    await request(app()).post(URL_OK).send({ event: 'campaign_sent', campaign_name: before.mcCampaignName });
    const after = await prisma.digestSend.findUniqueOrThrow({ where: { id: send.id } });
    expect(after).toEqual(before);
    // linked by name when the id is absent; stored with no campaign id → clean up via sendId
    const ev = await prisma.emailEvent.findFirst({ where: { sendId: send.id } });
    expect(ev?.type).toBe('CAMPAIGN_SENT');
    await prisma.emailEvent.deleteMany({ where: { sendId: send.id } });
    expect(mcCampaignId).toBeTruthy();
  });

  it('history: "—" (null) for a send with no proof the webhook was receiving; 0 once it is proven', async () => {
    const { send, mcCampaignId, portal } = await runWithSend();
    const none = await digestHistory({ portal, cfg: cfg() });
    expect(none[0].variants[0]).toMatchObject({ unsubscribes: null, bounces: null, complaints: null });
    // A reader event alone is not proof (it could arrive long after the webhook was registered).
    await request(app()).post(URL_OK).send({ event: 'unsubscribe', email: addr('nv1'), campaign_id: mcCampaignId });
    expect((await digestHistory({ portal, cfg: cfg() }))[0].variants[0].unsubscribes).toBeNull();
    // campaign_sent for this campaign proves coverage: real counts, zeros included.
    await request(app()).post(URL_OK).send({ event: 'campaign_sent', campaign_id: mcCampaignId });
    expect((await digestHistory({ portal, cfg: cfg() }))[0].variants[0]).toMatchObject({ unsubscribes: 1, bounces: 0, complaints: 0 });
    expect(send.id).toBeTruthy();
  });

  it('history: folded counts alone also prove coverage', async () => {
    const { send, portal } = await runWithSend();
    await prisma.digestSend.update({ where: { id: send.id }, data: { rolledBounce: 3 } });
    expect((await digestHistory({ portal, cfg: cfg() }))[0].variants[0]).toMatchObject({ unsubscribes: 0, bounces: 3, complaints: 0 });
  });

  it('history shows rolled + live unsubscribes/bounces/complaints only while webhooks are on', async () => {
    const { send, mcCampaignId, portal } = await runWithSend();
    await prisma.digestSend.update({ where: { id: send.id }, data: { rolledUnsub: 2, rolledSpam: 1, rolledBounce: 1 } });
    await request(app()).post(URL_OK).send([
      { event: 'unsubscribe', email: addr('h1'), campaign_id: mcCampaignId },
      { event: 'unsubscribe', email: addr('h2'), campaign_id: mcCampaignId },
      { event: 'spam', email: addr('h1'), campaign_id: mcCampaignId },
      { event: 'hard_bounce', email: addr('h3'), campaign_id: mcCampaignId },
    ]);
    const on = await digestHistory({ portal, cfg: cfg() });
    expect(on[0].variants[0]).toMatchObject({ unsubscribes: 4, bounces: 2, complaints: 2 });
    const off = await digestHistory({ portal, cfg: cfg({ DIGEST_WEBHOOKS_ENABLED: 'false' }) });
    expect(off[0].variants[0]).toMatchObject({ unsubscribes: null, bounces: null, complaints: null });
  });
});

describe('liveness: SENT by poll, no campaign webhook within 2 h', () => {
  const marker = async (runId: string) =>
    ((await prisma.digestRun.findUniqueOrThrow({ where: { id: runId } })).alerts as Record<string, { raisedAt: string }>)
      .webhook_silent;

  it('raises webhook_silent once when silent for ≥ 2 h', async () => {
    const { run } = await runWithSend();
    const now = new Date();
    expect(await checkWebhookLiveness(run.id, { now, cfg: cfg() })).toEqual(['FREE']);
    const first = await marker(run.id);
    expect(first).toBeDefined();
    await checkWebhookLiveness(run.id, { now: new Date(now.getTime() + 60_000), cfg: cfg() });
    expect((await marker(run.id)).raisedAt).toBe(first.raisedAt);
  });

  it('does not raise when the webhook came, when < 2 h, or when webhooks/digest are off', async () => {
    const heard = await runWithSend();
    await request(app()).post(URL_OK).send({ event: 'campaign_sent', campaign_id: heard.mcCampaignId });
    expect(await checkWebhookLiveness(heard.run.id, { cfg: cfg() })).toEqual([]);
    expect(await marker(heard.run.id)).toBeUndefined();

    const fresh = await runWithSend({ sentConfirmedAt: new Date(Date.now() - WEBHOOK_SILENT_AFTER_MS + 60_000) });
    expect(await checkWebhookLiveness(fresh.run.id, { cfg: cfg() })).toEqual([]);
    expect(await marker(fresh.run.id)).toBeUndefined();

    const off = await runWithSend();
    expect(await checkWebhookLiveness(off.run.id, { cfg: cfg({ DIGEST_WEBHOOKS_ENABLED: 'false' }) })).toEqual([]);
    expect(await checkWebhookLiveness(off.run.id, { cfg: cfg({ DIGEST_ENABLED: 'false' }) })).toEqual([]);
    expect(await marker(off.run.id)).toBeUndefined();

    const scheduled = await runWithSend({ state: 'SCHEDULED', sentConfirmedAt: null });
    expect(await checkWebhookLiveness(scheduled.run.id, { cfg: cfg() })).toEqual([]);
  });

  it('a campaign_sent linked by our campaign NAME (no id) counts as heard', async () => {
    const { run, send, portal } = await runWithSend();
    await request(app()).post(URL_OK).send({ event: 'campaign_sent', campaign_name: send.mcCampaignName });
    expect(await checkWebhookLiveness(run.id, { cfg: cfg() })).toEqual([]);
    expect(await marker(run.id)).toBeUndefined();
    expect((await webhookHealth({ portal, cfg: cfg() })).alive).toBe(true);
    await prisma.emailEvent.deleteMany({ where: { sendId: send.id } });
  });

  it('advanceRun runs the check (wired into the door), touching no provider', async () => {
    const { run } = await runWithSend();
    const sender = new FakeSender();
    const c = cfg({ DIGEST_CUTOFF: '23:59', DIGEST_SEND_AT: '07:30' });
    await advanceRun(run.id, 'cron', { sender, cfg: c, now: new Date(), alerts: false });
    expect(await marker(run.id)).toBeDefined();
    expect(sender.calls).toEqual([]);
  });

  it('status: webhook.alive false + banner while silent; true once a campaign_sent arrives', async () => {
    const { mcCampaignId, portal } = await runWithSend();
    const a = app(cfg(), portal);
    const silent = await request(a).get('/api/digest/status').set('Authorization', AUTH);
    expect(silent.status).toBe(200);
    expect(silent.body.webhook).toMatchObject({ enabled: true, alive: false });
    expect(silent.body.config.webhooksEnabled).toBe(true);
    expect(silent.body.attention?.code).toBe('webhook_silent');

    await request(a).post(URL_OK).send({ event: 'campaign_sent', campaign_id: mcCampaignId });
    const alive = await request(a).get('/api/digest/status').set('Authorization', AUTH);
    expect(alive.body.webhook.alive).toBe(true);
    expect(alive.body.webhook.lastEventAt).not.toBeNull();
    expect(alive.body.attention?.code).not.toBe('webhook_silent');

    const off = await webhookHealth({ portal, cfg: cfg({ DIGEST_WEBHOOKS_ENABLED: 'false' }) });
    expect(off).toEqual({ enabled: false, alive: null, lastEventAt: null, lastNoAddressAt: null, noAddressCount: 0 });
  });

  it('banner and alert copy', () => {
    const c = cfg();
    const base = { enabled: true, now: new Date(), cfg: c, run: null, sends: [] };
    expect(digestAttention({ ...base, webhookSilent: true })?.code).toBe('webhook_silent');
    expect(digestAttention({ ...base, webhookSilent: false })).toBeNull();
    expect(digestAttention({ ...base, enabled: false, webhookSilent: true })).toBeNull();
    expect(alertCopy('webhook_silent', {}, c).short).toMatch(/webhook/i);
  });
});

describe('QA follow-ups', () => {
  it('rate limit: a valid token is never limited by the failed-token budget', async () => {
    const a = app(cfg(), undefined, { invalidPerMin: 3 });
    for (let i = 0; i < 8; i++) {
      const res = await request(a).post(URL_OK).send({ event: 'campaign_opened' });
      expect(res.status).toBe(200);
    }
  });

  it('rate limit: wrong tokens get 404, then 429 — never the path', async () => {
    const a = app(cfg(), undefined, { invalidPerMin: 3 });
    const wrong = randomBytes(32).toString('hex');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(a).post(`/api/webhooks/mailercloud/${wrong}`).send({ event: 'campaign_opened' });
      codes.push(res.status);
      expect(res.text).not.toContain(wrong);
    }
    expect(codes.slice(0, 3)).toEqual([404, 404, 404]);
    expect(codes.slice(3)).toEqual([429, 429, 429]);
    // ...and Mailercloud on the same IP is still let through.
    expect((await request(a).post(URL_OK).send({ event: 'campaign_opened' })).status).toBe(200);
  });

  it('a body-limit-sized batch (~250 KB) is accepted and stored, quickly', async () => {
    const id = `${CAMP}-big`;
    const events: object[] = [];
    let i = 0;
    while (JSON.stringify(events).length < 250_000) {
      events.push({ event: 'unsubscribe', email: `${ADDR_LOCAL}.big${i++}@example.invalid`, campaign_id: id, ts_event: 1761200000 });
    }
    expect(events.length).toBeGreaterThan(1500);
    const t0 = Date.now();
    const res = await request(app()).post(URL_OK).send(events);
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stored: events.length, duplicates: 0 });
    expect(ms).toBeLessThan(10_000);
    expect(await prisma.emailEvent.count({ where: { mcCampaignId: id } })).toBe(events.length);
    expect(await prisma.emailSuppression.count({ where: { email: { startsWith: `${ADDR_LOCAL}.big` } } })).toBe(events.length);
    // The replay is all duplicates.
    expect((await request(app()).post(URL_OK).send(events)).body).toMatchObject({ stored: 0, duplicates: events.length });
  });

  it('over the body limit → 413, nothing echoed', async () => {
    const big = JSON.stringify([{ event: 'unsubscribe', email: ADDRESS, pad: 'x'.repeat(300_000) }]);
    const res = await request(app()).post(URL_OK).set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(413);
    expect(res.text).not.toContain(ADDR_LOCAL);
  });

  it('opt-outs without a readable address are counted, logged and surfaced — no PII', async () => {
    await prisma.emailEvent.deleteMany({ where: { type: 'NO_ADDRESS' } }); // earlier tests made some
    const before = logs.length;
    const res = await request(app())
      .post(URL_OK)
      .send([
        { event: 'unsubscribe', campaign_id: camp() },
        { event: 'hard_bounce', email: 'not-an-address', campaign_id: camp() },
        { event: 'campaign_opened', email: addr('na') },
        { event: 'campaign_sent' },
      ]);
    expect(res.body).toMatchObject({ stored: 0, ignored: 4, noAddress: 2 });
    const line = logs.slice(before).join('\n');
    expect(line).toContain('ignored_type=1 no_campaign=1 no_address=2');
    expect(line).not.toContain('not-an-address');
    expect(line.toLowerCase()).not.toContain(ADDR_LOCAL.toLowerCase());
    await request(app()).post(URL_OK).send({ event: 'unsubscribe', campaign_id: camp() });

    const rows = await prisma.$queryRaw<{ j: string }[]>`SELECT row_to_json(e)::text AS j FROM "EmailEvent" e WHERE type = 'NO_ADDRESS'`;
    expect(rows.length).toBe(2); // one per IST day per event name
    for (const r of rows) expect(r.j).not.toContain('not-an-address');
    const h = await webhookHealth({ portal: `${PORTAL_PREFIX}none`, cfg: cfg() });
    expect(h.lastNoAddressAt).not.toBeNull();
    expect(h.noAddressCount).toBe(3);
    const c = cfg();
    expect(digestAttention({ enabled: true, now: new Date(), cfg: c, run: null, sends: [], webhookNoAddress: 3 })?.code).toBe('webhook_no_address');
    expect(digestAttention({ enabled: true, now: new Date(), cfg: c, run: null, sends: [], webhookNoAddress: 0 })).toBeNull();
  });
});

describe('QA verification of e43217f', () => {
  it('NO_ADDRESS receivedAt is the real instant, not shifted by the DB session time zone', async () => {
    // The local dev DB runs with TimeZone=Asia/Kolkata: a raw-SQL Date bind used
    // to land +05:30 in the future (the Event-retention ::timestamp bug again).
    const now = new Date(Date.now() - 60_000);
    await handleMailercloudWebhook({ event: 'abuse', campaign_id: camp() }, { cfg: cfg(), now }); // event name used only here
    const row = await prisma.emailEvent.findFirstOrThrow({ where: { type: 'NO_ADDRESS', meta: { path: ['event'], equals: 'abuse' } } });
    expect(row.receivedAt.toISOString()).toBe(now.toISOString());
    const h = await webhookHealth({ portal: `${PORTAL_PREFIX}none`, cfg: cfg(), now: new Date() });
    expect(Date.parse(h.lastNoAddressAt!)).toBeLessThanOrEqual(Date.now()); // never in the future
  });

  it('lastSeenAt: a batch mixing a replayed and a new event for one address moves it; an all-replay batch does not', async () => {
    const a = addr('mix');
    const c1 = camp();
    const c2 = camp();
    const t0 = new Date(Date.now() - 10 * 60_000);
    const t1 = new Date(Date.now() - 5 * 60_000);
    const t2 = new Date(Date.now() - 60_000);
    await handleMailercloudWebhook({ event: 'unsubscribe', email: a, campaign_id: c1 }, { cfg: cfg(), now: t0 });
    const r = await handleMailercloudWebhook(
      [
        { event: 'unsubscribe', email: a, campaign_id: c1 }, // replay
        { event: 'hard_bounce', email: a, campaign_id: c2 }, // new
        { event: 'hard_bounce', email: a, campaign_id: c2 }, // same key twice in one batch
      ],
      { cfg: cfg(), now: t1 },
    );
    expect(r).toMatchObject({ stored: 1, duplicates: 2 });
    let s = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(a) } });
    expect(s.reason).toBe('HARD_BOUNCE');
    expect(s.firstSeenAt.getTime()).toBe(t0.getTime());
    expect(s.lastSeenAt.getTime()).toBe(t1.getTime());
    await handleMailercloudWebhook(
      [
        { event: 'unsubscribe', email: a, campaign_id: c1 },
        { event: 'hard_bounce', email: a, campaign_id: c2 },
      ],
      { cfg: cfg(), now: t2 },
    );
    s = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(a) } });
    expect(s.lastSeenAt.getTime()).toBe(t1.getTime());
  });

  it('rate limit: the valid-token ceiling 429s a valid flood, and does not spend the failed-token budget', async () => {
    const a = app(cfg(), undefined, { invalidPerMin: 2, validPerMin: 2 });
    const ok = [];
    for (let i = 0; i < 3; i++) ok.push((await request(a).post(URL_OK).send({ event: 'campaign_opened' })).status);
    expect(ok).toEqual([200, 200, 429]);
    const wrong = randomBytes(32).toString('hex');
    expect((await request(a).post(`/api/webhooks/mailercloud/${wrong}`).send({})).status).toBe(404);
  });

  it('a mid-batch store failure: 500 path, retry counts each event once, NO_ADDRESS once, poll nudge not lost', async () => {
    const later = new Date(Date.now() + 50 * 60_000);
    const { send, mcCampaignId } = await runWithSend({ state: 'SCHEDULED', sentConfirmedAt: null, nextAttemptAt: later });
    const id = `${CAMP}-chunkfail`;
    const events: object[] = [{ event: 'campaign_sent', campaign_id: mcCampaignId }, { event: 'campaign_unsubscribed', campaign_id: id }];
    for (let i = 0; i < 1200; i++) events.push({ event: 'unsubscribe', email: `${ADDR_LOCAL}.cf${i}@example.invalid`, campaign_id: id });
    const realTx = prisma.$transaction.bind(prisma);
    let calls = 0;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: Parameters<typeof prisma.$transaction>) => {
      calls++;
      if (calls === 2) return Promise.reject(new Error('simulated chunk-2 failure'));
      return (realTx as (...a: unknown[]) => unknown)(...args);
    }) as typeof prisma.$transaction);
    try {
      await expect(handleMailercloudWebhook(events, { cfg: cfg() })).rejects.toThrow('simulated');
    } finally {
      spy.mockRestore();
    }
    // Chunk 1 committed; chunk 2 did not.
    expect(await prisma.emailEvent.count({ where: { mcCampaignId: id } })).toBe(999);
    const noAddr = () =>
      prisma.emailEvent.findFirst({ where: { type: 'NO_ADDRESS', meta: { path: ['event'], equals: 'campaign_unsubscribed' } } }); // used only here
    expect(await noAddr()).toBeNull(); // counted only once the delivery is stored
    const s = await prisma.digestSend.findUniqueOrThrow({ where: { id: send.id } });
    expect(s.nextAttemptAt!.getTime()).toBeLessThan(later.getTime()); // nudged though chunk 2 failed
    expect(s.state).toBe('SCHEDULED');

    const retry = await handleMailercloudWebhook(events, { cfg: cfg() });
    expect(retry).toMatchObject({ stored: 201, duplicates: 1000 });
    expect(await prisma.emailEvent.count({ where: { mcCampaignId: id } })).toBe(1200);
    expect(await prisma.emailSuppression.count({ where: { email: { startsWith: `${ADDR_LOCAL}.cf` } } })).toBe(1200);
    expect(((await noAddr())!.meta as { count: number }).count).toBe(1);
  });
});

describe('suppression reason escalation (owner, 2026-10-23): SPAM > HARD_BOUNCE > UNSUBSCRIBE, never down', () => {
  const reasonOf = async (a: string) => (await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(a) } })).reason;
  const send = (events: object | object[], now = new Date()) => handleMailercloudWebhook(events, { cfg: cfg(), now });

  it('escalateReason / SUPPRESSION_RANK: the pure rule', () => {
    expect(SUPPRESSION_RANK.SPAM).toBeGreaterThan(SUPPRESSION_RANK.HARD_BOUNCE);
    expect(SUPPRESSION_RANK.HARD_BOUNCE).toBeGreaterThan(SUPPRESSION_RANK.UNSUBSCRIBE);
    expect(SUPPRESSION_RANK.MANUAL).toBeGreaterThan(SUPPRESSION_RANK.SPAM);
    expect(escalateReason('UNSUBSCRIBE', 'HARD_BOUNCE')).toBe('HARD_BOUNCE');
    expect(escalateReason('HARD_BOUNCE', 'SPAM')).toBe('SPAM');
    expect(escalateReason('SPAM', 'UNSUBSCRIBE')).toBe('SPAM');
    expect(escalateReason('SPAM', 'HARD_BOUNCE')).toBe('SPAM');
    expect(escalateReason('MANUAL', 'SPAM')).toBe('MANUAL');
  });

  it('upgrade: unsubscribe → hard bounce → spam, each a later delivery', async () => {
    const a = addr('esc-up');
    await send({ event: 'unsubscribe', email: a, campaign_id: camp() });
    expect(await reasonOf(a)).toBe('UNSUBSCRIBE');
    await send({ event: 'hard_bounce', email: a, campaign_id: camp() });
    expect(await reasonOf(a)).toBe('HARD_BOUNCE');
    await send({ event: 'spam', email: a, campaign_id: camp() });
    expect(await reasonOf(a)).toBe('SPAM');
  });

  it('never downgrade: spam then hard bounce then unsubscribe stays SPAM (lastSeenAt still moves)', async () => {
    const a = addr('esc-down');
    const t0 = new Date(Date.now() - 30 * 60_000);
    const t1 = new Date(Date.now() - 20 * 60_000);
    const t2 = new Date(Date.now() - 10 * 60_000);
    await send({ event: 'spam', email: a, campaign_id: camp() }, t0);
    await send({ event: 'hard_bounce', email: a, campaign_id: camp() }, t1);
    expect(await reasonOf(a)).toBe('SPAM');
    await send({ event: 'unsubscribe', email: a, campaign_id: camp() }, t2);
    const s = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(a) } });
    expect(s.reason).toBe('SPAM');
    expect(s.lastSeenAt.getTime()).toBe(t2.getTime());
    expect(s.firstSeenAt.getTime()).toBe(t0.getTime());
    // and a hard bounce is not downgraded by an unsubscribe either
    const b = addr('esc-down2');
    await send({ event: 'hard_bounce', email: b, campaign_id: camp() });
    await send({ event: 'unsubscribe', email: b, campaign_id: camp() });
    expect(await reasonOf(b)).toBe('HARD_BOUNCE');
  });

  it('one batch with the same address twice, either order: the higher reason wins, one row', async () => {
    const a = addr('esc-batch1');
    const b = addr('esc-batch2');
    const r = await send([
      { event: 'unsubscribe', email: a, campaign_id: camp() },
      { event: 'spam', email: a.toUpperCase(), campaign_id: camp() },
      { event: 'hard_bounce', email: b, campaign_id: camp() },
      { event: 'unsubscribe', email: b, campaign_id: camp() },
    ]);
    expect(r).toMatchObject({ stored: 4, duplicates: 0 });
    expect(await reasonOf(a)).toBe('SPAM');
    expect(await reasonOf(b)).toBe('HARD_BOUNCE');
    expect(await prisma.emailSuppression.count({ where: { email: { in: [norm(a), norm(b)] } } })).toBe(2);
  });

  it('existing row + a batch holding a lower and a higher event: upgrades once', async () => {
    const a = addr('esc-batch3');
    await send({ event: 'hard_bounce', email: a, campaign_id: camp() });
    await send([
      { event: 'unsubscribe', email: a, campaign_id: camp() },
      { event: 'spam', email: a, campaign_id: camp() },
    ]);
    expect(await reasonOf(a)).toBe('SPAM');
  });

  it('replay-safe: replaying the lower event after an upgrade changes nothing; replaying the higher keeps it', async () => {
    const a = addr('esc-replay');
    const unsub = { event: 'unsubscribe', email: a, campaign_id: camp() };
    const bounce = { event: 'hard_bounce', email: a, campaign_id: camp() };
    const t0 = new Date(Date.now() - 30 * 60_000);
    const t1 = new Date(Date.now() - 20 * 60_000);
    await send(unsub, t0);
    await send(bounce, t1);
    const before = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(a) } });
    expect(before.reason).toBe('HARD_BOUNCE');
    const r = await send([unsub, bounce, unsub], new Date());
    expect(r).toMatchObject({ stored: 0, duplicates: 3 });
    const after = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(a) } });
    expect(after).toEqual(before);
  });

  it('MANUAL is never rewritten by a webhook', async () => {
    const a = addr('esc-manual');
    await prisma.emailSuppression.create({ data: { email: norm(a), reason: 'MANUAL', source: 'manual' } });
    await send([{ event: 'spam', email: a, campaign_id: camp() }, { event: 'hard_bounce', email: a, campaign_id: camp() }]);
    const s = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(a) } });
    expect(s).toMatchObject({ reason: 'MANUAL', source: 'manual' });
  });

  it('concurrent opposite-order deliveries still escalate without deadlock', async () => {
    const addrs = Array.from({ length: 300 }, (_, i) => `${ADDR_LOCAL}.escdl.${i}@example.invalid`);
    const a = addrs.map((email) => ({ event: 'unsubscribe', email, campaign_id: `${CAMP}-escA` }));
    const b = [...addrs].reverse().map((email) => ({ event: 'spam', email, campaign_id: `${CAMP}-escB` }));
    const rs = await Promise.allSettled([send(a), send(b)]);
    expect(rs.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await prisma.emailSuppression.findMany({ where: { email: { startsWith: `${ADDR_LOCAL}.escdl.` } } });
    expect(rows).toHaveLength(300);
    expect(new Set(rows.map((r) => r.reason))).toEqual(new Set(['SPAM']));
  });
});

describe('QA verification of e43217f: proof by campaign id, banner window, per-day count', () => {
  it('history: a campaign_sent stored with our mcCampaignId but no sendId link still proves coverage', async () => {
    const { mcCampaignId, portal } = await runWithSend();
    await prisma.emailEvent.create({
      data: { type: 'CAMPAIGN_SENT', mcCampaignId, sendId: null, dedupeKey: sha(`unlinked-${mcCampaignId}`), meta: { event: 'campaign_sent' } },
    });
    expect((await digestHistory({ portal, cfg: cfg() }))[0].variants[0]).toMatchObject({ unsubscribes: 0, bounces: 0, complaints: 0 });
  });

  it('status: webhook_no_address banner counts the latest IST day only, and clears after 24 h', async () => {
    await prisma.emailEvent.deleteMany({ where: { type: 'NO_ADDRESS' } });
    const now = new Date();
    const yesterday = new Date(now.getTime() - 26 * 3_600_000); // a different IST day
    const five = Array.from({ length: 5 }, () => ({ event: 'unsubscribed', campaign_id: camp() }));
    await handleMailercloudWebhook(five, { cfg: cfg(), now: yesterday });
    await handleMailercloudWebhook([{ event: 'abuse' }, { event: 'abuse' }], { cfg: cfg(), now });
    const portal = `${PORTAL_PREFIX}${RUN}-nobanner`;
    const h = await webhookHealth({ portal, cfg: cfg(), now });
    expect(h).toMatchObject({ lastNoAddressAt: now.toISOString(), noAddressCount: 2 });
    const on = await digestStatus({ portal, cfg: cfg(), now });
    expect(on.attention?.code).toBe('webhook_no_address');
    expect(on.attention?.headline).toMatch(/^2 /);
    const later = await digestStatus({ portal, cfg: cfg(), now: new Date(now.getTime() + 25 * 3_600_000) });
    expect(later.attention).toBeNull();
    expect(later.webhook.lastNoAddressAt).toBe(now.toISOString()); // still reported, just no banner
    const off = await digestStatus({ portal, cfg: cfg({ DIGEST_WEBHOOKS_ENABLED: 'false' }), now });
    expect(off.attention).toBeNull();
  });
});

describe('QA verification of e43217f: concurrent batches', () => {
  it('two concurrent deliveries sharing addresses in opposite order both store (no deadlock → no 500)', async () => {
    for (let round = 0; round < 3; round++) {
      const addrs = Array.from({ length: 500 }, (_, i) => `${ADDR_LOCAL}.dl${round}.${i}@example.invalid`);
      const a = addrs.map((email) => ({ event: 'unsubscribe', email, campaign_id: `${CAMP}-dlA${round}` }));
      const b = [...addrs].reverse().map((email) => ({ event: 'hard_bounce', email, campaign_id: `${CAMP}-dlB${round}` }));
      const rs = await Promise.allSettled([handleMailercloudWebhook(a, { cfg: cfg() }), handleMailercloudWebhook(b, { cfg: cfg() })]);
      expect(rs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await prisma.emailSuppression.count({ where: { email: { startsWith: `${ADDR_LOCAL}.dl${round}.` } } })).toBe(500);
    }
  });
});

describe('logs', () => {
  it('no address and no token in anything logged during this file', () => {
    const all = logs.join('\n').toLowerCase();
    expect(all).toContain('[digest-webhook]');
    expect(all).not.toContain(ADDR_LOCAL.toLowerCase());
    expect(all).not.toContain('example.invalid');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(OLD_TOKEN);
  });
});
