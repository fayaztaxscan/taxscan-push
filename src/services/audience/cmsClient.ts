import { signPushGet } from '../../lib/cmsSignature';
import { redactText } from '../../lib/redact';
import { env, type AudienceEnv } from '../../lib/env';

/**
 * Door L client — our signed GET to the CMS subscriber list (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.2;
 * push-feed contract v1.3 §1–§3, §7). Zero dependencies: Node's global `fetch` + AbortController.
 *
 * Every request:
 *  - goes to `env.audience.cms.baseUrl` + LIST_PATH, **https only**, host on the allow-list (the env
 *    already refuses anything else; checked again here, at the door);
 *  - is signed with `signPushGet` over the path `new URL()` will actually send and the canonical
 *    query (a fresh 128-bit `nonce` per request — a retry is signed again, new ts + new nonce), and
 *    the URL sent is asserted to carry exactly that path and query;
 *  - uses `redirect: 'error'`, so a redirect can never carry a signed request anywhere;
 *  - times out after 30 s; 429 / 5xx / network failures are retried up to 3 times with jittered
 *    backoff; any other answer is FATAL for this page.
 *
 * A reply is accepted only in the contract's shape: `{data: [...rows], meta: {next_cursor: string |
 * null, as_of: <instant>}}`, at most `limit` rows; `meta.counts` (optional, design §12.2 #6) is read
 * when present. Rows are returned RAW — the caller parses each with `parseCmsListRow`.
 *
 * Never logs. An error message names the HTTP status or the failing check — never the secret, the
 * signature, a row or an address (and is passed through `redactText` anyway).
 */

export const LIST_PATH = '/api/v1/push-feed/subscribers';
export const CMS_TIMEOUT_MS = 30_000;
export const CMS_MAX_RETRIES = 3;
export const CMS_BACKOFF_BASE_MS = 2_000;
export const CMS_BACKOFF_CAP_MS = 30_000;
/** Contract §1: 1,000 by default, 5,000 at most. */
export const CMS_PAGE_LIMIT = 5_000;
/** A page of 5,000 rows is ~2 MB; anything far larger is not a page we will parse. */
const MAX_BODY_CHARS = 32 * 1024 * 1024;

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const COUNT_KEYS = ['active', 'cancelled', 'free', 'ended'] as const;

export type CmsCounts = Partial<Record<(typeof COUNT_KEYS)[number], number>>;

export type CmsPage = {
  rows: unknown[];
  nextCursor: string | null;
  asOf: Date;
  /** `meta.counts`, only when the CMS sends it (each key a non-negative integer). */
  counts: CmsCounts | null;
};

export class CmsPullError extends Error {
  constructor(
    readonly kind: 'RETRYABLE' | 'FATAL',
    message: string,
    readonly http: number | null = null,
  ) {
    super(message);
    this.name = 'CmsPullError';
  }
}

export type CmsClientOptions = {
  baseUrl: string;
  secret: string;
  allowedHosts: readonly string[];
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  /**
   * TESTS ONLY: allow plain http to 127.0.0.1 / ::1 (the fake CMS). Refused unless
   * NODE_ENV === 'test'; production never sets it (`createCmsClient` does not pass it).
   */
  allowLoopbackHttpForTests?: boolean;
};

export type PageQuery = { updatedSince?: Date | null; cursor?: string | null; limit?: number };

export class CmsListClient {
  private readonly o: Required<Omit<CmsClientOptions, 'allowLoopbackHttpForTests'>> & { loopback: boolean };

  constructor(opts: CmsClientOptions) {
    this.o = {
      baseUrl: opts.baseUrl,
      secret: opts.secret,
      allowedHosts: opts.allowedHosts.map((h) => h.toLowerCase()),
      timeoutMs: opts.timeoutMs ?? CMS_TIMEOUT_MS,
      maxRetries: opts.maxRetries ?? CMS_MAX_RETRIES,
      backoffBaseMs: opts.backoffBaseMs ?? CMS_BACKOFF_BASE_MS,
      backoffCapMs: opts.backoffCapMs ?? CMS_BACKOFF_CAP_MS,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: opts.random ?? Math.random,
      now: opts.now ?? (() => new Date()),
      loopback: opts.allowLoopbackHttpForTests === true && process.env.NODE_ENV === 'test',
    };
  }

  /** The list URL (no query), validated: https (or loopback http in tests), allowed host. Throws FATAL. */
  listUrl(): URL {
    if (!this.o.secret) throw new CmsPullError('FATAL', 'cms list: CMS_FEED_PULL_SECRET is unset');
    let u: URL;
    try {
      u = new URL(`${this.o.baseUrl.replace(/\/+$/, '')}${LIST_PATH}`);
    } catch {
      throw new CmsPullError('FATAL', 'cms list: CMS_FEED_BASE_URL is not a valid URL');
    }
    const loopbackHost = u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    const httpsOk = u.protocol === 'https:' || (this.o.loopback && u.protocol === 'http:' && loopbackHost);
    if (!httpsOk) throw new CmsPullError('FATAL', 'cms list: only https is allowed');
    if (u.username || u.password || u.search || u.hash) throw new CmsPullError('FATAL', 'cms list: the base URL must be a plain origin + path');
    if (!this.o.allowedHosts.includes(u.hostname.toLowerCase())) throw new CmsPullError('FATAL', 'cms list: host is not in CMS_FEED_ALLOWED_HOSTS');
    return u;
  }

  /** One page, with bounded retries for 429 / 5xx / network. Every attempt is signed afresh. */
  async fetchPage(q: PageQuery): Promise<CmsPage> {
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? CMS_PAGE_LIMIT)), CMS_PAGE_LIMIT);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(q, limit);
      } catch (err) {
        const e = err instanceof CmsPullError ? err : new CmsPullError('RETRYABLE', 'cms list: request failed');
        if (e.kind !== 'RETRYABLE' || attempt >= this.o.maxRetries) throw e;
        await this.o.sleep(this.backoff(attempt));
      }
    }
  }

  private backoff(attempt: number): number {
    const step = Math.min(this.o.backoffCapMs, this.o.backoffBaseMs * 2 ** attempt);
    return Math.round(step / 2 + this.o.random() * (step / 2));
  }

  private async attempt(q: PageQuery, limit: number): Promise<CmsPage> {
    const base = this.listUrl();
    const params: Record<string, string> = { limit: String(limit) };
    if (q.cursor) params.cursor = q.cursor;
    if (q.updatedSince) params.updated_since = q.updatedSince.toISOString();
    // Sign the path WHATWG URL will send (`base.pathname`), then prove the URL we send carries exactly it.
    const signed = signPushGet({ secret: this.o.secret, path: base.pathname, params, now: this.o.now() });
    const target = new URL(`${base.origin}${signed.pathAndQuery}`);
    if (target.pathname !== base.pathname || target.search !== `?${signed.canonicalQuery}`) {
      throw new CmsPullError('FATAL', 'cms list: the URL would not carry the signed path and query');
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await fetch(target.href, {
        method: 'GET',
        headers: { ...signed.headers, Accept: 'application/json' },
        redirect: 'error',
        signal: ac.signal,
      });
      status = res.status;
      text = await res.text();
    } catch {
      // Timeout, connection failure, or a redirect (refused by redirect: 'error'): never the cause text.
      throw new CmsPullError('RETRYABLE', ac.signal.aborted ? `cms list: no reply within ${this.o.timeoutMs} ms` : 'cms list: connection failed or redirected');
    } finally {
      clearTimeout(timer);
    }
    if (status === 429 || status >= 500 || status === 408) throw new CmsPullError('RETRYABLE', `cms list: HTTP ${status}`, status);
    if (status < 200 || status >= 300) throw new CmsPullError('FATAL', `cms list: HTTP ${status}`, status);
    if (text.length > MAX_BODY_CHARS) throw new CmsPullError('FATAL', 'cms list: reply too large');
    return parsePage(text, limit);
  }
}

/** Strict contract shape → CmsPage, or a FATAL error naming the failing field. */
export function parsePage(text: string, limit: number = CMS_PAGE_LIMIT): CmsPage {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CmsPullError('FATAL', 'cms list: reply is not JSON');
  }
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.data)) throw new CmsPullError('FATAL', 'cms list: reply has no data array');
  if (o.data.length > limit) throw new CmsPullError('FATAL', 'cms list: more rows than the limit');
  const meta = o.meta && typeof o.meta === 'object' && !Array.isArray(o.meta) ? (o.meta as Record<string, unknown>) : null;
  if (!meta) throw new CmsPullError('FATAL', 'cms list: reply has no meta');
  const nc = meta.next_cursor;
  if (!(nc === null || (typeof nc === 'string' && nc.length > 0 && nc.length <= 1024))) throw new CmsPullError('FATAL', 'cms list: bad meta.next_cursor');
  const asOf = typeof meta.as_of === 'string' && INSTANT_RE.test(meta.as_of) ? new Date(meta.as_of) : null;
  if (!asOf || Number.isNaN(asOf.getTime())) throw new CmsPullError('FATAL', 'cms list: bad meta.as_of');
  let counts: CmsCounts | null = null;
  if (meta.counts !== undefined && meta.counts !== null) {
    const c = meta.counts && typeof meta.counts === 'object' && !Array.isArray(meta.counts) ? (meta.counts as Record<string, unknown>) : null;
    if (!c) throw new CmsPullError('FATAL', 'cms list: bad meta.counts');
    counts = {};
    for (const k of COUNT_KEYS) {
      const v = c[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new CmsPullError('FATAL', 'cms list: bad meta.counts');
      counts[k] = v;
    }
  }
  return { rows: o.data, nextCursor: nc as string | null, asOf, counts };
}

/** The production client, from the audience env. No secret is ever logged. */
export function createCmsClient(cfg: AudienceEnv = env.audience, overrides: Partial<CmsClientOptions> = {}): CmsListClient {
  return new CmsListClient({ baseUrl: cfg.cms.baseUrl, secret: cfg.cms.pullSecret, allowedHosts: cfg.cms.allowedHosts, ...overrides });
}

/** An error's message, safe to store or log (secrets + addresses removed). */
export function cmsErrorText(err: unknown, cfg: AudienceEnv = env.audience): string {
  const msg = err instanceof CmsPullError ? err.message : 'cms list: unexpected failure';
  return redactText(msg, [cfg.cms.pullSecret, cfg.cms.inboundSecret, cfg.cms.inboundSecretPrevious].filter(Boolean)).slice(0, 160);
}
