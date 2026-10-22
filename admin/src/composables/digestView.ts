/**
 * Small pure helpers for the Digests screen. Every decision about what may be
 * pressed is made by the server (`actions` in GET /api/digest/runs/:id); these
 * only turn payload values into words.
 */

export type Audience = 'FREE' | 'PREMIUM';
export type SendState = 'PENDING' | 'CREATED' | 'SCHEDULED' | 'SENT' | 'PARTIALLY_SENT' | 'FAILED' | 'SKIPPED';
export type RunState = 'building' | 'created' | 'scheduled' | 'sent' | 'partially_sent' | 'failed' | 'skipped';

export const AUDIENCES: Audience[] = ['FREE', 'PREMIUM'];
export const AUDIENCE_LABEL: Record<Audience, string> = { FREE: 'Free', PREMIUM: 'Premium' };

// UNVERIFIED: Mailercloud's campaign page URL pattern — confirm in the account
// (design §12 open question 3) before relying on it. The one place it lives.
export const MAILERCLOUD_CAMPAIGN_URL = (campaignId: string) =>
  `https://app.mailercloud.com/campaigns/${encodeURIComponent(campaignId)}`;

/** A variant's state in the editor's words. `sendLive` off turns a ready draft into "Preview only". */
export function sendStateLabel(state: SendState, sendLive: boolean): string {
  switch (state) {
    case 'PENDING':
      return 'Building';
    case 'CREATED':
      return sendLive ? 'Ready' : 'Preview only';
    case 'SCHEDULED':
      return 'Sending';
    case 'SENT':
      return 'Sent';
    case 'PARTIALLY_SENT':
      return 'Partly sent';
    case 'FAILED':
      return 'Failed';
    case 'SKIPPED':
      return 'Skipped';
  }
}

/** Reuses the app's existing badge colours: green sent, amber in flight / partial, red failed, grey otherwise. */
export function sendStateBadge(state: SendState): string {
  if (state === 'SENT') return 'SENT';
  if (state === 'SCHEDULED' || state === 'PARTIALLY_SENT') return 'SCHEDULED';
  if (state === 'FAILED') return 'FAILED';
  return 'DRAFT';
}

export function runStateLabel(state: RunState): string {
  const words: Record<RunState, string> = {
    building: 'Building',
    created: 'Drafts ready',
    scheduled: 'Sending',
    sent: 'Sent',
    partially_sent: 'Partly sent',
    failed: 'Failed',
    skipped: 'Skipped',
  };
  return words[state];
}

export function approvalLabel(approval: string, approvedBy: string | null, approvedAt: string | null): string {
  if (approval === 'APPROVED') {
    const at = approvedAt ? ` at ${timeIst(approvedAt)}` : '';
    return approvedBy ? `Approved by ${approvedBy}${at}` : `Approved${at}`;
  }
  if (approval === 'HELD') return 'Held by an editor — it will not send until approved';
  if (approval === 'PENDING') return 'Waiting for approval';
  return 'No approval needed';
}

/** Why a story ranked where it did. */
export function readLabel(basis: 'reads' | 'new' | 'none', readRate: number | null): string {
  if (basis === 'reads' && readRate !== null) {
    const r = readRate >= 10 ? Math.round(readRate) : Math.round(readRate * 10) / 10;
    return `${r.toLocaleString()} reads/h`;
  }
  if (basis === 'new') return 'new — neutral';
  return '—';
}

/** "—" for missing, never 0. */
export function count(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString();
}

export function timeIst(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
}

export function dateLabel(runDate: string): string {
  // runDate is the IST calendar date (yyyy-mm-dd); format it without shifting the day.
  const [y, m, d] = runDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
