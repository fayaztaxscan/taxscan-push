import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { redactError } from './sender';

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
 *  - upsert `EmailSuppression` for UNSUBSCRIBE / HARD_BOUNCE / SPAM in the same
 *    transaction as the event row (an opt-out is never lost between the two);
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
/** More events than this in one request is not a Mailercloud delivery: 400. */
export const MAX_EVENTS_PER_REQUEST = 500;
const TXN_TIMEOUT_MS = 10_000;

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
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
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
  const mcCampaignId = pick(ev, PAYLOAD_FIELDS.campaignId) ?? (camp ? pick(camp, ['id', 'campaign_id', 'uid']) : null);
  const campaignName = pick(ev, PAYLOAD_FIELDS.campaignName) ?? (camp ? pick(camp, ['name', 'campaign_name']) : null);
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
    errorText: type === 'CAMPAIGN_ERROR' ? pick(ev, PAYLOAD_FIELDS.errorText) : null,
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

export type WebhookResult = {
  received: number;
  stored: number;
  duplicates: number;
  ignored: number;
  types: EmailEventType[];
};

export class MalformedWebhookError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MalformedWebhookError';
  }
}

function metaOf(e: Extract<NormalisedEvent, { ignored: false }>, cfg: Pick<DigestEnv, 'mailercloud'>): Prisma.InputJsonObject {
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
async function linkSends(events: Extract<NormalisedEvent, { ignored: false }>[]): Promise<Map<string, string>> {
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

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Inserts one event (deduped) and its suppression row together. True when the event was new. */
async function storeOne(
  e: Extract<NormalisedEvent, { ignored: false }>,
  sendId: string | null,
  meta: Prisma.InputJsonObject,
  now: Date,
): Promise<boolean> {
  const attempt = () =>
    prisma.$transaction(
      async (tx) => {
        const r = await tx.emailEvent.createMany({
          data: [
            {
              type: e.type,
              mcCampaignId: e.mcCampaignId,
              sendId,
              emailHash: e.emailHash,
              dedupeKey: e.dedupeKey,
              meta,
              receivedAt: now,
            },
          ],
          skipDuplicates: true,
        });
        const inserted = r.count === 1;
        if (SUPPRESSING.has(e.type) && e.email) {
          // A replay re-asserts the row (an opt-out must exist) but does not move lastSeenAt.
          await tx.emailSuppression.upsert({
            where: { email: e.email },
            create: { email: e.email, reason: e.type, source: 'mailercloud_webhook', firstSeenAt: now, lastSeenAt: now },
            update: inserted ? { lastSeenAt: now } : {},
          });
        }
        return inserted;
      },
      { timeout: TXN_TIMEOUT_MS },
    );
  try {
    return await attempt();
  } catch (err) {
    // Two concurrent deliveries of the same address: the loser's suppression insert
    // collides. Once more, now that the row exists.
    if (isUniqueViolation(err)) return attempt();
    throw err;
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

  const out: WebhookResult = { received: raw.length, stored: 0, duplicates: 0, ignored: 0, types: [] };
  const kept: Extract<NormalisedEvent, { ignored: false }>[] = [];
  for (const ev of raw) {
    const n = normaliseEvent(ev);
    if (n.ignored) out.ignored++;
    else kept.push(n);
  }
  if (kept.length === 0) return out;

  const sends = await linkSends(kept);
  for (const e of kept) {
    const sendId =
      (e.mcCampaignId ? sends.get(`id:${e.mcCampaignId}`) : undefined) ??
      (e.campaignName ? sends.get(`name:${e.campaignName}`) : undefined) ??
      null;
    const inserted = await storeOne(e, sendId, metaOf(e, cfg), now);
    if (inserted) {
      out.stored++;
      if (!out.types.includes(e.type)) out.types.push(e.type);
      if (sendId && CAMPAIGN_TYPES.has(e.type)) await bringPollForward(sendId, now);
    } else {
      out.duplicates++;
    }
  }
  return out;
}
