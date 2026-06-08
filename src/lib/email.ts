/**
 * Transactional email (Phase 8 of USER_MANAGEMENT_PLAN.md — email invites).
 *
 * Provider: ElasticEmail v4 transactional API. The sender is an injectable
 * function (`EmailSender`) — production wires the real ElasticEmail call;
 * tests pass an in-memory stub, exactly like the push `Sender` seam in
 * src/services/send.ts.
 *
 * Graceful degradation: email is OPTIONAL infrastructure. If the provider
 * isn't configured (no API key / no from-address), `isEmailConfigured()`
 * returns false and the invite route falls back to handing the admin the
 * accept link to share manually. A missing email provider must never block
 * the invite itself.
 */

import { env } from './env';

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type EmailSendResult = { ok: true } | { ok: false; error: string };

export type EmailSender = (msg: EmailMessage) => Promise<EmailSendResult>;

/** True when both an API key and a from-address are present. */
export function isEmailConfigured(): boolean {
  return Boolean(env.email.apiKey && env.email.from);
}

const ELASTICEMAIL_ENDPOINT = 'https://api.elasticemail.com/v4/emails/transactional';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Real sender — posts a single transactional email to ElasticEmail. Returns
 * a result object rather than throwing so callers can treat delivery as
 * best-effort. Network/timeout/non-2xx all collapse to `{ ok: false, error }`.
 */
export const elasticEmailSender: EmailSender = async (msg) => {
  if (!isEmailConfigured()) {
    return { ok: false, error: 'email provider not configured' };
  }
  const from = env.email.fromName
    ? `${env.email.fromName} <${env.email.from}>`
    : env.email.from;

  try {
    const res = await fetch(ELASTICEMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ElasticEmail-ApiKey': env.email.apiKey,
      },
      body: JSON.stringify({
        Recipients: { To: [msg.to] },
        Content: {
          From: from,
          Subject: msg.subject,
          Body: [
            { ContentType: 'HTML', Content: msg.html },
            { ContentType: 'PlainText', Content: msg.text },
          ],
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        error: `ElasticEmail responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
};

/**
 * Default sender used when the app doesn't inject one. Delegates to
 * ElasticEmail when configured; otherwise reports not-configured so the
 * caller takes the manual-link fallback.
 */
export const defaultEmailSender: EmailSender = (msg) => elasticEmailSender(msg);

/**
 * Renders the invite email. Plain, link-forward, no images — deliverability
 * over polish. The link is the single call to action; the raw URL is repeated
 * in text so it survives HTML-stripping mail clients.
 */
export function buildInviteEmail(opts: {
  inviteUrl: string;
  role: string;
  inviterEmail?: string | null;
  expiresAt: Date;
}): { subject: string; html: string; text: string } {
  const roleLabel = opts.role === 'ADMIN' ? 'an administrator' : 'a publisher';
  const inviter = opts.inviterEmail ? ` by ${escapeHtml(opts.inviterEmail)}` : '';
  const inviterText = opts.inviterEmail ? ` by ${opts.inviterEmail}` : '';
  const expires = opts.expiresAt.toUTCString();

  const subject = 'You have been invited to Taxscan Push';

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.5;">
    <p>Hello,</p>
    <p>You have been invited${inviter} to join <strong>Taxscan Push</strong> as ${roleLabel}.</p>
    <p>Click the button below to set your password and activate your account:</p>
    <p>
      <a href="${escapeHtml(opts.inviteUrl)}"
         style="display: inline-block; background: #1463ff; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600;">
        Accept invitation
      </a>
    </p>
    <p style="font-size: 13px; color: #555;">
      Or paste this link into your browser:<br>
      <a href="${escapeHtml(opts.inviteUrl)}">${escapeHtml(opts.inviteUrl)}</a>
    </p>
    <p style="font-size: 13px; color: #555;">
      This invitation expires on <strong>${escapeHtml(expires)}</strong>. If it has
      expired, ask an administrator to send a new one. If you weren't expecting this
      invitation you can safely ignore this email.
    </p>
  </body>
</html>`;

  const text = [
    'Hello,',
    '',
    `You have been invited${inviterText} to join Taxscan Push as ${roleLabel}.`,
    '',
    'Open this link to set your password and activate your account:',
    opts.inviteUrl,
    '',
    `This invitation expires on ${expires}. If it has expired, ask an administrator`,
    "to send a new one. If you weren't expecting this invitation you can ignore this email.",
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
