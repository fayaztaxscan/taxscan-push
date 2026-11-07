import { env } from '../../lib/env';
import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { isTestSegmentOnly } from './publicCampaign';
import { articleContentOf, UTM_CONTENT_MAX } from '../whatsapp/postText';

/**
 * "Every push posts" (brief 2026-11-04-academy-store-posts). From a time set per page (LINKEDIN_TAXSCAN_ALL_PUSHES_FROM,
 * LINKEDIN_ACADEMY_ALL_PUSHES_FROM, FACEBOOK_ALL_PUSHES_FROM), the Taxscan LinkedIn page, the Taxscan Academy LinkedIn page and the
 * Taxscan Facebook page post EVERY push, like the push notification itself: a taxscan.in article, an academy.taxscan.in course or a
 * shop.taxscan.in product, ONE POST PER PUSH, repeats included (the morning backfill, a resend, a Compose copy). A push sent before
 * the page's time follows today's rule (one post per article) for good; a push at or after it follows this one. Nothing older ever
 * becomes eligible, so switching on never floods a page with the past.
 *
 * This is a SECOND rule beside `isPublicArticleCampaign()`, which is NOT changed: the WhatsApp queue and today's article posting
 * keep using it exactly as before.
 *
 * What qualifies (`isAllPushesCampaign`), and nothing else:
 *   a taxscan.in article                          `articleContentOf` (https://www.taxscan.in/<section>/<slug>, or the old …-<id> shape)
 *   https://academy.taxscan.in/course/<slug>      a course
 *   https://shop.taxscan.in/products/<slug>       a shop product
 * on ALLOWED_PUSH_HOSTS, and not test-segment-only. The home page, a section page, a collection and any other page qualify ONLY under
 * SOCIAL_ANY_LINK_FROM (below). The caller has already selected `status = SENT`, `lastSentAt` set and the portal, exactly as for articles.
 *
 * ANY OTHER LINK (brief 2026-11-07-social-every-link). A fourth kind, `page`: any other page on ALLOWED_PUSH_HOSTS (a shop collection,
 * the pricing page, a home or section page), which is not an article, course or product. It qualifies ONLY from SOCIAL_ANY_LINK_FROM
 * (one time for all four channels) and only for a push whose `lastSentAt` is at or after it. THE TIME CHECK LIVES IN
 * `isAllPushesCampaign` ITSELF, so no caller can forget it: a push with no `lastSentAt` never qualifies as a page (fail closed). The
 * channel's own all-pushes time is still the caller's split, as for every kind (a page push is a candidate only where the page already
 * follows this rule at that send time). Articles, courses and products are untouched by it.
 *
 * One row per push: the key is `push:<campaignId>:<lastSentAt ms>`, stored in the same `articleKey` column, so a resend of the same
 * campaign row (a new `lastSentAt`) is a new key and posts again, while the unique (page, articleKey) still stops two ticks posting
 * the same push. The `push:` prefix cannot meet an article key (`article:<id>` or a URL).
 */

export const PUSH_KEY_PREFIX = 'push:';
export type StoreKind = 'course' | 'product';
export type StoreLink = { kind: StoreKind; host: string; slug: string; /** `https://<host>/<dir>/<slug>`: no query, no fragment, no trailing slash. */ base: string };

/** The two path shapes, by host. The slug is one path segment; a trailing slash is allowed. */
const STORE_PATHS: Readonly<Record<string, { dir: string; kind: StoreKind }>> = {
  'academy.taxscan.in': { dir: 'course', kind: 'course' },
  'shop.taxscan.in': { dir: 'products', kind: 'product' },
};

/** A course or shop-product link, parsed; null for anything else (http, another host or path, userinfo, a port, an empty slug). */
export function storeLinkOf(url: string): StoreLink | null {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  const host = u.hostname.toLowerCase();
  const rule = STORE_PATHS[host];
  if (!rule) return null;
  const m = new RegExp(`^/${rule.dir}/([^/]+)/?$`).exec(u.pathname);
  if (!m) return null;
  return { kind: rule.kind, host, slug: m[1], base: `https://${host}/${rule.dir}/${m[1]}` };
}

export type PageLink = {
  kind: 'page';
  host: string;
  /** The non-empty path segments, in order (empty for the root path). */
  segments: string[];
  /** `https://<host><path>`: no query, no fragment; the root path is `https://<host>/`. */
  base: string;
};

/**
 * Any OTHER page on an allowed host (brief 2026-11-07-social-every-link): not an article (`articleContentOf`), not a course or product
 * (`storeLinkOf`), no userinfo, no port, on `ALLOWED_PUSH_HOSTS`. The host must be NAMED in that list: with the list emptied (the
 * operator's "permissive" mode) nothing counts as a page, so the card fetch can never be pointed at a host nobody listed. null for
 * anything else. Pure. It says what KIND of link this is, never whether it is time to post it (that is `isAllPushesCampaign`).
 */
export function pageLinkOf(url: string): PageLink | null {
  const raw = String(url ?? '').trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username !== '' || u.password !== '' || u.port !== '') return null;
  const host = u.hostname.toLowerCase();
  if (!env.allowedPushHosts.includes(host) || !isAllowedPushUrl(raw)) return null;
  if (articleContentOf({ url: raw }) !== null || storeLinkOf(raw) !== null) return null;
  const segments = u.pathname.split('/').filter(Boolean);
  return { kind: 'page', host, segments, base: `https://${host}${u.pathname}` };
}

/**
 * Does this push follow the new rule? ONE predicate for the LinkedIn, Facebook and WhatsApp workers and queue, the screens and the
 * Channels marks. Looks at what was sent, never at who sent it (as `isPublicArticleCampaign` does). Every caller passes the campaign
 * with its `lastSentAt`: a push to any other page (`pageLinkOf`) counts only when that time is at or after SOCIAL_ANY_LINK_FROM.
 */
export function isAllPushesCampaign(
  c: { url: string; target?: unknown; lastSentAt?: Date | null },
  testTopic: string = env.testSegmentTopic,
  anyLinkFrom: Date | null = env.social.anyLinkFrom,
): boolean {
  const url = String(c.url ?? '').trim();
  if (isTestSegmentOnly(c.target, testTopic) || !isAllowedPushUrl(url)) return false;
  if (articleContentOf({ url }) !== null || storeLinkOf(url) !== null) return true;
  // ANY OTHER LINK: only from SOCIAL_ANY_LINK_FROM, and only for a push SENT at or after it. A missing send time never qualifies.
  return anyLinkFrom !== null && !!c.lastSentAt && c.lastSentAt.getTime() >= anyLinkFrom.getTime() && pageLinkOf(url) !== null;
}

/**
 * The time a page's new rule REALLY starts: its all-pushes time, but never earlier than the page's own go-live (LINKEDIN_POST_FROM,
 * LINKEDIN_ACADEMY_POST_FROM, FACEBOOK_POST_FROM). Nothing pushed before a page's go-live is ever posted there, whatever else is set.
 * null = the page stays on today's rule.
 */
export const newRuleFrom = (pushesFrom: Date | null, postFrom: Date | null): Date | null => (pushesFrom ? (postFrom && postFrom > pushesFrom ? postFrom : pushesFrom) : null);

/** `push:<campaign id>:<send time in ms>`: the row key of ONE push. */
export const pushKey = (c: { id: string; lastSentAt: Date }): string => `${PUSH_KEY_PREFIX}${c.id}:${c.lastSentAt.getTime()}`;
export const isPushKey = (key: string): boolean => key.startsWith(PUSH_KEY_PREFIX);
/** The campaign id inside a `push:<campaign id>:<send time in ms>` key (a cuid has no colon). */
export const pushKeyCampaignId = (key: string): string => key.slice(PUSH_KEY_PREFIX.length, key.lastIndexOf(':'));
/** The campaigns that already have a `push:` row, out of a page's keys (the workers' `have` read): the new rule has handled them. */
export function pushedCampaignIds(keys: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const k of keys) if (isPushKey(k)) ids.add(pushKeyCampaignId(k));
  return ids;
}

/** `utm_content` for a course / product post: the slug (decoded), cut like an article's. */
export function storeUtmContent(link: StoreLink): string {
  let slug = link.slug;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw segment
  }
  return slug.slice(0, UTM_CONTENT_MAX);
}

/**
 * `utm_content` for an other-page post: the path segments (each decoded) joined by `-`, cut to `UTM_CONTENT_MAX`; `home` for the root
 * path. `/collections/all` → `collections-all`, `/pricing` → `pricing`, `/` → `home`.
 */
export function pageUtmContent(link: PageLink): string {
  if (link.segments.length === 0) return 'home';
  const parts = link.segments.map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg; // keep the raw segment
    }
  });
  return parts.join('-').slice(0, UTM_CONTENT_MAX);
}

/**
 * The push body for a course / product post: line endings unified, each line's runs of spaces/tabs collapsed to one space, empty
 * lines dropped, so the lines the editor wrote stay as single line breaks (`- ` bullets survive) and nothing else. Empty string when
 * there is no body.
 */
export function storeBodyLines(body: string | null | undefined): string {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** The push title on one line. */
export const storeTitle = (title: string): string => String(title ?? '').replace(/\s+/g, ' ').trim();
