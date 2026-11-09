import { redactText } from '../../lib/redact';
import type { FetchLike } from '../linkedin/post';

/**
 * One call to the Telegram Bot API (`POST https://api.telegram.org/bot<token>/<method>`, JSON body). Plain `fetch`, no SDK.
 *
 * THE TOKEN IS IN THE URL PATH (that is how the Bot API works), so nothing about a request or a thrown error is ever kept: the result is
 * a verdict whose `error` is a SHORT FIXED CODE chosen from a small list (`telegram_403`, `telegram_400_chat_not_found`, `timeout`...),
 * never the provider's free text, a URL or a body. A thrown fetch error (whose message can carry the URL) becomes `network_error` and its
 * message is dropped. `redactBotToken` is the belt to those braces for any text that must be shown.
 *
 *   posted    - { ok: true, result: { message_id } }
 *   rate      - HTTP 429: `retryAfterSec` is Telegram's `parameters.retry_after`
 *   transient - 5xx, network, timeout: retry soon
 *   stop      - 401 (token revoked), 403 (bot removed / blocked / not an admin), 400 "chat not found" or "not enough rights": the CHANNEL is
 *               stopped until an ADMIN resumes (retrying cannot help and would only repeat the failure)
 *   failed    - any other 4xx. On a photo this is the "Telegram refused the picture" answer the worker repeats once as a text message.
 */
export type TelegramFailKind = 'rate' | 'transient' | 'stop' | 'failed';
export type TelegramFailure = { kind: TelegramFailKind; status: number | null; code: number | null; retryAfterSec: number | null; error: string };
export type TelegramResult = { kind: 'posted'; messageId: number | null } | TelegramFailure;

/** Telegram's reply envelope, read defensively. */
type Reply = { ok?: unknown; result?: { message_id?: unknown; title?: unknown }; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };

export type TelegramMethod = 'sendPhoto' | 'sendMessage' | 'getChat';
export type TelegramRequest = { method: TelegramMethod; token: string; body: Record<string, unknown> };

const TIMEOUT_MS = 15_000;
const API = 'https://api.telegram.org';
/** Telegram's own cap on how long `retry_after` can ask us to wait that we are willing to honour in one go. */
export const RETRY_AFTER_CAP_SEC = 6 * 60 * 60;

export const methodUrl = (token: string, method: TelegramMethod): string => `${API}/bot${token}/${method}`;

/** Any bot token in `text` (the exact one given, or anything shaped like one, or a `/bot…/` path piece) replaced; never throws. */
export function redactBotToken(text: string, token = ''): string {
  let t = text;
  if (token) t = t.split(token).join('[token]');
  return redactText(t.replace(/\/bot[^/\s"']+\//gi, '/bot[token]/').replace(/\b\d{5,20}:[A-Za-z0-9_-]{20,}\b/g, '[token]'));
}

/** What Telegram's free-text `description` is mapped to. A short fixed word, never the text itself. Order matters (first match wins). */
const DESCRIPTION_CODES: readonly [RegExp, string][] = [
  [/chat not found/i, 'chat_not_found'],
  [/not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED/i, 'not_enough_rights'],
  [/bot was kicked|bot is not a member|bot was blocked|bot can't|deactivated/i, 'bot_removed'],
  [/can't parse entities/i, 'cannot_parse'],
  [/message is too long|caption is too long|MESSAGE_TOO_LONG/i, 'too_long'],
  [/wrong file identifier|failed to get HTTP URL|wrong type of the web page content|IMAGE_PROCESS_FAILED|PHOTO_INVALID_DIMENSIONS|PHOTO_[A-Z_]+|wrong remote file/i, 'photo_refused'],
];
const STOP_CODES: ReadonlySet<string> = new Set(['chat_not_found', 'not_enough_rights', 'bot_removed']);

/** Pure: the verdict for a non-2xx answer. `body` is Telegram's parsed JSON (or null). */
export function classify(status: number, body: Reply | null): TelegramFailure {
  const code = typeof body?.error_code === 'number' && Number.isFinite(body.error_code) ? body.error_code : null;
  const http = status || code || 0;
  const description = typeof body?.description === 'string' ? body.description : '';
  const word = DESCRIPTION_CODES.find(([re]) => re.test(description))?.[1] ?? null;
  const ra = body?.parameters?.retry_after;
  const retryAfterSec = typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? Math.min(Math.ceil(ra), RETRY_AFTER_CAP_SEC) : null;
  const base = { status: status || null, code, retryAfterSec };
  const error = `telegram_${http}${word ? `_${word}` : ''}`;
  if (http === 429) return { kind: 'rate', ...base, error: 'telegram_429' };
  if (http >= 500) return { kind: 'transient', ...base, error };
  if (http === 401 || http === 403 || (word !== null && STOP_CODES.has(word))) return { kind: 'stop', ...base, error };
  return { kind: 'failed', ...base, error };
}

/** One Bot API call. Never throws, never returns a URL, a body or a thrown message. */
export async function callTelegram(r: TelegramRequest, fetchImpl: FetchLike = fetch): Promise<TelegramResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(methodUrl(r.token, r.method), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r.body),
    });
    let json: Reply | null = null;
    try {
      json = (await res.json()) as Reply;
    } catch {
      json = null; // not JSON
    }
    if (res.status >= 200 && res.status < 300 && json?.ok !== false) {
      // A 2xx means "posted", with or without an id: never re-post it.
      const id = json?.result?.message_id;
      return { kind: 'posted', messageId: typeof id === 'number' && Number.isInteger(id) ? id : null };
    }
    return classify(res.status, json);
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { kind: 'transient', status: null, code: null, retryAfterSec: null, error: aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/** The text of a photo post (HTML, caption <= 1024) or a text post (HTML, <= 4096, link preview ON). The caller builds `text` with `post.ts`. */
export function photoBody(chat: string, photoUrl: string, caption: string): Record<string, unknown> {
  return { chat_id: chat, photo: photoUrl, caption, parse_mode: 'HTML' };
}
export function messageBody(chat: string, text: string, link: string): Record<string, unknown> {
  return { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: false, url: link, prefer_large_media: true } };
}

/** The connection check's verdict: the channel's title, or an error class. Posts nothing. */
export type ConnectionResult = { kind: 'ok'; title: string } | { kind: TelegramFailKind; status: number | null; error: string };

/** `getChat` for the channel: proves the token works and the channel exists (the admin right is only proven by a post). */
export async function checkTelegram(r: { token: string; channel: string }, fetchImpl: FetchLike = fetch): Promise<ConnectionResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(methodUrl(r.token, 'getChat'), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: r.channel }),
    });
    let json: Reply | null = null;
    try {
      json = (await res.json()) as Reply;
    } catch {
      json = null;
    }
    if (res.ok && json?.ok === true && typeof json.result?.title === 'string' && json.result.title.trim()) {
      return { kind: 'ok', title: json.result.title.trim().slice(0, 120) };
    }
    if (res.ok) return { kind: 'failed', status: res.status, error: 'telegram_no_title' };
    const c = classify(res.status, json);
    return { kind: c.kind, status: c.status, error: c.error };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { kind: 'transient', status: null, error: aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
