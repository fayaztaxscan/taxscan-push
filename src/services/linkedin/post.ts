import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { articleContentOf } from '../whatsapp/postText';
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

/* ------------------------------------------------------------------ */
/* Hashtags, per article, from the CMS's own editorial data            */
/* ------------------------------------------------------------------ */

export type CmsArticle = {
  keywords: string[];
  courts: { name: string; shortName: string }[];
  category: string | null;
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
  return { keywords, courts, category: str(o.category_name) };
}

/* ------------------------------------------------------------------ */
/* One post, ready to send                                             */
/* ------------------------------------------------------------------ */

export type PostPayload = { commentary: string; title: string; link: string; hashtags: string[]; hashtagSource: 'cms' | 'fallback' };

/**
 * Everything a post needs, built from the campaign (and, fail-open, the CMS). Null when the URL is not a taxscan.in
 * article or the final link is off `ALLOWED_PUSH_HOSTS`.
 */
export async function buildPost(
  c: { id: string; title: string; url: string; authority: string | null; categories: string[] },
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
  return { commentary: buildCommentary(title, tags), title, link, hashtags: tags, hashtagSource: source };
}
