import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { redactError } from './sender';
import { afterSuppressionWrite } from '../suppression';

/**
 * Mailercloud campaign webhooks (docs/EMAIL_DIGEST_DESIGN.md §2, §4
 * `webhook.ts`, §8, §9, task 8).
 *
 * `POST /api/webhooks/mailercloud/:token` → `handleMailercloudWebhook(body)`:
 *  - normalise the payload (one event object, an array, or `{events|data: […]}`);
 *  - map the event type; opened/clicked and unknown types are acknowledged and
 *    dropped, never stored;
 *  - write one `EmailEvent` per event, deduped on a stable `dedupeKey` (unique
 *    index + `skipDuplicates`), so a provider retry or a replay counts once;
 *  - upsert `EmailSuppression` (keyed on `emailHash`) for NEWLY stored UNSUBSCRIBE /
 *    HARD_BOUNCE / SPAM events, in the same transaction as the event rows (an opt-out is never
 *    lost between the two, and a replay never re-creates a lifted one),
 *    in chunks of CHUNK_SIZE events, a constant number of statements each; the
 *    recorded reason escalates SPAM > HARD_BOUNCE > UNSUBSCRIBE, never down;
 *  - count what was dropped and why; a recognised opt-out with no readable
 *    address also leaves a daily `NO_ADDRESS` row (no PII) for the status screen;
 *  - link `sendId` when the campaign is one of our digest variants.
 *
 * PII: the address is normalised, hashed (sha256) for `EmailEvent.emailHash`
 * and written to `EmailSuppression.email` only. It never enters `meta`, a log
 * line, an error, an audit row or a response.
 *
 * campaign_sent / campaign_error do NOT change a variant's state. They only
 * bring its next status poll forward (`nextAttemptAt = now` on a SCHEDULED,
 * unclaimed variant), so the runner's own `verifyStep` decides SENT /
 * PARTIALLY_SENT / FAILED with the provider's counts, exactly as before. A
 * webhook never calls the provider and never re-sends anything.
 */

export type EmailEventType = 'UNSUBSCRIBE' | 'HARD_BOUNCE' | 'SPAM' | 'CAMPAIGN_SENT' | 'CAMPAIGN_ERROR';

const SUPPRESSING: ReadonlySet<EmailEventType> = new Set(['UNSUBSCRIBE', 'HARD_BOUNCE', 'SPAM']);
const CAMPAIGN_TYPES: ReadonlySet<EmailEventType> = new Set(['CAMPAIGN_SENT', 'CAMPAIGN_ERROR']);

/** Our digest campaign names (`mcCampaignName`); only these names are ever copied into `meta`. */
const OUR_CAMPAIGN_PREFIX = 'TS-DIGEST-';
/** A token shorter than this is treated as unset: the route answers 404 to everyone. */
export const MIN_WEBHOOK_TOKEN_LENGTH = 32;
/**
 * More events than this in one request is not a Mailercloud delivery: 400.
 * Set ABOVE what the 256 KB body limit can carry in storable events (the
 * smallest, `{"event":"spam","email":"a@b.co"}`, is 33 bytes → ~7,900), so
 * a delivery the body limit accepts is never permanently rejected by count.
 */
export const MAX_EVENTS_PER_REQUEST = 10_000;
/** Events per transaction. Each chunk is a constant 2 statements, not one per event. */
const CHUNK_SIZE = 1000;
const TXN_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ */
/* UNVERIFIED payload assumptions — the ONE place they live            */
/* ------------------------------------------------------------------ */
/*
 * Mailercloud documents the campaign webhook EVENT NAMES (campaign_sent,
 * campaign_opened, campaign_clicked, unsubscribe, campaign_error, spam,
 * hard_bounce) but not the request body. Every field name below is a guess,
 * tolerant on purpose, to be confirmed on the first live webhook (Mailercloud's
 * "Test webhook" button sends a dummy one). Transactional webhooks are
 * documented as `{event, message_id, email, date_event, ts, ts_event, …}`,
 * which is why `event`/`email`/`ts_event` come first.
 */
export const PAYLOAD_FIELDS = {
  /** Envelopes that hold a list of events. A bare array is also accepted. */
  lists: ['events', 'data', 'payload'],
  /** Nested objects searched (after the event itself) for any field below. */
  nested: ['data', 'payload', 'contact', 'subscriber', 'details'],
  type: ['event', 'event_type', 'eventType', 'type', 'event_name', 'trigger', 'webhook_event'],
  email: ['email', 'contact_email', 'email_address', 'emailAddress', 'subscriber_email', 'recipient'],
  /** `campaign` may be a plain id or an object `{id, name}`. */
  campaignId: ['campaign_id', 'campaignId', 'campaign_uid', 'campaign_key', 'campaign'],
  campaignName: ['campaign_name', 'campaignName'],
  eventTime: ['ts_event', 'date_event', 'event_time', 'timestamp', 'event_date', 'created_at', 'date'],
  errorText: ['description', 'reason', 'error', 'error_message', 'message'],
} as const;

/** Provider event name (lowercased, separators → `_`) → our type. Anything else is ignored. */
const TYPE_MAP: Record<string, EmailEventType> = {
  unsubscribe: 'UNSUBSCRIBE',
  unsubscribed: 'UNSUBSCRIBE',
  campaign_unsubscribe: 'UNSUBSCRIBE',
  campaign_unsubscribed: 'UNSUBSCRIBE',
  hard_bounce: 'HARD_BOUNCE',
  hardbounce: 'HARD_BOUNCE',
  hard_bounced: 'HARD_BOUNCE',
  campaign_hard_bounce: 'HARD_BOUNCE',
  spam: 'SPAM',
  spam_complaint: 'SPAM',
  spam_report: 'SPAM',
  complaint: 'SPAM',
  abuse: 'SPAM',
  campaign_spam: 'SPAM',
  campaign_sent: 'CAMPAIGN_SENT',
  campaign_error: 'CAMPAIGN_ERROR',
  campaign_failed: 'CAMPAIGN_ERROR',
};

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/**
 * True when `given` equals the current token or, during a rotation, the
 * previous one. Both sides are hashed first so `timingSafeEqual` always
 * compares equal-length buffers, and both candidates are always compared.
 * A token shorter than MIN_WEBHOOK_TOKEN_LENGTH counts as unset.
 */
export function webhookTokenMatches(given: string, cfg: Pick<DigestEnv, 'mailercloud'>): boolean {
  const g = sha256(given ?? '');
  let ok = false;
  for (const t of [cfg.mailercloud.webhookToken, cfg.mailercloud.webhookTokenPrevious]) {
    const valid = typeof t === 'string' && t.length >= MIN_WEBHOOK_TOKEN_LENGTH;
    const same = timingSafeEqual(g, sha256(valid ? t : '\u0000unset'));
    if (valid && same) ok = true;
  }
  return ok;
}

/* ------------------------------------------------------------------ */
/* Normalise                                                           */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Postgres `text` and `jsonb` reject NUL. One NUL in a stored field would turn
 * the delivery into a permanent 500, so Mailercloud would retry it (and every
 * event batched with it) until it switched the webhook off.
 */
function noNul(v: string | null): string | null {
  return v === null ? null : v.split('\u0000').join('');
}

/** First non-empty scalar among `keys`, on the event itself, then on its nested objects. */
function pick(ev: Obj, keys: readonly string[]): string | null {
  const scopes: Obj[] = [ev, ...PAYLOAD_FIELDS.nested.map((k) => ev[k]).filter(isObj)];
  for (const scope of scopes) {
    for (const k of keys) {
      const v = scope[k];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

/** `campaign: {id, name}` objects, on the event or a nested object. */
function campaignObject(ev: Obj): Obj | null {
  for (const scope of [ev, ...PAYLOAD_FIELDS.nested.map((k) => ev[k]).filter(isObj)]) {
    if (isObj(scope.campaign)) return scope.campaign;
  }
  return null;
}

/** Trimmed, lowercased address, or null when it does not look like one. */
export function normaliseEmail(raw: string | null): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  // Control characters (NUL above all) are never part of a real mailbox, and
  // Postgres rejects NUL in text: storing one would 500 the delivery forever.
  // eslint-disable-next-line no-control-regex
  if (e.length > 254 || /[\u0000-\u001f\u007f]/.test(e) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/** sha256 hex of the normalised address. The only form of an address `EmailEvent` holds. */
export function emailHash(normalised: string): string {
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

function eventTime(raw: string | null): string | null {
  if (!raw) return null;
  let d: Date;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    d = new Date(raw.includes('T') || /[zZ+]/.test(raw) ? raw : raw.replace(' ', 'T'));
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type NormalisedEvent =
  | { ignored: true; reason: 'unknown_type' | 'no_campaign' | 'no_address'; rawType: string | null }
  | {
      ignored: false;
      type: EmailEventType;
      rawType: string;
      email: string | null;
      emailHash: string | null;
      mcCampaignId: string | null;
      campaignName: string | null;
      at: string | null;
      errorText: string | null;
      dedupeKey: string;
    };

/** Lowercase, `[\s-]` → `_`; null unless it is a short identifier (never free text in meta). */
function rawTypeOf(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z0-9_.]{1,40}$/.test(t) ? t : null;
}

/**
 * The stable identity of one event. Deliberately built from WHAT happened
 * (type, campaign, reader) and not from delivery details (timestamps, a
 * delivery id) that may differ between a provider's retries: "reader X
 * unsubscribed from campaign Y" is one fact however often it is delivered.
 */
function dedupeKeyOf(type: EmailEventType, campaignRef: string | null, hash: string | null): string {
  return createHash('sha256').update(`mailercloud|${type}|${campaignRef ?? '-'}|${hash ?? '-'}`).digest('hex');
}

/** One provider event → our shape, or the reason it is dropped. Pure. */
export function normaliseEvent(ev: Obj): NormalisedEvent {
  const rawType = rawTypeOf(pick(ev, PAYLOAD_FIELDS.type));
  const type = rawType ? TYPE_MAP[rawType] : undefined;
  if (!rawType || !type) return { ignored: true, reason: 'unknown_type', rawType };

  const camp = campaignObject(ev);
  const mcCampaignId = noNul(pick(ev, PAYLOAD_FIELDS.campaignId) ?? (camp ? pick(camp, ['id', 'campaign_id', 'uid']) : null)) || null;
  const campaignName = noNul(pick(ev, PAYLOAD_FIELDS.campaignName) ?? (camp ? pick(camp, ['name', 'campaign_name']) : null)) || null;
  const campaignRef = mcCampaignId ? `id:${mcCampaignId}` : campaignName ? `name:${campaignName}` : null;
  const email = normaliseEmail(pick(ev, PAYLOAD_FIELDS.email));
  const hash = email ? emailHash(email) : null;

  if (CAMPAIGN_TYPES.has(type) && !campaignRef) return { ignored: true, reason: 'no_campaign', rawType };
  if (SUPPRESSING.has(type) && !email) return { ignored: true, reason: 'no_address', rawType };

  return {
    ignored: false,
    type,
    rawType,
    email,
    emailHash: hash,
    mcCampaignId: mcCampaignId ? mcCampaignId.slice(0, 100) : null,
    campaignName,
    at: eventTime(pick(ev, PAYLOAD_FIELDS.eventTime)),
    errorText: type === 'CAMPAIGN_ERROR' ? noNul(pick(ev, PAYLOAD_FIELDS.errorText)) : null,
    // Campaign events are about the campaign, not a reader: one per campaign.
    dedupeKey: dedupeKeyOf(type, campaignRef, CAMPAIGN_TYPES.has(type) ? null : hash),
  };
}

/** The event objects in a body, or null when the body is not a webhook payload at all. */
export function eventsOf(body: unknown): Obj[] | null {
  if (Array.isArray(body)) return body.filter(isObj);
  if (!isObj(body)) return null;
  for (const k of PAYLOAD_FIELDS.lists) {
    const v = body[k];
    if (Array.isArray(v)) return v.filter(isObj);
  }
  return [body];
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export type IgnoreReason = 'unknown_type' | 'no_campaign' | 'no_address';

export type WebhookResult = {
  received: number;
  stored: number;
  duplicates: number;
  ignored: number;
  /** Why events were dropped. `no_address` = a recognised opt-out we could not act on. */
  ignoredBy: Record<IgnoreReason, number>;
  types: EmailEventType[];
};

export class MalformedWebhookError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MalformedWebhookError';
  }
}

type Kept = Extract<NormalisedEvent, { ignored: false }>;

function metaOf(e: Kept, cfg: Pick<DigestEnv, 'mailercloud'>): Prisma.InputJsonObject {
  const meta: Record<string, string> = { event: e.rawType };
  if (e.at) meta.at = e.at;
  if (e.campaignName?.startsWith(OUR_CAMPAIGN_PREFIX)) meta.campaignName = e.campaignName.slice(0, 120);
  if (e.errorText) {
    const secrets = [cfg.mailercloud.apiKey, cfg.mailercloud.webhookToken, cfg.mailercloud.webhookTokenPrevious];
    meta.error = redactError(e.errorText, secrets).slice(0, 200);
  }
  return meta;
}

/** Our digest variant for each campaign id / name in the batch. */
async function linkSends(events: Kept[]): Promise<Map<string, string>> {
  const ids = [...new Set(events.map((e) => e.mcCampaignId).filter((v): v is string => !!v))];
  const names = [...new Set(events.map((e) => e.campaignName).filter((v): v is string => !!v && v.startsWith(OUR_CAMPAIGN_PREFIX)))];
  const map = new Map<string, string>();
  if (ids.length === 0 && names.length === 0) return map;
  const sends = await prisma.digestSend.findMany({
    where: { OR: [{ mcCampaignId: { in: ids } }, { mcCampaignName: { in: names } }] },
    select: { id: true, mcCampaignId: true, mcCampaignName: true },
  });
  for (const s of sends) {
    if (s.mcCampaignId) map.set(`id:${s.mcCampaignId}`, s.id);
    map.set(`name:${s.mcCampaignName}`, s.id);
  }
  return map;
}

/** A total order for lock acquisition (any consistent order will do). */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The recorded `EmailSuppression.reason` escalates and never downgrades (owner,
 * 2026-10-23): a bounce or a spam complaint overrides an unsubscribe, because
 * the reason decides what may lift the row later (an UNSUBSCRIBE is lifted by a
 * newer opt-in; HARD_BOUNCE / SPAM only by an explicit opt-in dated after the
 * bounce or complaint; MANUAL never automatically).
 *
 * MANUAL ranks above every automatic reason: it is a person's deliberate
 * decision, so no webhook ever rewrites it. (Rewriting it to HARD_BOUNCE would
 * make it liftable by an opt-in, a weakening.)
 *
 * The single definition: the SQL rank in `storeChunk` is generated from this.
 */
export const SUPPRESSION_RANK: Readonly<Record<string, number>> = Object.freeze({
  // CMS audience sync (design §6.3; contract v1.2 §10): a deactivated account, suppressed by its
  // account id. The weakest reason: any real opt-out replaces it, and only it is lifted when the
  // account is reactivated.
  ACCOUNT_DELETED: 0,
  UNSUBSCRIBE: 1,
  HARD_BOUNCE: 2,
  SPAM: 3,
  MANUAL: 4,
});

/** The higher-ranked of two reasons (ties keep `current`). Pure; mirrors the SQL. */
export function escalateReason(current: string, incoming: string): string {
  return (SUPPRESSION_RANK[incoming] ?? 0) > (SUPPRESSION_RANK[current] ?? 0) ? incoming : current;
}

type SuppressionFacts = { reason: string; source: string; firstSeenAt: Date; lastSeenAt: Date };

/**
 * What a backup restore writes onto an `EmailSuppression` row that already exists
 * (scripts/restore-backup.ts). A backup is older than the live row, so it may only make
 * the opt-out STRONGER, never weaker: the higher-ranked reason (MANUAL is never rewritten),
 * its source, the earliest first-seen and the latest last-seen (`lastSeenAt` is what a
 * later opt-in must beat, so moving it back would make the row easier to lift). Pure.
 */
export function mergeSuppressionForRestore(existing: SuppressionFacts, incoming: SuppressionFacts): SuppressionFacts {
  const reason = escalateReason(existing.reason, incoming.reason);
  return {
    reason,
    source: reason === existing.reason ? existing.source : incoming.source,
    firstSeenAt: incoming.firstSeenAt < existing.firstSeenAt ? incoming.firstSeenAt : existing.firstSeenAt,
    lastSeenAt: incoming.lastSeenAt > existing.lastSeenAt ? incoming.lastSeenAt : existing.lastSeenAt,
  };
}

/** `CASE <col> WHEN 'UNSUBSCRIBE' THEN 1 … ELSE 0 END`, built from SUPPRESSION_RANK (constants only). */
function rankSql(col: string): Prisma.Sql {
  const arms = Object.entries(SUPPRESSION_RANK)
    .map(([reason, rank]) => `WHEN '${reason.replace(/'/g, "''")}' THEN ${Number(rank)}`)
    .join(' ');
  return Prisma.raw(`(CASE ${col} ${arms} ELSE 0 END)`);
}

/**
 * Stores one chunk in ONE transaction, a constant number of statements however many events it
 * holds:
 *  1. insert the events, skipping existing dedupe keys, returning the new keys;
 *  2. ONE upsert of the opt-out addresses whose events were NEW in this delivery (one row per
 *     address, the batch's highest-ranked reason), keyed on `emailHash` (written here, and by
 *     the table's trigger): a new address is inserted; an existing row's reason is upgraded if
 *     the incoming one ranks higher (never downgraded) and its `lastSeenAt` moves forward. A
 *     row that is hash-only (an erased address) keeps `email` null;
 *  3. `afterSuppressionWrite`: stamp the CMS account onto the row, mark the audience member
 *     suppressed.
 * ONLY newly inserted events touch `EmailSuppression` (CMS audience design §6.3): a provider
 * replay of an old opt-out is a duplicate event, so it can never re-create a suppression that a
 * later explicit opt-in lifted. That is safe because an event row and its suppression always
 * commit together — a duplicate event's suppression is already written (or was lifted since).
 * Rows are written in hash order, so two concurrent deliveries that share addresses take their
 * row locks in the same order and wait instead of deadlocking. Returns the dedupe keys that
 * were new.
 */
async function storeChunk(chunk: { e: Kept; sendId: string | null; meta: Prisma.InputJsonObject }[], now: Date): Promise<Set<string>> {
  return prisma.$transaction(
    async (tx) => {
      // Measured before the key ordering: two reversed 1,000-address batches deadlocked 10 rounds in 10.
      const created = await tx.emailEvent.createManyAndReturn({
        data: [...chunk].sort((a, b) => byKey(a.e.dedupeKey, b.e.dedupeKey)).map(({ e, sendId, meta }) => ({
          type: e.type,
          mcCampaignId: e.mcCampaignId,
          sendId,
          emailHash: e.emailHash,
          dedupeKey: e.dedupeKey,
          meta,
          receivedAt: now,
        })),
        skipDuplicates: true,
        select: { dedupeKey: true },
      });
      const fresh = new Set(created.map((r) => r.dedupeKey));
      // One row per address: ON CONFLICT DO UPDATE cannot touch the same row twice in one statement.
      const byHash = new Map<string, { email: string; reason: string }>();
      for (const { e } of chunk) {
        if (!SUPPRESSING.has(e.type) || !e.email || !e.emailHash || !fresh.has(e.dedupeKey)) continue;
        const cur = byHash.get(e.emailHash);
        byHash.set(e.emailHash, { email: e.email, reason: cur ? escalateReason(cur.reason, e.type) : e.type });
      }
      if (byHash.size > 0) {
        const sorted = [...byHash].sort(([a], [b]) => byKey(a, b));
        const ids = sorted.map(() => randomUUID());
        const hashes = sorted.map(([h]) => h);
        const emails = sorted.map(([, v]) => v.email);
        const reasons = sorted.map(([, v]) => v.reason);
        // `firstSeenAt`/`lastSeenAt` are timestamp (no zone): bind ISO + AT TIME ZONE 'UTC'
        // (a raw JS Date bind is read in the session TimeZone; see recordNoAddress).
        await tx.$executeRaw`
          INSERT INTO "EmailSuppression" AS s (id, email, "emailHash", reason, source, "firstSeenAt", "lastSeenAt")
          SELECT id, email, hash, reason, 'mailercloud_webhook',
                 (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
                 (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          FROM unnest(${ids}::text[], ${emails}::text[], ${hashes}::text[], ${reasons}::text[]) AS u(id, email, hash, reason)
          ORDER BY hash
          ON CONFLICT ("emailHash") DO UPDATE SET
            reason = CASE WHEN ${rankSql('EXCLUDED.reason')} > ${rankSql('s.reason')} THEN EXCLUDED.reason ELSE s.reason END,
            "lastSeenAt" = GREATEST(s."lastSeenAt", EXCLUDED."lastSeenAt")`;
        await afterSuppressionWrite(tx, hashes, now);
      }
      return fresh;
    },
    { timeout: TXN_TIMEOUT_MS },
  );
}

/** IST calendar date, YYYY-MM-DD (the no-address signal is one row per IST day per event name). */
function istDay(now: Date): string {
  return new Date(now.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

/**
 * A recognised opt-out (unsubscribe / hard bounce / spam) without a readable
 * address cannot be acted on — the reader stays mailable in our copy. Make it
 * visible: one `NO_ADDRESS` row per IST day per provider event name, its
 * `receivedAt` moved to the latest occurrence and `meta.count` incremented.
 * No address, no hash. Read by `/api/digest/status` (`webhook.lastNoAddressAt`).
 * `receivedAt` is a `timestamp` (no zone) column: the instant is bound as an ISO
 * string and converted AT TIME ZONE 'UTC', because a raw JS Date bind is read
 * in the session's TimeZone (Asia/Kolkata locally → +05:30, as in eventRetention).
 */
async function recordNoAddress(rawTypes: Map<string, number>, now: Date): Promise<void> {
  const day = istDay(now);
  for (const [rawType, count] of rawTypes) {
    const key = createHash('sha256').update(`mailercloud|NO_ADDRESS|${day}|${rawType}`).digest('hex');
    const meta = JSON.stringify({ event: rawType, day, count });
    await prisma.$executeRaw`
      INSERT INTO "EmailEvent" (id, provider, type, "dedupeKey", meta, "receivedAt")
      VALUES (${randomUUID()}, 'mailercloud', 'NO_ADDRESS', ${key}, ${meta}::jsonb, (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
      ON CONFLICT ("dedupeKey") DO UPDATE
        SET "receivedAt" = GREATEST("EmailEvent"."receivedAt", EXCLUDED."receivedAt"),
            meta = jsonb_set("EmailEvent".meta, '{count}',
                     to_jsonb(COALESCE(("EmailEvent".meta ->> 'count')::int, 0) + ${count}::int))`;
  }
}

/**
 * campaign_sent / campaign_error on one of our SCHEDULED variants: poll now.
 * Only `nextAttemptAt` moves, only earlier, only while no step holds the row.
 */
async function bringPollForward(sendId: string, now: Date): Promise<void> {
  await prisma.digestSend.updateMany({
    where: { id: sendId, state: 'SCHEDULED', stepClaimedAt: null, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { gt: now } }] },
    data: { nextAttemptAt: now },
  });
}

/**
 * Processes one verified webhook body. Throws `MalformedWebhookError` (→ 400)
 * when the body is not a payload; any other throw is a storage failure (→ 500,
 * so Mailercloud retries rather than an opt-out being lost).
 */
export async function handleMailercloudWebhook(
  body: unknown,
  opts: { now?: Date; cfg?: DigestEnv } = {},
): Promise<WebhookResult> {
  const cfg = opts.cfg ?? env.digest;
  const now = opts.now ?? new Date();
  const raw = eventsOf(body);
  if (raw === null) throw new MalformedWebhookError('body is not an object or array');
  if (raw.length > MAX_EVENTS_PER_REQUEST) throw new MalformedWebhookError('too many events');

  const out: WebhookResult = {
    received: raw.length,
    stored: 0,
    duplicates: 0,
    ignored: 0,
    ignoredBy: { unknown_type: 0, no_campaign: 0, no_address: 0 },
    types: [],
  };
  const kept: Kept[] = [];
  const noAddress = new Map<string, number>();
  for (const ev of raw) {
    const n = normaliseEvent(ev);
    if (n.ignored) {
      out.ignored++;
      out.ignoredBy[n.reason]++;
      if (n.reason === 'no_address' && n.rawType) noAddress.set(n.rawType, (noAddress.get(n.rawType) ?? 0) + 1);
    } else {
      kept.push(n);
    }
  }
  if (kept.length === 0) {
    if (noAddress.size > 0) await recordNoAddress(noAddress, now);
    return out;
  }

  const sends = await linkSends(kept);
  const rows = kept.map((e) => ({
    e,
    sendId:
      (e.mcCampaignId ? sends.get(`id:${e.mcCampaignId}`) : undefined) ??
      (e.campaignName ? sends.get(`name:${e.campaignName}`) : undefined) ??
      null,
    meta: metaOf(e, cfg),
  }));
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const fresh = await storeChunk(chunk, now);
    // Nudge right after the chunk commits: if a LATER chunk fails, the retry
    // sees these campaign events as duplicates and would never nudge again.
    const nudge = new Set<string>();
    for (const { e, sendId } of chunk) {
      // Two events with the same key in one delivery: the first is new, the rest duplicates.
      if (fresh.delete(e.dedupeKey)) {
        out.stored++;
        if (!out.types.includes(e.type)) out.types.push(e.type);
        if (sendId && CAMPAIGN_TYPES.has(e.type)) nudge.add(sendId);
      } else {
        out.duplicates++;
      }
    }
    for (const sendId of nudge) await bringPollForward(sendId, now);
  }
  // Counted only once the delivery is stored: a store failure → 500 → Mailercloud
  // retries the whole body, and counting first would add the same events per retry.
  if (noAddress.size > 0) await recordNoAddress(noAddress, now);
  return out;
}
