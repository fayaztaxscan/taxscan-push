/**
 * Plain-words readings of the Telegram channel's short error codes, shared by the Telegram screen and the Campaigns Channels tooltip.
 *
 * The server only ever sends a SHORT FIXED CODE (never Telegram's own text, a URL or the bot token). The screen shows the words AND the
 * code, e.g. "Telegram refused the post (telegram_400)", so a code can still be searched for in the logs and the docs.
 *
 * The status-based codes are built as `telegram_<HTTP status>` with an optional `_<reason>` suffix, so the reading is pattern based: a
 * 5xx arrives as `telegram_502`, `telegram_503`... (not a literal `telegram_5xx`), and an unfamiliar code is shown as it is.
 */

/** The reason suffixes the server adds after the HTTP status. */
const REASON_WORDS: Record<string, string> = {
  chat_not_found: 'Telegram could not find the channel',
  not_enough_rights: 'The bot is not allowed to post in the channel',
  bot_removed: 'The bot was removed from the channel',
  cannot_parse: 'Telegram could not read the post text',
  too_long: 'The post was too long for Telegram',
  photo_refused: 'Telegram refused the picture',
};

/** Codes that are not `telegram_<status>[_<reason>]`. */
const FIXED_WORDS: Record<string, string> = {
  network_error: 'Could not reach Telegram',
  timeout: 'Telegram did not answer in time',
  unknown_outcome: 'Outcome unknown — check the channel before retrying',
  link_not_allowed: 'The push link is not one that is posted',
  campaign_not_found: 'The push could not be found',
  not_configured: 'The channel is not set up',
  no_message_id: 'Posted, but Telegram sent no message link',
  image_dropped: 'Posted without the picture',
  telegram_no_title: 'Telegram answered without a channel name',
};

const BY_STATUS = /^telegram_(\d{1,3})(?:_([a-z_]+))?$/;

function statusWords(status: number): string {
  if (status === 429) return 'Telegram asked us to slow down';
  if (status >= 500) return 'Telegram had a problem on its side';
  if (status === 401) return 'Telegram rejected the bot token';
  if (status === 403) return 'Telegram refused the bot';
  if (status >= 400) return 'Telegram refused the post';
  return 'Telegram answered with an error';
}

/** The words for a code, or null when the code is not one we know (the caller then shows the code alone). */
export function telegramErrorWords(code: string): string | null {
  const fixed = FIXED_WORDS[code];
  if (fixed) return fixed;
  const m = BY_STATUS.exec(code);
  if (!m) return null;
  const reason = m[2] ? REASON_WORDS[m[2]] : undefined;
  return reason ?? statusWords(Number(m[1]));
}

/** "Telegram refused the post (telegram_400)": the words, then the code (and the HTTP status when given and not already in the code). */
export function telegramErrorText(code: string, httpStatus?: number | null): string {
  const words = telegramErrorWords(code);
  if (!words) return code;
  const extra = httpStatus && !code.includes(String(httpStatus)) ? `, HTTP ${httpStatus}` : '';
  return `${words} (${code}${extra})`;
}

/** True for a short machine code (as opposed to a sentence such as a network error message). */
export const looksLikeCode = (s: string): boolean => /^[a-z0-9_]{3,64}$/.test(s);
