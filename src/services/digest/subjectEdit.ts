import type { DigestApproval, DigestAudience, DigestBuild, DigestSendState } from '@prisma/client';
import type { DigestEnv } from '../../lib/env';
import { prisma } from '../../lib/prisma';
import { defuseMergeTags } from './renderer';
import { istDateOf, isPastCutoff } from './retryPolicy';
import { redactError, SenderError, type DigestSender } from './sender';

/**
 * Editing a digest version's SUBJECT between the 06:30 build and the run's approval (brief 2026-10-30-digest-subject-edit).
 *
 * Only `DigestSend.subject` (and the Mailercloud draft's subject) changes. The frozen HTML is NOT re-rendered, so its
 * `<title>` keeps the automatic subject (the lead headline): the title is not what an inbox lists, and re-rendering
 * would break "frozen at the build". Preheader, stories, order and html are out of scope.
 *
 * `subjectLock` is the one rule, used by the route (which enforces it) and by the Digests screen (which shows it).
 */

export const SUBJECT_MAX_CHARS = 150;

export type SubjectLockCode = 'not_today' | 'not_built' | 'approved' | 'past_cutoff' | 'scheduled' | 'changed';

/** Plain reasons, as the screen shows them and the route answers them. */
export const SUBJECT_LOCK_TEXT: Record<SubjectLockCode, string> = {
  not_today: 'Locked — only today’s digest can be edited',
  not_built: 'Locked — today’s digest is not built yet',
  approved: 'Locked — approved',
  past_cutoff: 'Locked — past the cut-off',
  scheduled: 'Locked — already scheduled',
  changed: 'Someone else just changed it — reload',
};

export type SubjectLockRun = { runDate: Date; build: DigestBuild; approval: DigestApproval };
export type SubjectLockSend = {
  state: DigestSendState;
  scheduleAttemptedAt: Date | null;
  /** The create step was claimed (a create may be in flight). */
  createAttemptedAt: Date | null;
  /** A per-variant approval (a variant rendered after the build). */
  approvedAt: Date | null;
};

/** Why this version's subject cannot be edited now, or null. Checked in the brief's order. Pure. */
export function subjectLock(run: SubjectLockRun, send: SubjectLockSend, now: Date, cfg: Pick<DigestEnv, 'cutoff'>): SubjectLockCode | null {
  if (run.runDate.getTime() !== istDateOf(now).getTime()) return 'not_today';
  if (run.build !== 'BUILT') return 'not_built';
  if (run.approval === 'APPROVED' || send.approvedAt) return 'approved';
  if (isPastCutoff(now, run.runDate, cfg.cutoff)) return 'past_cutoff';
  if (send.scheduleAttemptedAt || (send.state !== 'PENDING' && send.state !== 'CREATED')) return 'scheduled';
  // A create in flight (or being retried) may build the draft from the old subject: not editable until it settles.
  if (send.state === 'PENDING' && send.createAttemptedAt) return 'changed';
  return null;
}

export type SubjectCheck = { ok: true; subject: string } | { ok: false; message: string };

/** Trim, 1–150 chars, no newline/control characters, merge tags defused exactly like the automatic subject. */
export function checkSubject(raw: unknown): SubjectCheck {
  if (typeof raw !== 'string') return { ok: false, message: 'The subject is required.' };
  const t = raw.trim();
  if (t === '') return { ok: false, message: 'The subject cannot be empty.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(t)) return { ok: false, message: 'The subject must be one line (no line breaks).' };
  if (t.length > SUBJECT_MAX_CHARS) return { ok: false, message: `The subject is ${t.length} characters; the limit is ${SUBJECT_MAX_CHARS}.` };
  const d = defuseMergeTags(t);
  if (d.length > SUBJECT_MAX_CHARS) return { ok: false, message: `The subject is too long once {{…}} is made safe (limit ${SUBJECT_MAX_CHARS}).` };
  return { ok: true, subject: d };
}

export type SubjectEditResult =
  | { status: 200; body: { ok: true; subject: string; unchanged?: true }; audit: { oldLength: number; newLength: number; created: boolean } | null }
  | { status: 404 | 409 | 502 | 400; body: { error: string; message: string }; audit?: undefined };

const fail = (status: 404 | 409 | 502 | 400, error: string, message: string): SubjectEditResult => ({ status, body: { error, message } });

/**
 * The whole edit. PENDING (no draft yet): the row only; `createDraft` then uses it. CREATED: a conditional row update
 * first (state CREATED, no schedule attempt, subject still the old one), then the provider call; a provider failure
 * puts the old subject back (same condition) and answers 502 with the provider's plain reason. Two editors at once: the
 * condition makes the second a 409 `changed`.
 */
export async function editSubject(o: {
  runId: string;
  audience: DigestAudience;
  raw: unknown;
  /** The subject the editor was looking at when they pressed Edit. When given and no longer current → 409 `changed`. */
  from?: unknown;
  now: Date;
  cfg: DigestEnv;
  sender: DigestSender | null;
}): Promise<SubjectEditResult> {
  const run = await prisma.digestRun.findUnique({ where: { id: o.runId }, select: { id: true, runDate: true, build: true, approval: true } });
  if (!run) return fail(404, 'not_found', 'No such digest run.');
  const send = await prisma.digestSend.findUnique({
    where: { runId_audience: { runId: o.runId, audience: o.audience } },
    select: { id: true, state: true, subject: true, mcCampaignId: true, scheduleAttemptedAt: true, createAttemptedAt: true, approvedAt: true },
  });
  if (!send) return fail(404, 'not_found', 'That version does not exist for this run.');

  const lock = subjectLock(run, send, o.now, o.cfg);
  if (lock) return fail(409, lock, SUBJECT_LOCK_TEXT[lock]);

  if (typeof o.from === 'string' && o.from !== send.subject) return fail(409, 'changed', SUBJECT_LOCK_TEXT.changed);

  const checked = checkSubject(o.raw);
  if (!checked.ok) return fail(400, 'invalid_subject', checked.message);
  const next = checked.subject;
  const old = send.subject;
  if (next === old) return { status: 200, body: { ok: true, subject: old, unchanged: true }, audit: null };

  const created = send.state === 'CREATED';
  if (created && !send.mcCampaignId) return fail(409, 'changed', SUBJECT_LOCK_TEXT.changed);
  if (created && !o.sender) return fail(409, 'provider_not_configured', 'Mailercloud is not configured (MAILERCLOUD_API_KEY is not set).');

  const guard = created
    ? { id: send.id, state: 'CREATED' as const, scheduleAttemptedAt: null, subject: old }
    : { id: send.id, state: 'PENDING' as const, createAttemptedAt: null, scheduleAttemptedAt: null, subject: old };
  const r = await prisma.digestSend.updateMany({ where: guard, data: { subject: next } });
  if (r.count !== 1) return fail(409, 'changed', SUBJECT_LOCK_TEXT.changed);

  if (created) {
    try {
      await (o.sender as DigestSender).updateSubject(send.mcCampaignId as string, next);
    } catch (err) {
      await prisma.digestSend.updateMany({ where: { id: send.id, subject: next }, data: { subject: old } });
      const why = redactError(err, [o.cfg.mailercloud.apiKey]);
      const maybe = err instanceof SenderError && err.kind === 'AMBIGUOUS' ? ' Mailercloud may or may not have applied it — check the draft in Mailercloud.' : '';
      return fail(502, 'provider_error', `Mailercloud did not accept the new subject: ${why}.${maybe}`);
    }
  }
  return { status: 200, body: { ok: true, subject: next }, audit: { oldLength: old.length, newLength: next.length, created } };
}
