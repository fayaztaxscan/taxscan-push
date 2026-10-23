import { parseDigestEnv } from '../lib/env';
import { MailercloudSender, type MailercloudOptions } from '../services/digest/mailercloud';
import { SenderError, isDuplicateNameError } from '../services/digest/sender';
import {
  NotReadOnlyError,
  createReadOnlyLookupSender,
  formatLookup,
  lookupDigestCampaigns,
  parseLookupDate,
} from '../services/digest/lookup';
import { FakeMailercloud } from './digestMailercloudFake';

/**
 * Task 13: the read-only `digest:lookup` CLI module, the client's read-only
 * guard, the duplicate-name error code and the webhook status read — all
 * against the local HTTP fake of Mailercloud (real HTTP, no real Mailercloud).
 */

const KEY = 'mc-lookup-test-key-0123456789abcdef';
const DATE = new Date(Date.UTC(2026, 10, 24)); // 24 Nov 2026 in the names below
let fake: FakeMailercloud;

const cfg = parseDigestEnv({ DIGEST_ENABLED: 'true', MAILERCLOUD_API_KEY: KEY, MAILERCLOUD_SENDER_NAME: 'Taxscan', MAILERCLOUD_SENDER_EMAIL: 'digest@news.taxscan.in' });

function opts(): Partial<MailercloudOptions> {
  return { baseV1: fake.base.v1, baseV2: fake.base.v2, sleep: async () => undefined, maxRetries: 1, timeoutMs: 2000 };
}

beforeAll(async () => {
  fake = await new FakeMailercloud().start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.campaigns.clear();
  fake.webhooks.clear();
});

describe('read-only client', () => {
  it('refuses every write BEFORE any request is made; reads still work', async () => {
    const ro = createReadOnlyLookupSender(cfg, opts());
    expect(ro.isReadOnly()).toBe(true);
    const draft = fake.addCampaign('TS-DIGEST-2026-11-24-FREE');
    const writes: [string, () => Promise<unknown>][] = [
      ['createDraft', () => ro.createDraft({ name: 'x', audience: 'FREE', subject: 's', preheader: 'p', html: '<p>x</p>', text: null, target: { listIds: ['l'], segmentIds: [], tagIds: [], excludeListIds: ['e'], excludeTagIds: [] } })],
      ['schedule', () => ro.schedule(draft.id, 'now')],
      ['testSend', () => ro.testSend(draft.id, ['someone@example.org'])],
    ];
    for (const [op, call] of writes) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).kind).toBe('FATAL');
      expect((err as SenderError).notSent).toBe(true);
      expect((err as SenderError).message).toMatch(new RegExp(`${op}: refused: this client is read-only`));
    }
    expect(fake.requests).toHaveLength(0); // nothing reached the provider
    expect((await ro.status(draft.id)).state).toBe('DRAFT');
    expect(fake.requests.every((r) => r.method === 'GET' || r.route === 'POST /v1/campaign/list')).toBe(true);
  });

  it('the lookup refuses a client that could write', async () => {
    const rw = new MailercloudSender({ apiKey: KEY, senderName: 'T', senderEmail: 'digest@news.taxscan.in', ...opts() });
    expect(rw.isReadOnly()).toBe(false);
    await expect(lookupDigestCampaigns(rw, { runDate: DATE, portal: 'taxscan', audiences: ['FREE'], cfg })).rejects.toBeInstanceOf(NotReadOnlyError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('lookupDigestCampaigns + formatLookup', () => {
  it('prints name, id, status and reach for drafts and finished campaigns alike; never the key or an address', async () => {
    fake.addCampaign('TS-DIGEST-2026-11-24-FREE', 'Draft');
    const sent = fake.addCampaign('TS-DIGEST-2026-11-24-PREMIUM', 'Finished');
    sent.summary = { queued_total: 200, sent: 198, opens: 1, clicks: 1 };
    fake.addCampaign('TS-DIGEST-2026-11-24-FREE-copy', 'Draft'); // a prefix match is not ours
    const rows = await lookupDigestCampaigns(createReadOnlyLookupSender(cfg, opts()), { runDate: DATE, portal: 'taxscan', audiences: ['FREE', 'PREMIUM'], cfg });
    expect(rows.map((r) => [r.name, r.found.length])).toEqual([
      ['TS-DIGEST-2026-11-24-FREE', 1],
      ['TS-DIGEST-2026-11-24-PREMIUM', 1],
    ]);
    expect(rows[1].found[0]).toMatchObject({ campaignId: sent.id, listStatus: 'Finished', state: 'SENT', targeted: 200, reached: 198 });
    const lines = formatLookup(rows);
    expect(lines[0]).toMatch(/^TS-DIGEST-2026-11-24-FREE: id=mc\d+ list-status=Draft state=DRAFT/);
    expect(lines[1]).toMatch(/^TS-DIGEST-2026-11-24-PREMIUM: id=mc\d+ list-status=Finished state=SENT reach=198\/200$/);
    const out = lines.join('\n');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('@');
    // Only read endpoints were called.
    expect(new Set(fake.requests.map((r) => r.route))).toEqual(new Set(['POST /v1/campaign/list', 'GET /v1/campaign']));
  });

  it('two campaigns with the exact name: both listed, flagged DUPLICATE; none: "not found"', async () => {
    fake.addCampaign('TS-DIGEST-2026-11-24-FREE', 'Draft');
    fake.addCampaign('TS-DIGEST-2026-11-24-FREE', 'Finished');
    const rows = await lookupDigestCampaigns(createReadOnlyLookupSender(cfg, opts()), { runDate: DATE, portal: 'taxscan', audiences: ['FREE', 'PREMIUM'], cfg });
    const lines = formatLookup(rows);
    expect(rows[0].found).toHaveLength(2);
    expect(lines[0]).toBe('TS-DIGEST-2026-11-24-FREE: DUPLICATE — 2 campaigns have this exact name; delete the extra one');
    expect(lines.at(-1)).toBe('TS-DIGEST-2026-11-24-PREMIUM: not found in Mailercloud');
  });

  it('a portal other than taxscan is part of the name; an unreadable list is "lookup failed", never "not found"', async () => {
    fake.script('POST /v1/campaign/list', { status: 200, body: { data: { list: [] } } }); // a shape we do not know
    const rows = await lookupDigestCampaigns(createReadOnlyLookupSender(cfg, opts()), { runDate: DATE, portal: 'academy', audiences: ['FREE'], cfg });
    expect(rows[0].name).toBe('TS-DIGEST-academy-2026-11-24-FREE');
    expect(formatLookup(rows)[0]).toMatch(/lookup failed — .*unreadable campaign list reply/);
  });

  it('parseLookupDate accepts YYYY-MM-DD only', () => {
    expect(parseLookupDate('2026-10-24')?.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    for (const bad of [undefined, '', '24-10-2026', '2026-02-30', '2026-10-24T00:00']) expect(parseLookupDate(bad)).toBeNull();
  });
});

describe('findCampaignByName: duplicates carry their own code (7b)', () => {
  it('two exact-name campaigns → RETRYABLE with code duplicate_name; one → that id', async () => {
    const sender = createReadOnlyLookupSender(cfg, opts());
    const a = fake.addCampaign('TS-DIGEST-2026-11-24-FREE');
    expect(await sender.findCampaignByName('TS-DIGEST-2026-11-24-FREE')).toEqual({ campaignId: a.id });
    fake.addCampaign('TS-DIGEST-2026-11-24-FREE');
    const err = await sender.findCampaignByName('TS-DIGEST-2026-11-24-FREE').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SenderError);
    expect((err as SenderError).kind).toBe('RETRYABLE');
    expect(isDuplicateNameError(err)).toBe(true);
    expect(isDuplicateNameError(new SenderError('RETRYABLE', 'timeout'))).toBe(false);
  });
});

describe('webhookStatus (GET /v1/webhooks/detail/{id}, health.ts daily check)', () => {
  it('Active / 1 → active; Inactive / 0 / Disabled → off; an unreadable or missing answer throws (never "off")', async () => {
    const sender = createReadOnlyLookupSender(cfg, opts());
    const cases: [string | number, boolean][] = [['Active', true], [1, true], ['Inactive', false], [0, false], ['Disabled', false]];
    for (const [st, active] of cases) {
      fake.webhooks.set('wh-1', st);
      expect(await sender.webhookStatus('wh-1')).toEqual({ active });
    }
    expect(fake.to('GET /v1/webhooks/detail').every((r) => r.headers.authorization === KEY)).toBe(true);
    fake.webhooks.set('wh-1', 'Pending review');
    await expect(sender.webhookStatus('wh-1')).rejects.toMatchObject({ kind: 'RETRYABLE' });
    await expect(sender.webhookStatus('wh-missing')).rejects.toBeInstanceOf(SenderError);
  });
});
