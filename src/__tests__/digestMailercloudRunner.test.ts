import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, ensureRun } from '../services/digest/runner';
import { createMailercloudSender } from '../services/digest/mailercloud';
import { FakeMailercloud } from './digestMailercloudFake';

/**
 * Email digest task 2 integration (docs/EMAIL_DIGEST_DESIGN.md §13): the
 * runner driving the REAL Mailercloud client against the local fake server,
 * one full happy path — create (draft) → schedule (now) → status Finished →
 * SENT. Rows live under unique `test-digest-mc-*` portals and are removed.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-mc-';
const KEY = 'mc-test-key-0123456789abcdef';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const ist = (h: number, min = 0) => new Date(Date.UTC(2026, 9, 23, h, min) - IST_OFFSET_MIN * 60 * 1000);

const cfg: DigestEnv = parseDigestEnv({
  DIGEST_ENABLED: 'true',
  DIGEST_SEND_LIVE: 'true',
  DIGEST_APPROVAL_REQUIRED: 'false',
  DIGEST_FREE_LIST_IDS: 'list-free',
  DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
  DIGEST_PREMIUM_LIST_IDS: 'list-premium',
  DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
  MAILERCLOUD_API_KEY: KEY,
  MAILERCLOUD_SENDER_NAME: 'Taxscan Digest',
  MAILERCLOUD_SENDER_EMAIL: 'digest@news.example.com',
});

let fake: FakeMailercloud;

beforeAll(async () => {
  fake = await new FakeMailercloud().start();
});

afterAll(async () => {
  await fake.stop();
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.$disconnect();
});

it('advanceRun with the real client: draft created, scheduled now, confirmed SENT', async () => {
  const sender = createMailercloudSender(cfg, { baseV1: fake.base.v1, baseV2: fake.base.v2, timeoutMs: 2000 });
  const run = await ensureRun({ portal: `${PORTAL_PREFIX}${Date.now()}`, now: ist(6, 0), cfg });
  const step = (now: Date) => advanceRun(run.id, 'cron', { sender, now, cfg, quiet: QUIET });

  // 06:30 IST: build + create both drafts; nothing is scheduled before the send time.
  await step(ist(6, 30));
  const creates = fake.to('POST /v2/campaign/save');
  expect(creates).toHaveLength(2);
  expect(creates.every((r) => (r.body as { is_publish: string }).is_publish === '0')).toBe(true);
  expect(fake.to('POST /v1/campaign/schedule')).toHaveLength(0);
  const rows = await prisma.digestSend.findMany({ where: { runId: run.id } });
  expect(rows.map((r) => r.state).sort()).toEqual(['CREATED', 'CREATED']);
  for (const r of rows) expect(fake.campaigns.get(r.mcCampaignId as string)?.status).toBe('Draft');

  // 07:30 IST: each stored id is scheduled exactly once, with no scheduled_at.
  await step(ist(7, 30));
  const schedules = fake.to('POST /v1/campaign/schedule');
  expect(schedules.map((r) => r.path).sort()).toEqual(rows.map((r) => `/v1/campaign/schedule/${r.mcCampaignId}`).sort());
  expect(schedules.every((r) => !('scheduled_at' in (r.body as object)))).toBe(true);

  // The provider finishes; the +10 min verification poll confirms it.
  for (const c of fake.campaigns.values()) {
    c.status = 'Finished';
    c.summary = { queued_total: 50, sent: 50, opens: 0, clicks: 0 };
  }
  const r = await step(ist(7, 40));
  expect(r.state).toBe('sent');
  const done = await prisma.digestSend.findMany({ where: { runId: run.id } });
  for (const d of done) expect(d).toMatchObject({ state: 'SENT', targeted: 50, reached: 50, sentVia: 'status_poll' });
  expect(fake.to('POST /v2/campaign/save')).toHaveLength(2); // never a second campaign
  expect(fake.requests.every((q) => q.headers.authorization === KEY)).toBe(true);
});
