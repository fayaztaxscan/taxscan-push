import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { storeLinkOf, storeUtmContent } from '../social/allPushes';
import { articleContentOf, buildPostText, cleanHeadline, shortLine } from './postText';
import { withWhatsAppUtm } from './utm';

/**
 * The WhatsApp post for ONE push under the "every push gets a row" rule (brief 2026-11-05-whatsapp-every-push).
 *
 *   an article                       exactly today's post (`buildPostText`: *headline*, short line, link)
 *   an academy course / shop product *<push title>*, a blank line, the push body cut with `shortLine`, a blank line, the link
 *
 * The title goes through `cleanHeadline` so WhatsApp's own formatting characters (* _ ~ `) cannot break the bold; emoji survive. A body
 * that is empty, or only repeats the title, adds no paragraph (as for an article). The link is the push's own URL with the WhatsApp
 * UTMs SET (one set, the push's own `utm_*` gone): `utm_content` is the slug for a course or product (`storeUtmContent`). Null when the
 * URL is neither, or the final link is off `ALLOWED_PUSH_HOSTS`. No network.
 */
export function buildPushPostText(c: { id: string; title: string; body: string; url: string }): string | null {
  if (articleContentOf(c) !== null) return buildPostText(c);
  const store = storeLinkOf(c.url);
  if (!store || !isAllowedPushUrl(c.url.trim())) return null;
  let link: string;
  try {
    link = withWhatsAppUtm(c.url.trim(), storeUtmContent(store));
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(link)) return null;
  const headline = cleanHeadline(c.title);
  const line = shortLine(c.body ?? '');
  const sameAsHeadline = line.replace(/[*_~`]/g, '').toLowerCase() === headline.toLowerCase();
  return [`*${headline}*`, ...(line && !sameAsHeadline ? [line] : []), link].join('\n\n');
}

/** What a push is, for the row's small label. */
export function pushKindOf(url: string): 'article' | 'course' | 'product' | null {
  if (articleContentOf({ url }) !== null) return 'article';
  return storeLinkOf(url)?.kind ?? null;
}
