import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseDigestEnv } from '../lib/env';
import { MailercloudSender, createMailercloudSender, type MailercloudOptions } from '../services/digest/mailercloud';
import { SenderError, redactError, type DraftInput } from '../services/digest/sender';
import { FakeMailercloud } from './digestMailercloudFake';

/**
 * Email digest task 2 (docs/EMAIL_DIGEST_DESIGN.md §4, §8, §13): the
 * Mailercloud client against a local fake HTTP server. No real Mailercloud
 * call, no real key: KEY below is a made-up value long enough for the
 * redactor to recognise.
 */

const KEY = 'mc-test-key-0123456789abcdef';
const SENDER = 'digest@news.example.com';
const REPLY = 'desk@news.example.com';

let fake: FakeMailercloud;
let sleeps: number[];

function client(over: Partial<MailercloudOptions> = {}): MailercloudSender {
  return new MailercloudSender({
    apiKey: KEY,
    senderName: 'Taxscan Digest',
    senderEmail: SENDER,
    replyEmail: REPLY,
    baseV1: fake.base.v1,
    baseV2: fake.base.v2,
    timeoutMs: 300,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...over,
  });
}

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  name: 'TS-DIGEST-2026-10-23-FREE-run1',
  audience: 'FREE',
  subject: 'Lead headline',
  preheader: 'Plus 7 more: second headline',
  html: '<html><body>digest</body></html>',
  text: 'digest',
  target: { listIds: ['L1'], segmentIds: ['S1'], tagIds: ['T1'], excludeListIds: ['LP'], excludeTagIds: ['TP'] },
  ...over,
});

/** The SenderError a promise rejects with (fails the test if it resolves or throws something else). */
async function failure(p: Promise<unknown>): Promise<SenderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SenderError);
    return err as SenderError;
  }
  throw new Error('expected a SenderError, the call succeeded');
}

beforeEach(async () => {
  fake = await new FakeMailercloud().start();
  sleeps = [];
});

afterEach(async () => {
  await fake.stop();
});

describe('requests', () => {
  it('sends the plain key in Authorization — no Bearer prefix', async () => {
    await client().health();
    const [r] = fake.to('GET /v1/client/plan');
    expect(r.headers.authorization).toBe(KEY);
  });

  it('createDraft: v2 campaign/save as a draft (is_publish "0") with targeting, excludes, preheader and mailing preference', async () => {
    const { campaignId } = await client().createDraft(draft());
    const [r] = fake.to('POST /v2/campaign/save');
    expect(r.headers.authorization).toBe(KEY);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body).toEqual({
      name: 'TS-DIGEST-2026-10-23-FREE-run1',
      subject: 'Lead headline',
      sender: { sender_name: 'Taxscan Digest', sender_email: SENDER },
      html: '<html><body>digest</body></html>',
      plain_text: 'digest',
      email_preheader: 'Plus 7 more: second headline',
      list_ids: ['L1'],
      segments: ['S1'],
      tag_ids: ['T1'],
      exclude_list_ids: ['LP'],
      exclude_tag_ids: ['TP'],
      reply_email: REPLY,
      track_opens: '1',
      track_clicks: '1',
      mailing_preference: true,
      is_publish: '0',
    });
    expect(r.body).not.toHaveProperty('scheduled_at');
    expect(fake.campaigns.get(campaignId)?.status).toBe('Draft');
  });

  it('createDraft omits plain_text when there is none, and reply_email when unset', async () => {
    await client({ replyEmail: '' }).createDraft(draft({ text: null }));
    const body = fake.to('POST /v2/campaign/save')[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('plain_text');
    expect(body).not.toHaveProperty('reply_email');
  });

  it('schedule: POST /v1/campaign/schedule/{id} with no scheduled_at (= send now)', async () => {
    const c = fake.addCampaign('x');
    await client().schedule(c.id, 'now');
    const [r] = fake.to('POST /v1/campaign/schedule');
    expect(r.path).toBe(`/v1/campaign/schedule/${c.id}`);
    expect(r.body).toEqual({});
    expect(fake.campaigns.get(c.id)?.status).toBe('Scheduled');
  });

  it('testSend: one testmail call per address', async () => {
    const c = fake.addCampaign('x');
    await client().testSend(c.id, ['a@example.com', 'b@example.com']);
    expect(fake.to('POST /v1/campaign/testmail').map((r) => r.body)).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
  });
});

describe('status and report', () => {
  it.each([
    ['Draft', 'DRAFT'],
    ['Scheduled', 'SCHEDULED'],
    ['Rescheduled', 'SCHEDULED'],
    ['Queued', 'SCHEDULED'],
    ['Processing', 'SCHEDULED'],
    ['Sending', 'SENDING'],
    ['Paused', 'SENDING'],
    ['Finished', 'SENT'],
    ['Aborted', 'FAILED'],
    ['Failed', 'FAILED'],
  ])('%s → %s', async (mc, ours) => {
    const c = fake.addCampaign('x', mc);
    expect((await client().status(c.id)).state).toBe(ours);
  });

  it('an unrecognised status throws instead of guessing', async () => {
    const c = fake.addCampaign('x', 'Duplicate');
    const e = await failure(client({ maxRetries: 0 }).status(c.id));
    expect(e.kind).toBe('RETRYABLE');
  });

  it('counts come from report_summary (numbers or numeric strings)', async () => {
    const c = fake.addCampaign('x', 'Finished');
    c.summary = { queued_total: '120', sent: 118, opens: 40, clicks: 9 };
    expect(await client().status(c.id)).toEqual({ state: 'SENT', targeted: 120, reached: 118 });
    expect(await client().report(c.id)).toEqual({ opens: 40, clicks: 9 });
  });
});

describe('findCampaignByName', () => {
  it('found → that id (exact name, not a prefix match)', async () => {
    fake.addCampaign('TS-DIGEST-2026-10-23-FREE-run1-old');
    const c = fake.addCampaign('TS-DIGEST-2026-10-23-FREE-run1');
    expect(await client().findCampaignByName('TS-DIGEST-2026-10-23-FREE-run1')).toEqual({ campaignId: c.id });
    expect(fake.to('POST /v1/campaign/list')[0].body).toEqual({ limit: 100, page: 1, search: 'TS-DIGEST-2026-10-23-FREE-run1' });
  });

  it('two campaigns with the exact name → inconclusive (throws), never the first one', async () => {
    const name = 'TS-DIGEST-2026-10-23-FREE';
    fake.addCampaign(name, 'Finished');
    fake.addCampaign(name, 'Draft');
    const e = await failure(client({ maxRetries: 0 }).findCampaignByName(name));
    expect(e.kind).toBe('RETRYABLE');
    expect(e.message).toContain('2 campaigns have this exact name');
  });

  it('not found → null', async () => {
    fake.addCampaign('TS-DIGEST-2026-10-22-FREE-run0');
    expect(await client().findCampaignByName('TS-DIGEST-2026-10-23-FREE-run1')).toBeNull();
  });

  it('walks past a full first page: the match on page 2 is found', async () => {
    const name = 'TS-DIGEST-2026-10-23-FREE-run1';
    for (let i = 0; i < 100; i++) fake.addCampaign(`${name}-old${i}`);
    const c = fake.addCampaign(name);
    expect(await client().findCampaignByName(name)).toEqual({ campaignId: c.id });
    expect(fake.to('POST /v1/campaign/list')).toHaveLength(2);
  });

  it('a nested list shape (data: {list: [...]}) throws instead of reading as empty', async () => {
    fake.script('POST /v1/campaign/list', { status: 200, body: { data: { list: [{ id: 'c1', name: 'x' }], total: 1 } } });
    const e = await failure(client({ maxRetries: 0 }).findCampaignByName('x'));
    expect(e.kind).toBe('RETRYABLE');
  });

  it('rows without a string name (e.g. campaign_name) throw instead of reading as "not found"', async () => {
    fake.script('POST /v1/campaign/list', { status: 200, body: { data: { '0': { id: 'c1', campaign_name: 'x' } } } });
    const e = await failure(client({ maxRetries: 0 }).findCampaignByName('x'));
    expect(e.kind).toBe('RETRYABLE');
  });

  it('an unreadable list reply throws; it is never read as "not found"', async () => {
    fake.script('POST /v1/campaign/list', { status: 200, body: { message: 'ok' } });
    const e = await failure(client({ maxRetries: 0 }).findCampaignByName('x'));
    expect(e.kind).toBe('RETRYABLE');
  });
});

describe('retries', () => {
  it('a read call: 429 → retry with backoff → success', async () => {
    fake.script('GET /v1/client/plan', { status: 429, body: { message: 'Too Many Requests' } }, { status: 429, body: { message: 'Too Many Requests' } });
    await client().health();
    expect(fake.to('GET /v1/client/plan')).toHaveLength(3);
    // ~1 s doubling with jitter (random 0.5 → 3/4 of each step)
    expect(sleeps).toEqual([750, 1500]);
  });

  it('a read call gives up after 5 retries, capped at 30 s, and throws RETRYABLE http 429', async () => {
    fake.script('GET /v1/client/plan', ...Array(10).fill({ status: 429, body: { message: 'Too Many Requests' } }));
    const e = await failure(client({ random: () => 1 }).health());
    expect(e).toMatchObject({ kind: 'RETRYABLE', http: 429 });
    expect(fake.to('GET /v1/client/plan')).toHaveLength(6);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it('the backoff step is capped at 30 s', async () => {
    fake.script('GET /v1/client/plan', ...Array(3).fill({ status: 503, body: {} }));
    await client({ random: () => 1, backoffBaseMs: 20_000 }).health();
    expect(sleeps).toEqual([20000, 30000, 30000]);
  });

  it('a read call: a timeout is RETRYABLE and retried', async () => {
    const c = fake.addCampaign('x', 'Sending');
    fake.script('GET /v1/campaign', 'hang');
    expect((await client().status(c.id)).state).toBe('SENDING');
    expect(fake.to('GET /v1/campaign')).toHaveLength(2);
  });

  it.each([
    ['429', { status: 429, body: { message: 'Too Many Requests' } }, 429],
    ['503', { status: 503, body: { message: 'unavailable' } }, 503],
  ] as const)('createDraft is NOT retried internally (%s → RETRYABLE with http)', async (_label, reply, http) => {
    fake.script('POST /v2/campaign/save', reply);
    const e = await failure(client().createDraft(draft()));
    expect(e).toMatchObject({ kind: 'RETRYABLE', http, notSent: false });
    expect(fake.to('POST /v2/campaign/save')).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([
    ['429', { status: 429, body: { message: 'Too Many Requests' } }, 429],
    ['502', { status: 502, body: {} }, 502],
  ] as const)('schedule is NOT retried internally (%s → RETRYABLE with http)', async (_label, reply, http) => {
    const c = fake.addCampaign('x');
    fake.script('POST /v1/campaign/schedule', reply);
    const e = await failure(client().schedule(c.id, 'now'));
    expect(e).toMatchObject({ kind: 'RETRYABLE', http, notSent: false });
    expect(fake.to('POST /v1/campaign/schedule')).toHaveLength(1);
  });
});

describe('error classification', () => {
  it.each([
    ['401 bad key', { status: 401, body: { errors: [{ field: '', message: 'Authorization failed' }] } }, 401, null],
    ['403', { status: 403, body: { message: 'Forbidden' } }, 403, null],
    ['400 validation', { status: 400, body: { errors: [{ field: 'sender_email', message: 'must be a valid email address' }] } }, 400, null],
    ['422 validation', { status: 422, body: { error: { field: 'name', message: 'invalid' } } }, 422, null],
    ['9002 quota', { status: 400, body: { code: 9002, message: 'Limit reached' } }, 400, '9002'],
    ['quota message', { status: 403, body: { message: 'Your email quota is exhausted' } }, 403, 'quota'],
  ] as const)('createDraft %s → FATAL, not retried', async (_label, reply, http, code) => {
    fake.script('POST /v2/campaign/save', reply);
    const e = await failure(client().createDraft(draft()));
    expect(e).toMatchObject({ kind: 'FATAL', http });
    if (code) expect(e.code).toBe(code);
    expect(fake.to('POST /v2/campaign/save')).toHaveLength(1);
  });

  it('401 on a read call is FATAL and not retried', async () => {
    fake.script('GET /v1/client/plan', { status: 401, body: { errors: [{ field: '', message: 'Authorization failed' }] } });
    const e = await failure(client().health());
    expect(e).toMatchObject({ kind: 'FATAL', http: 401 });
    expect(fake.to('GET /v1/client/plan')).toHaveLength(1);
  });

  it('404 on schedule (unknown id) → FATAL', async () => {
    const e = await failure(client().schedule('nope', 'now'));
    expect(e).toMatchObject({ kind: 'FATAL', http: 404 });
  });

  it('5xx on a read call that never recovers → RETRYABLE with http', async () => {
    fake.script('GET /v1/client/plan', ...Array(3).fill({ status: 500, body: {} }));
    const e = await failure(client({ maxRetries: 2 }).health());
    expect(e).toMatchObject({ kind: 'RETRYABLE', http: 500 });
  });

  it('connection refused → RETRYABLE, notSent: true (create and read)', async () => {
    const closed = await closedPort();
    const c = client({ baseV1: `http://127.0.0.1:${closed}/v1`, baseV2: `http://127.0.0.1:${closed}/v2`, maxRetries: 1 });
    const create = await failure(c.createDraft(draft()));
    expect(create).toMatchObject({ kind: 'RETRYABLE', notSent: true, http: null });
    const read = await failure(c.health());
    expect(read).toMatchObject({ kind: 'RETRYABLE', notSent: true });
    expect(sleeps).toHaveLength(1); // the read retried once; the create did not
  });

  it('create: server accepts the request then hangs past the timeout → AMBIGUOUS', async () => {
    fake.script('POST /v2/campaign/save', 'hang');
    const e = await failure(client().createDraft(draft()));
    expect(e).toMatchObject({ kind: 'AMBIGUOUS', notSent: false, http: null });
    expect(fake.to('POST /v2/campaign/save')).toHaveLength(1); // it DID reach the provider
  });

  it('schedule: server accepts the request then hangs past the timeout → AMBIGUOUS', async () => {
    const c = fake.addCampaign('x');
    fake.script('POST /v1/campaign/schedule', 'hang');
    const e = await failure(client().schedule(c.id, 'now'));
    expect(e).toMatchObject({ kind: 'AMBIGUOUS', notSent: false });
    expect(fake.to('POST /v1/campaign/schedule')).toHaveLength(1);
  });

  it('a socket reset after the request was sent on schedule → AMBIGUOUS, never notSent', async () => {
    const c = fake.addCampaign('x');
    fake.script('POST /v1/campaign/schedule', 'reset');
    const e = await failure(client().schedule(c.id, 'now'));
    expect(e).toMatchObject({ kind: 'AMBIGUOUS', notSent: false });
  });

  it('create answered 2xx without an id → AMBIGUOUS', async () => {
    fake.script('POST /v2/campaign/save', { status: 201, body: {} });
    const e = await failure(client().createDraft(draft()));
    expect(e).toMatchObject({ kind: 'AMBIGUOUS', http: 201 });
  });

  it('no API key → FATAL before any request', async () => {
    const e = await failure(client({ apiKey: '' }).createDraft(draft()));
    expect(e).toMatchObject({ kind: 'FATAL', notSent: true });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('secrets and addresses never leave in an error', () => {
  it('the key and any address echoed by the provider are masked in err.message and redactError', async () => {
    const echo = `bad sender ${SENDER} for key ${KEY} (Authorization: ${KEY}) to ops%40example.com`;
    fake.script('POST /v2/campaign/save', { status: 400, body: { errors: [{ field: 'sender_email', message: echo }] } });
    fake.script('POST /v1/campaign/testmail', { status: 400, body: { errors: [{ field: 'email', message: `a@example.com ${KEY}` }] } });
    const errs = [await failure(client().createDraft(draft())), await failure(client().testSend(fake.addCampaign('x').id, ['a@example.com']))];
    for (const e of errs) {
      for (const text of [e.message, redactError(e, [])]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toMatch(/@|%40/);
      }
    }
  });
});

describe('createMailercloudSender', () => {
  it('builds a client from the digest env (MAILERCLOUD_* secrets)', async () => {
    const cfg = parseDigestEnv({
      MAILERCLOUD_API_KEY: KEY,
      MAILERCLOUD_SENDER_NAME: 'Taxscan Digest',
      MAILERCLOUD_SENDER_EMAIL: SENDER,
    });
    const s = createMailercloudSender(cfg, { baseV1: fake.base.v1, baseV2: fake.base.v2 });
    await s.health();
    expect(fake.requests[0].headers.authorization).toBe(KEY);
  });
});

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
