import { prisma } from '../../lib/prisma';
import { safeErrorLog } from '../../lib/httpErrors';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { istDay } from '../whatsapp/queue';
import { channelName, getPageStatus, istClock, pageLabel, type PageStatus } from './pageStatus';
import type { SocialChannel } from './pause';

/**
 * The alert for a page that stops posting (brief 2026-11-09-social-page-alerts-pause). An email (ElasticEmail, the active ADMINs, like the
 * existing social stop alerts) when a page enters `held` (LinkedIn's daily limit) or `failing` (its last 2 finished posts FAILED):
 * ONE email per page per kind per IST day, saying the page, the reason in words, since when, when it resumes (if known) and what to do.
 *
 * The existing stop alerts (LinkedIn / Facebook token, Facebook policy, Telegram channel) stay as they are and are NEVER sent again from
 * here: a `stopped` page is not alerted by this module, and neither is a paused one (nobody is posting; an admin did it on purpose).
 * Not for `quota_headroom`, `compose_skip` or WhatsApp.
 *
 * What was sent is remembered in `DigestSetting` (`social:alert:<channel>:<page>:<kind>` = `{ day }`, the IST day), like the stop markers.
 * Called by each worker right after an attempt ends in a failure or a hold (event-driven: no extra tick). Never throws. The email holds
 * ONLY the page, our own words and a short reason code: never a token, a URL, or the provider's own message.
 */

export type AlertKind = 'held' | 'failing';
export const alertKey = (channel: SocialChannel, page: string, kind: AlertKind): string => `social:alert:${channel}:${page}:${kind}`;

export type AlertDeps = {
  emailSender?: EmailSender;
  isEmailConfigured?: () => boolean;
  /** Active ADMIN emails; default reads the User table. */
  recipients?: () => Promise<string[]>;
};

export type AlertResult = 'sent' | 'already_today' | 'not_alertable' | 'email_not_configured' | 'no_recipients';

async function defaultRecipients(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true, role: 'ADMIN' }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.trim().toLowerCase()))];
}

/** The email for a status (pure): subject + text. */
export function alertEmail(s: PageStatus, now: Date): { subject: string; text: string } | null {
  const label = pageLabel(s.channel, s.page);
  const since = s.since ? istClock(new Date(s.since), now) : 'just now';
  const where = `Open SOCIAL → ${channelName(s.channel)} in the admin`;
  if (s.status === 'held') {
    return {
      subject: `${label}: posting is held (LinkedIn's daily limit for this page)`,
      text:
        `LinkedIn refused new posts for the ${label} page ("Organization post creation limit reached"), so Taxscan Push has stopped asking for it.\n\n` +
        `Held since ${since}${s.resumesAt ? `; it posts again from ${istClock(new Date(s.resumesAt), now)}` : ''}. Every push in between is skipped on this page and is NOT posted later; the other pages are not affected.\n\n` +
        `Nothing is broken and nothing needs fixing. If this happens every day, the page is being given more posts than LinkedIn allows it: you can Pause it from its Social screen so pushes are skipped on purpose. ${where} to see the skipped rows.`,
    };
  }
  if (s.status === 'failing') {
    return {
      subject: `${label}: the last ${s.failures} posts failed`,
      text:
        `The last ${s.failures} posts to the ${label} page failed (${s.detail ?? 'see the failed rows'}), with no successful post after them. Since ${since}.\n\n` +
        `What to do: ${where}, look at the failed rows and their reasons, then Retry or Skip them. If it keeps failing, an administrator can Pause the page there: pushes are then skipped on purpose instead of retried, and posting starts again from the next push after Resume.`,
    };
  }
  return null;
}

/**
 * Send the alert for `channel` / `page` if it is `held` or `failing` and not already sent for that kind today (IST). Never throws.
 */
export async function alertIfNeeded(channel: SocialChannel, page: string, now: Date, d: AlertDeps = {}): Promise<AlertResult> {
  try {
    const status = await getPageStatus(channel, page, now);
    if (status.status !== 'held' && status.status !== 'failing') return 'not_alertable';
    const kind: AlertKind = status.status;
    const key = alertKey(channel, page, kind);
    const today = istDay(now);
    const prev = await prisma.digestSetting.findUnique({ where: { key } });
    if (prev) {
      try {
        if ((JSON.parse(prev.value) as { day?: string }).day === today) return 'already_today';
      } catch {
        // a damaged marker counts as none
      }
    }
    if (!(d.isEmailConfigured ?? isEmailConfigured)()) return 'email_not_configured';
    const to = await (d.recipients ?? defaultRecipients)();
    if (to.length === 0) return 'no_recipients';
    const mail = alertEmail(status, now);
    if (!mail) return 'not_alertable';
    // Remember first: a failed send must not become a mail every minute.
    const value = JSON.stringify({ day: today });
    await prisma.digestSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    const send = d.emailSender ?? defaultEmailSender;
    const html = `<p>${mail.text.replace(/\n\n/g, '</p><p>')}</p>`;
    for (const addr of to) await send({ to: addr, subject: mail.subject, html, text: mail.text });
    return 'sent';
  } catch (err) {
    console.error('[social-alert] failed', safeErrorLog(err));
    return 'not_alertable';
  }
}
