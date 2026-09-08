import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import type { EmailMessage, EmailSender } from '../lib/email';
import {
  lastReportEmailRun,
  reportRecipientEmails,
  sendScheduledReport,
} from '../services/reportScheduler';

const app = createApp();
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(y: number, m: number, d: number, h = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h) - IST_OFFSET_MIN * 60 * 1000);
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const campaignIds: string[] = [];
const userIds: string[] = [];
const recipientIds: string[] = [];

function recordingSender(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sender: async (m) => (sent.push(m), { ok: true }), sent };
}

/** A sender that fails every recipient the way an expired plan does. */
const failingSender =
  (error: string): EmailSender =>
  async () => ({ ok: false, error });

const runPortals: string[] = [];

afterAll(async () => {
  if (campaignIds.length) await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (recipientIds.length) await prisma.reportRecipient.deleteMany({ where: { id: { in: recipientIds } } });
  if (runPortals.length) await prisma.reportEmailRun.deleteMany({ where: { portal: { in: runPortals } } });
  await prisma.$disconnect();
});

describe('reportRecipientEmails', () => {
  it('returns active users + active report-only emails, deduped, excludes inactive', async () => {
    const tag = uniq();
    const activeUserEmail = `active-${tag}@x.com`;
    const inactiveUserEmail = `inactive-${tag}@x.com`;
    const extraEmail = `extra-${tag}@x.com`;
    const u1 = await prisma.user.create({ data: { email: activeUserEmail, passwordHash: 'x', role: 'PUBLISHER', isActive: true } });
    const u2 = await prisma.user.create({ data: { email: inactiveUserEmail, passwordHash: 'x', role: 'PUBLISHER', isActive: false } });
    userIds.push(u1.id, u2.id);
    const r1 = await prisma.reportRecipient.create({ data: { email: extraEmail, active: true } });
    const r2 = await prisma.reportRecipient.create({ data: { email: `off-${tag}@x.com`, active: false } });
    // a report-only row duplicating the active user's email → must dedup
    const r3 = await prisma.reportRecipient.create({ data: { email: activeUserEmail, active: true } });
    recipientIds.push(r1.id, r2.id, r3.id);

    const emails = await reportRecipientEmails();
    expect(emails).toEqual(expect.arrayContaining([activeUserEmail, extraEmail]));
    expect(emails).not.toContain(inactiveUserEmail);
    expect(emails).not.toContain(`off-${tag}@x.com`);
    expect(emails.filter((e) => e === activeUserEmail)).toHaveLength(1); // deduped
  });
});

describe('sendScheduledReport', () => {
  it('builds the report for the window and emails every recipient', async () => {
    const portal = `test-reportsched-${uniq()}`;
    runPortals.push(portal);
    const c1 = await prisma.campaign.create({
      data: { portal, title: 'Bombay HC ruling [Read Order]', body: '.', url: 'https://taxscan.in/bombay/1', target: { type: 'all' }, status: 'DRAFT', categories: ['Income Tax'], createdAt: ist(2026, 6, 16, 10) },
    });
    const c2 = await prisma.campaign.create({
      data: { portal, title: 'Relief: ITAT [Read Order]', body: '.', url: 'https://taxscan.in/itat/2', target: { type: 'all' }, status: 'DRAFT', categories: ['Income Tax'], createdAt: ist(2026, 6, 17, 10) },
    });
    campaignIds.push(c1.id, c2.id);

    const { sender, sent } = recordingSender();
    const res = await sendScheduledReport({
      period: 'weekly',
      now: ist(2026, 6, 22, 9), // window 06-15..06-21
      portal,
      recipients: ['a@team.com', 'b@team.com'],
      sender,
    });

    expect(res).toMatchObject({ period: 'weekly', recipients: 2, sent: 2, failed: 0, total: 2 });
    expect(sent.map((m) => m.to).sort()).toEqual(['a@team.com', 'b@team.com']);
    expect(sent[0].subject).toContain('Weekly Coverage Report');
    expect(sent[0].html).toContain('Bombay High Court'); // bench heatmap rendered
    expect(sent[0].html).toContain('ITAT');
  });
});

/**
 * A scheduled send that fails must leave a trace the product can show. Before
 * this, the only record of a failed run was a console line in the deploy logs:
 * the 2026-08-31 weekly and 2026-09-01 monthly both sent 0 of 6 (the email
 * provider's plan had expired) and it went unnoticed for a week.
 */
describe('report email run bookkeeping', () => {
  it('records a failed run with the provider error, and lastReportEmailRun returns it', async () => {
    const portal = `test-runrec-${uniq()}`;
    runPortals.push(portal);

    const res = await sendScheduledReport({
      period: 'weekly',
      now: ist(2026, 8, 31, 7),
      portal,
      recipients: ['a@team.com', 'b@team.com'],
      sender: failingSender('ElasticEmail responded 400: {"Error":"Your plan expired."}'),
    });
    expect(res).toMatchObject({ recipients: 2, sent: 0, failed: 2 });

    const run = await lastReportEmailRun(portal);
    expect(run).toMatchObject({ period: 'weekly', recipients: 2, sent: 0, failed: 2 });
    expect(run?.error).toContain('Your plan expired.');
  });

  it('records a successful run with no error, so the warning clears itself', async () => {
    const portal = `test-runrec-${uniq()}`;
    runPortals.push(portal);
    const { sender } = recordingSender();

    await sendScheduledReport({
      period: 'weekly',
      now: ist(2026, 9, 7, 7),
      portal,
      recipients: ['a@team.com'],
      sender,
    });

    const run = await lastReportEmailRun(portal);
    expect(run).toMatchObject({ sent: 1, failed: 0, error: null });
  });

  it('keeps the newest run when several have happened', async () => {
    const portal = `test-runrec-${uniq()}`;
    runPortals.push(portal);
    const { sender } = recordingSender();

    await sendScheduledReport({
      period: 'weekly',
      now: ist(2026, 8, 31, 7),
      portal,
      recipients: ['a@team.com'],
      sender: failingSender('boom'),
    });
    await sendScheduledReport({
      period: 'monthly',
      now: ist(2026, 9, 1, 7),
      portal,
      recipients: ['a@team.com'],
      sender,
    });

    const run = await lastReportEmailRun(portal);
    expect(run).toMatchObject({ period: 'monthly', failed: 0 });
  });

  it('does NOT record when record:false — a personal test must not set the banner', async () => {
    const portal = `test-runrec-${uniq()}`;
    runPortals.push(portal);

    await sendScheduledReport({
      period: 'weekly',
      now: ist(2026, 9, 7, 7),
      portal,
      recipients: ['me@team.com'],
      sender: failingSender('provider down'),
      record: false,
    });

    expect(await lastReportEmailRun(portal)).toBeNull();
  });
});

describe('GET /api/reports/email-status', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/reports/email-status');
    expect(res.status).toBe(401);
  });

  it('reports the last scheduled run', async () => {
    // The route reads the configured portal, so drive it through that one and
    // clean up after: this is the portal the real crons write to.
    const portal = process.env.RSS_PORTAL || 'taxscan';
    const before = await prisma.reportEmailRun.findMany({ where: { portal }, select: { id: true } });
    const keep = new Set(before.map((r) => r.id));

    await sendScheduledReport({
      period: 'weekly',
      now: ist(2026, 8, 31, 7),
      portal,
      recipients: ['a@team.com'],
      sender: failingSender('ElasticEmail responded 400: {"Error":"Your plan expired."}'),
    });

    const res = await request(app).get('/api/reports/email-status').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.lastRun).toMatchObject({ period: 'weekly', sent: 0, failed: 1 });
    expect(res.body.lastRun.error).toContain('Your plan expired.');

    const after = await prisma.reportEmailRun.findMany({ where: { portal }, select: { id: true } });
    const mine = after.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (mine.length) await prisma.reportEmailRun.deleteMany({ where: { id: { in: mine } } });
  });
});
