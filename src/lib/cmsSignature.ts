import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * HMAC signing between us and the CMS — push-feed contract v1.2 (signing unchanged since v1.1; CMS file
 * `docs/design/push-feed-contract-v1.2-artefacts-2026-10-24.md` §1–§3, §8; our design
 * docs/CMS_AUDIENCE_SYNC_DESIGN.md §5, §8). One rule, both directions:
 *
 *   signed string = <timestamp> "." <METHOD> "." <path> "." <payload>
 *   signature     = "sha256=" + lower-case hex HMAC-SHA256(key = secret (UTF-8), signed string)
 *
 *  - <timestamp>: unix seconds, a plain decimal integer, exactly as sent in the header;
 *  - <path>: starts with "/", no scheme/host/query, never normalised;
 *  - <payload>: POST → the raw body BYTES; GET → the canonical query (§2.1; "" when none).
 *    A GET carrying a body is refused.
 *
 * Doors:
 *  - W (CMS → us, POST /api/integrations/cms/events): `X-CMS-Timestamp`, `X-CMS-Signature`,
 *    nonce `X-CMS-Event-Id` (= body event_id, checked after the signature by the route). We
 *    verify with the CONSTANT path below, never the path the request claims to be on, and
 *    accept the current or the previous secret during a rotation.
 *  - L / V (us → CMS, GET): `X-Push-Timestamp`, `X-Push-Signature`, and a SIGNED `nonce` query
 *    parameter (32 lower-case hex, new per request) — a header nonce would not be signed.
 *
 * Skew: |now − ts| ≤ 300 s. Comparison is constant-time over the 32 digest bytes, against every
 * active secret (no early exit). Nothing here logs; a result says WHY only to the caller, which
 * must answer the same 401 for every failure.
 */

export const CMS_WEBHOOK_PATH = '/api/integrations/cms/events';
export const CMS_MAX_SKEW_SECONDS = 300;
export const CMS_SIGNATURE_PREFIX = 'sha256=';

export const CMS_HEADERS = {
  /** Door W, CMS → us. */
  timestamp: 'X-CMS-Timestamp',
  signature: 'X-CMS-Signature',
  eventId: 'X-CMS-Event-Id',
} as const;

export const PUSH_HEADERS = {
  /** Doors L / V, us → CMS. */
  timestamp: 'X-Push-Timestamp',
  signature: 'X-Push-Signature',
} as const;

export type SignedMethod = 'GET' | 'POST';

export type VerifyFailure =
  | 'no_secret'
  | 'missing_headers'
  | 'bad_timestamp'
  | 'skew'
  | 'bad_signature_format'
  | 'bad_signature'
  | 'bad_path'
  | 'bad_query'
  | 'get_with_body';

export type VerifyResult =
  | { ok: true; ts: number; matched: 'current' | 'previous' }
  | { ok: false; reason: VerifyFailure };

const TS_RE = /^[0-9]{1,15}$/;
const SIG_RE = /^sha256=[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

// ─── canonical query (contract §2.1) ──────────────────────────────────────────

/** RFC 3986 encoding: unreserved `A–Z a–z 0–9 - . _ ~` kept, every other UTF-8 byte → upper-case %XX. */
export function rfc3986Encode(s: string): string {
  // encodeURIComponent leaves !'()* alone; RFC 3986 treats them as reserved.
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** RFC 3986 percent-decoding ONLY (`+` stays a literal plus); null on a bad escape or invalid UTF-8. */
function percentDecode(s: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25 /* % */) {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c < 0x80) {
      bytes.push(c);
    } else {
      // A raw non-ASCII character on the wire: take its UTF-8 bytes as they are.
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      bytes.push(...Buffer.from(ch, 'utf8'));
      if (ch.length === 2) i += 1;
    }
  }
  try {
    return utf8Strict.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export type CanonicalQueryResult =
  | { ok: true; canonical: string; params: Record<string, string> }
  | { ok: false; reason: 'bad_encoding' | 'duplicate_key' };

/**
 * The canonical form of a raw query string (the text after the first `?`, without it).
 * Empty segments are dropped; each splits at its FIRST `=` (none → empty value); keys and
 * values are percent-decoded (RFC 3986 only; must be valid UTF-8), re-encoded with upper-case
 * %XX, a repeated key is refused, pairs are sorted by encoded key (byte order), joined with `&`.
 * No query → "".
 */
export function canonicalizeQuery(rawQuery: string): CanonicalQueryResult {
  const pairs: [string, string][] = [];
  const params: Record<string, string> = Object.create(null);
  for (const segment of rawQuery.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    const rawKey = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? '' : segment.slice(eq + 1);
    const key = percentDecode(rawKey);
    const value = percentDecode(rawValue);
    if (key === null || value === null) return { ok: false, reason: 'bad_encoding' };
    if (Object.prototype.hasOwnProperty.call(params, key)) return { ok: false, reason: 'duplicate_key' };
    params[key] = value;
    pairs.push([rfc3986Encode(key), rfc3986Encode(value)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { ok: true, canonical: pairs.map(([k, v]) => `${k}=${v}`).join('&'), params: { ...params } };
}

/**
 * The canonical query for parameters WE send. Send exactly this string as the URL's query, so
 * the wire form equals the signed form (a `+` goes out as %2B). Throws on a lone surrogate.
 */
export function buildCanonicalQuery(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

// ─── the signed string and the HMAC ──────────────────────────────────────────

function assertPath(path: string): void {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('cmsSignature: path must start with "/" and carry no query or fragment');
  }
}

/** `<ts>.<METHOD>.<path>.<payload>` as bytes. POST payload = the raw body; GET payload = canonical query. */
export function signedBytes(ts: string, method: SignedMethod, path: string, payload: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${ts}.${method}.${path}.`, 'utf8'),
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload,
  ]);
}

/** Lower-case hex HMAC-SHA256 of `message` keyed by the secret's UTF-8 bytes. */
export function hmacHex(secret: string, message: Buffer | string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(message).digest('hex');
}

/** The header value: `sha256=<hex>`. */
export function signatureHeader(secret: string, ts: string, method: SignedMethod, path: string, payload: Buffer | string): string {
  return CMS_SIGNATURE_PREFIX + hmacHex(secret, signedBytes(ts, method, path, payload));
}

/** Unix seconds now, as the header string. */
export function unixSeconds(now: Date = new Date()): string {
  return String(Math.floor(now.getTime() / 1000));
}

/** A fresh door-L/V nonce: 128 random bits as 32 lower-case hex. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

// ─── verification (shared) ───────────────────────────────────────────────────

type VerifyInput = {
  /** [current, previous]; empty strings are skipped. */
  secrets: readonly string[];
  method: SignedMethod;
  path: string;
  payload: Buffer | string;
  timestampHeader: string | undefined | null;
  signatureHeader: string | undefined | null;
  now?: Date;
};

function verifySigned(input: VerifyInput): VerifyResult {
  const secrets = input.secrets.map((s, i) => ({ s, slot: i === 0 ? ('current' as const) : ('previous' as const) })).filter((x) => x.s !== '');
  if (secrets.length === 0) return { ok: false, reason: 'no_secret' };
  const tsRaw = input.timestampHeader ?? '';
  const sigRaw = input.signatureHeader ?? '';
  if (tsRaw === '' || sigRaw === '') return { ok: false, reason: 'missing_headers' };
  if (!TS_RE.test(tsRaw)) return { ok: false, reason: 'bad_timestamp' };
  const ts = Number(tsRaw);
  const nowS = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowS - ts) > CMS_MAX_SKEW_SECONDS) return { ok: false, reason: 'skew' };
  if (!SIG_RE.test(sigRaw)) return { ok: false, reason: 'bad_signature_format' };
  const given = Buffer.from(sigRaw.slice(CMS_SIGNATURE_PREFIX.length), 'hex');
  const message = signedBytes(tsRaw, input.method, input.path, input.payload);
  // Check every secret (no early exit), each in constant time over the 32 digest bytes.
  let matched: 'current' | 'previous' | null = null;
  for (const { s, slot } of secrets) {
    const expected = createHmac('sha256', Buffer.from(s, 'utf8')).update(message).digest();
    if (timingSafeEqual(expected, given) && matched === null) matched = slot;
  }
  return matched ? { ok: true, ts, matched } : { ok: false, reason: 'bad_signature' };
}

/**
 * Door W, inbound: verify a CMS webhook POST over its RAW body bytes. The signed path is
 * always CMS_WEBHOOK_PATH (a proxy rewrite fails closed). The `X-CMS-Event-Id` ⇔ body
 * `event_id` check and the replay rule (`classifyWebhookReplay`) run after this, in the route.
 */
export function verifyCmsWebhook(input: {
  secrets: readonly string[];
  rawBody: Buffer;
  timestampHeader: string | undefined | null;
  signatureHeader: string | undefined | null;
  now?: Date;
}): VerifyResult {
  return verifySigned({
    secrets: input.secrets,
    method: 'POST',
    path: CMS_WEBHOOK_PATH,
    payload: input.rawBody,
    timestampHeader: input.timestampHeader,
    signatureHeader: input.signatureHeader,
    now: input.now,
  });
}

/** Door W, the CMS side (used by tests and the fake CMS): sign a webhook body. */
export function signCmsWebhook(secret: string, rawBody: Buffer | string, now: Date = new Date()): Record<string, string> {
  const ts = unixSeconds(now);
  return {
    [CMS_HEADERS.timestamp]: ts,
    [CMS_HEADERS.signature]: signatureHeader(secret, ts, 'POST', CMS_WEBHOOK_PATH, rawBody),
  };
}

/**
 * Door W replay rule (contract §3), given the receipt we stored for this `event_id` (its first
 * accepted signed timestamp) and the verified timestamp of this delivery:
 *  - no receipt → `new` (apply);
 *  - same timestamp → `exact_replay` (401, not processed);
 *  - a different timestamp → `retry`: only the secret holder can sign a new one, so this is the
 *    CMS re-sending after a lost answer → 2xx, NOT applied again.
 */
export function classifyWebhookReplay(storedSignedTs: number | bigint | null | undefined, ts: number): 'new' | 'exact_replay' | 'retry' {
  if (storedSignedTs === null || storedSignedTs === undefined) return 'new';
  return Number(storedSignedTs) === ts ? 'exact_replay' : 'retry';
}

// ─── doors L / V: our signed GET ─────────────────────────────────────────────

export type SignedGet = {
  /** Path + "?" + canonical query: send exactly this. */
  pathAndQuery: string;
  canonicalQuery: string;
  nonce: string;
  ts: string;
  headers: Record<string, string>;
};

/**
 * Sign one GET to the CMS. Adds a fresh `nonce` (or the one given — tests only; it must be 32
 * lower-case hex), builds the canonical query and signs `<ts>.GET.<path>.<canonical query>`.
 * The caller sends `pathAndQuery` verbatim with `headers` and NO body; a retry calls this again
 * (new timestamp, new nonce).
 */
export function signPushGet(input: {
  secret: string;
  path: string;
  params?: Readonly<Record<string, string>>;
  now?: Date;
  nonce?: string;
}): SignedGet {
  if (!input.secret) throw new Error('cmsSignature: no secret configured');
  assertPath(input.path);
  const params = { ...(input.params ?? {}) };
  if (Object.prototype.hasOwnProperty.call(params, 'nonce')) throw new Error('cmsSignature: nonce is added by signPushGet');
  const nonce = input.nonce ?? newNonce();
  if (!NONCE_RE.test(nonce)) throw new Error('cmsSignature: nonce must be 32 lower-case hex characters');
  params.nonce = nonce;
  const canonicalQuery = buildCanonicalQuery(params);
  const ts = unixSeconds(input.now);
  return {
    pathAndQuery: `${input.path}?${canonicalQuery}`,
    canonicalQuery,
    nonce,
    ts,
    headers: {
      [PUSH_HEADERS.timestamp]: ts,
      [PUSH_HEADERS.signature]: signatureHeader(input.secret, ts, 'GET', input.path, canonicalQuery),
    },
  };
}

/**
 * Doors L / V, the CMS side (the fake CMS in tests verifies OUR requests with this): verify a
 * signed GET from its path, raw query and headers. Refuses a body, a duplicate key, bad
 * encoding, and a missing/malformed `nonce`; nonce REUSE is the caller's store (TTL 300 s).
 */
export function verifyPushGet(input: {
  secrets: readonly string[];
  path: string;
  rawQuery: string;
  bodyLength?: number;
  timestampHeader: string | undefined | null;
  signatureHeader: string | undefined | null;
  now?: Date;
}): VerifyResult & { nonce?: string; params?: Record<string, string> } {
  if ((input.bodyLength ?? 0) > 0) return { ok: false, reason: 'get_with_body' };
  if (!input.path.startsWith('/') || input.path.includes('?')) return { ok: false, reason: 'bad_path' };
  const q = canonicalizeQuery(input.rawQuery);
  if (!q.ok) return { ok: false, reason: 'bad_query' };
  const res = verifySigned({
    secrets: input.secrets,
    method: 'GET',
    path: input.path,
    payload: q.canonical,
    timestampHeader: input.timestampHeader,
    signatureHeader: input.signatureHeader,
    now: input.now,
  });
  if (!res.ok) return res;
  // Checked after the signature, as the CMS does: a failed check stores and reveals nothing.
  if (!NONCE_RE.test(q.params.nonce ?? '')) return { ok: false, reason: 'bad_query' };
  return { ...res, nonce: q.params.nonce, params: q.params };
}
