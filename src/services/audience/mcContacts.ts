import { redactText } from '../../lib/redact';
import { env, type AudienceEnv } from '../../lib/env';

/**
 * The Mailercloud CONTACT client (docs/CMS_AUDIENCE_SYNC_DESIGN.md §3.2, §6; owner 24 Oct). A separate
 * client from the digest's `DigestSender` with a separate key (`MAILERCLOUD_SYNC_API_KEY`), and by
 * construction it can only:
 *   get a contact            GET  /v1/contacts/{email}
 *   create a contact         POST /v1/contacts            (single create — never upsert, never batch)
 *   add tags                 PUT  /v1/contacts/{email}    body {tags} ONLY
 *   remove tags              POST /v1/contact/tag/remove  body {id, tag_ids}
 *   read the tag catalogue   POST /v1/tags/search
 *   read a segment's count   POST /v1/segment/search
 *   re-subscribe (lift path) POST /v1/contacts/resubscribe body {email, consent_source, consent_at} — refused
 *                            unless the client was built with `resubscribeWrites: true`
 * There is NO delete: the CMS deletes a contact on erasure itself (contract v1.3) and we never do.
 * Nothing here ever sends a contact STATUS (Mailercloud ignores one on a PUT and answers `status_not_changed`: the only way back to
 * subscribed is the dedicated re-subscribe endpoint, which records the reader's consent). `/contacts/resubscribe` is requested by
 * `resubscribe()` and nowhere else. A source-scan test pins all of this.
 *
 * Auth is `Authorization: <key>` — the plain key, no "Bearer". Zero dependencies (global fetch).
 * Nothing here logs; every error message is built here, names the operation and the HTTP status, and
 * is passed through `redactText` with the key, so neither the key nor an address leaves in it.
 *
 * Classification (the writer's retry policy depends on it):
 *   2xx                                  → ok
 *   GET 404                              → `null` (absent)
 *   create answered "already exists"     → ALREADY_EXISTS (M-1: a race with the CMS sign-up box)
 *   tag/remove on a missing contact      → ABSENT
 *   re-subscribe answered 404, 409 or 422 → NOT_RESUBSCRIBABLE (final, never retried: not found, bounced / spam / suppressed, or a
 *                                          consent Mailercloud refuses — the writer counts it and the lift is handled)
 *   429, 408, 5xx, network, timeout      → RETRYABLE
 *   any other 4xx (401, 403, 400, quota) → FATAL
 *
 * UNVERIFIED until the M-tests on internal addresses (§6.4): the shape of `tags` on a GET (array of
 * names / ids, or a comma-joined string — all are read), whether PUT/create `tags` take tag NAMES
 * (assumed: we send names, resolved from the catalogue by id) and whether they append or replace
 * (M-3: the writer always sends the union of what is there and what we add, safe either way).
 */

export const MC_CONTACTS_BASE_V1 = 'https://cloudapi.mailercloud.com/v1';
export const MC_CONTACT_TIMEOUT_MS = 30_000;

export type ContactErrorKind = 'RETRYABLE' | 'FATAL' | 'ALREADY_EXISTS' | 'ABSENT' | 'NOT_RESUBSCRIBABLE';

/** What the re-subscribe endpoint did: 200 changed (`subscribed`), 200 already subscribed (`already`), 202 double opt-in e-mail sent (`pending_confirmation`). */
export type ResubscribeOutcome = 'subscribed' | 'already' | 'pending_confirmation';

/** The consent source we send: a fixed, safe description of where the reader's opt-in was given (the CMS account settings). */
export const RESUBSCRIBE_CONSENT_SOURCE = 'taxscan account settings';
export const CONSENT_SOURCE_MAX = 100;
/** Mailercloud answers 422 to a `consent_source` with anything but letters, digits, spaces and . , : - _ / @ + (1–100 characters). */
const CONSENT_SOURCE_DISALLOWED = /[^A-Za-z0-9 .,:\-_/@+]/g;

/**
 * The ONE place a `consent_source` is made safe: everything outside Mailercloud's allowed set is REMOVED (brackets, quotes, control
 * characters, accents…), the rest is cut to 100 characters and trimmed; nothing left → the fixed source above. Never throws.
 */
export function safeConsentSource(raw: unknown): string {
  const cleaned = String(raw ?? '').replace(CONSENT_SOURCE_DISALLOWED, '').slice(0, CONSENT_SOURCE_MAX).trim();
  return cleaned || RESUBSCRIBE_CONSENT_SOURCE;
}

/** The proof of the opt-in Mailercloud wants: where it was given and when (RFC 3339, not in the future, within 90 days, after the unsubscribe). */
export type ResubscribeConsent = { source: string; at: Date };

export class ContactError extends Error {
  constructor(
    readonly kind: ContactErrorKind,
    message: string,
    readonly http: number | null = null,
    /** The operation that failed (`createContact`, …) — set by `McContactClient.err`, for the writer's refusal log. */
    readonly op: string | null = null,
  ) {
    super(message);
    this.name = 'ContactError';
  }
}

export type McContact = {
  id: string | null;
  /** Tag tokens exactly as Mailercloud returned them (names or ids). */
  tags: string[];
};

export type McTag = { id: string; name: string };

export type ContactClientOptions = {
  apiKey: string;
  baseV1?: string;
  timeoutMs?: number;
  /** The §6.3 lift path. Default false: `resubscribe()` refuses before any request. */
  resubscribeWrites?: boolean;
};

const ALREADY_EXISTS_TEXT = /already\s*exist/i;
const NOT_FOUND_TEXT = /not\s*(found|exist)|does\s*not\s*exist|invalid\s*contact/i;

export class McContactClient {
  private readonly key: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly resubscribeWrites: boolean;

  constructor(opts: ContactClientOptions) {
    this.key = opts.apiKey.trim();
    this.base = (opts.baseV1 ?? MC_CONTACTS_BASE_V1).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? MC_CONTACT_TIMEOUT_MS;
    this.resubscribeWrites = opts.resubscribeWrites === true;
  }

  /** The contact, or null when Mailercloud answers 404. */
  async getContact(email: string): Promise<McContact | null> {
    const r = await this.call('getContact', 'GET', `/contacts/${encodeURIComponent(email)}`);
    if (r.status === 404) return null;
    const data = obj(obj(r.body)?.data) ?? obj(r.body);
    if (!data) throw this.err('RETRYABLE', 'getContact', 'unreadable reply', r.status);
    const id = typeof data.id === 'string' || typeof data.id === 'number' ? String(data.id) : null;
    return { id, tags: tagTokens(data.tags) };
  }

  /**
   * Create ONE contact in our list with these tags. Single create, never upsert; no status is sent
   * (Mailercloud's default applies to a NEW contact only). Call only after `getContact` said 404.
   * "Already exists" → ContactError ALREADY_EXISTS (the writer switches to the existing-contact path).
   */
  async createContact(email: string, listId: string, tagNames: readonly string[]): Promise<void> {
    if (!listId) throw this.err('FATAL', 'createContact', 'AUDIENCE_MC_LIST_ID is unset');
    await this.call('createContact', 'POST', '/contacts', { email, list_id: listId, tags: [...tagNames] });
  }

  /** Tags on an existing contact: PUT carrying `tags` ONLY (the union the writer computed). */
  async putTags(email: string, tags: readonly string[]): Promise<void> {
    await this.call('putTags', 'PUT', `/contacts/${encodeURIComponent(email)}`, { tags: [...tags] });
  }

  /** Remove our tags by id. A missing contact → ContactError ABSENT. */
  async removeTags(email: string, tagIds: readonly string[]): Promise<void> {
    if (tagIds.length === 0) return;
    await this.call('removeTags', 'POST', '/contact/tag/remove', { id: email, tag_ids: [...tagIds] });
  }

  /**
   * The ONLY re-subscribe (design §6.3): a CMS opt-in dated after the opt-out, lifted by ingest, with AUDIENCE_RESUBSCRIBE_WRITES on.
   * `POST /v1/contacts/resubscribe` with `{ email, consent_source, consent_at }` and nothing else (no list, ip, text or contact id).
   * Refused before any request otherwise. 200 → `subscribed` (changed) or `already`; 202 → `pending_confirmation` (Mailercloud sent
   * its double opt-in e-mail; a repeat within 24 h sends no second one). A 404, 409 (bounced / spam / suppressed: never possible) or 422
   * (consent refused) → ContactError NOT_RESUBSCRIBABLE; 429 / 5xx / network → RETRYABLE; 401 / 403 (quota) → FATAL.
   */
  async resubscribe(email: string, consent: ResubscribeConsent): Promise<ResubscribeOutcome> {
    if (!this.resubscribeWrites) throw this.err('FATAL', 'resubscribe', 'refused: AUDIENCE_RESUBSCRIBE_WRITES is off');
    if (!(consent?.at instanceof Date) || Number.isNaN(consent.at.getTime())) throw this.err('FATAL', 'resubscribe', 'refused: no valid consent time');
    const r = await this.call('resubscribe', 'POST', '/contacts/resubscribe', {
      email,
      consent_source: safeConsentSource(consent.source),
      consent_at: consent.at.toISOString().replace(/\.\d{3}Z$/, 'Z'), // RFC 3339 to the whole second (floored: never later than the real time)
    });
    const b = obj(r.body);
    if (r.status === 202 || b?.status === 'pending_confirmation') return 'pending_confirmation';
    return b?.changed === false ? 'already' : 'subscribed';
  }

  /** Every tag (id + name), all pages. */
  async listTags(): Promise<McTag[]> {
    const out: McTag[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await this.call('listTags', 'POST', '/tags/search', { limit: 100, page });
      const raw = obj(r.body)?.data;
      const items = Array.isArray(raw) ? raw : obj(raw) ? Object.values(raw as object) : null;
      if (!items) throw this.err('RETRYABLE', 'listTags', 'unreadable reply', r.status);
      for (const it of items) {
        const o = obj(it);
        const id = o && (typeof o.id === 'string' || typeof o.id === 'number') ? String(o.id) : null;
        const name = o && typeof o.tag_name === 'string' ? o.tag_name : o && typeof o.name === 'string' ? o.name : null;
        if (id && name) out.push({ id, name });
      }
      if (items.length < 100) return out;
    }
    throw this.err('RETRYABLE', 'listTags', 'too many pages');
  }

  /**
   * How many contacts carry a tag, if Mailercloud says (M-5, UNVERIFIED: the documented tags/search
   * reply has no count — a numeric `contact_count` / `contacts_count` / `count` on the matching item is
   * read when present). null = Mailercloud does not tell us.
   */
  async tagCount(tagId: string): Promise<number | null> {
    const tags = await this.call('tagCount', 'POST', '/tags/search', { limit: 100, page: 1 });
    const raw = obj(tags.body)?.data;
    const items = Array.isArray(raw) ? raw : obj(raw) ? Object.values(raw as object) : [];
    for (const it of items) {
      const o = obj(it);
      if (!o || String(o.id) !== tagId) continue;
      for (const k of ['contact_count', 'contacts_count', 'count']) {
        const v = o[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
      }
    }
    return null;
  }

  /** A segment's `active_count` (documented on segment/search). null when the segment is not found. */
  async segmentCount(segmentId: string): Promise<number | null> {
    for (let page = 1; page <= 20; page++) {
      const r = await this.call('segmentCount', 'POST', '/segment/search', { limit: 100, page });
      const raw = obj(r.body)?.data;
      const items = Array.isArray(raw) ? raw : obj(raw) ? Object.values(raw as object) : null;
      if (!items) throw this.err('RETRYABLE', 'segmentCount', 'unreadable reply', r.status);
      for (const it of items) {
        const o = obj(it);
        if (o && String(o.id) === segmentId && typeof o.active_count === 'number') return o.active_count;
      }
      if (items.length < 100) return null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */

  private async call(op: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    if (!this.key) throw this.err('FATAL', op, 'not configured (MAILERCLOUD_SYNC_API_KEY unset)');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const headers: Record<string, string> = { Authorization: this.key, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
        redirect: 'error',
      });
      status = res.status;
      text = await res.text();
    } catch {
      throw this.err('RETRYABLE', op, ac.signal.aborted ? `no reply within ${this.timeoutMs} ms` : 'connection failed');
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseJson(text);
    if (status >= 200 && status < 300) return { status, body: parsed };
    if (status === 404 && op === 'getContact') return { status, body: parsed };
    // Re-subscribe: not found, not re-subscribable (bounced / spam / abuse / suppressed) or a consent Mailercloud refuses. Final: the
    // message carries the HTTP status and Mailercloud's fixed code words only, never its free text (it could echo an address).
    if (op === 'resubscribe' && (status === 404 || status === 409 || status === 422)) {
      throw this.err('NOT_RESUBSCRIBABLE', op, `HTTP ${status}${refusalCodes(parsed)}`, status);
    }
    const msg = providerText(parsed);
    if (op === 'createContact' && status >= 400 && status < 500 && ALREADY_EXISTS_TEXT.test(msg)) {
      throw this.err('ALREADY_EXISTS', op, 'contact already exists', status);
    }
    if (op === 'removeTags' && (status === 404 || (status === 400 && NOT_FOUND_TEXT.test(msg)))) {
      throw this.err('ABSENT', op, 'contact not found', status);
    }
    if (status === 429 || status === 408 || status >= 500) throw this.err('RETRYABLE', op, `HTTP ${status}`, status);
    throw this.err('FATAL', op, `HTTP ${status}${msg ? `: ${redactText(msg).slice(0, 120)}` : ''}`, status);
  }

  private err(kind: ContactErrorKind, op: string, message: string, http: number | null = null): ContactError {
    return new ContactError(kind, redactText(`mailercloud contacts ${op}: ${message}`, [this.key]), http, op);
  }
}

/** The production client from the audience env (the SYNC key, not the digest's). */
export function createContactClient(cfg: AudienceEnv = env.audience, overrides: Partial<ContactClientOptions> = {}): McContactClient {
  return new McContactClient({ apiKey: cfg.mailercloud.syncApiKey, resubscribeWrites: cfg.resubscribeWrites, ...overrides });
}

/* ---------------------------------------------------------------- */

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Tags as Mailercloud returns them: an array (of strings or {id|tag_name|name}) or a comma-joined string. */
export function tagTokens(v: unknown): string[] {
  const out: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === 'string' && s.trim()) out.push(s.trim());
    else if (typeof s === 'number') out.push(String(s));
  };
  if (Array.isArray(v)) {
    for (const t of v) {
      const o = obj(t);
      if (o) {
        push(o.id);
        push(o.tag_name ?? o.name);
      } else push(t);
    }
  } else if (typeof v === 'string') {
    for (const t of v.split(',')) push(t);
  }
  return [...new Set(out)];
}

/**
 * Mailercloud's machine-readable words on a refusal (`contact_not_resubscribable`, `invalid`, and for a 409 the contact's
 * `current_status`), as " code (current_status)" — ONLY lower-case snake_case tokens of a sane length are kept, so nothing free-form
 * (an address, a name) can ride along. "" when there is none.
 */
function refusalCodes(body: unknown): string {
  const r = obj(body);
  if (!r) return '';
  const token = (v: unknown, max: number): string | null => (typeof v === 'string' && new RegExp(`^[a-z][a-z_]{2,${max}}$`).test(v) ? v : null);
  const err = obj(r.error);
  const first = Array.isArray(r.errors) ? obj(r.errors[0]) : null;
  const code = token(r.code, 40) ?? token(r.error, 40) ?? token(err?.code, 40) ?? token(first?.code, 40);
  const current = token(r.current_status, 30) ?? token(err?.current_status, 30);
  return `${code ? ` ${code}` : ''}${current ? ` (${current})` : ''}`;
}

/** "message; message" from `{errors:[…]}`, `{error:{…}|string}` or `{message}` — redacted by the caller. */
function providerText(body: unknown): string {
  const r = obj(body);
  if (!r) return '';
  const entries = Array.isArray(r.errors) ? r.errors : r.error !== undefined ? [r.error] : [r];
  return entries
    .map((e) => (typeof e === 'string' ? e : typeof obj(e)?.message === 'string' ? String(obj(e)!.message) : ''))
    .filter(Boolean)
    .join('; ');
}
