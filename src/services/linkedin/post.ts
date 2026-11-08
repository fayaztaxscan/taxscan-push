import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { articleContentOf } from '../whatsapp/postText';
import { fetchStorePage, type StorePageFetch, type StorePageResult } from '../social/storePage';
import { pageLinkOf, pageUtmContent, storeBodyLines, storeLinkOf, storeTitle, storeUtmContent } from '../social/allPushes';
import { withLinkedInUtm } from './pages';

/* ------------------------------------------------------------------ */
/* Commentary: LinkedIn's "little text" format                         */
/* ------------------------------------------------------------------ */

/**
 * Plain text for the Posts API `commentary`: every reserved character is backslash-escaped, or LinkedIn cuts the text
 * at the first unescaped one (headlines hold `[Read Order]` and `(2)`). Reserved list: `\ | { } @ [ ] ( ) < > # * _ ~`
 * (learn.microsoft.com … /shares/little-text-format, checked 2 Nov 2026).
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (m) => `\\${m}`);
}

/** A hashtag in the documented template form `{hashtag|\#|Tag}` (renders as a real, clickable hashtag). `tag` is letters/digits only. */
export const hashtagTemplate = (tag: string): string => `{hashtag|\\#|${tag}}`;

/** headline, a blank line, then the hashtags (each already letters/digits only). */
export function buildCommentary(headline: string, tags: readonly string[]): string {
  const head = escapeLittleText(headline.replace(/\s+/g, ' ').trim());
  return tags.length ? `${head}\n\n${tags.map(hashtagTemplate).join(' ')}` : head;
}

/**
 * The commentary of an IMAGE post (brief 2026-11-08-social-picture): today's commentary with the tagged link on its own line, put
 * just before the hashtag line (so it shows before LinkedIn's "…more"), or at the end when there are no hashtags. The link is
 * escaped as little text like everything else in the commentary (UTM names hold `_`). Null when the result would pass
 * `COMMENTARY_MAX`: the caller then posts today's link post instead.
 */
export function commentaryWithLink(commentary: string, link: string): string | null {
  const line = escapeLittleText(link.trim());
  const at = commentary.lastIndexOf('\n\n{hashtag|');
  const out = at >= 0 ? `${commentary.slice(0, at)}\n\n${line}${commentary.slice(at)}` : `${commentary}\n\n${line}`;
  return out.length <= COMMENTARY_MAX ? out : null;
}

/* ------------------------------------------------------------------ */
/* Hashtags, per article, from the CMS's own editorial data            */
/* ------------------------------------------------------------------ */

export type CmsArticle = {
  keywords: string[];
  courts: { name: string; shortName: string }[];
  category: string | null;
  /** The cover picture's URL (`cover_image_url`), for the link card's thumbnail. */
  coverImageUrl?: string | null;
  /** The editor's one-line summary (`excerpt`), for the link card's description. */
  excerpt?: string | null;
};

export const MAX_HASHTAGS = 6;
export const MAX_KEYWORD_TAGS = 3;
export const KEYWORD_MAX_CHARS = 24;
export const KEYWORD_MAX_WORDS = 3;
export const FIXED_TAG = 'taxscan';

/** Generic keywords that say nothing (lower case, whitespace-collapsed). One constant, easy to extend. */
export const KEYWORD_STOPLIST: ReadonlySet<string> = new Set([
  'income tax act',
  'interest',
  'assessing officer',
  'tax',
  'order',
  'judgment',
  'result date',
  'disciplinary action',
  'latest judgments',
]);

/** Categories that are not worth a tag. */
const CATEGORY_SKIP: ReadonlySet<string> = new Set(['other taxations', 'top stories', 'uncategorized', 'other news']);

/** Words that stay upper case however the editor typed them. */
const ACRONYMS: ReadonlySet<string> = new Set([
  'GST', 'CGST', 'IGST', 'SGST', 'UTGST', 'ITC', 'NFAC', 'ICAI', 'DGGI', 'CBDT', 'CBIC', 'TDS', 'TCS', 'AO', 'ITAT', 'CESTAT',
  'NCLT', 'NCLAT', 'GSTAT', 'SEBI', 'RBI', 'FEMA', 'PMLA', 'IBC', 'HC', 'PAN', 'EPF', 'ESI', 'LLP', 'MSME', 'ROC', 'MCA',
]);
/** Acts whose acronym is added to a section tag (`Section 69 CGST Act` → `#Section69CGST`). */
const SECTION_ACTS = ['CGST', 'IGST', 'SGST', 'FEMA', 'PMLA', 'IBC'];

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** CamelCase, letters and digits only; acronyms stay upper case. Null when nothing is left. */
export function camelCase(phrase: string): string | null {
  const words = clean(phrase).split(/[\s-]+/).filter(Boolean);
  const out = words
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
    .map((w) => {
      if (ACRONYMS.has(w.toUpperCase())) return w.toUpperCase();
      if (/^[A-Z0-9]{2,}$/.test(w)) return w; // already an acronym the editor typed
      return w[0].toUpperCase() + w.slice(1);
    })
    .join('');
  return out || null;
}

/** `Section 69 CGST Act` → `Section69CGST`; `Section 57(iv) of the Income Tax Act` → `Section57`; `Section 270A` → `Section270A`. */
export function sectionTag(keyword: string): string | null {
  const m = /^section\s+(\d+[A-Za-z]{0,3})(?![A-Za-z])/i.exec(clean(keyword));
  if (!m) return null;
  const act = SECTION_ACTS.find((a) => new RegExp(`\\b${a}\\b`, 'i').test(keyword));
  return `Section${m[1].toUpperCase().replace(/^(\d+)([A-Z]*)$/, '$1$2')}${act ?? ''}`;
}

/** The court tag: SC → SupremeCourt; a clean acronym → itself (or a bench keyword `ITAT Panaji` → ITATPanaji); else CamelCase(name). */
export function courtTag(court: { name: string; shortName: string } | undefined, keywords: readonly string[]): string | null {
  if (!court) return null;
  const short = (court.shortName ?? '').trim();
  if (short === 'SC') return 'SupremeCourt';
  if (/^[A-Z]{2,8}$/.test(short)) {
    // a bench keyword: exactly two words, the first the acronym, the second a capitalised name (a place)
    const bench = keywords.map(clean).find((k) => {
      const w = k.split(' ');
      return w.length === 2 && w[0].toLowerCase() === short.toLowerCase() && /^[A-Z][A-Za-z]+$/.test(w[1]);
    });
    if (bench) return `${short}${bench.split(' ')[1]}`;
    return short;
  }
  return camelCase(court.name);
}

/** Section phrase, else a keyword that is plain words, ≤ 3 words and ≤ 24 characters once CamelCased. */
function keywordTag(keyword: string): string | null {
  const k = clean(keyword);
  if (!k || KEYWORD_STOPLIST.has(k.toLowerCase())) return null;
  const section = sectionTag(k);
  if (section) return section;
  if (!/^[A-Za-z0-9 -]+$/.test(k)) return null; // apostrophes, brackets, "&" …: not a clean tag
  if (k.split(/[\s-]+/).filter(Boolean).length > KEYWORD_MAX_WORDS) return null;
  const tag = camelCase(k);
  return tag && tag.length <= KEYWORD_MAX_CHARS ? tag : null;
}

export type HashtagInput = {
  cms: CmsArticle | null;
  /** Campaign.authority, e.g. "Supreme Court", "CESTAT" (the fallback's court). */
  authority: string | null;
  /** Campaign.categories (the RSS tags; the fallback's category). */
  categories: readonly string[];
};

function categoryTag(name: string | null | undefined): string | null {
  const n = clean(name ?? '');
  if (!n || CATEGORY_SKIP.has(n.toLowerCase())) return null;
  return camelCase(n);
}

/**
 * Up to 6 unique (case-insensitive) hashtags, letters and digits only, `taxscan` last: court (+ bench), category, up to
 * 3 editorial keywords in the editor's order, `#taxscan`. Without usable CMS data: the campaign's own authority and
 * category, plus `taxscan`. Pure.
 */
export function hashtagsFor(input: HashtagInput): { tags: string[]; source: 'cms' | 'fallback' } {
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (t: string | null): boolean => {
    if (!t || !/^[A-Za-z0-9]+$/.test(t) || seen.has(t.toLowerCase())) return false;
    seen.add(t.toLowerCase());
    tags.push(t);
    return true;
  };
  const cms = input.cms && (input.cms.keywords.length > 0 || input.cms.courts.length > 0) ? input.cms : null;
  if (cms) {
    add(courtTag(cms.courts[0], cms.keywords));
    add(categoryTag(cms.category));
    let kw = 0;
    for (const k of cms.keywords) {
      if (kw >= MAX_KEYWORD_TAGS) break;
      // a keyword that is the court's own name / short name repeats the court
      const c = cms.courts[0];
      if (c && [c.name, c.shortName].some((n) => clean(n ?? '').toLowerCase() === clean(k).toLowerCase())) continue;
      if (add(keywordTag(k))) kw += 1;
    }
  } else {
    const a = clean(input.authority ?? '');
    add(/^[A-Z]{2,8}$/.test(a) ? a : camelCase(a));
    for (const c of input.categories.flatMap((x) => x.split(','))) if (add(categoryTag(c))) break;
  }
  add(FIXED_TAG);
  // `taxscan` always survives the cap: it is last, so trim the middle
  const body = tags.filter((t) => t.toLowerCase() !== FIXED_TAG).slice(0, MAX_HASHTAGS - 1);
  return { tags: [...body, FIXED_TAG], source: cms ? 'cms' : 'fallback' };
}

/* ------------------------------------------------------------------ */
/* The CMS article API (public, read-only, no auth)                    */
/* ------------------------------------------------------------------ */

export const CMS_ARTICLE_API = 'https://api.taxscan.in/api/v1/articles/';
const CMS_TIMEOUT_MS = 5000;
const CMS_MAX_BYTES = 2 * 1024 * 1024;

/** The slug is the last URL path segment. */
export function slugOf(url: string): string | null {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs.length ? decodeURIComponent(segs[segs.length - 1]) : null;
  } catch {
    return null;
  }
}

export type FetchLike = typeof fetch;

/**
 * Reads the article's editorial keywords / courts / category. 5 s timeout, ONE attempt, body capped at 2 MB, host must
 * be api.taxscan.in, no credentials sent. Returns null on any failure (fail-open: the caller uses the fallback tags).
 */
export async function fetchCmsArticle(slug: string, fetchImpl: FetchLike = fetch): Promise<CmsArticle | null> {
  try {
    const url = new URL(`${CMS_ARTICLE_API}${encodeURIComponent(slug)}`);
    if (url.hostname !== 'api.taxscan.in') return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CMS_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url.toString(), { signal: ctrl.signal, headers: { accept: 'application/json' }, redirect: 'error' });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > CMS_MAX_BYTES) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > CMS_MAX_BYTES) return null;
      return parseCmsArticle(JSON.parse(new TextDecoder().decode(buf)));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Reads only what the hashtags need, tolerating missing fields. Null when the shape is not an article. */
export function parseCmsArticle(raw: unknown): CmsArticle | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const keywords = Array.isArray(o.keywords) ? o.keywords.map(str).filter((x): x is string => !!x) : [];
  const courts = Array.isArray(o.courts)
    ? o.courts
        .map((c) => (c && typeof c === 'object' ? { name: str((c as Record<string, unknown>).name), shortName: str((c as Record<string, unknown>).shortName) } : null))
        .filter((c): c is { name: string | null; shortName: string | null } => !!c && (!!c.name || !!c.shortName))
        .map((c) => ({ name: c.name ?? '', shortName: c.shortName ?? '' }))
    : [];
  return { keywords, courts, category: str(o.category_name), coverImageUrl: str(o.cover_image_url), excerpt: str(o.excerpt) };
}

/* ------------------------------------------------------------------ */
/* One post, ready to send                                             */
/* ------------------------------------------------------------------ */

/** The link card's description is cut at a word boundary to at most this many characters (the ellipsis included). */
export const DESCRIPTION_MAX = 200;

/** Whitespace-collapsed, cut at a word boundary to ≤ 200 characters with "…". A plain string (not little-text commentary). */
export function cardDescription(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= DESCRIPTION_MAX) return flat;
  const room = DESCRIPTION_MAX - 1; // one character for the ellipsis
  const cut = flat.slice(0, room + 1);
  const at = cut.lastIndexOf(' ');
  const head = (at > 0 ? cut.slice(0, at) : flat.slice(0, room)).replace(/[\s.,;:!?-]+$/, '');
  return `${head}…`;
}

export type PostPayload = {
  commentary: string;
  title: string;
  link: string;
  hashtags: string[];
  /** 'fixed' = a course / shop post: only the fixed `#taxscan`, no CMS data. */
  hashtagSource: 'cms' | 'fallback' | 'fixed';
  /** The card's one-line description: the CMS excerpt, else the campaign body (≤ 200 characters). May be empty. */
  description: string;
  /** The CMS cover picture's URL, or null (the CMS fetch failed or has none). Never scraped from the page. */
  coverImageUrl: string | null;
  /** Course / shop posts only: why there is no `coverImageUrl` (a fixed word, safe to log). */
  imageReason?: string;
};

/**
 * Everything a post needs, built from the campaign (and, fail-open, the CMS). Null when the URL is not a taxscan.in
 * article or the final link is off `ALLOWED_PUSH_HOSTS`.
 */
export async function buildPost(
  c: { id: string; title: string; url: string; authority: string | null; categories: string[]; body?: string | null },
  page: string,
  fetchCms: (slug: string) => Promise<CmsArticle | null> = (s) => fetchCmsArticle(s),
): Promise<PostPayload | null> {
  const content = articleContentOf(c);
  if (!content) return null;
  let link: string;
  try {
    link = withLinkedInUtm(c.url, page, content);
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(link)) return null;
  const slug = slugOf(c.url);
  const cms = slug ? await fetchCms(slug).catch(() => null) : null;
  const { tags, source } = hashtagsFor({ cms, authority: c.authority, categories: c.categories });
  const title = c.title.replace(/\s+/g, ' ').trim();
  return {
    commentary: buildCommentary(title, tags),
    title,
    link,
    hashtags: tags,
    hashtagSource: source,
    description: cardDescription(cms?.excerpt || c.body),
    coverImageUrl: cms?.coverImageUrl ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Course and shop pushes (brief 2026-11-04-academy-store-posts)       */
/* ------------------------------------------------------------------ */

/**
 * The longest `commentary` sent. LinkedIn documents 3,000 characters for a post's text (UGC Post API; the Posts API answers 400
 * FIELD_LENGTH_TOO_LONG above its limit). It is measured on the text as SENT (escape backslashes and the hashtag template count),
 * which can only be longer than what LinkedIn counts, so staying under it is safe.
 */
export const COMMENTARY_MAX = 3000;
/** The card title taken from a page is cut at a word boundary to at most this many characters. */
export const CARD_TITLE_MAX = 200;

/** Whitespace-collapsed, cut at a word boundary to ≤ `max` characters with "…". A plain string (not little-text commentary). */
function cutPlain(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > 0 ? cut.slice(0, at) : flat.slice(0, max - 1)).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/**
 * The commentary of a course / shop post: the push title, a blank line, the push body (its own lines, single line breaks), a blank
 * line, `#taxscan` as the documented hashtag template. Title and body are escaped as little text (emoji pass through untouched); the
 * hashtag is NOT escaped. When the whole would pass `COMMENTARY_MAX`, the BODY is cut (at a word boundary, with "…", on the raw text
 * so no escape pair is ever split) or dropped; the title is never cut. Pure.
 */
export function buildStoreCommentary(title: string, body: string): string {
  const head = escapeLittleText(storeTitle(title));
  const tag = hashtagTemplate(FIXED_TAG);
  const lines = storeBodyLines(body);
  if (!lines) return `${head}\n\n${tag}`;
  const whole = `${head}\n\n${escapeLittleText(lines)}\n\n${tag}`;
  if (whole.length <= COMMENTARY_MAX) return whole;
  // the room the body may use: everything but the title, the tag and the two blank lines between the three parts
  const room = COMMENTARY_MAX - head.length - tag.length - 4;
  if (room < 2) return `${head}\n\n${tag}`;
  let used = 0;
  let kept = '';
  for (const ch of lines) {
    const w = escapeLittleText(ch).length;
    if (used + w > room - 1) break; // one character for the ellipsis
    used += w;
    kept += ch;
  }
  const at = Math.max(kept.lastIndexOf(' '), kept.lastIndexOf('\n'));
  const head2 = (at > 0 ? kept.slice(0, at) : kept).replace(/[\s.,;:!?-]+$/, '');
  return head2 ? `${head}\n\n${escapeLittleText(head2)}…\n\n${tag}` : `${head}\n\n${tag}`;
}

export type StorePostPayload = PostPayload & { hashtagSource: 'fixed'; imageReason?: string };

/**
 * Everything a course / shop post needs, built from the campaign and (fail-open) the product page's og tags. Null when the URL is not a
 * course or shop-product link, or the final link is off `ALLOWED_PUSH_HOSTS`.
 *  - commentary: see `buildStoreCommentary`;
 *  - link: the push's own link with this page's LinkedIn UTMs (`utm_content` = the slug), replacing any UTMs the push carried;
 *  - card title / description: the page's `og:title` / `og:description`, else the push title / body;
 *  - picture: the page's `og:image:secure_url`, else `og:image` when it is https; with no usable one, `imageReason` says why.
 * The page is fetched on its canonical form (the link without a query string, WITH a trailing slash): WordPress answers the
 * slash-less course URL with a redirect, and redirects are refused.
 */
export async function buildStorePost(
  c: { id: string; title: string; url: string; body?: string | null },
  page: string,
  fetchPage: StorePageFetch = (u) => fetchStorePage(u),
): Promise<StorePostPayload | null> {
  const link = storeLinkOf(c.url);
  if (!link || !isAllowedPushUrl(c.url.trim())) return null;
  return cardPost(c, page, storeUtmContent(link), `${link.base}/`, fetchPage);
}

/**
 * The post for a push to ANY OTHER page on an allowed host (brief 2026-11-07-social-every-link: a shop collection, the pricing page, a
 * home or section page), built exactly like a course / product post: the push's own title and body, the link with this page's LinkedIn
 * UTMs (`utm_content` = the path segments joined by `-`, `home` for the root; the push's own `utm_*` replaced, other query parameters
 * kept), the card from the page's og tags. The page is fetched on the push's own address WITHOUT its query (https, no redirects, 5 s,
 * capped read: see `fetchStorePage`) and, as for a course, any problem there is fail-open: the post goes out with the push's own wording
 * and no picture. Null when the URL is not an allowed other page, or the final link is off `ALLOWED_PUSH_HOSTS`.
 */
export async function buildPagePost(
  c: { id: string; title: string; url: string; body?: string | null },
  page: string,
  fetchPage: StorePageFetch = (u) => fetchStorePage(u),
): Promise<StorePostPayload | null> {
  const link = pageLinkOf(c.url);
  if (!link) return null;
  return cardPost(c, page, pageUtmContent(link), link.base, fetchPage);
}

/** The shared body of a course / product / other-page post (moved out of `buildStorePost` unchanged). */
async function cardPost(
  c: { id: string; title: string; url: string; body?: string | null },
  page: string,
  utmContent: string,
  fetchUrl: string,
  fetchPage: StorePageFetch,
): Promise<StorePostPayload | null> {
  let tagged: string;
  try {
    tagged = withLinkedInUtm(c.url.trim(), page, utmContent);
  } catch {
    return null;
  }
  if (!isAllowedPushUrl(tagged)) return null;
  const got: StorePageResult = await fetchPage(fetchUrl).catch((): StorePageResult => ({ ok: false, reason: 'page_network' }));
  const tags = got.ok ? got.tags : null;
  const title = storeTitle(c.title);
  return {
    commentary: buildStoreCommentary(c.title, c.body ?? ''),
    title: tags?.title ? cutPlain(tags.title, CARD_TITLE_MAX) : title,
    link: tagged,
    hashtags: [FIXED_TAG],
    hashtagSource: 'fixed',
    description: cardDescription(tags?.description || c.body),
    coverImageUrl: tags?.imageUrl ?? null,
    imageReason: tags ? (tags.imageUrl ? undefined : tags.imageReason ?? 'no_tag') : got.ok ? undefined : got.reason,
  };
}
