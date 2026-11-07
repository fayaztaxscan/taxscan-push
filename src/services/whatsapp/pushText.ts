import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { pageLinkOf, pageUtmContent, storeLinkOf, storeUtmContent } from '../social/allPushes';
import { articleContentOf, buildPostText, cleanHeadline, shortLine } from './postText';
import { withWhatsAppUtm } from './utm';

/**
 * The WhatsApp post for ONE push under the "every push gets a row" rule (brief 2026-11-05-whatsapp-every-push).
 *
 *   an article                       exactly today's post (`buildPostText`: *headline*, short line, link)
 *   an academy course / shop product *<push title>*, a blank line, the push body cut with `shortLine`, a blank line, the link
 *   any other allowed page           the same shape as a course / product (brief 2026-11-07-social-every-link); `utm_content` is the path
 *                                    segments joined by `-` (`home` for the root)
 *
 * The title goes through `cleanHeadline` so WhatsApp's own formatting characters (* _ ~ `) cannot break the bold; emoji survive. A body
 * that is empty, or only repeats the title, adds no paragraph (as for an article). The link is the push's own URL with the WhatsApp
 * UTMs SET (one set, the push's own `utm_*` gone): `utm_content` is the slug for a course or product (`storeUtmContent`). Null when the
 * URL is none of the three kinds, or the final link is off `ALLOWED_PUSH_HOSTS`. No network.
 */
export function buildPushPostText(c: { id: string; title: string; body: string; url: string }): string | null {
  if (articleContentOf(c) !== null) return buildPostText(c);
  const store = storeLinkOf(c.url);
  const other = store ? null : pageLinkOf(c.url);
  if ((!store && !other) || !isAllowedPushUrl(c.url.trim())) return null;
  let link: string;
  try {
    link = withWhatsAppUtm(c.url.trim(), store ? storeUtmContent(store) : pageUtmContent(other!));
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(link)) return null;
  const headline = cleanHeadline(c.title);
  const line = shortLine(c.body ?? '');
  const sameAsHeadline = line.replace(/[*_~`]/g, '').toLowerCase() === headline.toLowerCase();
  return [`*${headline}*`, ...(line && !sameAsHeadline ? [line] : []), link].join('\n\n');
}

/** What a push is, for the row's small label. `page` = any other allowed page (brief 2026-11-07-social-every-link). */
export function pushKindOf(url: string): 'article' | 'course' | 'product' | 'page' | null {
  if (articleContentOf({ url }) !== null) return 'article';
  const store = storeLinkOf(url);
  if (store) return store.kind;
  return pageLinkOf(url) ? 'page' : null;
}
