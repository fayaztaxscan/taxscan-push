import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { articleContentOf, shortLine } from '../whatsapp/postText';
import { fetchCmsArticle, slugOf, type CmsArticle } from '../linkedin/post';
import { pageLinkOf, pageUtmContent, storeLinkOf, storeTitle, storeUtmContent } from '../social/allPushes';
import { withTelegramUtm } from './pages';

/**
 * One Telegram post, built (brief 2026-11-09-telegram-channel). HTML parse mode, EVERY field escaped:
 *
 *     <b>headline</b>
 *
 *     the short line (<= 160 characters)
 *
 *     <a href="the tagged link">Read more</a>
 *
 * The short line is the CMS article API's excerpt for an article, the push body otherwise. With a picture the text is a `sendPhoto`
 * CAPTION (Telegram's limit: 1024 characters after the markup is parsed); without one it is a `sendMessage` text (4096) with the link
 * preview on. Pure apart from the one CMS fetch, which is fail-open (CMS down = no excerpt and no cover, never a delay or a refusal).
 */

export const CAPTION_MAX = 1024;
export const TEXT_MAX = 4096;
export const READ_MORE = 'Read more';
/** A short line is kept only when at least this many characters of it fit; below that it is dropped rather than cut to a stub. */
const MIN_LINE_ROOM = 24;

/** `&` `<` `>` `"` as the four named entities the Bot API accepts. Escaping happens ONCE, on the final visible text. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Whitespace-collapsed and cut at a word boundary to at most `max` characters (the "…" included); never splits a surrogate pair. */
export function cutAtWord(text: string, max: number): string {
  const t = flat(text);
  if (t.length <= max) return t;
  if (max <= 1) return max === 1 ? '…' : '';
  const room = max - 1; // one character for the ellipsis
  let head = t.slice(0, room + 1);
  const at = head.lastIndexOf(' ');
  head = at > room / 2 ? head.slice(0, at) : t.slice(0, room);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // half of a surrogate pair
  return `${head.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/**
 * The post's HTML for a character limit. The limit counts VISIBLE characters (what is left after Telegram parses the markup), so the
 * headline and line are cut as plain text FIRST and escaped after: an entity or a tag can never be cut in half. The link costs only
 * "Read more".
 */
export function buildHtml(p: { headline: string; line: string; link: string }, limit: number): string {
  const tail = READ_MORE.length + 2; // "\n\n" + the link text
  const room = limit - tail;
  const head = cutAtWord(p.headline, room);
  const lineRoom = room - head.length - 2;
  const line = p.line && lineRoom >= MIN_LINE_ROOM ? cutAtWord(p.line, lineRoom) : '';
  return [`<b>${escapeHtml(head)}</b>`, ...(line ? [escapeHtml(line)] : []), `<a href="${escapeHtml(p.link)}">${READ_MORE}</a>`].join('\n\n');
}
export const captionOf = (p: { headline: string; line: string; link: string }): string => buildHtml(p, CAPTION_MAX);
export const textOf = (p: { headline: string; line: string; link: string }): string => buildHtml(p, TEXT_MAX);

export type TgKind = 'article' | 'course' | 'product' | 'page';
export type TgPostPayload = {
  headline: string;
  line: string;
  /** The tagged link (`taxscan-telegram / social / telegram-channel / <id|slug>`). */
  link: string;
  /** The article's cover picture from the CMS API (articles only), not yet checked against the picture allowlist. */
  coverImageUrl: string | null;
  kind: TgKind;
};

/**
 * Null when the URL is not an article, course, product or other allowed page, or the final link is off `ALLOWED_PUSH_HOSTS`. An article
 * costs one CMS fetch (excerpt + cover); a course, product or other page costs none.
 */
export async function buildTelegramPost(
  c: { title: string; url: string; body?: string | null },
  fetchCms: (slug: string) => Promise<CmsArticle | null> = (s) => fetchCmsArticle(s),
): Promise<TgPostPayload | null> {
  const url = String(c.url ?? '').trim();
  if (!isAllowedPushUrl(url)) return null;
  const store = storeLinkOf(url);
  const other = store ? null : pageLinkOf(url);
  let kind: TgKind;
  let content: string | null;
  if (store) {
    kind = store.kind;
    content = storeUtmContent(store);
  } else if (other) {
    kind = 'page';
    content = pageUtmContent(other);
  } else {
    kind = 'article';
    content = articleContentOf({ url });
  }
  if (!content) return null;
  let link: string;
  try {
    link = withTelegramUtm(url, content);
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(link)) return null;
  let cms: CmsArticle | null = null;
  if (kind === 'article') {
    const slug = slugOf(url);
    cms = slug ? await fetchCms(slug).catch(() => null) : null;
  }
  const headline = storeTitle(c.title);
  const candidate = shortLine(cms?.excerpt ?? '') || shortLine(c.body ?? '');
  const line = candidate.toLowerCase() === headline.toLowerCase() ? '' : candidate;
  return { headline, line, link, coverImageUrl: cms?.coverImageUrl ?? null, kind };
}
