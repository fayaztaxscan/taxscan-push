import { prisma } from '../lib/prisma';
import type { EmailMessage, EmailSender } from '../lib/email';
import { reportRecipientEmails, sendScheduledReport } from '../services/reportScheduler';

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

afterAll(async () => {
  if (campaignIds.length) await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (recipientIds.length) await prisma.reportRecipient.deleteMany({ where: { id: { in: recipientIds } } });
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
    const c1 = await prisma.campaign.create({
      data: { portal, title: 'Bombay HC ruling [Read Order]', body: '.', url: 'https://taxscan.in', target: { type: 'all' }, status: 'DRAFT', categories: ['Income Tax'], createdAt: ist(2026, 6, 16, 10) },
    });
    const c2 = await prisma.campaign.create({
      data: { portal, title: 'Relief: ITAT [Read Order]', body: '.', url: 'https://taxscan.in', target: { type: 'all' }, status: 'DRAFT', categories: ['Income Tax'], createdAt: ist(2026, 6, 17, 10) },
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
