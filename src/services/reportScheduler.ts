import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../lib/email';
import { buildReport, renderReportEmail, reportWindow } from './reports';

/**
 * Weekly/monthly coverage-report emails (SEND_PACING_PLAN.md / reports).
 * Recipients = active app users (User.email) + active report-only emails
 * (ReportRecipient), deduped. Internal — never sent to push subscribers.
 */

export type ReportRunResult = {
  period: 'weekly' | 'monthly';
  recipients: number;
  sent: number;
  failed: number;
  total: number;
};

/** Active app-user emails + active report-only emails, deduped (lowercased). */
export async function reportRecipientEmails(): Promise<string[]> {
  const [users, extra] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true }, select: { email: true } }),
    prisma.reportRecipient.findMany({ where: { active: true }, select: { email: true } }),
  ]);
  const set = new Set<string>();
  for (const u of users) set.add(u.email.trim().toLowerCase());
  for (const r of extra) set.add(r.email.trim().toLowerCase());
  return [...set];
}

export async function sendScheduledReport(opts: {
  period: 'weekly' | 'monthly';
  now?: Date;
  sender?: EmailSender;
  portal?: string;
  recipients?: string[];
}): Promise<ReportRunResult> {
  const now = opts.now ?? new Date();
  const sender = opts.sender ?? defaultEmailSender;
  const portal = opts.portal ?? env.rss.portal;

  const { start, end } = reportWindow(opts.period, now);
  const report = await buildReport({ portal, period: opts.period, start, end });
  const { subject, html, text } = renderReportEmail(report);

  const emails = opts.recipients ?? (await reportRecipientEmails());
  let sent = 0;
  let failed = 0;
  for (const to of emails) {
    const r = await sender({ to, subject, html, text });
    if (r.ok) sent += 1;
    else {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error('[report] email failed', { to, error: r.error });
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[report] ${opts.period} sent=${sent} failed=${failed} recipients=${emails.length} articles=${report.total}`,
  );
  return { period: opts.period, recipients: emails.length, sent, failed, total: report.total };
}

let started = false;

export function startReportScheduler(): void {
  if (!env.reports.enabled) {
    // eslint-disable-next-line no-console
    console.log('[report] disabled (set REPORTS_ENABLED=true to start)');
    return;
  }
  if (!isEmailConfigured()) {
    // eslint-disable-next-line no-console
    console.warn('[report] email not configured (ELASTICEMAIL_API_KEY/EMAIL_FROM) — scheduler not started');
    return;
  }
  for (const c of [env.reports.weeklyCron, env.reports.monthlyCron]) {
    if (!cron.validate(c)) throw new Error(`Invalid report cron: ${c}`);
  }
  if (started) return;
  started = true;

  cron.schedule(
    env.reports.weeklyCron,
    () => {
      void sendScheduledReport({ period: 'weekly' }).catch((e) =>
        // eslint-disable-next-line no-console
        console.error('[report] weekly run failed', e),
      );
    },
    { timezone: env.rss.tz },
  );
  cron.schedule(
    env.reports.monthlyCron,
    () => {
      void sendScheduledReport({ period: 'monthly' }).catch((e) =>
        // eslint-disable-next-line no-console
        console.error('[report] monthly run failed', e),
      );
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(
    `[report] scheduled weekly="${env.reports.weeklyCron}" monthly="${env.reports.monthlyCron}" tz=${env.rss.tz}`,
  );
}
