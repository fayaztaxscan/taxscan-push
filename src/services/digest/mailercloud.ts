import { env, type DigestEnv } from '../../lib/env';
import {
  DUPLICATE_NAME_CODE,
  SenderError,
  redactError,
  type CampaignReport,
  type CampaignStatus,
  type DigestSender,
  type DraftInput,
  type ProviderCampaignState,
} from './sender';

/**
 * Mailercloud implementation of `DigestSender` (docs/EMAIL_DIGEST_DESIGN.md
 * §4, §8, §13 task 2). Zero dependencies: Node's global `fetch` +
 * AbortController.
 *
 * Endpoints (checked against apidoc.mailercloud.com openapi-v1/-v2, 2026-10-22):
 *   health             GET  /v1/client/plan
 *   createDraft        POST /v2/campaign/save       (is_publish "0" → a draft)
 *   schedule           POST /v1/campaign/schedule/{id}   (no scheduled_at → now)
 *   status, report     GET  /v1/campaign/{id}
 *   testSend           POST /v1/campaign/testmail/{id}   (one call per address)
 *   findCampaignByName POST /v1/campaign/list        (search, exact-name match)
 *   webhookStatus      GET  /v1/webhooks/detail/{id} (task 13; status Active/1 vs Inactive/0)
 *
 * Read-only mode (`readOnly: true`, task 13 — the `digest:lookup` CLI): every
 * write (createDraft, schedule, testSend) is refused inside `call()` before
 * any request is made, so such a client can only read.
 *
 * Auth is `Authorization: <key>` — the plain key, NO "Bearer " prefix.
 *
 * Retries: only calls that are safe to repeat (health, status, report, the
 * campaign-list lookup) are retried here, on 429 / 5xx / network failure, with
 * exponential backoff and jitter (~1 s doubling, cap 30 s, ≤ 5 retries;
 * Mailercloud sends no Retry-After). createDraft, schedule and testSend are
 * NEVER repeated inside the client: they throw the classified SenderError and
 * the runner's write-ahead markers decide what happens next.
 *
 * Classification (the runner depends on it):
 *   2xx                                        → ok
 *   4xx with code 9002 or a quota/credit message → FATAL, code = "9002" | "quota"
 *   429                                        → RETRYABLE, http 429
 *   408, 5xx                                   → RETRYABLE, http set (may have been applied)
 *   any other 3xx/4xx (401, 403, 400, 422, 404) → FATAL, http set
 *   connect-phase failure (refused, DNS, TLS, connect timeout) → RETRYABLE, notSent
 *   timeout / reset after the request left: write → AMBIGUOUS, read → RETRYABLE
 *   create answered 2xx without an id           → AMBIGUOUS (it was probably made)
 *
 * The client never logs. Every error message is passed through `redactError`
 * with this client's key, so neither the key nor an address can leave in it.
 */

/** Per-request timeout. Well under the runner's 10-minute stale-claim window, even with every retry. */
export const MC_TIMEOUT_MS = 30_000;
export const MC_MAX_RETRIES = 5;
export const MC_BACKOFF_BASE_MS = 1_000;
export const MC_BACKOFF_CAP_MS = 30_000;
/** Page size and page limit for the exact-name lookup (the API allows 10–100 per page). */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 5;
/** Whole-lookup budget: stays well under the runner's 10-minute stale-claim window. */
const LIST_DEADLINE_MS = 5 * 60_000;

export const MC_BASE_V1 = 'https://cloudapi.mailercloud.com/v1';
export const MC_BASE_V2 = 'https://cloudapi.mailercloud.com/v2';

export type MailercloudOptions = {
  apiKey: string;
  senderName: string;
  senderEmail: string;
  replyEmail?: string;
  /** Injectable for tests (a local fake server). */
  baseV1?: string;
  baseV2?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Injectable so tests do not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Task 13: refuse every write before a request is made (the read-only lookup CLI). */
  readOnly?: boolean;
};

type Mode = 'read' | 'write';
type Op = 'health' | 'createDraft' | 'schedule' | 'status' | 'report' | 'testSend' | 'findCampaignByName' | 'webhookStatus';
type Reply = { status: number; body: unknown };

/** Error codes that mean the connection was never made, so no request byte reached the provider. */
const CONNECT_PHASE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Mailercloud campaign status (case-insensitive) → our normalised state. Unknown values throw. */
const STATUS_MAP: Record<string, ProviderCampaignState> = {
  draft: 'DRAFT',
  scheduled: 'SCHEDULED',
  rescheduled: 'SCHEDULED',
  queued: 'SCHEDULED',
  processing: 'SCHEDULED',
  sending: 'SENDING',
  // Not progressing, not done: the runner keeps polling and fails it at the cut-off.
  paused: 'SENDING',
  finished: 'SENT',
  aborted: 'FAILED',
  failed: 'FAILED',
};

const QUOTA_CODES = new Set(['9002']);
const QUOTA_TEXT = /quota|insufficient|credits?\b|balance|funds/i;

export class MailercloudSender implements DigestSender {
  private readonly o: Required<Omit<MailercloudOptions, 'replyEmail'>> & { replyEmail: string };

  constructor(opts: MailercloudOptions) {
    this.o = {
      apiKey: opts.apiKey.trim(),
      senderName: opts.senderName,
      senderEmail: opts.senderEmail,
      replyEmail: opts.replyEmail ?? '',
      baseV1: (opts.baseV1 ?? MC_BASE_V1).replace(/\/+$/, ''),
      baseV2: (opts.baseV2 ?? MC_BASE_V2).replace(/\/+$/, ''),
      timeoutMs: opts.timeoutMs ?? MC_TIMEOUT_MS,
      maxRetries: opts.maxRetries ?? MC_MAX_RETRIES,
      backoffBaseMs: opts.backoffBaseMs ?? MC_BACKOFF_BASE_MS,
      backoffCapMs: opts.backoffCapMs ?? MC_BACKOFF_CAP_MS,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: opts.random ?? Math.random,
      readOnly: opts.readOnly ?? false,
    };
  }

  /** True when this client refuses every write (createDraft, schedule, testSend). */
  isReadOnly(): boolean {
    return this.o.readOnly;
  }

  async health(): Promise<void> {
    await this.call('health', 'read', 'GET', `${this.o.baseV1}/client/plan`);
  }

  async createDraft(input: DraftInput): Promise<{ campaignId: string }> {
    if (!this.o.senderEmail.trim() || !this.o.senderName.trim()) {
      throw this.err('FATAL', 'createDraft', 'not configured (MAILERCLOUD_SENDER_NAME / _SENDER_EMAIL unset)', { notSent: true });
    }
    const t = input.target;
    const body: Record<string, unknown> = {
      name: input.name,
      subject: input.subject,
      sender: { sender_name: this.o.senderName, sender_email: this.o.senderEmail },
      html: input.html,
      email_preheader: input.preheader,
      list_ids: t.listIds,
      segments: t.segmentIds,
      tag_ids: t.tagIds,
      exclude_list_ids: t.excludeListIds,
      exclude_tag_ids: t.excludeTagIds,
      track_opens: '1',
      track_clicks: '1',
      // The owner wants a manage-preferences link in the footer.
      mailing_preference: true,
      // "0" = save as a draft. The ONLY thing that sends it is schedule().
      is_publish: '0',
    };
    if (input.text) body.plain_text = input.text;
    if (this.o.replyEmail.trim()) body.reply_email = this.o.replyEmail.trim();

    const reply = await this.call('createDraft', 'write', 'POST', `${this.o.baseV2}/campaign/save`, body);
    const id = idOf(reply.body);
    if (!id) {
      // A 2xx means the campaign was most likely made; without its id only a lookup can tell.
      throw this.err('AMBIGUOUS', 'createDraft', `HTTP ${reply.status} without a campaign id`, { http: reply.status });
    }
    return { campaignId: id };
  }

  async schedule(campaignId: string, when: 'now'): Promise<void> {
    if (when !== 'now') throw this.err('FATAL', 'schedule', `unsupported "when"`, { notSent: true });
    // No scheduled_at: Mailercloud schedules for the current time.
    await this.call('schedule', 'write', 'POST', `${this.o.baseV1}/campaign/schedule/${encodeURIComponent(campaignId)}`, {});
  }

  async status(campaignId: string): Promise<CampaignStatus> {
    const c = await this.campaign('status', campaignId);
    const raw = typeof c.status === 'string' ? c.status.trim().toLowerCase() : '';
    const state = STATUS_MAP[raw];
    if (!state) {
      // Never guess a state: the runner treats a status error as "unknown" and does not schedule.
      throw this.err('RETRYABLE', 'status', `unrecognised campaign status "${String(c.status).slice(0, 40)}"`);
    }
    const r = asRecord(c.report_summary);
    // UNVERIFIED: targeted = report_summary.queued_total, reached = report_summary.sent (the
    // API examples show both; whether suppressed contacts make sent < queued_total on a
    // finished campaign is not documented — that would read as PARTIALLY_SENT).
    return { state, targeted: num(r?.queued_total), reached: num(r?.sent) };
  }

  async report(campaignId: string): Promise<CampaignReport> {
    const r = asRecord((await this.campaign('report', campaignId)).report_summary);
    return { opens: num(r?.opens), clicks: num(r?.clicks) };
  }

  async testSend(campaignId: string, emails: string[]): Promise<void> {
    // The endpoint takes one address per call. Not retried: a repeat is a duplicate test mail.
    for (const email of emails) {
      await this.call('testSend', 'write', 'POST', `${this.o.baseV1}/campaign/testmail/${encodeURIComponent(campaignId)}`, {
        email,
      });
    }
  }

  /**
   * Exact-name lookup over the campaign list's `search` filter. Returns null
   * only when the provider's answer proves no such campaign exists (a short
   * last page with no exact match). A reply we cannot read, or more pages
   * than we are willing to walk, throws — it is never read as "not found".
   */
  async findCampaignByName(name: string): Promise<{ campaignId: string } | null> {
    const hits = await this.scanByName(name, true);
    // Two campaigns with exactly our name (one copied and renamed by hand, say) prove
    // nothing about which one is ours: adopting the wrong one could schedule a draft
    // while its twin was already sent. Inconclusive, never a guess — and said as such
    // (code duplicate_name), so the banner asks for the extra one to be deleted.
    if (hits.length > 1) {
      throw this.err('RETRYABLE', 'findCampaignByName', `lookup inconclusive: ${hits.length} campaigns have this exact name`, {
        code: DUPLICATE_NAME_CODE,
      });
    }
    return hits[0] ? { campaignId: hits[0].campaignId } : null;
  }

  /**
   * EVERY campaign with exactly this name, with its provider status (task 13, the
   * read-only `digest:lookup` CLI). Walks all pages; an unreadable reply or more
   * pages than allowed throws, never "none".
   */
  async findCampaignsByName(name: string): Promise<{ campaignId: string; status: string | null }[]> {
    return this.scanByName(name, false);
  }

  /**
   * Webhook status (task 13, health.ts's daily check). UNVERIFIED shape (design §12
   * open question 3): `status` "Active"/1 = on, "Inactive"/"Disabled"/0 = off, at the
   * top level or under `data` (also `data["0"]`). Anything else throws — an
   * unreadable answer is never read as "switched off".
   */
  async webhookStatus(webhookId: string): Promise<{ active: boolean }> {
    const reply = await this.call('webhookStatus', 'read', 'GET', `${this.o.baseV1}/webhooks/detail/${encodeURIComponent(webhookId)}`);
    const r = asRecord(reply.body);
    const d = asRecord(r?.data);
    const holder = d && 'status' in d ? d : asRecord(d?.['0']) ?? r;
    const raw = holder?.status;
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : typeof raw === 'number' ? String(raw) : '';
    if (v === 'active' || v === '1' || v === 'enabled') return { active: true };
    if (v === 'inactive' || v === '0' || v === 'disabled' || v === 'deactivated') return { active: false };
    throw this.err('RETRYABLE', 'webhookStatus', 'unreadable webhook status reply');
  }

  /* ---------------------------------------------------------------- */

  /**
   * Exact-name matches over the campaign list's `search` filter. `stopAtHit`: return
   * as soon as a page holds a match (the runner's lookup); otherwise walk to the last
   * page. Null-safe: an unreadable reply, a match without an id, an exhausted time
   * budget or too many pages throw RETRYABLE — never an empty answer.
   */
  private async scanByName(name: string, stopAtHit: boolean): Promise<{ campaignId: string; status: string | null }[]> {
    const startedAt = Date.now();
    const out: { campaignId: string; status: string | null }[] = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      if (Date.now() - startedAt > LIST_DEADLINE_MS) {
        throw this.err('RETRYABLE', 'findCampaignByName', 'lookup inconclusive: time budget exceeded');
      }
      const reply = await this.call('findCampaignByName', 'read', 'POST', `${this.o.baseV1}/campaign/list`, {
        limit: LIST_PAGE_SIZE,
        page,
        search: name,
      });
      const items = listItems(reply.body);
      if (!items) throw this.err('RETRYABLE', 'findCampaignByName', 'unreadable campaign list reply');
      for (const hit of items.filter((c) => c.name === name)) {
        const id = idOf(hit);
        if (!id) throw this.err('RETRYABLE', 'findCampaignByName', 'matching campaign has no id');
        out.push({ campaignId: id, status: typeof hit.status === 'string' ? hit.status.slice(0, 40) : null });
      }
      if (stopAtHit && out.length > 0) return out;
      if (items.length < LIST_PAGE_SIZE) return out;
    }
    throw this.err('RETRYABLE', 'findCampaignByName', `lookup inconclusive after ${LIST_MAX_PAGES} pages`);
  }

  private async campaign(op: 'status' | 'report', campaignId: string): Promise<Record<string, unknown>> {
    const reply = await this.call(op, 'read', 'GET', `${this.o.baseV1}/campaign/${encodeURIComponent(campaignId)}`);
    const c = campaignOf(reply.body);
    if (!c) throw this.err('RETRYABLE', op, 'unreadable campaign reply');
    return c;
  }

  /** One logical call: a single attempt for writes; bounded retries with backoff for reads. */
  private async call(op: Op, mode: Mode, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Reply> {
    if (!this.o.apiKey) throw this.err('FATAL', op, 'not configured (MAILERCLOUD_API_KEY unset)', { notSent: true });
    // Read-only client: a write never leaves this process (checked before any request).
    if (mode === 'write' && this.o.readOnly) throw this.err('FATAL', op, 'refused: this client is read-only', { notSent: true });
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(op, mode, method, url, body);
      } catch (err) {
        const retry = mode === 'read' && err instanceof SenderError && err.kind === 'RETRYABLE' && attempt < this.o.maxRetries;
        if (!retry) throw err;
        await this.o.sleep(this.backoff(attempt));
      }
    }
  }

  /** Exponential, with jitter: half the step fixed, half random. Step = base·2^n, capped. */
  private backoff(attempt: number): number {
    const step = Math.min(this.o.backoffCapMs, this.o.backoffBaseMs * 2 ** attempt);
    return Math.round(step / 2 + this.o.random() * (step / 2));
  }

  private async attempt(op: Op, mode: Mode, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Reply> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs);
    let status: number;
    let text: string;
    try {
      const headers: Record<string, string> = { Authorization: this.o.apiKey, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
        // A redirect is a misconfiguration; never let fetch replay a POST elsewhere.
        redirect: 'manual',
      });
      status = res.status;
      text = await res.text(); // still under the same timer
    } catch (err) {
      throw this.networkError(op, mode, err, ac.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseJson(text);
    if (status >= 200 && status < 300) return { status, body: parsed };
    throw this.httpError(op, status, parsed);
  }

  private networkError(op: Op, mode: Mode, err: unknown, timedOut: boolean): SenderError {
    const code = connectCode(err);
    if (!timedOut && code && CONNECT_PHASE_CODES.has(code)) {
      return this.err('RETRYABLE', op, `connection failed before the request was sent (${code})`, { notSent: true });
    }
    const what = timedOut ? `no reply within ${this.o.timeoutMs} ms` : `connection lost (${code ?? 'network error'})`;
    // The request may have reached Mailercloud. A write may have been applied; a read is just retried.
    return mode === 'write'
      ? this.err('AMBIGUOUS', op, `${what}; the provider may have acted`)
      : this.err('RETRYABLE', op, what);
  }

  private httpError(op: Op, status: number, body: unknown): SenderError {
    const code = providerCode(body);
    const detail = providerMessage(body);
    const msg = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
    if (status >= 400 && status < 500 && ((code && QUOTA_CODES.has(code)) || (detail && QUOTA_TEXT.test(detail)))) {
      return this.err('FATAL', op, `quota or funds: ${msg}`, { http: status, code: code ?? 'quota' });
    }
    if (status === 429 || status === 408 || status >= 500) return this.err('RETRYABLE', op, msg, { http: status, code });
    return this.err('FATAL', op, msg, { http: status, code });
  }

  private err(
    kind: SenderError['kind'],
    op: Op,
    message: string,
    opts: { code?: string | null; http?: number | null; notSent?: boolean } = {},
  ): SenderError {
    // Redacted here, at the source, so err.message itself is safe to store or show.
    return new SenderError(kind, redactError(new Error(`mailercloud ${op}: ${message}`), [this.o.apiKey]), opts);
  }
}

/** The runner-facing factory. Reads the Railway secrets from the digest env; logs nothing. */
export function createMailercloudSender(
  cfg: DigestEnv = env.digest,
  overrides: Partial<MailercloudOptions> = {},
): MailercloudSender {
  return new MailercloudSender({
    apiKey: cfg.mailercloud.apiKey,
    senderName: cfg.mailercloud.senderName,
    senderEmail: cfg.mailercloud.senderEmail,
    replyEmail: cfg.mailercloud.replyEmail,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* Reply parsing (defensive: the documented shapes vary by endpoint)   */
/* ------------------------------------------------------------------ */

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function idOf(v: unknown): string | null {
  const r = asRecord(v);
  const id = r?.id ?? asRecord(r?.data)?.id;
  if (typeof id === 'string' && id.trim()) return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

/** `{data: {"0": {...}}}` (as documented), `{data: [{...}]}` or `{data: {...}}`. */
function campaignOf(body: unknown): Record<string, unknown> | null {
  const data = asRecord(body)?.data;
  if (Array.isArray(data)) return asRecord(data[0]);
  const d = asRecord(data);
  if (!d) return null;
  if ('status' in d || 'id' in d) return d;
  return asRecord(d['0']);
}

/** Campaign list items: `data` as an array or a `{"0": {...}, "1": {...}}` object. Null = unreadable. */
/**
 * The campaign rows of a list reply, or null when the shape is not one we
 * recognise. Strict on purpose: `findCampaignByName` reads null as
 * "unreadable" (throws) but an empty array as "not found" (the runner may then
 * create again), so a nested shape like `data: {list: [...]}` or rows without a
 * string `name` must never come out as an empty list.
 */
function listItems(body: unknown): Record<string, unknown>[] | null {
  const data = asRecord(body)?.data;
  const values = Array.isArray(data) ? data : asRecord(data) ? Object.values(data as object) : null;
  if (!values) return null;
  const rows = values.map(asRecord);
  if (rows.some((x) => x === null || typeof x.name !== 'string')) return null;
  return rows as Record<string, unknown>[];
}

/** The provider's own error code, if any (`code`, `error_code`, `error.code`, `errors[0].code`). */
function providerCode(body: unknown): string | null {
  const r = asRecord(body);
  const errors = Array.isArray(r?.errors) ? r?.errors : [];
  const c = r?.code ?? r?.error_code ?? asRecord(r?.error)?.code ?? asRecord(errors[0])?.code;
  return typeof c === 'string' || typeof c === 'number' ? String(c) : null;
}

/** "field: message; …" from `{errors: [...]}`, `{error: {...}}` or `{message}`, ≤ 200 chars. */
function providerMessage(body: unknown): string {
  const r = asRecord(body);
  if (!r) return '';
  const entries = Array.isArray(r.errors) ? r.errors : r.error ? [r.error] : [r];
  const parts = entries
    .map((e) => {
      const x = asRecord(e);
      if (!x) return typeof e === 'string' ? e : '';
      const m = typeof x.message === 'string' ? x.message : '';
      const f = typeof x.field === 'string' && x.field ? `${x.field}: ` : '';
      return m ? `${f}${m}` : '';
    })
    .filter(Boolean);
  return parts.join('; ').slice(0, 200);
}

/**
 * The system error code behind a fetch failure (undici wraps it in `cause`).
 * For an AggregateError (happy-eyeballs tried several addresses) a code is
 * returned only when EVERY attempt failed in the connect phase.
 */
function connectCode(err: unknown): string | null {
  const cause = (err as { cause?: unknown })?.cause as { code?: unknown; errors?: unknown[] } | undefined;
  if (!cause) return null;
  if (Array.isArray(cause.errors) && cause.errors.length > 0) {
    const codes = cause.errors.map((e) => (e as { code?: unknown })?.code);
    const allConnect = codes.every((c) => typeof c === 'string' && CONNECT_PHASE_CODES.has(c));
    return allConnect ? (codes[0] as string) : 'mixed';
  }
  return typeof cause.code === 'string' ? cause.code : null;
}
