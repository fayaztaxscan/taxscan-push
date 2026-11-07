import bcrypt from 'bcrypt';
import type { DigestAudience, User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseDigestEnv, type AudienceEnv, type DigestEnv } from '../lib/env';
import { advanceRun, audienceTarget, awaitDigestAlerts, ensureRun, pressSendFree, type DigestTrigger } from '../services/digest/runner';
import { digestRunDetail } from '../services/digest/screen';
import { MailercloudSender } from '../services/digest/mailercloud';
import type { DraftInput } from '../services/digest/sender';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';
import { FakeMailercloud } from './digestMailercloudFake';

/**
 * DIGEST_FREE_SEGMENT_IDS (brief 2026-11-07-free-digest-segment): with the setting, the Free digest's draft targets that Mailercloud
 * segment and nothing else; unset, nothing changes. Provider calls go to the in-memory FakeSender or a local fake HTTP server; the
 * users are throwaway @team.test addresses. The numbers below are the brief's acceptance tests.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-free-segment-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const PASSWORD = 'Free-segment-pass-1234';

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

/** DIGEST_FREE_MANUAL on, a Premium SEGMENT (as in production), a Free segment unless overridden. */
function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_FREE_MANUAL: 'true',
    DIGEST_FREE_SEGMENT_IDS: 'seg-free',
    DIGEST_PREMIUM_SEGMENT_IDS: 'seg-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    ...over,
  });
}

/** Today's Free setup: a list and an exclude list, no segment. */
const LIST_SETUP: NodeJS.ProcessEnv = {
  DIGEST_FREE_SEGMENT_IDS: '',
  DIGEST_FREE_LIST_IDS: 'list-free',
  DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
};

const aud = (over: NodeJS.ProcessEnv = {}): AudienceEnv =>
  parseAudienceEnv({
    AUDIENCE_SYNC_ENABLED: 'true',
    AUDIENCE_MC_TAG_PREMIUM: 'tag-premium',
    AUDIENCE_MC_TAG_FORMER: 'tag-former',
    AUDIENCE_MC_TAG_NO_MARKETING: 'tag-nomkt',
    ...over,
  });
const AUD_ON = aud({ DIGEST_AUDIENCE_FROM_CMS: 'true' });
const AUD_OFF = aud();

const SEGMENT_TARGET = { listIds: [], segmentIds: ['seg-free'], tagIds: [], excludeListIds: [], excludeTagIds: [] };

/* ------------------------------------------------------------------ */
/* Acceptance 1–5, 7: audienceTarget                                    */
/* ------------------------------------------------------------------ */

describe('1. the setting unset: Free is exactly what it is today', () => {
  it('parses to an empty list by default', () => {
    expect(parseDigestEnv({}).audiences.free.segmentIds).toEqual([]);
    expect(cfg({ DIGEST_FREE_SEGMENT_IDS: ' seg-a , seg-b ,, ' }).audiences.free.segmentIds).toEqual(['seg-a', 'seg-b']);
  });

  it('non-derived: the list + exclude target, byte for byte', () => {
    const c = cfg({ ...LIST_SETUP, DIGEST_FREE_EXCLUDE_TAG_IDS: 'x1' });
    expect(audienceTarget(c, 'FREE', AUD_OFF)).toEqual({
      ok: true,
      target: { listIds: ['list-free'], segmentIds: [], tagIds: [], excludeListIds: ['list-premium'], excludeTagIds: ['x1'] },
    });
  });

  it('derived: the list, the Former tag and the derived excludes, byte for byte', () => {
    const c = cfg(LIST_SETUP);
    expect(audienceTarget(c, 'FREE', AUD_ON)).toEqual({
      ok: true,
      target: { listIds: ['list-free'], segmentIds: [], tagIds: ['tag-former'], excludeListIds: ['list-premium'], excludeTagIds: ['tag-premium', 'tag-nomkt'] },
    });
  });

  it("today's refusals are unchanged: no reader list, no premium exclude", () => {
    expect(audienceTarget(cfg({ DIGEST_FREE_SEGMENT_IDS: '', DIGEST_FREE_LIST_IDS: '' }), 'FREE', AUD_OFF)).toEqual({ ok: false, reason: 'DIGEST_FREE_LIST_IDS is empty' });
    const noExclude = audienceTarget(cfg({ DIGEST_FREE_SEGMENT_IDS: '', DIGEST_FREE_LIST_IDS: 'list-free' }), 'FREE', AUD_OFF);
    expect(noExclude).toMatchObject({ ok: false });
    expect((noExclude as { reason: string }).reason).toMatch(/no premium exclude/);
    // The derived branch needs no configured exclude (the derived tags carry it).
    expect(audienceTarget(cfg({ DIGEST_FREE_SEGMENT_IDS: '', DIGEST_FREE_LIST_IDS: 'list-free' }), 'FREE', AUD_ON).ok).toBe(true);
  });
});

describe('2. a Free segment, no list, manual on', () => {
  it('the target is the segment and nothing else (derived off)', () => {
    expect(audienceTarget(cfg(), 'FREE', AUD_OFF)).toEqual({ ok: true, target: SEGMENT_TARGET });
  });

  it('the target is the same with DIGEST_AUDIENCE_FROM_CMS on: no derived tags, no Former tag', () => {
    expect(audienceTarget(cfg(), 'FREE', AUD_ON)).toEqual({ ok: true, target: SEGMENT_TARGET });
  });

  it('configured excludes are not added either; several segments are all kept', () => {
    const c = cfg({ DIGEST_FREE_SEGMENT_IDS: 'seg-free, seg-free-2', DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-x', DIGEST_FREE_EXCLUDE_TAG_IDS: 'tag-x' });
    for (const a of [AUD_OFF, AUD_ON]) {
      expect(audienceTarget(c, 'FREE', a)).toEqual({ ok: true, target: { ...SEGMENT_TARGET, segmentIds: ['seg-free', 'seg-free-2'] } });
    }
  });
});

describe('3–5. refusals, each in plain words naming the settings', () => {
  const reasonOf = (c: DigestEnv, a: AudienceEnv): string => {
    const t = audienceTarget(c, 'FREE', a);
    if (t.ok) throw new Error('expected a refusal');
    return t.reason;
  };

  it('3. segment and list both set', () => {
    for (const a of [AUD_OFF, AUD_ON]) {
      const r = reasonOf(cfg({ DIGEST_FREE_LIST_IDS: 'list-free' }), a);
      expect(r).toContain('DIGEST_FREE_SEGMENT_IDS');
      expect(r).toContain('DIGEST_FREE_LIST_IDS');
    }
  });

  it('4. segment set, manual off', () => {
    for (const a of [AUD_OFF, AUD_ON]) {
      const r = reasonOf(cfg({ DIGEST_FREE_MANUAL: 'false' }), a);
      expect(r).toContain('DIGEST_FREE_MANUAL');
      expect(r).toContain('DIGEST_FREE_SEGMENT_IDS');
    }
    expect(reasonOf(cfg({ DIGEST_FREE_MANUAL: '' }), AUD_OFF)).toContain('DIGEST_FREE_MANUAL');
  });

  it('5. a Free segment that is also a Premium segment', () => {
    for (const a of [AUD_OFF, AUD_ON]) {
      const r = reasonOf(cfg({ DIGEST_FREE_SEGMENT_IDS: 'seg-free, seg-premium' }), a);
      expect(r).toContain('DIGEST_FREE_SEGMENT_IDS');
      expect(r).toContain('DIGEST_PREMIUM_SEGMENT_IDS');
    }
  });
});

describe("7. Premium's target is unchanged in every case above", () => {
  const baseline = (a: AudienceEnv) => audienceTarget(cfg({ ...LIST_SETUP, DIGEST_PREMIUM_LIST_IDS: 'list-premium' }), 'PREMIUM', a);

  it('whatever the Free setting, Premium resolves exactly as before', () => {
    const cases: NodeJS.ProcessEnv[] = [
      {}, // segment set
      { DIGEST_FREE_LIST_IDS: 'list-free' }, // refused for Free (both)
      { DIGEST_FREE_MANUAL: 'false' }, // refused for Free (manual off)
      { DIGEST_FREE_SEGMENT_IDS: 'seg-free, seg-premium' }, // refused for Free (collision)
      LIST_SETUP, // unset
    ];
    for (const a of [AUD_OFF, AUD_ON]) {
      const want = audienceTarget(cfg({ ...LIST_SETUP, DIGEST_PREMIUM_LIST_IDS: '' }), 'PREMIUM', a);
      for (const over of cases) {
        const got = audienceTarget(cfg(over), 'PREMIUM', a);
        expect(got).toEqual(want);
      }
    }
    expect(baseline(AUD_OFF).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 6: the draft body                                         */
/* ------------------------------------------------------------------ */

describe('6. the Mailercloud draft for a Free segment target', () => {
  let fake: FakeMailercloud;
  beforeEach(async () => {
    fake = await new FakeMailercloud().start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('carries the segment, and empty list, tag and exclude fields', async () => {
    const t = audienceTarget(cfg(), 'FREE', AUD_OFF);
    if (!t.ok) throw new Error(t.reason);
    const draft: DraftInput = { name: 'TS-DIGEST-2026-11-08-FREE', audience: 'FREE', subject: 'S', preheader: 'P', html: '<html></html>', text: 't', target: t.target };
    const sender = new MailercloudSender({
      apiKey: 'mc-test-key-0123456789abcdef',
      senderName: 'Team',
      senderEmail: 'digest@news.example.com',
      replyEmail: '',
      baseV1: fake.base.v1,
      baseV2: fake.base.v2,
      timeoutMs: 300,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    await sender.createDraft(draft);
    const [r] = fake.to('POST /v2/campaign/save');
    const body = r.body as Record<string, unknown>;
    expect(body.segments).toEqual(['seg-free']);
    expect(body.list_ids).toEqual([]);
    expect(body.tag_ids).toEqual([]);
    expect(body.exclude_list_ids).toEqual([]);
    expect(body.exclude_tag_ids).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 8, 10, and the build constraint                           */
/* ------------------------------------------------------------------ */

const userIds: string[] = [];
let presser: User;
let n = 0;

async function newRun(c: DigestEnv) {
  const portal = `${PORTAL_PREFIX}${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;
  return ensureRun({ portal, now: ist(6, 0), cfg: c });
}

function tick(runId: string, now: Date, sender: FakeSender, c: DigestEnv, trigger: DigestTrigger = 'cron', audience: AudienceEnv = AUD_OFF) {
  return advanceRun(runId, trigger, { sender, now, cfg: c, audience, quiet: QUIET, buildContent: placeholderContent, alerts: false });
}

async function createdRun(c: DigestEnv) {
  const run = await newRun(c);
  const sender = new FakeSender();
  await tick(run.id, ist(6, 30), sender, c);
  return { run, sender };
}

function press(runId: string, now: Date, sender: FakeSender, c: DigestEnv) {
  return pressSendFree(runId, presser.id, { sender, now, cfg: c, audience: AUD_OFF, quiet: QUIET, buildContent: placeholderContent, alerts: false });
}

function scheduled(sender: FakeSender): DigestAudience[] {
  return sender.calls.filter((c) => c.method === 'schedule').map((c) => sender.campaigns.get(c.args[0] as string)?.input.audience as DigestAudience);
}

beforeAll(async () => {
  const email = `digest-free-segment-${Date.now()}-${Math.floor(Math.random() * 1e9)}@team.test`;
  presser = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'PUBLISHER', isActive: true } });
  userIds.push(presser.id);
});

afterAll(async () => {
  await awaitDigestAlerts();
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true, sends: { select: { id: true } } } });
  const ids = [...runs.map((r) => r.id), ...runs.flatMap((r) => r.sends.map((s) => s.id))];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    if (ids.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${ids}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('8. a pressed Send Free on a segment-target draft', () => {
  it('the morning draft targets the segment, and one press schedules it once; Premium is untouched', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    const drafts = [...sender.campaigns.values()];
    const free = drafts.find((d) => d.input.audience === 'FREE')!;
    const premium = drafts.find((d) => d.input.audience === 'PREMIUM')!;
    expect(free.input.target).toEqual(SEGMENT_TARGET);
    expect(premium.input.target).toEqual({ listIds: [], segmentIds: ['seg-premium'], tagIds: [], excludeListIds: [], excludeTagIds: [] });

    const r = await press(run.id, ist(7, 10), sender, c);
    expect(r).toMatchObject({ ok: true, scheduled: true, state: 'SCHEDULED' });
    expect(scheduled(sender)).toEqual(['FREE']);

    // A second press, and a press after the send, are refused: still exactly one provider schedule call.
    expect(await press(run.id, ist(7, 11), sender, c)).toMatchObject({ ok: false, status: 409 });
    expect(scheduled(sender)).toEqual(['FREE']);
  });

  it("the gates are the ones digestFreeManual.test.ts expects: quiet hours and the cut-off refuse, nothing is sent", async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    expect(await press(run.id, ist(3, 0), sender, c)).toMatchObject({ ok: false, status: 409 });
    expect(await press(run.id, ist(17, 30), sender, c)).toMatchObject({ ok: false, status: 409, code: 'past_cutoff' });
    expect(scheduled(sender)).toEqual([]);
  });

  it('a refused target (segment and list both set) stops the press with config_invalid and the plain reason', async () => {
    const good = cfg();
    const { run, sender } = await createdRun(good);
    const bad = cfg({ DIGEST_FREE_LIST_IDS: 'list-free' });
    const r = await press(run.id, ist(7, 10), sender, bad);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'config_invalid' });
    expect(JSON.stringify(r)).toContain('DIGEST_FREE_LIST_IDS');
    expect(scheduled(sender)).toEqual([]);
  });
});

describe('the build fails closed on a Free refusal, Premium included (kept behaviour)', () => {
  it('segment + list both set: nothing is drafted for either version', async () => {
    const c = cfg({ DIGEST_FREE_LIST_IDS: 'list-free' });
    const run = await newRun(c);
    const sender = new FakeSender();
    await tick(run.id, ist(6, 30), sender, c);
    expect(sender.count('createDraft')).toBe(0);
    const after = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.build).not.toBe('BUILT');
  });
});

describe('9–10. the screen', () => {
  const opts = (c: DigestEnv, now: Date) => ({ cfg: c, audience: AUD_OFF, now, quiet: QUIET, providerReady: true, viewerCanTest: false });

  it('10. the payload says a segment is the target, and never contains a segment id', async () => {
    const c = cfg();
    const { run } = await createdRun(c);
    const detail = await digestRunDetail(run.id, opts(c, ist(7, 10)));
    expect(detail).not.toBeNull();
    expect(detail!.freeTargetsSegment).toBe(true);
    const json = JSON.stringify(detail);
    expect(json).not.toContain('seg-free');
    expect(json).not.toContain('seg-premium');
    expect(json).not.toMatch(/segmentIds/);
  });

  it('9. with a list target, or a refused one, the boolean is false', async () => {
    const withList = cfg(LIST_SETUP);
    const { run } = await createdRun(withList);
    expect((await digestRunDetail(run.id, opts(withList, ist(7, 10))))!.freeTargetsSegment).toBe(false);
    // The same run read with a refused configuration (segment and list together): not a segment target either.
    const refused = cfg({ DIGEST_FREE_LIST_IDS: 'list-free', DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium' });
    expect((await digestRunDetail(run.id, opts(refused, ist(7, 10))))!.freeTargetsSegment).toBe(false);
  });
});
