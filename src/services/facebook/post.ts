import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { articleContentOf } from '../whatsapp/postText';
import { fetchCmsArticle, hashtagsFor, slugOf, FIXED_TAG, type CmsArticle } from '../linkedin/post';
import { pageLinkOf, pageUtmContent, storeBodyLines, storeLinkOf, storeTitle, storeUtmContent } from '../social/allPushes';
import { withFacebookUtm } from './pages';

/**
 * Facebook posts reuse LinkedIn's CMS fetch and hashtag rules unchanged (imported, not copied): CMS down → fallback tags,
 * never delayed or blocked.
 */
export const MAX_FB_HASHTAGS = 4;

/** Plain text: headline, a blank line, then at most 4 `#Tag`s with `#taxscan` last. No escaping, no link in the text. */
export function buildMessage(headline: string, tags: readonly string[]): string {
  const head = headline.replace(/\s+/g, ' ').trim();
  const body = tags.filter((t) => t.toLowerCase() !== FIXED_TAG).slice(0, MAX_FB_HASHTAGS - 1);
  const all = [...body, FIXED_TAG].map((t) => `#${t}`);
  return `${head}\n\n${all.join(' ')}`;
}

/**
 * A photo post's caption (brief 2026-11-08-social-picture): today's message with the tagged link on its own line, just before the
 * hashtag line (or at the end when there is none). Plain text, nothing to escape.
 */
export function captionWithLink(message: string, link: string): string {
  const at = message.lastIndexOf('\n\n#');
  return at >= 0 ? `${message.slice(0, at)}\n\n${link.trim()}${message.slice(at)}` : `${message}\n\n${link.trim()}`;
}

export type FbPostPayload = {
  message: string;
  link: string;
  hashtags: string[];
  /** 'fixed' = a course / shop post: only the fixed `#taxscan`, no CMS data. */
  hashtagSource: 'cms' | 'fallback' | 'fixed';
};

/** Null when the URL is not a taxscan.in article or the final link is off `ALLOWED_PUSH_HOSTS`. */
export async function buildFacebookPost(
  c: { id: string; title: string; url: string; authority: string | null; categories: string[]; body?: string | null },
  page: string,
  fetchCms: (slug: string) => Promise<CmsArticle | null> = (s) => fetchCmsArticle(s),
): Promise<FbPostPayload | null> {
  const content = articleContentOf(c);
  if (!content) return null;
  let link: string;
  try {
    link = withFacebookUtm(c.url, page, content);
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(link)) return null;
  const slug = slugOf(c.url);
  const cms = slug ? await fetchCms(slug).catch(() => null) : null;
  const { tags, source } = hashtagsFor({ cms, authority: c.authority, categories: c.categories });
  const hashtags = [...tags.filter((t) => t.toLowerCase() !== FIXED_TAG).slice(0, MAX_FB_HASHTAGS - 1), FIXED_TAG];
  return { message: buildMessage(c.title, tags), link, hashtags, hashtagSource: source };
}

/**
 * A course / shop push on Facebook (brief 2026-11-04-academy-store-posts): the message is the push title, a blank line, the push body
 * (its own lines, single line breaks), a blank line, `#taxscan`; the link is the push's own link with the Facebook UTMs
 * (`taxscan-facebook / social / facebook-<page> / <slug>`), replacing any UTMs the push carried. No picture is uploaded: Facebook
 * builds the card from the page's og tags, as it does for articles. Plain text, nothing to escape. Null when the URL is not a
 * course or shop-product link, or the final link is off `ALLOWED_PUSH_HOSTS`. No network.
 */
export function buildFacebookStorePost(c: { title: string; url: string; body?: string | null }, page: string): FbPostPayload | null {
  const link = storeLinkOf(c.url);
  if (!link || !isAllowedPushUrl(c.url.trim())) return null;
  return storeLikePost(c, page, storeUtmContent(link));
}

/**
 * A push to ANY OTHER page on an allowed host (brief 2026-11-07-social-every-link) on Facebook: built exactly like a course / product
 * post (`buildFacebookStorePost`), with `utm_content` = the path segments joined by `-` (`home` for the root). Pure, no network: Facebook
 * builds the card from the page's og tags itself, so there is no page fetch here to fail. Null when the URL is not an allowed other page,
 * or the final link is off `ALLOWED_PUSH_HOSTS`.
 */
export function buildFacebookPagePost(c: { title: string; url: string; body?: string | null }, page: string): FbPostPayload | null {
  const link = pageLinkOf(c.url);
  if (!link) return null;
  return storeLikePost(c, page, pageUtmContent(link));
}

/** The shared body of a course / product / other-page post (moved out of `buildFacebookStorePost` unchanged). */
function storeLikePost(c: { title: string; url: string; body?: string | null }, page: string, utmContent: string): FbPostPayload | null {
  let tagged: string;
  try {
    tagged = withFacebookUtm(c.url.trim(), page, utmContent);
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(tagged)) return null;
  const body = storeBodyLines(c.body);
  return { message: [storeTitle(c.title), ...(body ? [body] : []), `#${FIXED_TAG}`].join('\n\n'), link: tagged, hashtags: [FIXED_TAG], hashtagSource: 'fixed' };
}
