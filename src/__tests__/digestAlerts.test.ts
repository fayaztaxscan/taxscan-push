import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { EmailMessage, EmailSender } from '../lib/email';
import { advanceRun, awaitDigestAlerts, ensureRun, type DigestTrigger } from '../services/digest/runner';
import {
  buildAlertEmail,
  digestAlertRecipients,
  resetAlertWarningsForTests,
  sendDigestAlerts,
  type AlertDeps,
} from '../services/digest/alerts';
import { digestAttention, type AttentionInput } from '../services/digest/status';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * Email digest task 6 (docs/EMAIL_DIGEST_DESIGN.md §4 alerts.ts, §6 /status,
 * §7 banner, §8): one alert email per kind per run, the recovery note, the
 * status endpoint and the Dashboard banner decision. Email goes to an
 * in-memory sender and an injected recipient list — never a real address.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-alerts-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const FAKE_KEY = 'mc-fake-key-0123456789abcdef';
const READER = 'reader.person@example.org';

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    MAILERCLOUD_API_KEY: FAKE_KEY,
    ...over,
  });
}

/** Records every email; optional latency to hold a claim open. */
function mailbox(opts: { delayMs?: number; fail?: boolean } = {}) {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = async (m) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) return { ok: false, error: `ElasticEmail responded 400 for ${READER}` };
    sent.push(m);
    return { ok: true };
  };
  return { sent, sender };
}

function alertDeps(box: ReturnType<typeof mailbox>, c: DigestEnv = cfg(), over: Partial<AlertDeps> = {}): AlertDeps {
  return {
    emailSender: box.sender,
    isConfigured: () => true,
    recipients: async () => ['admin.one@team.test'],
    cfg: c,
    ...over,
  };
}

let n = 0;
async function newRun(c: DigestEnv = cfg(), now = ist(6, 0)) {
  const portal = `${PORTAL_PREFIX}${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;
  return ensureRun({ portal, now, cfg: c });
}

function step(
  runId: string,
  trigger: DigestTrigger,
  now: Date,
  sender: FakeSender,
  box: ReturnType<typeof mailbox>,
  c: DigestEnv = cfg(),
) {
  return advanceRun(runId, trigger, {
    sender,
    now,
    cfg: c,
    quiet: QUIET,
    buildContent: placeholderContent,
    alerts: (id) => sendDigestAlerts(id, alertDeps(box, c, { now })),
    awaitAlerts: true,
  });
}

/** A run driven to SENT with the mailer off, so a test can then set its alerts by hand. */
async function sentRun() {
  const run = await newRun();
  const sender = new FakeSender();
  const go = (now: Date) =>
    advanceRun(run.id, 'cron', { sender, now, cfg: cfg(), quiet: QUIET, buildContent: placeholderContent, alerts: false });
  await go(ist(6, 30));
  await go(ist(7, 30));
  sender.setStatus({ state: 'SENT', targeted: 10, reached: 10 });
  expect((await go(ist(7, 41))).state).toBe('sent');
  return run;
}

async function setAlerts(runId: string, alerts: Record<string, unknown>) {
  await prisma.$executeRaw`UPDATE "DigestRun" SET alerts = ${JSON.stringify(alerts)}::jsonb WHERE id = ${runId}`;
}

const minutesAfter = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

async function alertsOf(runId: string): Promise<Record<string, Record<string, unknown>>> {
  const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: runId } });
  return r.alerts as Record<string, Record<string, unknown>>;
}

const userIds: string[] = [];

afterAll(async () => {
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('one email per kind per run', () => {
  it('a forced 401 gives exactly one "rejected" email, even after more advances', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'FATAL', 2, { http: 401 });
    const box = mailbox();
    await step(run.id, 'cron', ist(6, 30), sender, box);
    await step(run.id, 'cron', ist(6, 31), sender, box);
    await step(run.id, 'cron', ist(6, 40), sender, box);

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].subject).toBe('[Taxscan digest] Mailercloud rejected the digest — 2026-10-23');
    expect(box.sent[0].text).toContain('Retry now');
    expect(box.sent[0].text).toContain('API key');
    const fatal = (await alertsOf(run.id)).fatal;
    expect(fatal.emailedAt).toEqual(expect.any(String));
    expect(fatal.emailedTo).toBe(1);
    expect(fatal.emailClaim).toBeUndefined();
  });

  it('each kind is emailed once: a second kind on the same run gets its own single email', async () => {
    const run = await newRun();
    await prisma.$executeRaw`UPDATE "DigestRun" SET alerts = ${JSON.stringify({
      retrying: { raisedAt: ist(6, 30).toISOString(), emailedAt: null, audience: 'FREE', step: 'create' },
      orphan_draft: { raisedAt: ist(6, 31).toISOString(), emailedAt: null, audience: 'FREE', campaignName: 'TS-DIGEST-x' },
    })}::jsonb WHERE id = ${run.id}`;
    const box = mailbox();
    await sendDigestAlerts(run.id, alertDeps(box));
    await sendDigestAlerts(run.id, alertDeps(box));
    expect(box.sent.map((m) => m.subject).sort()).toEqual([
      '[Taxscan digest] Mailercloud not answering — retrying — 2026-10-23',
      '[Taxscan digest] Spare digest draft in Mailercloud — 2026-10-23',
    ]);
  });

  it('concurrent alert passes send one email', async () => {
    const run = await newRun();
    await prisma.$executeRaw`UPDATE "DigestRun" SET alerts = ${JSON.stringify({
      sanity_hold: { raisedAt: ist(6, 30).toISOString(), emailedAt: null, candidates: 400, max: 150 },
    })}::jsonb WHERE id = ${run.id}`;
    const box = mailbox({ delayMs: 150 });
    const deps = alertDeps(box);
    await Promise.all([sendDigestAlerts(run.id, deps), sendDigestAlerts(run.id, deps), sendDigestAlerts(run.id, deps)]);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain('Held for approval');
    expect(box.sent[0].text).toContain('400 candidate stories');
  });

  it('no email when nothing is wrong (a clean run to SENT)', async () => {
    const run = await newRun();
    const sender = new FakeSender();
    const box = mailbox();
    await step(run.id, 'cron', ist(6, 30), sender, box);
    await step(run.id, 'cron', ist(7, 30), sender, box);
    sender.setStatus({ state: 'SENT', targeted: 10, reached: 10 });
    const r = await step(run.id, 'cron', ist(7, 41), sender, box);
    expect(r.state).toBe('sent');
    expect(box.sent).toHaveLength(0);
    expect(await alertsOf(run.id)).toEqual({});
  });

  it('a failed alert email is retried later (bounded), never marked emailed', async () => {
    const run = await newRun();
    await prisma.$executeRaw`UPDATE "DigestRun" SET alerts = ${JSON.stringify({
      build_failed: { raisedAt: ist(6, 30).toISOString(), emailedAt: null, error: 'db blip' },
    })}::jsonb WHERE id = ${run.id}`;
    const down = mailbox({ fail: true });
    const r1 = await sendDigestAlerts(run.id, alertDeps(down, cfg(), { now: ist(6, 31) }));
    expect(r1.failed).toEqual(['build_failed']);
    let m = (await alertsOf(run.id)).build_failed;
    expect(m.emailedAt).toBeNull();
    expect(m.emailAttempts).toBe(1);
    expect(String(m.emailError)).not.toContain(READER);

    // Too soon: no attempt at all.
    const up = mailbox();
    await sendDigestAlerts(run.id, alertDeps(up, cfg(), { now: ist(6, 35) }));
    expect(up.sent).toHaveLength(0);
    // After the wait: delivered once.
    await sendDigestAlerts(run.id, alertDeps(up, cfg(), { now: ist(6, 42) }));
    await sendDigestAlerts(run.id, alertDeps(up, cfg(), { now: ist(7, 0) }));
    expect(up.sent).toHaveLength(1);
    m = (await alertsOf(run.id)).build_failed;
    expect(m.emailedAt).toEqual(expect.any(String));
  });
});

describe('attempt bound and claim guards', () => {
  it('send lands but the stamp does not: repeated passes 11 min apart email at most 3 times, then stop', async () => {
    const run = await newRun();
    await setAlerts(run.id, { fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: null } });
    const sent: EmailMessage[] = [];
    // Delivers, then the "stamp" is lost: the claim token is overwritten, so finishKind's fenced write misses.
    const lossy: EmailSender = async (m) => {
      sent.push(m);
      await prisma.$executeRaw`
        UPDATE "DigestRun" SET alerts = jsonb_set(alerts, '{fatal,emailClaim}', '"lost"'::jsonb) WHERE id = ${run.id}`;
      return { ok: true };
    };
    for (let i = 0; i < 6; i++) {
      await sendDigestAlerts(run.id, { ...alertDeps(mailbox()), emailSender: lossy, now: minutesAfter(ist(6, 31), 11 * i) });
    }
    expect(sent).toHaveLength(3);
    const m = (await alertsOf(run.id)).fatal;
    expect(m.emailAttempts).toBe(3);
    expect(m.emailedAt).toBeNull();
  });

  it('a failing provider is tried exactly MAX_ATTEMPTS (3) times', async () => {
    const run = await newRun();
    await setAlerts(run.id, { build_failed: { raisedAt: ist(6, 30).toISOString(), emailedAt: null } });
    let calls = 0;
    const failing: EmailSender = async () => (calls++, { ok: false, error: 'plan expired' });
    for (let i = 0; i < 5; i++) {
      await sendDigestAlerts(run.id, { ...alertDeps(mailbox()), emailSender: failing, now: minutesAfter(ist(6, 31), 11 * i) });
    }
    expect(calls).toBe(3);
    expect((await alertsOf(run.id)).build_failed.emailAttempts).toBe(3);
  });

  it('the SQL emailedAt guard: a pass reading a stale "not emailed" row still cannot claim it', async () => {
    const run = await newRun();
    await setAlerts(run.id, { fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: null } });
    const stale = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    const box = mailbox();
    await sendDigestAlerts(run.id, alertDeps(box));
    expect(box.sent).toHaveLength(1);
    // The second pass's JS check sees the old row (emailedAt null, no claim); only SQL can stop it.
    const spy = jest.spyOn(prisma.digestRun, 'findUnique').mockResolvedValueOnce(stale as never);
    try {
      await sendDigestAlerts(run.id, alertDeps(box));
    } finally {
      spy.mockRestore();
    }
    expect(box.sent).toHaveLength(1);
  });
});

describe('recovery', () => {
  it('resolved suppresses problem emails that had not gone out yet', async () => {
    const run = await sentRun();
    await setAlerts(run.id, {
      fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: ist(6, 31).toISOString() },
      retrying: { raisedAt: ist(6, 32).toISOString(), emailedAt: null },
    });
    const box = mailbox();
    await sendDigestAlerts(run.id, alertDeps(box));
    expect(box.sent.map((m) => m.subject)).toEqual(['[Taxscan digest] Resolved — digest sent — 2026-10-23']);
    expect((await alertsOf(run.id)).retrying.emailedAt).toBeNull();
  });

  it('once resolved exists, a problem kind cannot be claimed (even on a run that is not sent)', async () => {
    const run = await newRun();
    await setAlerts(run.id, {
      fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: null },
      resolved: { raisedAt: ist(7, 0).toISOString(), emailedAt: ist(7, 0).toISOString() },
      orphan_draft: { raisedAt: ist(6, 40).toISOString(), emailedAt: null },
    });
    const box = mailbox();
    await sendDigestAlerts(run.id, alertDeps(box));
    // orphan_draft is housekeeping, not a problem the recovery covers: still emailed.
    expect(box.sent.map((m) => m.subject)).toEqual(['[Taxscan digest] Spare digest draft in Mailercloud — 2026-10-23']);
  });

  it('a problem email mid-send (claimed, not stamped) still earns the resolved note', async () => {
    const run = await sentRun();
    await setAlerts(run.id, {
      fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: null, emailClaim: 'other-pass', emailClaimedAt: new Date().toISOString() },
    });
    const box = mailbox();
    await sendDigestAlerts(run.id, alertDeps(box));
    const a = await alertsOf(run.id);
    expect(a.resolved.emailSkipped).toBeUndefined();
    expect(box.sent.map((m) => m.subject)).toEqual(['[Taxscan digest] Resolved — digest sent — 2026-10-23']);
  });

  it('fatal fixed + Retry now → SENT: exactly one "resolved" email', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'FATAL', 2, { http: 401 });
    const box = mailbox();
    await step(run.id, 'cron', ist(6, 30), sender, box);
    expect(box.sent).toHaveLength(1);

    await step(run.id, 'retry', ist(7, 35), sender, box); // key fixed: create + schedule
    sender.setStatus({ state: 'SENT', targeted: 50, reached: 50 });
    const r = await step(run.id, 'cron', ist(7, 46), sender, box);
    expect(r.state).toBe('sent');
    await step(run.id, 'cron', ist(8, 0), sender, box);
    await sendDigestAlerts(run.id, alertDeps(box));

    expect(box.sent.map((m) => m.subject)).toEqual([
      '[Taxscan digest] Mailercloud rejected the digest — 2026-10-23',
      '[Taxscan digest] Resolved — digest sent — 2026-10-23',
    ]);
    expect((await alertsOf(run.id)).resolved.emailedAt).toEqual(expect.any(String));
  });

  it('no "resolved" email when no problem email was ever sent', async () => {
    const run = await newRun();
    await prisma.$executeRaw`UPDATE "DigestRun" SET alerts = ${JSON.stringify({
      retrying: { raisedAt: ist(6, 30).toISOString(), emailedAt: null, emailSkipped: 'no_recipients' },
    })}::jsonb WHERE id = ${run.id}`;
    const sender = new FakeSender();
    const box = mailbox();
    await step(run.id, 'cron', ist(6, 30), sender, box);
    await step(run.id, 'cron', ist(7, 30), sender, box);
    sender.setStatus({ state: 'SENT', targeted: 10, reached: 10 });
    await step(run.id, 'cron', ist(7, 41), sender, box);
    expect(box.sent).toHaveLength(0);
    expect((await alertsOf(run.id)).resolved.emailSkipped).toBe('no_problem_email_was_sent');
  });
});

describe('never throws, never leaks', () => {
  it('ElasticEmail not configured → no throw, no email, nothing stamped', async () => {
    resetAlertWarningsForTests();
    const run = await newRun();
    await prisma.$executeRaw`UPDATE "DigestRun" SET alerts = ${JSON.stringify({
      fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: null },
    })}::jsonb WHERE id = ${run.id}`;
    const box = mailbox();
    const r = await sendDigestAlerts(run.id, alertDeps(box, cfg(), { isConfigured: () => false }));
    expect(r.notConfigured).toBe(true);
    expect(box.sent).toHaveLength(0);
    expect((await alertsOf(run.id)).fatal.emailedAt).toBeNull();
    // The real default (blank key under jest) takes the same path.
    await expect(sendDigestAlerts(run.id)).resolves.toMatchObject({ notConfigured: true });
  });

  it('an alert hook that throws cannot change the advance result', async () => {
    const run = await newRun();
    const r = await advanceRun(run.id, 'cron', {
      sender: new FakeSender(),
      now: ist(6, 30),
      cfg: cfg(),
      quiet: QUIET,
      buildContent: placeholderContent,
      alerts: async () => {
        throw new Error('mailer exploded');
      },
    });
    expect(r.outcome).toBe('advanced');
    expect(r.state).toBe('created');
  });

  it('advanceRun does not wait for a slow mailer; awaitDigestAlerts does', async () => {
    const run = await newRun();
    let done = false;
    const t0 = Date.now();
    const r = await advanceRun(run.id, 'cron', {
      sender: new FakeSender(),
      now: ist(6, 30),
      cfg: cfg(),
      quiet: QUIET,
      buildContent: placeholderContent,
      alerts: async () => {
        await new Promise((res) => setTimeout(res, 1500));
        done = true;
      },
    });
    expect(r.state).toBe('created');
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(done).toBe(false);
    await awaitDigestAlerts();
    expect(done).toBe(true);
  });

  it('a sender that throws is treated as a failed send', async () => {
    const run = await newRun();
    await prisma.$executeRaw`UPDATE "DigestRun" SET alerts = ${JSON.stringify({
      fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: null },
    })}::jsonb WHERE id = ${run.id}`;
    const r = await sendDigestAlerts(run.id, {
      ...alertDeps(mailbox()),
      emailSender: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(r.failed).toEqual(['fatal']);
  });

  it('the email carries no API key and no reader address, even if the marker did', () => {
    const c = cfg();
    const marker = {
      raisedAt: ist(6, 30).toISOString(),
      audience: 'FREE',
      step: 'create',
      error: `401 Unauthorized: key ${FAKE_KEY} rejected; Authorization: ${FAKE_KEY}; contact ${READER} or reader%40example.org ${'x'.repeat(400)}`,
      problems: [`bad list for ${READER}`],
      campaignName: `TS-DIGEST ${READER}`,
    };
    for (const kind of ['fatal', 'config_invalid', 'ambiguous_create', 'build_failed', 'orphan_draft']) {
      const e = buildAlertEmail(kind, marker, new Date(Date.UTC(2026, 9, 23)), c);
      for (const part of [e.subject, e.text, e.html]) {
        expect(part).not.toContain(FAKE_KEY);
        expect(part).not.toContain(READER);
        expect(part).not.toContain('reader%40example.org');
        expect(part).not.toContain('x'.repeat(200));
      }
    }
  });

  it('a skipped alert is not emailed in preview mode (drafts are skipped at 17:00 by design)', async () => {
    const c = cfg({ DIGEST_SEND_LIVE: 'false' });
    const run = await newRun(c);
    const sender = new FakeSender();
    const box = mailbox();
    await step(run.id, 'cron', ist(6, 30), sender, box, c);
    await step(run.id, 'cron', ist(17, 0), sender, box, c);
    expect((await alertsOf(run.id)).skipped.emailSkipped).toBe('preview_only');
    expect(box.sent).toHaveLength(0);
  });
});

describe('recipients', () => {
  it('active ADMIN users only', async () => {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const mk = (email: string, role: 'ADMIN' | 'PUBLISHER', isActive: boolean) =>
      prisma.user.create({ data: { email, passwordHash: 'x', role, isActive } });
    const users = await Promise.all([
      mk(`alert-admin-${tag}@team.test`, 'ADMIN', true),
      mk(`alert-gone-${tag}@team.test`, 'ADMIN', false),
      mk(`alert-pub-${tag}@team.test`, 'PUBLISHER', true),
    ]);
    userIds.push(...users.map((u) => u.id));
    const list = await digestAlertRecipients();
    expect(list).toContain(`alert-admin-${tag}@team.test`);
    expect(list).not.toContain(`alert-gone-${tag}@team.test`);
    expect(list).not.toContain(`alert-pub-${tag}@team.test`);
  });
});

describe('GET /api/digest/status', () => {
  it('401 without a session or bearer', async () => {
    const res = await request(createApp()).get('/api/digest/status');
    expect(res.status).toBe(401);
  });

  it('digest off: enabled false, no attention', async () => {
    const res = await request(createApp({ digest: { cfg: cfg({ DIGEST_ENABLED: 'false' }) } }))
      .get('/api/digest/status')
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, today: null, attention: null, history: [] });
  });

  it("today's run, alerts with emailed flag, 14-day history; no html, no key, no address", async () => {
    const c = cfg();
    const run = await newRun(c, ist(6, 0));
    const sender = new FakeSender().fail('createDraft', 'FATAL', 2, { http: 401 });
    const box = mailbox();
    await step(run.id, 'cron', ist(6, 30), sender, box, c);
    // Yesterday's run on the same portal, for the history.
    await ensureRun({ portal: run.portal, now: ist(9, 0, 22), cfg: c });

    const app = createApp({ digest: { cfg: c, clock: () => ist(7, 0), portal: run.portal } });
    const res = await request(app).get('/api/digest/status').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.enabled).toBe(true);
    expect(b.config).toMatchObject({ sendLive: true, approvalRequired: false, sendAt: '07:30', cutoff: '17:00', providerConfigured: true });
    expect(b.today).toMatchObject({ runId: run.id, runDate: '2026-10-23', state: 'failed', build: 'BUILT', approval: 'NOT_REQUIRED' });
    expect(b.today.variants).toHaveLength(2);
    expect(b.today.variants[0]).toMatchObject({ audience: 'FREE', state: 'FAILED', lastErrorKind: 'FATAL' });
    expect(b.today.variants[0]).not.toHaveProperty('html');
    expect(b.today.alerts).toEqual([
      expect.objectContaining({ kind: 'fatal', text: 'Mailercloud rejected the digest', open: true, emailed: true }),
    ]);
    expect(b.today).toHaveProperty('readsUsed');
    expect(b.today).toHaveProperty('readsSource');
    expect(b.attention).toMatchObject({ code: 'fatal', link: '/digests' });
    expect(b.history).toEqual([
      { runDate: '2026-10-23', state: 'failed' },
      { runDate: '2026-10-22', state: 'building' },
    ]);
    const raw = JSON.stringify(b);
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain('@example.com');
    expect(raw).not.toContain('PLACEHOLDER');
  });

  it('redacts a variant lastError at the endpoint even if an unredacted string was stored', async () => {
    const c = cfg();
    const run = await newRun(c, ist(6, 0));
    await advanceRun(run.id, 'cron', { sender: new FakeSender(), now: ist(6, 30), cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
    await prisma.digestSend.updateMany({
      where: { runId: run.id },
      data: { lastError: `401 key=${FAKE_KEY} Authorization: ${FAKE_KEY} for ${READER}`, lastErrorKind: 'RETRYABLE' },
    });
    const app = createApp({ digest: { cfg: c, clock: () => ist(7, 0), portal: run.portal } });
    const res = await request(app).get('/api/digest/status').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.today.variants[0].lastError).toContain('401');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain(READER);
  });
});

describe('digestAttention (the Dashboard banner decision)', () => {
  const base: AttentionInput = {
    enabled: true,
    now: ist(8, 0),
    cfg: { sendLive: true, approvalRequired: true, sanityMaxCandidates: 150, cutoff: '17:00' },
    run: { build: 'BUILT', approval: 'APPROVED', skipReason: null, candidateCount: 30 },
    sends: [
      { state: 'SENT', sendAfter: ist(7, 30), lastError: null, lastErrorKind: null },
      { state: 'SENT', sendAfter: ist(7, 30), lastError: null, lastErrorKind: null },
    ],
  };
  const both = (s: Partial<AttentionInput['sends'][number]>) => base.sends.map((x) => ({ ...x, ...s }));
  const code = (over: Partial<AttentionInput>) => digestAttention({ ...base, ...over })?.code ?? null;

  it.each<[string, Partial<AttentionInput>, string | null]>([
    ['sent → silent', {}, null],
    ['digest off → silent even when failed', { enabled: false, sends: both({ state: 'FAILED', lastErrorKind: 'FATAL' }) }, null],
    ['no run today → silent', { run: null }, null],
    ['FATAL → fatal', { sends: both({ state: 'FAILED', lastErrorKind: 'FATAL', lastError: '401' }) }, 'fatal'],
    ['config_invalid variant', { sends: both({ state: 'FAILED', lastErrorKind: 'FATAL', lastError: 'config_invalid: x' }) }, 'config_invalid'],
    ['provider failed', { sends: both({ state: 'FAILED', lastError: 'provider_failed: nobody reached' }) }, 'provider_failed'],
    ['unconfirmed at cut-off', { sends: both({ state: 'FAILED', lastError: 'not_confirmed_by_cutoff' }) }, 'not_confirmed_by_cutoff'],
    ['ambiguous create', { sends: both({ state: 'FAILED', lastErrorKind: 'AMBIGUOUS', lastError: 'create_unconfirmed' }) }, 'ambiguous'],
    ['build failed', { run: { ...base.run!, build: 'BUILD_FAILED' }, sends: [] }, 'build_failed'],
    ['sanity hold', { run: { ...base.run!, approval: 'PENDING', candidateCount: 400 }, sends: both({ state: 'CREATED' }) }, 'sanity_hold'],
    ['sanity hold but approved → silent while scheduled', { run: { ...base.run!, candidateCount: 400 }, sends: both({ state: 'SCHEDULED' }) }, null],
    ['skipped: too little news → silent', { run: { ...base.run!, build: 'SKIPPED', skipReason: 'too_little_news' }, sends: [] }, null],
    ['skipped: not approved', { run: { ...base.run!, build: 'SKIPPED', skipReason: 'not_approved' }, sends: [] }, 'skipped'],
    ['skipped: config_invalid', { run: { ...base.run!, build: 'SKIPPED', skipReason: 'config_invalid' }, sends: [] }, 'skipped'],
    ['skipped variants: cut-off passed', { run: { ...base.run!, skipReason: 'cutoff_passed' }, sends: both({ state: 'SKIPPED' }) }, 'skipped'],
    [
      'preview mode: routine cut-off skip → silent',
      { cfg: { ...base.cfg, sendLive: false }, run: { ...base.run!, skipReason: 'cutoff_passed' }, sends: both({ state: 'SKIPPED' }) },
      null,
    ],
    ['partially sent', { sends: [base.sends[0], { ...base.sends[1], state: 'PARTIALLY_SENT' }] }, 'partially_sent'],
    ['awaiting approval past send time', { run: { ...base.run!, approval: 'PENDING' }, sends: both({ state: 'CREATED' }) }, 'awaiting_approval'],
    ['awaiting approval before send time → silent', { now: ist(7, 0), run: { ...base.run!, approval: 'PENDING' }, sends: both({ state: 'CREATED' }) }, null],
    ['held by an editor (deliberate) → silent', { run: { ...base.run!, approval: 'HELD' }, sends: both({ state: 'CREATED' }) }, null],
    ['preview mode, created, pending → silent', { cfg: { ...base.cfg, sendLive: false }, run: { ...base.run!, approval: 'PENDING' }, sends: both({ state: 'CREATED' }) }, null],
    ['retrying a temporary error', { sends: both({ state: 'PENDING', lastError: '503', lastErrorKind: 'RETRYABLE' }) }, 'retrying'],
    ['scheduled, waiting for confirmation → silent', { sends: both({ state: 'SCHEDULED' }) }, null],
  ])('%s', (_name, over, expected) => {
    expect(code(over)).toBe(expected);
  });

  it('every attention carries a one-line action and the Digests link', () => {
    const a = digestAttention({ ...base, sends: both({ state: 'FAILED', lastErrorKind: 'FATAL' }) });
    expect(a).toMatchObject({ link: '/digests' });
    expect(a?.action).toMatch(/Retry now/);
  });
});
