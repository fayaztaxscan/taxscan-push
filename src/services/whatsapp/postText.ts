import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { withWhatsAppUtm } from './utm';

/** The short line is cut at a word boundary to at most this many characters (the ellipsis included). */
export const SHORT_LINE_MAX = 160;

/** `utm_content` is the numeric id, else the slug cut to this many characters. */
export const UTM_CONTENT_MAX = 100;
const TRAILING_ID = /-(\d{4,})$/;

/**
 * Is this a taxscan.in article, and what is its `utm_content`? null when it isn't one.
 *
 * An article = host `taxscan.in` / `www.taxscan.in` (academy and shop are never WhatsApp posts) and a path with at
 * least two segments (`/<section>/<slug>`, the current shape: no trailing id) or a trailing numeric id (the old
 * `…-1451580` shape). The home page and section index pages (`/income-tax`) are not articles. The content is the
 * numeric id when there is one, otherwise the last path segment (the slug), cut to 100 characters.
 * Identity (which pushes are the same article) stays `articleKey()`.
 */
export function articleContentOf(c: { url: string }): string | null {
  let u: URL;
  try {
    u = new URL(c.url.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !/^(www\.)?taxscan\.in$/i.test(u.hostname)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1];
  const id = TRAILING_ID.exec(last)?.[1];
  if (id) return id;
  if (segs.length < 2) return null;
  return last.slice(0, UTM_CONTENT_MAX);
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
  const content = articleContentOf(c);
  if (!content) return null;
  let link: string;
  try {
    link = withWhatsAppUtm(c.url, content);
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(link)) return null;
  const headline = cleanHeadline(c.title);
  const line = shortLine(c.body ?? '');
  const sameAsHeadline = line.replace(/[*_~`]/g, '').toLowerCase() === headline.toLowerCase();
  return [`*${headline}*`, ...(line && !sameAsHeadline ? [line] : []), link].join('\n\n');
}
