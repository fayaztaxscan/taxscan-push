import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { articleKey } from '../reports';
import { withWhatsAppUtm } from './utm';

/** The short line is cut at a word boundary to at most this many characters (the ellipsis included). */
export const SHORT_LINE_MAX = 160;

/** taxscan.in / www.taxscan.in only: academy and shop links are never WhatsApp posts. */
const TAXSCAN_ARTICLE_HOST = /^https?:\/\/(www\.)?taxscan\.in\//i;

/** The trailing taxscan id of an article URL ("…-1451580" → "1451580"), or null when it isn't a taxscan.in article. */
export function articleIdOf(c: { id: string; url: string }): string | null {
  if (!TAXSCAN_ARTICLE_HOST.test(c.url.trim())) return null;
  const k = articleKey(c);
  return k.startsWith('article:') ? k.slice('article:'.length) : null;
}

/** WhatsApp's own formatting characters (* _ ~ `) removed from the headline so it can't break the bold. */
export function cleanHeadline(title: string): string {
  return title.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
}

/** Whitespace-collapsed, cut at a word boundary to ≤ 160 characters with "…". */
export function shortLine(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= SHORT_LINE_MAX) return flat;
  const room = SHORT_LINE_MAX - 1; // one character for the ellipsis
  const cut = flat.slice(0, room + 1);
  const at = cut.lastIndexOf(' ');
  const head = (at > 0 ? cut.slice(0, at) : flat.slice(0, room)).replace(/[\s.,;:!?-]+$/, '');
  return `${head}…`;
}

/**
 * The WhatsApp post, built on the server (the client never assembles links):
 *
 *   *<headline>*
 *
 *   <short line>
 *
 *   <link>
 *
 * The short line (and its blank line) is left out when the body is empty or equals the headline. The link is the
 * campaign's clean `url` with the WhatsApp UTMs, never the push's own tagged URL. Returns null when the URL isn't a
 * taxscan article or fails the `ALLOWED_PUSH_HOSTS` check on the final link.
 */
export function buildPostText(c: { id: string; title: string; body: string; url: string }): string | null {
  const id = articleIdOf(c);
  if (!id) return null;
  let link: string;
  try {
    link = withWhatsAppUtm(c.url, id);
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(link)) return null;
  const headline = cleanHeadline(c.title);
  const line = shortLine(c.body ?? '');
  const sameAsHeadline = line.replace(/[*_~`]/g, '').toLowerCase() === headline.toLowerCase();
  return [`*${headline}*`, ...(line && !sameAsHeadline ? [line] : []), link].join('\n\n');
}
