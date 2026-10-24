import { normaliseEmail } from '../digest/webhook';

/**
 * CMS Feed 1 payloads → one `AccountSnapshot` (push-feed contract v1.3 = the v1.2 wire, §6, §7, §11; design §2, §5).
 *
 * Every event and every list row is a FULL snapshot of one account, so both doors parse to the
 * same shape and go through the one `applyAccountSnapshot()`. Strict on purpose: a payload that
 * breaks the contract is refused (`invalid`), never half-read. Pure, no I/O, never logs; a
 * refusal names the FIELD, never its value.
 *
 * v1.2 rules carried here:
 *  - `erasure` is a boolean on every event and row (never null), and may be true ONLY on an
 *    `account.deleted` event or a tombstone list row (`deleted_at` set) — an erasure is
 *    irreversible, so `erasure: true` anywhere else is refused;
 *  - `email` / `name` may be null (withheld: consent false + free/ended; or a deletion);
 *  - `reactivated` is on events only (absent on list rows → false).
 * `name` is validated and then DROPPED: we never store a reader's name.
 */

export const CMS_EVENT_TYPES = [
  'account.created',
  'account.updated',
  'account.email_changed',
  'account.deleted',
  'subscription.started',
  'subscription.renewed',
  'subscription.cancelled',
  'subscription.ended',
] as const;
export type CmsEventType = (typeof CMS_EVENT_TYPES)[number];

/** Statuses the rules understand (contract A.3, plus `deleted` on a deletion). Anything else is kept verbatim. */
export const KNOWN_STATUSES = ['free', 'active', 'cancelled', 'ended', 'deleted'] as const;

export function isKnownStatus(s: string): boolean {
  return (KNOWN_STATUSES as readonly string[]).includes(s);
}

export type AccountSnapshot = {
  accountId: string;
  seq: bigint;
  /** Normalised address, or null (withheld / deleted). Never logged. */
  email: string | null;
  /** Verbatim (a known status, or an unknown one the rules ignore). */
  status: string;
  plan: string | null;
  periodEnd: Date | null;
  consentValue: boolean | null;
  consentAt: Date | null;
  erasure: boolean;
  reactivated: boolean;
  deleted: boolean;
  /** When the account was deleted (`deleted_at`, else the event's `occurred_at`); null when live. */
  deletedAt: Date | null;
};

export type ParseFailure = { ok: false; reason: string };

type Obj = Record<string, unknown>;

const ACCOUNT_ID_RE = /^[\x21-\x7e]{1,64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATUS_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function has(o: Obj, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** `YYYY-MM-DD` → UTC midnight of that calendar date; null stays null; anything else → undefined (invalid). */
function dateOnly(v: unknown): Date | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : d;
}

/** An ISO-8601 instant WITH a zone (`Z` or ±hh:mm); null stays null; anything else → undefined. */
function instant(v: unknown): Date | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || !INSTANT_RE.test(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function nullableString(v: unknown, max: number): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v;
}

/** The fields events and list rows share. `deletedAtHint` = the row's `deleted_at` or the event's `occurred_at`. */
function parseCommon(
  o: Obj,
  opts: { deletedAtHint: Date | null; forcedDeleted: boolean; reactivated: boolean; erasureAllowed: boolean },
): AccountSnapshot | ParseFailure {
  const fail = (field: string): ParseFailure => ({ ok: false, reason: `bad_${field}` });

  if (typeof o.account_id !== 'string' || !ACCOUNT_ID_RE.test(o.account_id)) return fail('account_id');
  if (typeof o.seq !== 'number' || !Number.isSafeInteger(o.seq) || o.seq < 0) return fail('seq');
  if (typeof o.status !== 'string' || !STATUS_RE.test(o.status)) return fail('status');

  if (!has(o, 'email')) return fail('email');
  let email: string | null = null;
  if (o.email !== null) {
    if (typeof o.email !== 'string') return fail('email');
    email = normaliseEmail(o.email);
    if (email === null) return fail('email');
  }
  if (!has(o, 'name') || nullableString(o.name, 500) === undefined) return fail('name');

  const plan = nullableString(o.plan, 64);
  if (!has(o, 'plan') || plan === undefined) return fail('plan');
  if (!has(o, 'period_start') || dateOnly(o.period_start) === undefined) return fail('period_start');
  const periodEnd = dateOnly(o.period_end);
  if (!has(o, 'period_end') || periodEnd === undefined) return fail('period_end');

  const mc = o.marketing_consent;
  if (!isObj(mc) || !has(mc, 'value') || !has(mc, 'at')) return fail('marketing_consent');
  if (mc.value !== null && typeof mc.value !== 'boolean') return fail('marketing_consent');
  const consentAt = instant(mc.at);
  if (consentAt === undefined) return fail('marketing_consent');

  if (typeof o.erasure !== 'boolean') return fail('erasure');

  const deleted = opts.forcedDeleted || o.status === 'deleted';
  // Irreversible: contract §11.2 — `erasure` is true ONLY on `account.deleted` (an event) or on its
  // list-row equivalent, a tombstone with `deleted_at` (QA L5: `status: "deleted"` on any other
  // event type is not enough).
  if (o.erasure && (!deleted || !opts.erasureAllowed)) return fail('erasure');

  return {
    accountId: o.account_id,
    seq: BigInt(o.seq),
    email,
    status: o.status,
    plan,
    periodEnd,
    consentValue: mc.value as boolean | null,
    consentAt,
    erasure: o.erasure,
    reactivated: opts.reactivated,
    deleted,
    deletedAt: deleted ? opts.deletedAtHint : null,
  };
}

export type ParsedCmsEvent =
  | { ok: true; eventId: string; event: CmsEventType; occurredAt: Date; snapshot: AccountSnapshot }
  | { ok: true; eventId: string; event: string; unknownType: true }
  | (ParseFailure & { eventId?: string; event?: string });

/** The `event_id` of a body already JSON-parsed, or null (route step 6: must equal X-CMS-Event-Id). */
export function eventIdOf(body: unknown): string | null {
  return isObj(body) && typeof body.event_id === 'string' && EVENT_ID_RE.test(body.event_id) ? body.event_id : null;
}

/** A door-W webhook body (already JSON-parsed). An unknown `event` is reported, not refused. */
export function parseCmsEvent(body: unknown): ParsedCmsEvent {
  if (!isObj(body)) return { ok: false, reason: 'not_an_object' };
  const eventId = eventIdOf(body);
  if (eventId === null) return { ok: false, reason: 'bad_event_id' };
  if (typeof body.event !== 'string' || !/^[a-z0-9_.]{1,64}$/.test(body.event)) return { ok: false, reason: 'bad_event', eventId };
  const event = body.event;
  if (!(CMS_EVENT_TYPES as readonly string[]).includes(event)) return { ok: true, eventId, event, unknownType: true };
  const occurredAt = instant(body.occurred_at);
  if (!occurredAt) return { ok: false, reason: 'bad_occurred_at', eventId, event };
  if (typeof body.reactivated !== 'boolean') return { ok: false, reason: 'bad_reactivated', eventId, event };
  const snap = parseCommon(body, {
    deletedAtHint: occurredAt,
    forcedDeleted: event === 'account.deleted',
    reactivated: body.reactivated,
    erasureAllowed: event === 'account.deleted',
  });
  if ('ok' in snap) return { ...snap, eventId, event };
  return { ok: true, eventId, event: event as CmsEventType, occurredAt, snapshot: snap };
}

/** One door-L list row (`data[i]`). */
export function parseCmsListRow(row: unknown): { ok: true; snapshot: AccountSnapshot } | ParseFailure {
  if (!isObj(row)) return { ok: false, reason: 'not_an_object' };
  const deletedAt = instant(row.deleted_at);
  if (!has(row, 'deleted_at') || deletedAt === undefined) return { ok: false, reason: 'bad_deleted_at' };
  const snap = parseCommon(row, { deletedAtHint: deletedAt, forcedDeleted: deletedAt !== null, reactivated: false, erasureAllowed: deletedAt !== null });
  if ('ok' in snap) return snap;
  return { ok: true, snapshot: snap };
}
