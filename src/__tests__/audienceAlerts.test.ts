/**
 * Audience alert emails (brief 2026-11-09-audience-alert-fixes): the email is dated by the IST calendar
 * day of the instant it is sent — not the previous day for an alert raised 00:00–05:29 IST — and the
 * "Mailercloud refused a contact write" alert says what that refusal almost always is.
 * Email goes to an in-memory sender and an injected recipient list; never a real address.
 */
import { prisma } from '../lib/prisma';
import { raiseAudienceAlert, sendAudienceAlerts, type AudienceAlertKind } from '../services/audience/alerts';

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PORTAL = `test-audience-alerts-${RUN}`;
const READER = 'reader.person@example.org';

type Sent = { to: string; subject: string; html: string; text: string };

/** Raise `kind` at `at`, send the pass at `at`, return the one email that went out. */
async function raiseAndSend(tag: string, kind: AudienceAlertKind, detail: Record<string, string | number>, at: string): Promise<Sent> {
  const portal = `${PORTAL}-${tag}`;
  const now = new Date(at);
  expect(await raiseAudienceAlert(portal, kind, detail, now)).toBe(true);
  const sent: Sent[] = [];
  const emailed = await sendAudienceAlerts(portal, {
    emailSender: async (m) => {
      sent.push(m as Sent);
      return { ok: true };
    },
    isConfigured: () => true,
    recipients: async () => ['admin@test.invalid'],
    now,
  });
  expect(emailed).toEqual([kind]);
  expect(sent).toHaveLength(1);
  return sent[0];
}

afterAll(async () => {
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

describe('the alert email is dated by the IST day', () => {
  it('8 Nov 04:31 IST (= 7 Nov 23:01 UTC): subject and first line say 2026-11-08, not 2026-11-07', async () => {
    const m = await raiseAndSend('a1', 'audience_breaker_open', { reason: 'truncated_load' }, '2026-11-07T23:01:00Z');
    expect(m.subject).toBe('[Taxscan digest] Audience sync paused — needs review — 2026-11-08');
    expect(m.text.split('\n')[0]).toBe('Daily email digest, 2026-11-08');
    expect(m.html).toContain('Daily email digest, 2026-11-08');
  });

  it('22:02 IST on 8 Nov (16:32 UTC) is dated 2026-11-08', async () => {
    const m = await raiseAndSend('a2', 'audience_writer_fatal', { count: 1, reason: 'contact_write' }, '2026-11-08T16:32:00Z');
    expect(m.subject).toMatch(/ — 2026-11-08$/);
    expect(m.text.split('\n')[0]).toBe('Daily email digest, 2026-11-08');
  });

  it('00:01 IST on 9 Nov (18:31 UTC on 8 Nov) is dated 2026-11-09', async () => {
    const m = await raiseAndSend('a3', 'audience_writer_fatal', { count: 1, reason: 'contact_write' }, '2026-11-08T18:31:00Z');
    expect(m.subject).toMatch(/ — 2026-11-09$/);
    expect(m.text.split('\n')[0]).toBe('Daily email digest, 2026-11-09');
  });

  it('the IST day boundary: 18:29:59 UTC is still 8 Nov IST, 18:30:00 UTC is 9 Nov', async () => {
    const before = await raiseAndSend('b1', 'seq_conflict', { count: 1 }, '2026-11-08T18:29:59Z');
    const after = await raiseAndSend('b2', 'seq_conflict', { count: 1 }, '2026-11-08T18:30:00Z');
    expect(before.subject).toMatch(/ — 2026-11-08$/);
    expect(after.subject).toMatch(/ — 2026-11-09$/);
  });
});

describe('audience_writer_fatal, end to end through the audience alert path', () => {
  it('a single refused contact: names the usual cause, says nothing to do, does not send the reader to the key', async () => {
    const m = await raiseAndSend('f1', 'audience_writer_fatal', { count: 1, reason: 'contact_write' }, '2026-11-08T16:32:00Z');
    expect(m.subject).toContain('Mailercloud refused a contact write');
    for (const part of [m.text, m.html]) {
      expect(part).toContain('hard-bounced in the past');
      expect(part).toContain('Nothing to do');
      expect(part).not.toContain('MAILERCLOUD_SYNC_API_KEY');
    }
  });

  it('a marker without a count is treated as one refusal', async () => {
    const m = await raiseAndSend('f2', 'audience_writer_fatal', { reason: 'contact_write' }, '2026-11-08T16:32:00Z');
    expect(m.text).toContain('refused 1 contact write(s)');
    expect(m.text).toContain('Nothing to do');
  });

  it('eleven refusals in a day: points at the key, the ids, the quota and Retry refused', async () => {
    const m = await raiseAndSend('f3', 'audience_writer_fatal', { count: 11, reason: 'contact_write' }, '2026-11-08T16:32:00Z');
    expect(m.text).toContain('refused 11 contact write(s)');
    expect(m.text).toContain('MAILERCLOUD_SYNC_API_KEY');
    expect(m.text).toContain('Retry refused');
    expect(m.text).not.toContain('Nothing to do');
  });

  it('a count raised again the same IST day refreshes the marker, and the email uses the refreshed count', async () => {
    const portal = `${PORTAL}-f4`;
    const t = new Date('2026-11-08T16:32:00Z');
    expect(await raiseAudienceAlert(portal, 'audience_writer_fatal', { count: 1, reason: 'contact_write' }, t)).toBe(true);
    expect(await raiseAudienceAlert(portal, 'audience_writer_fatal', { count: 25, reason: 'contact_write' }, new Date(t.getTime() + 60_000))).toBe(false);
    const sent: Sent[] = [];
    await sendAudienceAlerts(portal, {
      emailSender: async (m) => {
        sent.push(m as Sent);
        return { ok: true };
      },
      isConfigured: () => true,
      recipients: async () => ['admin@test.invalid'],
      now: new Date(t.getTime() + 120_000),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('refused 25 contact write(s)');
    expect(sent[0].text).toContain('MAILERCLOUD_SYNC_API_KEY');
  });

  it('an address in the stored reason never reaches the email or a log line', async () => {
    const before = logs.length;
    const m = await raiseAndSend(
      'f5',
      'audience_writer_fatal',
      { count: 2, reason: `HTTP 400: Invalid email ${READER} or reader%40example.org` },
      '2026-11-08T16:32:00Z',
    );
    for (const part of [m.subject, m.text, m.html, ...logs.slice(before)]) {
      expect(part).not.toContain(READER);
      expect(part).not.toContain('reader%40example.org');
      expect(part).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
  });
});
