/**
 * The one text redactor (moved here from `services/digest/sender.ts` on 2026-10-23 so the
 * app's error logging can use it too): masks email-shaped substrings (plain or
 * %40-encoded), key/token/password/Authorization parameters, and any of `secrets`
 * verbatim. Never throws. Does not truncate; callers decide the length.
 */

// Plain and URL-encoded (%40) addresses.
export const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
// key=…, api_key: …, token=…, "Authorization: <key>" / "Authorization: Bearer <key>".
export const SECRET_PARAM =
  /\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|key|authorization)(["']?\s*[=:]\s*["']?)(?:bearer\s+)?[^\s&"',;]+/gi;

// A Telegram Bot API URL carries the bot token IN ITS PATH (`/bot<digits>:<secret>/sendPhoto`), where no `token=` marker would catch it
// (brief 2026-11-09-telegram-channel). Whatever the error text, a path like that never reaches a log.
export const BOT_TOKEN_PATH = /\bbot\d{5,20}:[A-Za-z0-9_-]{16,}/gi;

export function redactText(text: string, secrets: readonly string[] = []): string {
  let msg = text;
  for (const secret of secrets) {
    // Short values would mask ordinary words; a real key is long.
    if (secret && secret.length >= 8) msg = msg.split(secret).join('[secret]');
  }
  return msg.replace(BOT_TOKEN_PATH, 'bot[redacted]').replace(EMAIL_SHAPED, '[email]').replace(SECRET_PARAM, '$1$2[redacted]');
}
