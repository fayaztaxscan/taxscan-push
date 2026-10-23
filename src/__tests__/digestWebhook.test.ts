import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun } from '../services/digest/runner';
import { alertCopy } from '../services/digest/alerts';
import { digestAttention } from '../services/digest/status';
import { digestHistory } from '../services/digest/screen';
import { checkWebhookLiveness, webhookHealth, WEBHOOK_SILENT_AFTER_MS } from '../services/digest/webhookLiveness';
import { normaliseEvent, webhookTokenMatches } from '../services/digest/webhook';
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

function app(c: DigestEnv = cfg(), portal?: string) {
  return createApp({ webhooks: { cfg: c, perMin: 10_000 }, digest: { cfg: c, ...(portal ? { portal } : {}) } });
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

afterAll(async () => {
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

  it('suppression: one row per normalised address; first reason kept, lastSeenAt moves', async () => {
    const raw = addr('supp');
    await request(app()).post(URL_OK).send({ event: 'unsubscribe', email: raw, campaign_id: camp() });
    const a = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(raw) } });
    expect(a).toMatchObject({ reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' });
    await new Promise((r) => setTimeout(r, 15));
    await request(app()).post(URL_OK).send({ event: 'hard_bounce', email: raw.toUpperCase(), campaign_id: camp() });
    const b = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: norm(raw) } });
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('UNSUBSCRIBE');
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

  it('history shows rolled + live unsubscribes/complaints only while webhooks are on', async () => {
    const { send, mcCampaignId, portal } = await runWithSend();
    await prisma.digestSend.update({ where: { id: send.id }, data: { rolledUnsub: 2, rolledSpam: 1 } });
    await request(app()).post(URL_OK).send([
      { event: 'unsubscribe', email: addr('h1'), campaign_id: mcCampaignId },
      { event: 'unsubscribe', email: addr('h2'), campaign_id: mcCampaignId },
      { event: 'spam', email: addr('h1'), campaign_id: mcCampaignId },
      { event: 'hard_bounce', email: addr('h3'), campaign_id: mcCampaignId },
    ]);
    const on = await digestHistory({ portal, cfg: cfg() });
    expect(on[0].variants[0]).toMatchObject({ unsubscribes: 4, complaints: 2 });
    const off = await digestHistory({ portal, cfg: cfg({ DIGEST_WEBHOOKS_ENABLED: 'false' }) });
    expect(off[0].variants[0]).toMatchObject({ unsubscribes: null, complaints: null });
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
    expect(off).toEqual({ enabled: false, alive: null, lastEventAt: null });
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
