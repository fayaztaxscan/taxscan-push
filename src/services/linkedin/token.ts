import cron from 'node-cron';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { istDay } from '../whatsapp/queue';

/**
 * LinkedIn access-token renewal (brief 2026-11-02-linkedin-token-refresh, docs/LINKEDIN_POSTING.md "Token renewal").
 *
 * The page's access token lasts about 60 days, its refresh token about a year (LinkedIn: "Refresh Tokens with OAuth 2.0").
 * Once a day (10:15 IST, and ~2 minutes after boot) a page whose access token has 14 days or less left is renewed:
 *   POST https://www.linkedin.com/oauth/v2/accessToken   grant_type=refresh_token, refresh_token, client_id, client_secret
 *   → access_token, expires_in, refresh_token (the same one, or a new one), refresh_token_expires_in (seconds remaining)
 * and "when does the token expire" comes from the token inspector:
 *   POST https://www.linkedin.com/oauth/v2/introspectToken   client_id, client_secret, token → active, status, expires_at (epoch s)
 * (both checked against LinkedIn's docs, 2 Nov 2026). A renewed token is stored ENCRYPTED (AES-256-GCM, `LINKEDIN_TOKEN_KEY`)
 * in `LinkedInToken`, never in the backup, and used only while the env access token is unchanged: a token pasted into Railway
 * wins at once. Every secret is kept out of logs, `lastError`, emails and API answers.
 */

const RENEW_WITHIN_DAYS = 14;
const YEARLY_WARN_DAYS = 30;
const YEARLY_MAIL_EVERY_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
export const ACCESS_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
export const INTROSPECT_URL = 'https://www.linkedin.com/oauth/v2/introspectToken';
const HTTP_TIMEOUT_MS = 15_000;
export const ERROR_MAX = 240;

export type FetchLike = typeof fetch;

/* ------------------------------------------------------------------ */
/* Encryption: v1:<iv>:<tag>:<ciphertext>, AES-256-GCM                 */
/* ------------------------------------------------------------------ */

/** The key as 32 bytes, or null when it is missing or the wrong length. */
export function keyBytes(keyB64: string): Buffer | null {
  if (!keyB64) return null;
  try {
    const b = Buffer.from(keyB64, 'base64');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

/** The plaintext, or null when the value is malformed, was made with another key, or was tampered with. */
export function decryptSecret(blob: string, key: Buffer): string | null {
  try {
    const [v, iv, tag, ct] = blob.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/* ------------------------------------------------------------------ */
/* Which token is in use                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { env: string; active: string }>();

/** The token last resolved for the page, if the env token it was resolved against is still the current one. */
export function cachedAccessToken(page: string): string | null {
  const c = cache.get(page);
  const cur = env.linkedin.pages[page]?.accessToken;
  return c && cur && c.env === cur ? c.active : null;
}
export function resetTokenCache(): void {
  cache.clear();
}

/**
 * The access token the page should use now. A stored (renewed) token whose `envFingerprint` equals the SHA-256 of the current
 * env value; otherwise the env token (and a stored row that no longer matches is dropped: the owner pasted a new token).
 * With renewal off, or the key missing / the wrong length, it is simply the env token.
 */
export async function activeAccessToken(page: string): Promise<string | null> {
  const envTok = env.linkedin.pages[page]?.accessToken;
  if (!envTok) return null;
  const tr = env.linkedin.tokenRefresh;
  const key = tr.enabled ? keyBytes(tr.key) : null;
  if (!key) return envTok;
  const row = await prisma.linkedInToken.findUnique({ where: { page } });
  if (!row) return envTok;
  if (row.envFingerprint !== sha256(envTok)) {
    await prisma.linkedInToken.deleteMany({ where: { id: row.id } });
    return envTok;
  }
  return decryptSecret(row.accessTokenEnc, key) ?? envTok;
}

/** Re-resolves every configured page into the cache (the worker calls it at the start of a tick and before a Retry). */
export async function refreshActiveTokens(): Promise<void> {
  for (const page of Object.keys(env.linkedin.pages)) {
    const envTok = env.linkedin.pages[page]?.accessToken;
    const active = envTok ? await activeAccessToken(page).catch(() => envTok) : null;
    if (envTok && active) cache.set(page, { env: envTok, active });
    else cache.delete(page);
  }
}

/* ------------------------------------------------------------------ */
/* Config check                                                        */
/* ------------------------------------------------------------------ */

/** Why renewal can't run, or null. (Posting itself keeps working with the env token either way.) */
export function renewalConfigProblem(pages: string[] = configuredPages()): string | null {
  const tr = env.linkedin.tokenRefresh;
  if (!tr.clientId) return 'LINKEDIN_CLIENT_ID is not set';
  if (!tr.clientSecret) return 'LINKEDIN_CLIENT_SECRET is not set';
  if (!tr.key) return 'LINKEDIN_TOKEN_KEY is not set';
  if (!keyBytes(tr.key)) return 'LINKEDIN_TOKEN_KEY must be 32 bytes, base64 (openssl rand -base64 32)';
  if (pages.length === 0) return 'no LinkedIn page is configured';
  for (const p of pages) if (!env.linkedin.pages[p]?.refreshToken) return `LINKEDIN_${p.toUpperCase()}_REFRESH_TOKEN is not set`;
  return null;
}
const configuredPages = (): string[] => Object.keys(env.linkedin.pages).filter((p) => env.linkedin.pages[p]?.orgUrn && env.linkedin.pages[p]?.accessToken);

/* ------------------------------------------------------------------ */
/* Small state in DigestSetting: blocked / alert days                  */
/* ------------------------------------------------------------------ */

type PageState = { blockedFp?: string; failAlertDay?: string; yearlyMailAt?: string };
const stateKey = (page: string): string => `linkedin:token:state:${page}`;
async function readState(page: string): Promise<PageState> {
  const row = await prisma.digestSetting.findUnique({ where: { key: stateKey(page) } });
  try {
    return row ? (JSON.parse(row.value) as PageState) : {};
  } catch {
    return {};
  }
}
async function writeState(page: string, s: PageState): Promise<void> {
  const value = JSON.stringify(s);
  await prisma.digestSetting.upsert({ where: { key: stateKey(page) }, create: { key: stateKey(page), value }, update: { value } });
}

/* ------------------------------------------------------------------ */
/* LinkedIn calls                                                      */
/* ------------------------------------------------------------------ */

/** Every secret the run knows, so none can reach a log, a column or an email. */
function secretsOf(extra: (string | undefined | null)[]): string[] {
  const tr = env.linkedin.tokenRefresh;
  return [tr.clientSecret, tr.key, ...extra].filter((x): x is string => !!x && x.length >= 6);
}
export function scrub(text: string, secrets: string[]): string {
  let t = text.replace(/\s+/g, ' ').trim();
  for (const s of secrets) t = t.split(s).join('[secret]');
  t = t.replace(/Bearer\s+\S+/gi, 'Bearer [secret]');
  return t.length > ERROR_MAX ? `${t.slice(0, ERROR_MAX - 1)}…` : t;
}

async function postForm(url: string, form: Record<string, string>, f: FetchLike): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await f(url, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString() });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Why the token inspector gave (or didn't give) an expiry. Never a response body, never a secret. */
export type IntrospectReason = 'ok' | 'no_expires_at' | 'network' | `http_${number}`;
export type Introspection = { active: boolean | null; expiresAt: Date | null; reason: IntrospectReason };

/**
 * When the token expires, per LinkedIn's token inspector (POST /oauth/v2/introspectToken, form client_id / client_secret / token;
 * `expires_at` is documented as OPTIONAL, and a client mismatch answers 200 with active:false). Always returns a verdict with a
 * reason: `ok` (an expiry came back), `no_expires_at` (200 without one), `http_<status>` or `network`.
 */
export async function introspect(token: string, f: FetchLike = fetch): Promise<Introspection> {
  const tr = env.linkedin.tokenRefresh;
  try {
    const r = await postForm(INTROSPECT_URL, { client_id: tr.clientId, client_secret: tr.clientSecret, token }, f);
    if (r.status !== 200 || !r.json) return { active: null, expiresAt: null, reason: `http_${r.status}` };
    const exp = typeof r.json.expires_at === 'number' ? new Date(r.json.expires_at * 1000) : null;
    const active = r.json.active === false || r.json.status === 'expired' || r.json.status === 'revoked' ? false : true;
    return { active, expiresAt: exp, reason: exp ? 'ok' : 'no_expires_at' };
  } catch {
    return { active: null, expiresAt: null, reason: 'network' };
  }
}

type RenewResult =
  | { ok: true; accessToken: string; expiresInS: number; refreshToken: string | null; refreshExpiresInS: number | null }
  | { ok: false; permanent: boolean; status: number | null; error: string };

async function callRefresh(refreshToken: string, f: FetchLike): Promise<RenewResult> {
  const tr = env.linkedin.tokenRefresh;
  try {
    const r = await postForm(ACCESS_TOKEN_URL, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: tr.clientId, client_secret: tr.clientSecret }, f);
    const j = r.json ?? {};
    if (r.status === 200 && typeof j.access_token === 'string' && j.access_token) {
      return {
        ok: true,
        accessToken: j.access_token,
        expiresInS: typeof j.expires_in === 'number' ? j.expires_in : 0,
        refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : null,
        refreshExpiresInS: typeof j.refresh_token_expires_in === 'number' ? j.refresh_token_expires_in : null,
      };
    }
    const desc = typeof j.error_description === 'string' ? j.error_description : typeof j.error === 'string' ? j.error : '';
    const permanent = r.status === 400 || r.status === 401;
    return { ok: false, permanent, status: r.status, error: `HTTP ${r.status}${desc ? `: ${desc.slice(0, 120)}` : ''}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, permanent: false, status: null, error: aborted ? 'timeout' : 'network error' };
  }
}

/* ------------------------------------------------------------------ */
/* Emails                                                              */
/* ------------------------------------------------------------------ */

export type TokenDeps = {
  now?: () => Date;
  fetch?: FetchLike;
  emailSender?: EmailSender;
  isEmailConfigured?: () => boolean;
  recipients?: () => Promise<string[]>;
  pages?: string[];
};

async function defaultRecipients(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true, role: 'ADMIN' }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.trim().toLowerCase()))];
}

const STEPS =
  `How to renew by hand (about 5 minutes):\n` +
  `1. LinkedIn Developer Portal → your app → Tools → OAuth 2.0 tools: create a token with the scopes you used before ` +
  `(w_organization_social), signing in as an admin of the page.\n` +
  `2. Copy the ACCESS token, then run:  railway variable set LINKEDIN_TAXSCAN_ACCESS_TOKEN="$(pbpaste)" -s taxscan-push\n` +
  `3. Copy the REFRESH token, then run:  railway variable set LINKEDIN_TAXSCAN_REFRESH_TOKEN="$(pbpaste)" -s taxscan-push\n` +
  `(The tokens go through the clipboard; never type or paste them anywhere else.)`;

async function mail(kind: 'failed' | 'yearly', subject: string, body: string, d: TokenDeps): Promise<boolean> {
  try {
    if (!(d.isEmailConfigured ?? isEmailConfigured)()) return false;
    const to = await (d.recipients ?? defaultRecipients)();
    const send = d.emailSender ?? defaultEmailSender;
    const text = `${body}\n\n${STEPS}`;
    const html = `<p>${text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
    for (const addr of to) await send({ to: addr, subject, html, text });
    return to.length > 0;
  } catch (err) {
    console.error(`[linkedin-token] ${kind} email failed`, safeErrorLog(err));
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* The daily check                                                     */
/* ------------------------------------------------------------------ */

const daysLeft = (at: Date | null | undefined, now: Date): number | null => (at ? Math.floor((at.getTime() - now.getTime()) / DAY_MS) : null);
const fmtDays = (n: number | null): string => (n === null ? 'unknown' : String(n));
const fmtDate = (d: Date): string => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export type PageCheck = { page: string; accessLeftDays: number | null; refreshLeftDays: number | null; action: 'none' | 'renewed' | 'failed' };

async function ensureRow(page: string, key: Buffer) {
  const existing = await prisma.linkedInToken.findUnique({ where: { page } });
  const envTok = env.linkedin.pages[page].accessToken;
  if (existing && existing.envFingerprint === sha256(envTok)) return existing;
  if (existing) await prisma.linkedInToken.deleteMany({ where: { id: existing.id } });
  return prisma.linkedInToken.create({
    data: { page, accessTokenEnc: encryptSecret(envTok, key), envFingerprint: sha256(envTok), refreshExpiresAt: env.linkedin.pages[page].refreshExpiresAt ?? null },
  });
}

async function checkPage(page: string, key: Buffer, d: TokenDeps, now: Date): Promise<PageCheck> {
  const f = d.fetch ?? fetch;
  const cfg = env.linkedin.pages[page];
  let row = await ensureRow(page, key);
  const active = (await activeAccessToken(page)) ?? cfg.accessToken;
  const storedRefresh = row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc, key) : null;
  const refreshToken = storedRefresh ?? cfg.refreshToken ?? '';
  const secrets = secretsOf([active, refreshToken, cfg.accessToken, cfg.refreshToken]);

  // 1. when does the active token expire?
  const intro = await introspect(active, f);
  // LinkedIn's date wins; else the stored one (a renewal's, or an earlier inspector date); else ESTIMATE it from when this env
  // token was first seen (the row's createdAt) plus the access-token lifetime, so the expiry is never unknown.
  type Source = 'linkedin' | 'stored' | 'estimate';
  let accessExpiresAt: Date;
  let source: Source;
  if (intro.expiresAt) {
    accessExpiresAt = intro.expiresAt;
    source = 'linkedin';
  } else if (row.accessExpiresAt && row.accessExpiresSource !== 'estimate') {
    accessExpiresAt = row.accessExpiresAt;
    source = 'stored';
  } else {
    accessExpiresAt = new Date(row.createdAt.getTime() + env.linkedin.tokenRefresh.accessTtlDays * DAY_MS);
    source = 'estimate';
  }
  const accessLeft = intro.active === false ? -1 : daysLeft(accessExpiresAt, now);
  const refreshExpiresAt = row.refreshExpiresAt ?? cfg.refreshExpiresAt ?? null;
  const refreshLeft = daysLeft(refreshExpiresAt, now);
  row = await prisma.linkedInToken.update({
    where: { id: row.id },
    data: { lastCheckAt: now, accessExpiresAt, accessExpiresSource: source === 'stored' ? row.accessExpiresSource ?? 'linkedin' : source },
  });

  let action: PageCheck['action'] = 'none';
  const state = await readState(page);
  const blockedNow = state.blockedFp === sha256(`${cfg.accessToken}|${cfg.refreshToken ?? ''}`);

  // 2. renew when 14 days or less are left
  if (accessLeft !== null && accessLeft <= RENEW_WITHIN_DAYS) {
    let failure: { permanent: boolean; error: string } | null = null;
    if (blockedNow) {
      failure = { permanent: true, error: row.lastError ?? 'the refresh token was rejected; sign in again' };
    } else if (!refreshToken) {
      failure = { permanent: true, error: 'no refresh token is set' };
    } else {
      const r = await callRefresh(refreshToken, f);
      if (r.ok) {
        row = await prisma.linkedInToken.update({
          where: { id: row.id },
          data: {
            accessTokenEnc: encryptSecret(r.accessToken, key),
            accessExpiresAt: new Date(now.getTime() + r.expiresInS * 1000),
            accessExpiresSource: 'renewal',
            ...(r.refreshExpiresInS !== null ? { refreshExpiresAt: new Date(now.getTime() + r.refreshExpiresInS * 1000) } : {}),
            ...(r.refreshToken && r.refreshToken !== refreshToken ? { refreshTokenEnc: encryptSecret(r.refreshToken, key) } : {}),
            renewedAt: now,
            lastError: null,
          },
        });
        cache.set(page, { env: cfg.accessToken, active: r.accessToken });
        // a successful renewal ends a login stop and its banner (the worker's stop keys on the active token, which just changed)
        await prisma.digestSetting.deleteMany({ where: { key: `linkedin:auth:${page}` } });
        if (state.blockedFp) await writeState(page, { ...state, blockedFp: undefined });
        action = 'renewed';
      } else {
        failure = { permanent: r.permanent, error: scrub(r.error, secrets) };
      }
    }
    if (failure) {
      action = 'failed';
      const lastError = scrub(failure.permanent ? `refresh token rejected (${failure.error}) — sign in again` : `renewal failed (${failure.error}) — will retry at the next daily check`, secrets);
      await prisma.linkedInToken.update({ where: { id: row.id }, data: { lastError } });
      const next: PageState = { ...state };
      if (failure.permanent) next.blockedFp = sha256(`${cfg.accessToken}|${cfg.refreshToken ?? ''}`);
      const today = istDay(now);
      if (state.failAlertDay !== today) {
        const about = source === 'estimate' ? 'about ' : '';
        const left = accessLeft < 0 ? 'The current access token has EXPIRED' : `The current access token has ${about}${accessLeft} day${accessLeft === 1 ? '' : 's'} left`;
        const sent = await mail('failed', `LinkedIn token could not be renewed (${accessLeft < 0 ? 'expired' : `${source === 'estimate' ? 'about ' : ''}${accessLeft} days left`})`, `Taxscan Push could not renew the ${page} LinkedIn access token automatically. ${left} (${source === 'estimate' ? 'until about' : 'until'} ${fmtDate(accessExpiresAt)}${source === 'estimate' ? '; an estimate, LinkedIn did not give the date' : ''}). ${lastError}\n\nPosts keep going out until it expires.`, d);
        if (sent) next.failAlertDay = today;
      }
      await writeState(page, next);
    }
  }

  // 3. the yearly sign-in is near: one email a week
  if (refreshLeft !== null && refreshLeft <= YEARLY_WARN_DAYS) {
    const s = await readState(page);
    if (!s.yearlyMailAt || now.getTime() - Date.parse(s.yearlyMailAt) >= YEARLY_MAIL_EVERY_MS) {
      const by = refreshExpiresAt ? fmtDate(refreshExpiresAt) : 'soon';
      const sent = await mail('yearly', `Yearly LinkedIn sign-in due by ${by}`, `The ${page} LinkedIn refresh token expires ${refreshExpiresAt ? `on ${fmtDate(refreshExpiresAt)}` : 'soon'} (${refreshLeft <= 0 ? 'now' : `${refreshLeft} days`}). After that the access token can no longer renew itself, so please sign in again before then.`, d);
      if (sent) await writeState(page, { ...s, yearlyMailAt: now.toISOString() });
    }
  }

  const after = await prisma.linkedInToken.findUnique({ where: { page } });
  const accessLeftNow = daysLeft(after?.accessExpiresAt ?? accessExpiresAt, now);
  const refreshLeftNow = daysLeft(after?.refreshExpiresAt ?? refreshExpiresAt, now);
  // eslint-disable-next-line no-console
  console.log(`[linkedin-token] page=${page} access_left_days=${fmtDays(accessLeftNow)} (source=${action === 'renewed' ? 'renewal' : source}) refresh_left_days=${fmtDays(refreshLeftNow)} introspect=${intro.reason} action=${action}`);
  return { page, accessLeftDays: accessLeftNow, refreshLeftDays: refreshLeftNow, action };
}

export type TokenRunResult = { refused: string | null; pages: PageCheck[] };

/** One daily run over every configured page. Never throws. */
export async function runTokenCheck(d: TokenDeps = {}): Promise<TokenRunResult> {
  const now = (d.now ?? (() => new Date()))();
  if (!env.linkedin.tokenRefresh.enabled) return { refused: 'LINKEDIN_TOKEN_REFRESH_ENABLED is off', pages: [] };
  const pages = d.pages ?? configuredPages();
  const problem = renewalConfigProblem(pages);
  if (problem) {
    console.error(`[linkedin-token] refusing to run: ${problem}`);
    return { refused: problem, pages: [] };
  }
  const key = keyBytes(env.linkedin.tokenRefresh.key)!;
  const out: PageCheck[] = [];
  for (const page of pages) {
    try {
      out.push(await checkPage(page, key, d, now));
    } catch (err) {
      console.error(`[linkedin-token] page=${page} check failed`, safeErrorLog(err));
    }
  }
  return { refused: null, pages: out };
}

/* ------------------------------------------------------------------ */
/* For the screen                                                      */
/* ------------------------------------------------------------------ */

export type TokenStatus = {
  validUntil: string | null;
  /** Where validUntil came from: 'linkedin' | 'renewal' | 'estimate' (the screen says "about" only for an estimate). */
  validUntilSource: 'linkedin' | 'renewal' | 'estimate' | null;
  refreshUntil: string | null;
  autoRenew: boolean;
  renewalFailed: boolean;
  renewedAt: string | null;
  status: 'ok' | 'amber' | 'red';
};

/** Dates and a status only; never a token. null when renewal is switched off (the screen then shows nothing new). */
export async function tokenStatus(page: string, nowDate: Date = new Date()): Promise<TokenStatus | null> {
  if (!env.linkedin.tokenRefresh.enabled) return null;
  const row = await prisma.linkedInToken.findUnique({ where: { page } });
  const cfg = env.linkedin.pages[page];
  const validUntil = row?.accessExpiresAt ?? null;
  const refreshUntil = row?.refreshExpiresAt ?? cfg?.refreshExpiresAt ?? null;
  const renewalFailed = !!row?.lastError;
  const a = daysLeft(validUntil, nowDate);
  const r = daysLeft(refreshUntil, nowDate);
  const status: TokenStatus['status'] = renewalFailed ? 'red' : (a !== null && a < RENEW_WITHIN_DAYS) || (r !== null && r < YEARLY_WARN_DAYS) ? 'amber' : 'ok';
  return {
    validUntil: validUntil ? validUntil.toISOString() : null,
    validUntilSource: validUntil ? ((row?.accessExpiresSource as TokenStatus['validUntilSource']) ?? 'linkedin') : null,
    refreshUntil: refreshUntil ? refreshUntil.toISOString() : null,
    autoRenew: renewalConfigProblem() === null,
    renewalFailed,
    renewedAt: row?.renewedAt ? row.renewedAt.toISOString() : null,
    status,
  };
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

let running = false;
async function guarded(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runTokenCheck();
  } catch (err) {
    console.error('[linkedin-token] run failed', safeErrorLog(err, { stack: true }));
  } finally {
    running = false;
  }
}

/** 10:15 IST daily and ~2 minutes after boot; only with LINKEDIN_TOKEN_REFRESH_ENABLED and a complete config. */
export function startLinkedInTokenRenewal(): void {
  if (!env.linkedin.tokenRefresh.enabled) {
    // eslint-disable-next-line no-console
    console.log('[linkedin-token] disabled (set LINKEDIN_TOKEN_REFRESH_ENABLED=true to start)');
    return;
  }
  const problem = renewalConfigProblem();
  if (problem) {
    console.error(`[linkedin-token] refusing to start: ${problem}`);
    return;
  }
  cron.schedule('15 10 * * *', () => void guarded(), { timezone: env.rss.tz });
  setTimeout(() => void guarded(), 2 * 60_000).unref();
  // eslint-disable-next-line no-console
  console.log('[linkedin-token] renewal started (daily 10:15 IST)');
}
