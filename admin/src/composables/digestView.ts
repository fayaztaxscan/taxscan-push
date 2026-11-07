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

/** The preview widths (design §7: phone 375, tablet 768, desktop 1024), shared by Digests and Templates. */
export const PREVIEW_WIDTHS = [
  { key: 'phone', label: 'Phone', px: 375 },
  { key: 'tablet', label: 'Tablet', px: 768 },
  { key: 'desktop', label: 'Desktop', px: 1024 },
] as const;
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number];

/* ------------------------------------------------------------------ */
/* What Retry now / Send now actually did                              */
/* ------------------------------------------------------------------ */

/** One version's outcome after a press, as the server read it back (`result.audiences`). */
export type VersionOutcome = { state: SendState; error: string | null; errorKind: string | null };
export type DoorResult = { state: RunState | null; steps?: string[]; audiences?: Partial<Record<Audience, VersionOutcome>> };
export type DoorMessage = { tone: 'ok' | 'err'; text: string };

/** The short reason a version shows (its last error), trimmed to one readable clause. */
export function shortReason(error: string | null): string {
  const t = (error ?? '').replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');
  if (!t) return 'it did not work';
  return t.length > 140 ? `${t.slice(0, 139).trimEnd()}…` : t;
}

const MADE: ReadonlySet<SendState> = new Set<SendState>(['CREATED', 'SCHEDULED', 'SENT', 'PARTIALLY_SENT']);
const HANDED: ReadonlySet<SendState> = new Set<SendState>(['SCHEDULED', 'SENT', 'PARTIALLY_SENT']);

/** "Free", "Premium", or "Free and Premium". */
const names = (list: Audience[]) => list.map((a) => AUDIENCE_LABEL[a]).join(' and ');

/**
 * The message under Digests after Retry now or Send now. It reports what happened to each version,
 * read from the server's per-version outcome — never a fixed success sentence (29 Oct 2026: a retry
 * Mailercloud refused twice was announced, in green, as "the draft is made").
 *  - green only when every version this press concerned is in the state it claims;
 *  - a version that failed (FAILED, or waiting with an error) turns it red, naming each reason;
 *  - partly made says which version was made and which failed.
 * `sendLive` off = preview mode: a retry makes drafts and sends nothing.
 */
export function doorMessage(kind: 'retry' | 'send_now', sendLive: boolean, r: DoorResult): DoorMessage {
  const run = r.state ? runStateLabel(r.state).toLowerCase() : 'unchanged';
  const rows = AUDIENCES.flatMap((a) => (r.audiences?.[a] ? [{ a, o: r.audiences[a] as VersionOutcome }] : []));
  const failed = rows.filter(({ o }) => o.state === 'FAILED' || (o.state === 'PENDING' && !!o.error));
  const made = rows.filter(({ o }) => MADE.has(o.state));
  const handed = rows.filter(({ o }) => HANDED.has(o.state));
  const reasons = (list: typeof rows) => list.map(({ a, o }) => `${AUDIENCE_LABEL[a]} — ${shortReason(o.error)}`).join('; ');
  const verb = kind === 'retry' ? "Retry didn't work" : "Send now didn't work";

  if (failed.length > 0) {
    if (kind === 'retry' && !sendLive && made.length > 0) {
      return { tone: 'err', text: `Retry only partly worked: the ${names(made.map((m) => m.a))} draft is made in Mailercloud; ${reasons(failed)}. Nothing was sent.` };
    }
    if (kind === 'send_now' && handed.length > 0) {
      return { tone: 'err', text: `Only the ${names(handed.map((m) => m.a))} digest was handed to Mailercloud. ${reasons(failed)}.` };
    }
    return { tone: 'err', text: `${verb}: ${reasons(failed)}. Nothing was sent.` };
  }
  if (handed.length > 0 && handed.length === rows.length) return { tone: 'ok', text: 'Handed to Mailercloud. It is sending now.' };
  if (kind === 'retry' && !sendLive && made.length > 0 && made.length === rows.length) {
    const which = made.length === AUDIENCES.length ? 'both drafts are' : `the ${names(made.map((m) => m.a))} draft is`;
    return { tone: 'ok', text: `Retried in preview mode: ${which} made in Mailercloud, nothing is sent.` };
  }
  return { tone: 'ok', text: `Not sent yet. Today's digest is now: ${run}.` };
}

/* ------------------------------------------------------------------ */
/* DIGEST_FREE_MANUAL: the Free version goes out only on "Send Free"    */
/* ------------------------------------------------------------------ */

export type ManualFreeView = {
  state: SendState;
  pressedAt?: string | null;
  pressedBy?: string | null;
  notSentToday?: boolean;
  scheduledAt: string | null;
  sentConfirmedAt: string | null;
  sendAfter: string;
};

/**
 * The one plain line for a Free version that is manual-only. Never "waiting for approval" (Approve does not cover it);
 * a day nobody pressed it is "Not sent today" — routine, not a fault. Null = say nothing special (the usual notes apply).
 */
export function manualFreeNote(v: ManualFreeView): string | null {
  if (v.notSentToday) return 'Nobody pressed Send Free before the cut-off. That is normal; nothing is wrong.';
  if (v.state === 'SKIPPED' || v.state === 'FAILED') return null;
  const pressed = v.pressedAt
    ? `Send Free pressed${v.pressedBy ? ` by ${v.pressedBy}` : ''} at ${timeIst(v.pressedAt)} IST.`
    : null;
  if (!pressed) return v.state === 'PENDING' || v.state === 'CREATED' ? 'Goes out only when someone presses Send Free.' : null;
  if (v.state === 'SENT' && v.sentConfirmedAt) return `${pressed} Confirmed sent at ${timeIst(v.sentConfirmedAt)} IST.`;
  if (v.state === 'SCHEDULED' && v.scheduledAt) return `${pressed} Handed to Mailercloud at ${timeIst(v.scheduledAt)} IST.`;
  return pressed;
}

/** The unsure-outcome sentence for Send Free (a press that got no reply). */
export const SEND_FREE_UNKNOWN =
  'No reply from the server in time — the Free digest may still be sending. Check this screen before pressing anything again.';

/** The Send Free confirm dialog's explanation, word for word as it has always read. */
export const SEND_FREE_CONFIRM_DETAIL =
  "It goes to the Free list straight away and only once today. Premium is not touched. A sent email can't be recalled.";

/** Added to that explanation when the Free digest targets a Mailercloud segment: the segment's count is only as fresh as its last refresh. */
export const SEND_FREE_SEGMENT_CHECK = 'Before you press: refresh the Free segment in Mailercloud and check its count.';

/** The same explanation when the Free digest targets a Mailercloud segment: the first sentence names the segment, not the list. */
export const SEND_FREE_CONFIRM_DETAIL_SEGMENT =
  "It goes to the Free segment straight away and only once today. Premium is not touched. A sent email can't be recalled.";

/** The Send Free dialog's title when the Free digest targets a segment: no number, because no stored figure describes the segment. */
export const SEND_FREE_CONFIRM_TITLE_SEGMENT = 'Free: the Free segment';

/**
 * The Send Free confirm dialog's detail text. With `freeTargetsSegment` (the server's boolean, never the segment id)
 * the first sentence says "the Free segment" and one check line is added; false or missing leaves the text exactly as it was.
 */
export function freeConfirmDetail(freeTargetsSegment: boolean | undefined): string {
  return freeTargetsSegment === true ? `${SEND_FREE_CONFIRM_DETAIL_SEGMENT} ${SEND_FREE_SEGMENT_CHECK}` : SEND_FREE_CONFIRM_DETAIL;
}

/**
 * The Send Free confirm dialog's title. `estimate` is the `targeted` count of the LAST Free send — with a segment target it
 * would be the size of some other audience (the staff list), so a real true drops it. False or missing: as it has always read,
 * "Free: ~10,066 readers", or "Free: full list" when Mailercloud has reported no size before.
 */
export function freeConfirmTitle(freeTargetsSegment: boolean | undefined, estimate: number | null | undefined): string {
  if (freeTargetsSegment === true) return SEND_FREE_CONFIRM_TITLE_SEGMENT;
  return estimate ? `Free: ~${estimate.toLocaleString()} readers` : 'Free: full list';
}

/** Run-level approval line: with Free manual, Approve covers Premium only, so say so. */
export function approvalLine(approval: string, approvedBy: string | null, approvedAt: string | null, freeManual: boolean): string {
  const text = approvalLabel(approval, approvedBy, approvedAt);
  return freeManual && (approval === 'PENDING' || approval === 'APPROVED') ? `Premium: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}
