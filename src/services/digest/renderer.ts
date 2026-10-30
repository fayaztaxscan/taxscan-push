import type { DigestAudience } from '@prisma/client';
import type { DigestEnv } from '../../lib/env';
import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import type { FrozenItem } from './builder';
import { istDateOf } from './retryPolicy';
import { adUtmContent, forbiddenForAudience } from './adRules';
import { isAllowedArticleImage } from './articleImage';

/**
 * Digest renderer (docs/EMAIL_DIGEST_DESIGN.md §4 renderer, §13 tasks 5 and 10).
 *
 * Task 10: the layout is a template with {{placeholders}} (`TEMPLATE_PLACEHOLDERS`);
 * `resolveTemplate()` picks it, and without one the built-in v0 layout
 * (`BUILTIN_TEMPLATE_HTML`) is used. Every rule below is the renderer's, whatever
 * the template: it fills the placeholders, a template only arranges them.
 * `renderDigest()` is PURE and deterministic: the same items, audience,
 * runDate and config give byte-identical output — no clock, no randomness,
 * no I/O. The runner calls it once, inside the build step, and freezes the
 * result on DigestSend; nothing re-renders after the freeze.
 *
 * Every rule below closes a defect of the hand-made digest (§1 table) and is
 * enforced here, so a bad digest is REFUSED (RenderError) rather than sent:
 *
 *  - subject   = lead MAIN headline, ≤ 90 chars on a word boundary (#4)
 *  - preheader = "Plus N more: <2nd headline>…", ≤ 110 chars, hidden in the
 *                HTML and returned for the provider's email_preheader (#7)
 *  - date      = from runDate in IST, "22 October 2026", never copied (#3)
 *  - footer    = postal address (empty → refuse), no "all types of emails" wording,
 *                Premium/Free reason line (#5, #6). NO unsubscribe link of ours: Mailercloud appends its
 *                own working footer to every campaign, and its merge tag is not one it expands (30 Oct 2026)
 *  - links     = every href passes isAllowedPushUrl() (else refuse) and
 *                carries the digest UTM (#16)
 *  - images    = every <img> has non-empty alt (#8); v0 is text-only unless a
 *                logo URL is passed
 *  - size      = HTML bytes + tracking-rewrite overhead per link: warn at
 *                DIGEST_HTML_WARN_KB, refuse above DIGEST_MAX_HTML_KB (#2)
 *  - layout    = the old Mailercloud newsletter's (30 Oct 2026): 900 px wide (860 inside), a story is a 280 px
 *                picture + 20 px gap + 560 px text row that stacks on phones (≤ 600 px media query), an ad is
 *                a desktop banner plus a mobile square swapped with the old newsletter's own CSS pattern;
 *                MSO fixed wrapper, 16 px body, light-only colour-scheme meta, no web fonts / JS / external CSS (#18)
 *  - escaping  = every text value is HTML-escaped
 *  - ads       = task 9: `ads` (picked by ads.ts) are drawn at fixed slots with
 *                live-text headline, real CTA button and image alt text; each
 *                link passes the allowlist and carries utm_content=ad-<id>-slot<N>;
 *                a SUBSCRIPTION ad in a PREMIUM render is refused (the guard,
 *                again); when `ads` is given, every slot drawn must have one
 *                (no empty slot). Ad markup counts toward the size budget.
 *
 * The runner's adapter (`renderDigestContent`, which picks the ads) lives in
 * `content.ts` so this module stays pure and import-cycle free.
 */

/** What the build step freezes onto each DigestSend. */
export type DigestContent = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /** The ads drawn, one per rendered slot (task 9). Absent from stub content. */
  placements?: AdPlacementRecord[];
  /** Task 10: the template used (null = built-in; absent from stub content). */
  templateId?: string | null;
  /** Set when the custom template failed and the built-in one was used instead (owner, 2026-10-23). */
  templateFallback?: TemplateFallback;
};

/** The custom template a variant fell back from, and the refusal that made it. */
export type TemplateFallback = { fromId: string; fromName: string; reason: string };

/**
 * Builds one variant's frozen content. `items` is that audience's frozen list
 * (MAIN by rank, then ICYMI) when the builder ran; undefined without one.
 * `cfg` is the runner's digest config (postal address, size limits).
 */
export type BuildContent = (input: {
  runId: string;
  runDate: Date;
  audience: DigestAudience;
  items?: FrozenItem[];
  cfg?: DigestEnv;
  /** The run's portal (the ad pool is per portal). Default: the push portal. */
  portal?: string;
  /** The build instant (ad date windows are judged at it). Default: now. */
  at?: Date;
}) => Promise<DigestContent>;

/** One ad placement the build records per send (DigestAdPlacement). */
export type AdPlacementRecord = { adId: string; slot: number; utmContent: string };

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

// Mailercloud does NOT expand this tag (Anagha's screenshot, 30 Oct 2026: it arrived as a dead link), and it
// appends its own working unsubscribe footer to every campaign. We never render it; a custom template that
// contains it is refused (it would render dead). Kept only to recognise it.
export const UNSUBSCRIBE_TAG = '{{unsubscribe_link}}';

export const SUBJECT_MAX = 90;
export const PREHEADER_MAX = 110;
/** Summary shown under a headline: about three lines in the 560 px text column. */
export const SUMMARY_MAX = 220;
/** Allowance per link for the provider's click-tracking rewrite (design §4). */
export const TRACKING_BYTES_PER_LINK = 150;

export const UTM_SOURCE = 'taxscan-digest';
export const UTM_MEDIUM = 'email';

export const PREMIUM_REASON = "You're receiving this daily digest as part of your Taxscan Premium subscription.";
export const FREE_REASON = "You're receiving this because you subscribed to Taxscan updates.";

/**
 * Ad insertion points (task 9 fills them; v0 renders nothing). `afterItem`
 * counts MAIN items in rank order; a slot whose item does not exist is not
 * rendered. `beforeFooter` is always reached.
 */
export type AdSlot = { slot: number; position: 'afterItem'; afterItem: number } | { slot: number; position: 'beforeFooter' };
export const AD_SLOTS: readonly AdSlot[] = [
  { slot: 1, position: 'afterItem', afterItem: 4 },
  { slot: 2, position: 'afterItem', afterItem: 9 },
  { slot: 3, position: 'beforeFooter' },
];
/** The slots drawn for a digest with `mainCount` MAIN stories (an afterItem slot needs its item). */
export function slotsForMainCount(mainCount: number): number[] {
  return AD_SLOTS.filter((s) => s.position === 'beforeFooter' || s.afterItem <= mainCount).map((s) => s.slot);
}

/** MAIN items the renderer will actually draw (a blank headline is skipped). */
export function renderableMainCount(items: Pick<FrozenItem, 'section' | 'title'>[]): number {
  return items.filter((i) => i.section === 'MAIN' && clean(i.title ?? '') !== '').length;
}

/** An ad ready to draw: what the picker chose, with its image already resolved to a URL. */
export type RenderAd = {
  slot: number;
  adId: string;
  kind: string;
  headline: string;
  body: string | null;
  ctaText: string;
  linkUrl: string;
  altText: string;
  /** The desktop banner (shown 860 px wide). */
  image: { url: string; width: number; height: number } | null;
  /** The mobile square (shown 300 px wide on phones). null = phones get the banner too. */
  mobileImage?: { url: string; width: number; height: number } | null;
};

/** Returns the slot's complete `<tr>…</tr>` markup, or '' for nothing. */
export type AdSlotHook = (slot: AdSlot, ctx: { audience: DigestAudience; utmCampaign: string }) => string;
/** v0: no ads. */
export const noAds: AdSlotHook = () => '';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Owner, 2026-10-23: the built-in look stays close to the hand-made Mailercloud digest readers
// know (Arial, a #3b3543 header bar with the white logo, square yellow buttons).
const FONT = "Arial,'Helvetica Neue',Helvetica,sans-serif";
/**
 * On every text cell and text element: a long unbroken word (URL-like slug, a
 * 100-char token) wraps instead of widening the 600 px column. Both properties
 * for client coverage (word-break:break-word for WebKit/old Outlook.com,
 * overflow-wrap:anywhere for the rest).
 */
export const WRAP = 'word-break:break-word;overflow-wrap:anywhere;';
const C = {
  page: '#f2f3f5',
  card: '#ffffff',
  rule: '#e3e5e8',
  text: '#111111', // never pure black (dark-mode inversion)
  ink: '#000000', // the old newsletter's headline and button text
  body: '#333333',
  muted: '#5f6368',
  link: '#1376c8',
  brand: '#3b3543', // the header bar (as in today's digest); fixed in dark mode too
  brandText: '#ffffff',
  button: '#FEE620', // square yellow CTA, bold dark text (today's digest)
  buttonText: '#000000',
};

/**
 * The five fixed footer links (owner, 29 Oct 2026). They are NOT story or ad links: no UTM, and the
 * link checks permit exactly these URLs (string-equal) and nothing broader — any other social URL in a
 * template is still refused. Icons are small PNGs in public/email/, served from the asset host.
 */
export const SOCIAL_LINKS = [
  { key: 'facebook', label: 'Facebook', href: 'https://www.facebook.com/taxscan/' },
  { key: 'x', label: 'X', href: 'https://twitter.com/tax_scan' },
  { key: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/taxscan/' },
  { key: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/company/tax-scan-9aa530129/' },
  { key: 'website', label: 'Taxscan website', href: 'https://www.taxscan.in/' },
] as const;
export const SOCIAL_ICON_SIZE = 24;
const SOCIAL_HREFS: ReadonlySet<string> = new Set(SOCIAL_LINKS.map((l) => l.href));
/**
 * The footer's contact line (owner, 29 Oct 2026): "Questions or feedback? Write to info@taxscan.in".
 * Mailercloud sends only from @hello.taxscan.in, so a reply lands at Mailercloud, not a real inbox
 * (the reply-to stays info@hello.taxscan.in); readers are pointed at a real mailbox instead. The one
 * `mailto:` the renderer draws, allowed EXACTLY (string-equal) by the link checks: no UTM, nothing broader.
 */
export const CONTACT_EMAIL = 'info@taxscan.in';
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;
export const CONTACT_LINE = `Questions or feedback? Write to ${CONTACT_EMAIL}`;
/** Exactly `mailto:info@taxscan.in`: any other mailto (or the same with a subject, or another case) is not allowed. */
export function isContactMailto(url: string): boolean {
  return url === CONTACT_MAILTO;
}

/** One of the five fixed social links, exactly. */
export function isSocialUrl(url: string): boolean {
  return SOCIAL_HREFS.has(url);
}

/**
 * The Taxscan logo (white, 440×106 for 2× at 220 px) on its own #3b3543 background, so it stays legible
 * even when a mail app recolours the header bar. Served from the asset host; the old transparent
 * `taxscan-logo-white-440.png` stays in `public/email/` because sent mail references it.
 */
export const LOGO_PATH = '/email/taxscan-logo-on-dark-440.png';
export const LOGO_WIDTH = 220;
export const LOGO_HEIGHT = 53;

/** Every button (Read More and an ad's CTA) is 38 px tall on desktop (the old newsletter's); phones draw it 43 px, full column. */
const BUTTON_HEIGHT = 38;
/** "Read More" is 96 px wide (the old newsletter's VML button is 95). */
const READ_MORE_WIDTH = 96;

/** A flat colour as a background-image too: apps that force-invert colours recolour `background-color` but leave an image alone. */
const solid = (hex: string) => `background-image:linear-gradient(${hex},${hex});`;

/**
 * A "bulletproof" table-cell button: square corners, a fixed-size yellow cell (`widthPx` × `heightPx`, `bgcolor` so Outlook
 * paints it) with ONE link inside, bold black text centred; the link's own box carries the same colours everywhere else.
 * One URL per button (the VML roundrect it replaced repeated it, 30 Oct 2026). On phones the table is the full column.
 * `href` is already escaped.
 */
function button(href: string, label: string, widthPx: number, heightPx = BUTTON_HEIGHT): string {
  const text = esc(label);
  return (
    `<table class="ts-btnt" width="${widthPx}" cellpadding="0" cellspacing="0"><tr><td align="center" width="${widthPx}" height="${heightPx}" bgcolor="${C.button}">` +
    `<a href="${href}" class="ts-btn" style="display:block;height:${heightPx}px;line-height:${heightPx}px;text-align:center;background-color:${C.button};${solid(C.button)}font-family:${FONT};font-size:15px;font-weight:700;color:${C.buttonText};text-decoration:none;">${text}</a>` +
    `</td></tr></table>`
  );
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type RenderErrorCode =
  | 'no_postal_address'
  | 'no_main_items'
  | 'link_not_allowed'
  | 'over_size_limit'
  | 'noreply_address'
  | 'ad_not_allowed'
  | 'ad_slot_empty'
  | 'template_unsubscribe_tag';

/** A refusal to render. The message never contains a full URL or an address. */
export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(`render refused (${code}): ${message}`);
    this.name = 'RenderError';
  }
}

/* ------------------------------------------------------------------ */
/* Sender / reply address rule (#9)                                    */
/* ------------------------------------------------------------------ */

/** True for noreply@, no-reply@, no_reply@, do-not-reply@ … (plus-tags ignored). */
export function isNoReplyAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  const local = (at >= 0 ? address.slice(0, at) : address).split('+')[0].toLowerCase().replace(/[-_.\s]/g, '');
  return local === 'noreply' || local === 'donotreply';
}

/**
 * Problems with the From / Reply-To config, in plain words, never echoing the
 * address. Used at boot (scheduler) and before every build (runner). An unset
 * address is not a problem here (the provider client refuses a missing sender).
 */
export function senderAddressProblems(mc: Pick<DigestEnv['mailercloud'], 'senderEmail' | 'replyEmail'>): string[] {
  const out: string[] = [];
  if (mc.senderEmail.trim() && isNoReplyAddress(mc.senderEmail.trim())) {
    out.push('MAILERCLOUD_SENDER_EMAIL is a no-reply address; use a monitored address');
  }
  if (mc.replyEmail.trim() && isNoReplyAddress(mc.replyEmail.trim())) {
    out.push('MAILERCLOUD_REPLY_EMAIL is a no-reply address; use a monitored address');
  }
  return out;
}

/** Throws RenderError('noreply_address') when the From/Reply config is a no-reply address. */
export function assertReplyAddresses(mc: Pick<DigestEnv['mailercloud'], 'senderEmail' | 'replyEmail'>): void {
  const p = senderAddressProblems(mc);
  if (p.length > 0) throw new RenderError('noreply_address', p.join('; '));
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * HTML-escapes text for element content AND double-quoted attributes. Braces become
 * `&#123;` / `&#125;` too (owner, 2026-10-23): a headline, excerpt or ad text that contains
 * `{{…}}` must never reach Mailercloud as a live merge tag. The renderer's own merge tag
 * (the unsubscribe link) is inserted raw, never through here.
 */
export function esc(s: string): string {
  return s.replace(
    /[&<>"'{}]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[c] as string,
  );
}

/**
 * The same guard for text that is not HTML: the subject, the preheader and the plain-text
 * part. A doubled brace — the merge-tag syntax (`{{unsubscribe_link}}`) — is split with a
 * space ("{ {", "} }"), so no reader-supplied `{{…}}` can be expanded; single braces are
 * left as written. Mailercloud documents no other merge-tag syntax (checked 2026-10-23), so
 * `[…]` and `%…%` are left alone.
 */
export function defuseMergeTags(s: string): string {
  return s.replace(/\{(?=\{)/g, '{ ').replace(/\}(?=\})/g, '} ');
}

/** A URL in the plain-text part: braces percent-encoded, so it stays one clickable token. */
function textUrl(u: string): string {
  return u.replace(/\{/g, '%7B').replace(/\}/g, '%7D');
}

/** Collapses whitespace (incl. newlines/control chars) to single spaces. */
export function clean(s: string): string {
  return (
    s
      // Zero-width (U+200B–U+200D, U+2060, U+FEFF) and bidi controls (U+202A–U+202E, U+2066–U+2069):
      // invisible, and bidi overrides can disguise text. Removed, not spaced. The one exception is
      // a U+200D joining two emoji (a ZWJ sequence such as 👨‍👩‍👧), which is one visible character.
      .replace(/[\u200b\u200c\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f])\u200d|\u200d(?!\p{Extended_Pictographic})/gu, '')
      // CR/LF/other C0 controls and runs of whitespace → one space (header-injection guard).
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
      .trim()
  );
}

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
/** User-perceived characters (an emoji ZWJ sequence or a flag is one). */
export function graphemes(s: string): string[] {
  return Array.from(GRAPHEMES.segment(s), (x) => x.segment);
}

/**
 * Trims `s` to at most `max` characters (counting the ellipsis), cutting at the
 * last word boundary and adding "…". Unchanged when it already fits.
 */
export function trimWords(s: string, max: number): string {
  const t = clean(s);
  const g = graphemes(t);
  if (g.length <= max) return t;
  const kept = g.slice(0, max - 1);
  // Prefer the last word boundary (a space, or the boundary right after the cut) when it falls
  // after ~60% of the limit; otherwise cut at a grapheme — never inside one.
  const boundary = g[max - 1] === ' ' ? max - 1 : kept.lastIndexOf(' ');
  const cut = (boundary >= Math.floor(max * 0.6) ? kept.slice(0, boundary) : kept).join('');
  return `${cut.replace(/[\s,;:.\-–—]+$/u, '')}…`;
}

/** "22 October 2026" for the IST day of `runDate`. */
export function formatDigestDate(runDate: Date): string {
  const d = istDateOf(runDate);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2026-10-22" for the IST day of `runDate`. */
function isoDay(runDate: Date): string {
  return istDateOf(runDate).toISOString().slice(0, 10);
}

/** "Taxscan Digest · 22 Oct 2026 · Free" — the human campaign name. */
export function digestCampaignName(runDate: Date, audience: DigestAudience): string {
  const d = istDateOf(runDate);
  const mon = MONTHS[d.getUTCMonth()].slice(0, 3);
  return `Taxscan Digest · ${d.getUTCDate()} ${mon} ${d.getUTCFullYear()} · ${audience === 'PREMIUM' ? 'Premium' : 'Free'}`;
}

/** "digest-2026-10-22-free" */
export function digestUtmCampaign(runDate: Date, audience: DigestAudience): string {
  return `digest-${isoDay(runDate)}-${audience === 'PREMIUM' ? 'premium' : 'free'}`;
}

/**
 * The single digest UTM function. Keeps every non-UTM query parameter and the
 * fragment; SETS (replaces, never duplicates) utm_source / utm_medium /
 * utm_campaign — and utm_content when given — so a URL that already carried
 * another channel's UTM is attributed to the digest, never double-tagged.
 */
export function withUtm(url: string, o: { campaign: string; content?: string }): string {
  const u = new URL(url);
  u.searchParams.set('utm_source', UTM_SOURCE);
  u.searchParams.set('utm_medium', UTM_MEDIUM);
  u.searchParams.set('utm_campaign', o.campaign);
  if (o.content) u.searchParams.set('utm_content', o.content);
  return u.toString();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || '(no host)';
  } catch {
    return '(unparseable)';
  }
}

/** Allowlist + scheme check. Even in the allowlist's permissive mode, only http(s). */
export function isAllowedDigestUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    // An explicit non-default port (e.g. :8443) is refused; WHATWG URL empties a default one.
    if (u.port !== '') return false;
    // Userinfo ("https://evil.com@www.taxscan.in/") is refused: the host is ours, but the
    // link reads as another site's to a reader and to spam filters.
    if (u.username !== '' || u.password !== '') return false;
  } catch {
    return false;
  }
  return isAllowedPushUrl(url);
}

/**
 * An ad link (task 9 follow-ups, owner 2026-10-23): the digest URL check AND
 * https only. Ads are checked at save, at pick and at render with this; article
 * links keep `isAllowedDigestUrl`, and push's shared allowlist is unchanged.
 */
export function isAllowedAdUrl(url: string): boolean {
  if (!isAllowedDigestUrl(url)) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export type RenderInput = {
  /** One audience's frozen list: MAIN by rank, then ICYMI (order is respected as given). */
  items: FrozenItem[];
  audience: DigestAudience;
  /** The run's IST date (DigestRun.runDate) or any instant on that IST day. */
  runDate: Date;
  cfg: Pick<DigestEnv, 'postalAddress' | 'maxHtmlKb' | 'htmlWarnKb'>;
  /** Optional logo image (must pass the allowlist). v0 default: none, a text wordmark. */
  logoUrl?: string | null;
  /** Raw ad insertion hook (tests of the slot positions). Ignored when `ads` is given. */
  adSlot?: AdSlotHook;
  /**
   * Task 9: the ads to draw. When given, every slot this digest draws must
   * have exactly one (else RenderError 'ad_slot_empty'). Undefined = no ads
   * (renderer unit tests only; the build always passes them).
   */
  ads?: RenderAd[];
  /**
   * Task 10: the template's COMPILED html (`resolveTemplate()` picks it).
   * Undefined = the built-in template (`BUILTIN_TEMPLATE_HTML`).
   */
  template?: { html: string };
  /**
   * 'send' (default): any refusal throws. 'check' (template validation and
   * previews only): a template's own off-allowlist link or image is left in
   * place for the validator to report, and the size limit is reported
   * (`overBudget`) instead of thrown. Never used for a digest that is frozen.
   */
  mode?: 'send' | 'check';
  /**
   * Decision A (brief digest-polish-old-look): URL of the 1600 x 840 "default story picture" (a
   * `/email-assets/<sha>.<jpg|png>` URL), resolved and frozen at the build. A main story whose own
   * `imageUrl` is null shows this; null/undefined = none set, draw the brand block. ICYMI never shows a picture.
   */
  defaultStoryImageUrl?: string | null;
  /** Where `/email-assets/` images are served from: template images may live there. */
  assetBaseUrl?: string;
};

export type RenderedDigest = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /** UTF-8 bytes of `html`. */
  htmlBytes: number;
  /** htmlBytes + TRACKING_BYTES_PER_LINK × links: the figure checked against the limits. */
  budgetBytes: number;
  linkCount: number;
  /** True at or above DIGEST_HTML_WARN_KB (still rendered). */
  sizeWarning: boolean;
  campaignName: string;
  /** Slots drawn (whether or not an ad was given for them). */
  renderedSlots: number[];
  /** Only in 'check' mode: the budget is above DIGEST_MAX_HTML_KB (in 'send' mode that throws). */
  overBudget: boolean;
};

type Prepared = {
  rank: number;
  section: 'MAIN' | 'ICYMI';
  title: string;
  label: string;
  summary: string | null;
  href: string;
  /** Story picture: only a documents.taxscan.in .jpg/.jpeg/.png passes (anything else → text-only). */
  imageUrl: string | null;
};

function prepare(items: FrozenItem[], utmCampaign: string): Prepared[] {
  return items.map((it, i) => {
    if (!isAllowedDigestUrl(it.url)) {
      throw new RenderError('link_not_allowed', `item ${i + 1} links to ${hostOf(it.url)}, which is not on ALLOWED_PUSH_HOSTS`);
    }
    const label = clean(it.authority ?? '') || clean(it.category ?? '');
    const summary = it.excerpt ? trimWords(it.excerpt, SUMMARY_MAX) : '';
    return {
      rank: i + 1,
      section: it.section,
      title: clean(it.title),
      label,
      summary: summary || null,
      href: withUtm(it.url, { campaign: utmCampaign, content: `item${i + 1}` }),
      imageUrl: isAllowedArticleImage(it.imageUrl) ? (it.imageUrl as string) : null,
    };
  });
}

/** Renders one variant. Pure; throws RenderError when a rule refuses it. */
export function renderDigest(input: RenderInput): RenderedDigest {
  const { audience, runDate, cfg } = input;
  const postal = clean(cfg.postalAddress ?? '');
  if (!postal) throw new RenderError('no_postal_address', 'DIGEST_POSTAL_ADDRESS is empty; a digest without a postal address is never built');

  // MAIN first (in given order), then ICYMI, whatever order they arrive in.
  // An item whose headline is blank once cleaned is skipped (the next MAIN item leads).
  const usable = input.items.filter((i) => clean(i.title ?? '') !== '');
  const ordered = [...usable.filter((i) => i.section === 'MAIN'), ...usable.filter((i) => i.section !== 'MAIN')];
  const utmCampaign = digestUtmCampaign(runDate, audience);
  const items = prepare(ordered, utmCampaign);
  const main = items.filter((i) => i.section === 'MAIN');
  const icymi = items.filter((i) => i.section === 'ICYMI');
  if (main.length === 0) throw new RenderError('no_main_items', 'no MAIN item with a headline to lead the digest');

  // The logo: given explicitly, else the committed asset on the digest asset host
  // (production always passes assetBaseUrl); without either, a text wordmark.
  const logoUrl = input.logoUrl ?? (input.assetBaseUrl ? `${input.assetBaseUrl}${LOGO_PATH}` : null);
  if (logoUrl && !isAllowedTemplateImage(logoUrl, input.assetBaseUrl ?? null)) {
    throw new RenderError('link_not_allowed', `logo image is on ${hostOf(logoUrl)}, which is not on ALLOWED_PUSH_HOSTS`);
  }

  const defaultPic = input.defaultStoryImageUrl && isAllowedTemplateImage(input.defaultStoryImageUrl, input.assetBaseUrl ?? null) ? input.defaultStoryImageUrl : null;
  const dateText = formatDigestDate(runDate);
  // Reader text never carries a live merge tag (owner, 2026-10-23).
  const subject = defuseMergeTags(trimWords(main[0].title, SUBJECT_MAX));
  // "Plus N more" counts the MAIN stories only: "In case you missed it" repeats yesterday's, it is not "more".
  const second = main[1];
  const preheader = defuseMergeTags(second ? preheaderFor(main.length - 1, second.title) : `Taxscan Daily Digest · ${dateText}`);
  const campaignName = digestCampaignName(runDate, audience);
  const homeHref = withUtm('https://www.taxscan.in/', { campaign: utmCampaign, content: 'header' });
  if (!isAllowedDigestUrl(homeHref)) throw new RenderError('link_not_allowed', 'the header link host is not on ALLOWED_PUSH_HOSTS');

  const renderedSlots = slotsForMainCount(main.length);
  const ad = input.ads ? adHookFor(input.ads, audience, utmCampaign, renderedSlots) : (slot: AdSlot) => (input.adSlot ?? noAds)(slot, { audience, utmCampaign });
  const textAds = input.ads ? textAdsFor(input.ads, utmCampaign) : new Map<number, string>();

  const mode = input.mode ?? 'send';
  if (mode === 'send' && input.template && input.template.html.includes(UNSUBSCRIBE_TAG)) {
    throw new RenderError('template_unsubscribe_tag', 'the template contains {{unsubscribe_link}}, which Mailercloud does not expand; it adds its own unsubscribe footer');
  }
  const shell = input.template
    ? templateLinks(input.template.html, { utmCampaign, mode, assetBaseUrl: input.assetBaseUrl ?? null })
    : BUILTIN_TEMPLATE_HTML;
  const html = fillTemplate(shell, templateValues({ audience, subject, preheader, dateText, main, icymi, postal, logoUrl, homeHref, ad, defaultPic, assetBaseUrl: input.assetBaseUrl ?? null }));
  const text = renderText({ audience, dateText, main, icymi, postal, homeHref, ads: textAds });

  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const linkCount = (html.match(/<a\s[^>]*href=/gi) ?? []).length;
  const budgetBytes = htmlBytes + linkCount * TRACKING_BYTES_PER_LINK;
  const limit = cfg.maxHtmlKb * 1024;
  const overBudget = budgetBytes > limit;
  if (overBudget && mode === 'send') {
    throw new RenderError(
      'over_size_limit',
      `${budgetBytes} bytes (html ${htmlBytes} + ${linkCount} links × ${TRACKING_BYTES_PER_LINK}) is over DIGEST_MAX_HTML_KB=${cfg.maxHtmlKb}`,
    );
  }
  const sizeWarning = budgetBytes >= cfg.htmlWarnKb * 1024;

  return { subject, preheader, html, text, htmlBytes, budgetBytes, linkCount, sizeWarning, campaignName, renderedSlots, overBudget };
}

/** The ad's link with the digest UTM (`utm_content=ad-<id>-slot<N>`). */
function adHref(a: RenderAd, utmCampaign: string): string {
  return withUtm(a.linkUrl, { campaign: utmCampaign, content: adUtmContent(a.adId, a.slot) });
}

/**
 * Validates the ads against the slots drawn (fail closed) and returns the
 * slot hook. Every check here repeats one the picker made, on purpose: the
 * renderer refuses to draw a guard violation whoever produced the list.
 */
function adHookFor(ads: RenderAd[], audience: DigestAudience, utmCampaign: string, renderedSlots: number[]): (slot: AdSlot) => string {
  const bySlot = new Map<number, RenderAd>();
  const ids = new Set<string>();
  for (const a of ads) {
    if (forbiddenForAudience(a.kind, audience)) {
      throw new RenderError('ad_not_allowed', `slot ${a.slot}: a subscription ad can never go to Premium readers`);
    }
    if (!isAllowedDigestUrl(a.linkUrl)) {
      throw new RenderError('link_not_allowed', `ad in slot ${a.slot} links to ${hostOf(a.linkUrl)}, which is not on ALLOWED_PUSH_HOSTS`);
    }
    if (!isAllowedAdUrl(a.linkUrl)) throw new RenderError('link_not_allowed', `ad in slot ${a.slot} links over plain http; ad links must be https`);
    if (a.image && !/^https:\/\//.test(a.image.url)) throw new RenderError('link_not_allowed', `ad image in slot ${a.slot} is not served over https`);
    if (a.mobileImage && !/^https:\/\//.test(a.mobileImage.url)) throw new RenderError('link_not_allowed', `ad image in slot ${a.slot} is not served over https`);
    if (bySlot.has(a.slot)) throw new RenderError('ad_not_allowed', `two ads for slot ${a.slot}`);
    if (ids.has(a.adId)) throw new RenderError('ad_not_allowed', `the same ad is placed twice (slot ${a.slot})`);
    bySlot.set(a.slot, a);
    ids.add(a.adId);
  }
  const empty = renderedSlots.filter((s) => !bySlot.has(s));
  if (empty.length > 0) throw new RenderError('ad_slot_empty', `no ad for slot ${empty.join(', ')}`);
  return (slot: AdSlot) => {
    const a = bySlot.get(slot.slot);
    return a ? adRow(a, adHref(a, utmCampaign), slot.position === 'beforeFooter') : '';
  };
}

function textAdsFor(ads: RenderAd[], utmCampaign: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const a of ads) {
    const t = (x: string) => defuseMergeTags(clean(x));
    const lines = [`* ${t(a.headline)}`, a.body ? `  ${t(a.body)}` : null, `  ${t(a.ctaText)}: ${textUrl(adHref(a, utmCampaign))}`];
    out.set(a.slot, lines.filter((l): l is string => l !== null).join('\n'));
  }
  return out;
}

/** Width the desktop banner is drawn at (the 900 px email's 860 px inner width). */
export const AD_IMAGE_DISPLAY_WIDTH = 860;
/** Width the mobile square is drawn at on phones (centred). */
export const AD_MOBILE_DISPLAY_WIDTH = 300;

/**
 * One house ad. WITH a picture it is the banner only, like the old newsletter's: the whole image linked, its alt
 * text — no label, headline, body or button (owner, 29 Oct 2026). Since 30 Oct it is TWO blocks swapped with the
 * old newsletter's CSS pattern: the desktop banner (`ml-mobile-hidden`, 860 px wide, hidden on phones) and, when the
 * ad has one, the mobile square (`ml-desk-hidden` + `mso-hide:all`, 300 px wide and centred, shown on phones only —
 * Outlook never sees it). An ad with no mobile square renders the banner alone, so phones get the banner as before.
 * WITHOUT a picture: the "From Taxscan" label, live-text headline, body and a real CTA button.
 */
function adRow(a: RenderAd, href: string, last = false): string {
  // 20 px of white space above each row, no rule (as the old newsletter); the last white row before the footer also closes with 20 px.
  const pad = `padding:20px 20px ${last ? 20 : 0}px 20px;`;
  const h = esc(href);
  if (a.image) {
    // The banner is always the full content width, at the stored image's own aspect (a narrower image is scaled up).
    const w = AD_IMAGE_DISPLAY_WIDTH;
    const hgt = Math.max(1, Math.round((a.image.height * w) / a.image.width));
    const alt = esc(clean(a.altText));
    const imgBase = `border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;font-family:${FONT};font-size:16px;color:${C.text};`;
    const link = (inner: string) => `<a href="${h}" style="display:block;margin:0;text-decoration:none;">${inner}</a>`;
    const desktop =
      `<div${a.mobileImage ? ' class="ml-mobile-hidden"' : ''} data-ad-variant="desktop">` +
      link(`<img class="adapt-img" src="${esc(a.image.url)}" width="${w}" height="${hgt}" alt="${alt}" style="display:block;width:100%;max-width:${w}px;height:auto;${imgBase}">`) +
      `</div>`;
    let mobile = '';
    if (a.mobileImage) {
      const mw = AD_MOBILE_DISPLAY_WIDTH;
      const mh = Math.max(1, Math.round((a.mobileImage.height * mw) / a.mobileImage.width));
      // `adapt-img` = the full column on phones (the old newsletter's 335 px square); the 300 px cap applies only where
      // this block is ever shown without that rule. Outlook skips it (MSO conditional + mso-hide).
      mobile =
        `<!--[if !mso]><!--><div class="ml-desk-hidden" data-ad-variant="mobile" style="display:none;float:left;overflow:hidden;width:0;max-height:0;line-height:0;mso-hide:all;">` +
        link(`<img class="adapt-img" src="${esc(a.mobileImage.url)}" width="${mw}" height="${mh}" alt="${alt}" style="display:block;width:100%;max-width:${mw}px;height:auto;margin:0 auto;${imgBase}">`) +
        `</div><!--<![endif]-->`;
    }
    return (
      `<tr><td class="ts-card ts-pad" data-ad-slot="${a.slot}" data-ad-image="1" style="${WRAP}${pad}background-color:${C.card};">` +
      desktop +
      mobile +
      `</td></tr>`
    );
  }
  const body = a.body
    ? `<p style="${WRAP}margin:0 0 12px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${C.body};" class="ts-body">${esc(clean(a.body))}</p>`
    : '';
  return (
    `<tr><td class="ts-card ts-pad" data-ad-slot="${a.slot}" style="${WRAP}${pad}background-color:${C.card};">` +
    `<p style="${WRAP}margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};" class="ts-muted">From Taxscan</p>` +
    `<h3 style="${WRAP}margin:0 0 6px 0;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:${C.text};" class="ts-text">${esc(clean(a.headline))}</h3>` +
    body +
    button(h, clean(a.ctaText), Math.min(AD_IMAGE_DISPLAY_WIDTH, 60 + graphemes(clean(a.ctaText)).length * 10)) +
    `</td></tr>`
  );
}

/** "Plus N more: <headline>…", the headline trimmed so the whole line is ≤ PREHEADER_MAX. */
export function preheaderFor(moreCount: number, secondTitle: string): string {
  const head = `Plus ${moreCount} more: `;
  const room = PREHEADER_MAX - graphemes(head).length;
  const t = clean(secondTitle);
  // Always end with "…" (there is more inside); trim on a word boundary to fit.
  const body = graphemes(t).length + 1 <= room ? `${t}…` : trimWords(t, room);
  return `${head}${body}`;
}

/* ------------------------------------------------------------------ */
/* HTML template (built-in, v0)                                        */
/* ------------------------------------------------------------------ */

type HtmlParts = {
  audience: DigestAudience;
  subject: string;
  preheader: string;
  dateText: string;
  main: Prepared[];
  icymi: Prepared[];
  postal: string;
  logoUrl: string | null;
  homeHref: string;
  ad: (slot: AdSlot) => string;
  /** The 1600 x 840 default story picture (null: the brand block is drawn instead). */
  defaultPic: string | null;
  /** The digest asset host, where the social icons are served (none → no icons row). */
  assetBaseUrl: string | null;
};

/** Zero-width filler after the preheader so clients don't pull body text into the preview. */
const PREVIEW_FILLER = '&#847;&zwnj;&nbsp;'.repeat(40);

/** The content width of the email (the old newsletter's), and what is inside its 20 px side padding. */
export const EMAIL_WIDTH = 900;
export const EMAIL_INNER_WIDTH = 860;
/** A story row: picture 280 px, 20 px gap, text column 560 px (= 860). */
export const STORY_IMAGE_WIDTH = 280;
export const STORY_GAP = 20;
export const STORY_TEXT_WIDTH = EMAIL_INNER_WIDTH - STORY_IMAGE_WIDTH - STORY_GAP;
/**
 * The picture's box is 1.91:1 (the og:image standard, 1200×628). We store no picture size, so this is an
 * assumption; `object-fit:cover` crops a picture of another shape instead of stretching it.
 */
export const STORY_IMAGE_HEIGHT = Math.round(STORY_IMAGE_WIDTH / (1200 / 628));
/** The white logo inside the brand block (440 x 106 file, drawn at 2x density). */
const BRAND_LOGO_WIDTH = 160;
const BRAND_LOGO_HEIGHT = 39;
const BRAND_LOGO_PATH = '/email/taxscan-logo-white-440.png';

/**
 * One story, laid out like the old newsletter's: picture left (280 px, `adapt-img` = full width on phones), a 20 px
 * gap, the text column right (560 px), both top-aligned. Headline: Arial 16 px bold, line-height 24 px (exact in
 * Outlook), black, linked, no underline. Summary: 16/24 #333, 15 px below the headline. "Read More": 13 px below the
 * summary, a 96 x 38 yellow square with 15 px bold black text (a table-cell button, one link; full column, 43 px high on
 * phones). Alt text = the headline.
 *
 * The row holds its shape WITHOUT the <style> block: it is two `display:inline-block` divs (100 % wide, capped at 280
 * and 560 px) plus a 20 px spacer, so they sit side by side only when 860 px is there and stack on anything narrower
 * (a phone, an app that drops <style>) with no media query; Outlook desktop gets an MSO-only 280/20/560 table. A MAIN
 * story with no picture of its own shows the default picture, else the brand block (same 280 x 147 box), so every
 * row keeps this shape. An ICYMI story ("In case you missed it") is text only: the same 560 px text column, left-aligned
 * with the main text column on desktop (a 300 px spacer), full width on phones.
 */
function itemRow(it: Prepared, defaultPic: string | null, logoWhiteUrl: string | null): string {
  const href = esc(it.href);
  const summary = it.summary
    ? `<p style="margin:15px 0 0 0;font-family:${FONT};font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:${C.body};" class="ts-body">${esc(it.summary)}</p>`
    : '';
  const text =
    `<h2 style="margin:0;font-family:${FONT};font-size:16px;line-height:24px;mso-line-height-rule:exactly;font-weight:700;color:${C.ink};"><a href="${href}" class="ts-head" style="color:${C.ink};text-decoration:none;">${esc(it.title)}</a></h2>` +
    summary +
    `<div style="padding-top:13px;">${button(href, 'Read More', READ_MORE_WIDTH, BUTTON_HEIGHT)}</div>`;
  const icymi = it.section === 'ICYMI';
  const open = `<tr><td class="ts-card ts-pad" data-item="${it.rank}" data-section="${it.section}" style="${WRAP}padding:20px 20px 0 20px;background-color:${C.card};">`;
  const W = STORY_IMAGE_WIDTH;
  const T = STORY_TEXT_WIDTH;
  const col = (w: number, extra = '') => `display:inline-block;width:100%;max-width:${w}px;vertical-align:top;${extra}`;
  const msoOpen = (first: number) => `<!--[if mso]><table width="${EMAIL_INNER_WIDTH}" cellpadding="0" cellspacing="0"><tr><td width="${first}" valign="top"><![endif]-->`;
  const msoClose = `<!--[if mso]></td></tr></table><![endif]-->`;
  const textDiv = `<div class="ts-stcol ts-sttext" style="${col(T)}">${text}</div>`;
  if (icymi) {
    // 300 px spacer (= picture + gap) so the text lines up with the main column's; empty, so stacked it takes no height.
    return (
      `${open}${msoOpen(W + STORY_GAP).replace('<![endif]-->', '&nbsp;<![endif]-->')}<!--[if mso]></td><td width="${T}" valign="top"><![endif]-->` +
      `<!--[if !mso]><!--><div class="ts-stgap" style="display:inline-block;width:${W + STORY_GAP}px;height:0;vertical-align:top;"></div><!--<![endif]-->${textDiv}${msoClose}</td></tr>`
    );
  }
  const pic = it.imageUrl ?? defaultPic;
  const picHtml = pic
    ? `<a href="${href}" style="display:block;text-decoration:none;"><img class="ts-pic adapt-img" src="${esc(pic)}" width="${W}" height="${STORY_IMAGE_HEIGHT}" alt="${esc(it.title)}" style="display:block;width:${W}px;max-width:100%;height:${STORY_IMAGE_HEIGHT}px;object-fit:cover;border:0;"></a>`
    : brandBlock(href, it.title, logoWhiteUrl);
  return (
    `${open}${msoOpen(W)}<div class="ts-stcol ts-stpic" style="${col(W)}">${picHtml}</div>` +
    `<!--[if mso]></td><td width="${STORY_GAP}"></td><td width="${T}" valign="top"><![endif]-->` +
    `<!--[if !mso]><!--><div class="ts-stgap" style="display:inline-block;width:${STORY_GAP}px;height:0;vertical-align:top;"></div><!--<![endif]-->` +
    `${textDiv}${msoClose}</td></tr>`
  );
}

/**
 * The brand block a main story shows until a default picture is uploaded (decision A): the same 280 x 147 box as a
 * picture, #3b3543 with the white Taxscan logo centred. A table, so the colour and the 147 px hold in Outlook too.
 */
function brandBlock(href: string, title: string, logoUrl: string | null): string {
  const inner = logoUrl
    ? `<img src="${esc(logoUrl)}" width="${BRAND_LOGO_WIDTH}" height="${BRAND_LOGO_HEIGHT}" alt="${esc(title)}" style="display:block;margin:0 auto;width:${BRAND_LOGO_WIDTH}px;height:${BRAND_LOGO_HEIGHT}px;border:0;outline:none;text-decoration:none;color:${C.brandText};font-family:${FONT};font-size:14px;">`
    : `<span style="font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;letter-spacing:0.08em;color:${C.brandText};">TAXSCAN</span>`;
  return (
    `<table role="presentation" class="ts-brand" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.brand}" style="width:100%;max-width:${STORY_IMAGE_WIDTH}px;background-color:${C.brand};${solid(C.brand)}">` +
    `<tr><td align="center" valign="middle" height="${STORY_IMAGE_HEIGHT}" style="height:${STORY_IMAGE_HEIGHT}px;padding:0;text-align:center;"><a href="${href}" style="display:block;text-decoration:none;color:${C.brandText};">${inner}</a></td></tr></table>`
  );
}

function sectionHeading(text: string, id: string): string {
  return (
    `<tr><td class="ts-card ts-pad" data-heading="${id}" style="${WRAP}padding:24px 20px 4px 20px;background-color:${C.card};border-top:4px solid ${C.brand};">` +
    `<h2 style="${WRAP}margin:0;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:${C.text};" class="ts-text">${esc(text)}</h2>` +
    `</td></tr>`
  );
}

/* ------------------------------------------------------------------ */
/* Templates (task 10)                                                 */
/* ------------------------------------------------------------------ */

/**
 * The placeholders a template may use. The renderer fills each one; a template
 * supplies only the layout around them. Row placeholders expand to table rows
 * (`<tr>…</tr>`), so they must sit directly inside a `<table>`.
 *
 * REQUIRED (exactly once): preheader, stories, icymi, ad_slot_3, footer. The
 * footer (reason line, unsubscribe tag, postal address) is ALWAYS the
 * renderer's own markup — a template can place it but never change or drop it.
 */
export const TEMPLATE_PLACEHOLDERS = {
  preheader: 'Hidden inbox preview text (“Plus N more: …”). Put it first in <body>.',
  stories: 'The stories, with ad slots 1 and 2 after stories 4 and 9 (table rows).',
  icymi: '“In case you missed it” rows, when there are any (table rows).',
  ad_slot_3: 'The ad above the footer (a table row).',
  footer: 'Reason line, unsubscribe link and postal address (a table row; cannot be removed).',
  social: 'Optional: a centred row of five small social icons (Facebook, X, Instagram, LinkedIn, the website). Put it above the footer.',
  subject: 'The subject line (the lead headline), escaped — e.g. inside <title>.',
  date: 'The digest date, “22 October 2026”.',
  home_url: 'taxscan.in with the digest UTM, for a header link.',
  logo: 'The Taxscan wordmark (or logo image).',
  premium_badge: 'A “Premium” badge in the Premium digest, nothing in the Free one.',
  audience: '“Free” or “Premium”.',
} as const;
export type TemplatePlaceholder = keyof typeof TEMPLATE_PLACEHOLDERS;
export const REQUIRED_PLACEHOLDERS: readonly TemplatePlaceholder[] = ['preheader', 'stories', 'icymi', 'ad_slot_3', 'footer'];
/** Placeholders that expand to table rows. */
export const ROW_PLACEHOLDERS: readonly TemplatePlaceholder[] = ['stories', 'icymi', 'ad_slot_3', 'social', 'footer'];
/** `{{name}}` in a template (the provider's own merge tags use the same braces). */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * The built-in template: the v0 layout (task 5) as a template. Used whenever
 * no template is ACTIVE or scheduled for the audience (`resolveTemplate`), and
 * the seed an admin starts a new template from.
 */
export const BUILTIN_TEMPLATE_HTML =
  `<!DOCTYPE html>\n` +
  `<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">\n` +
  `<head>\n` +
  `<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<meta http-equiv="X-UA-Compatible" content="IE=edge">\n` +
  `<meta name="x-apple-disable-message-reformatting">\n` +
  `<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">\n` +
  `<meta name="color-scheme" content="light">\n` +
  `<meta name="supported-color-schemes" content="light">\n` +
  `<title>{{subject}}</title>\n` +
  `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->\n` +
  // Enhancement only: the layout works with this block stripped (Gmail app, Outlook).
  `<style>\n` +
  // Light only: the email has no dark palette, so a dark-mode app has nothing of ours to switch to. The header and the
  // yellow buttons also carry a background-image (see `solid`) — that is what protects them in the Gmail apps, which give
  // no hook. `[data-ogsb]` / `[data-ogsc]` are Outlook.com / new Outlook's own forced-colour attributes (NOT Gmail's):
  // they put the brand colours back where Outlook recolours them anyway.
  `:root{color-scheme:light;supported-color-schemes:light}img{outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;font-family:${FONT};font-size:14px;color:${C.text}}\n` +
  `[data-ogsb] .ts-hdr{background-color:${C.brand}!important}[data-ogsb] .ts-btn{background-color:${C.button}!important}[data-ogsc] .ts-btn{color:${C.buttonText}!important}[data-ogsc] .ts-hdr-text{color:${C.brandText}!important}\n` +
  // The old newsletter's own pattern: a desktop-only block (.ml-mobile-hidden) and a phone-only block (.ml-desk-hidden, hidden
  // by its inline style and shown here). The story row already stacks by itself (inline-block columns); on phones this
  // only tightens it: white edge to edge with 20 px text padding, a full-column Read More (43 px), full-width pictures.
  `@media only screen and (max-width:600px){` +
  `.ts-outer{padding:0!important}` +
  `.ts-pad{padding-left:20px!important;padding-right:20px!important}` +
  `.ts-hdr{padding:14px 10px 12px!important}.ts-logo{width:160px!important}` +
  `.ml-mobile-hidden{display:none!important}` +
  `.ml-desk-hidden{display:block!important;float:none!important;overflow:visible!important;width:auto!important;max-height:none!important;line-height:normal!important;text-align:center!important}` +
  `.ts-stcol{display:block!important;width:100%!important;max-width:100%!important}.ts-stgap{display:none!important}.ts-brand{max-width:100%!important}` +
  `.ts-pic,.adapt-img{width:100%!important;max-width:100%!important;height:auto!important}` +
  `.ts-sttext{padding-top:12px!important}` +
  `.ts-btnt{width:100%!important}.ts-btn{display:block!important;width:auto!important;height:43px!important;line-height:43px!important}` +
  `}\n` +
  `</style>\n` +
  `</head>\n` +
  `<body class="ts-bg" style="margin:0;padding:0;width:100%;background-color:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">\n` +
  `{{preheader}}\n` +
  `<table role="presentation" class="ts-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${C.page};"><tr><td class="ts-outer" align="center" style="padding:16px 8px;">\n` +
  `<!--[if mso]><table role="presentation" width="${EMAIL_WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td width="${EMAIL_WIDTH}"><![endif]-->\n` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_WIDTH}px;margin:0 auto;border-collapse:collapse;">\n` +
  `<tr><td class="ts-pad ts-hdr" align="center" style="${WRAP}padding:22px 20px 18px 20px;background-color:${C.brand};${solid(C.brand)}text-align:center;" bgcolor="${C.brand}">` +
  `<a href="{{home_url}}" style="display:inline-block;min-height:44px;text-decoration:none;color:${C.brandText};">{{logo}}</a>` +
  `<p class="ts-hdr-text" style="${WRAP}margin:10px 0 0 0;font-family:${FONT};font-size:15px;line-height:22px;color:${C.brandText};">Daily Digest &middot; {{date}}{{premium_badge}}</p>` +
  `</td></tr>\n` +
  `{{stories}}\n` +
  `{{icymi}}\n` +
  `{{ad_slot_3}}\n` +
  `{{social}}\n` +
  `{{footer}}\n` +
  `</table>\n` +
  `<!--[if mso]></td></tr></table><![endif]-->\n` +
  `</td></tr></table>\n` +
  `</body>\n` +
  `</html>\n`;

/**
 * Fills a template in ONE pass: a value is never re-scanned, so a headline that
 * happens to contain "{{footer}}" stays text. Unknown names are left as they
 * are (the validator refuses them before a template can be activated; the
 * provider's own merge tags, e.g. the unsubscribe tag inside the footer, pass).
 */
export function fillTemplate(html: string, values: Partial<Record<string, string>>): string {
  return html.replace(PLACEHOLDER_RE, (m, name: string) => {
    const v = values[name];
    return v === undefined ? m : v;
  });
}

/** Every value the renderer puts into a template. */
function templateValues(p: HtmlParts): Record<TemplatePlaceholder, string> {
  const premium = p.audience === 'PREMIUM';
  const logo = p.logoUrl
    ? `<img class="ts-logo" src="${esc(p.logoUrl)}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Taxscan" style="display:block;margin:0 auto;width:${LOGO_WIDTH}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;color:${C.brandText};font-family:${FONT};font-size:28px;line-height:${LOGO_HEIGHT}px;font-weight:700;letter-spacing:0.08em;">`
    : `<span style="font-family:${FONT};font-size:28px;line-height:36px;font-weight:700;letter-spacing:0.08em;color:${C.brandText};">TAXSCAN</span>`;
  const badge = premium
    ? ` <span style="display:inline-block;margin-left:8px;padding:0 10px;border:1px solid ${C.brandText};border-radius:12px;font-family:${FONT};font-size:14px;line-height:20px;font-weight:700;color:${C.brandText};vertical-align:middle;">Premium</span>`
    : '';

  // The brand block's logo lives on the asset host; without one a text wordmark is drawn (unit tests).
  const logoWhite = p.assetBaseUrl ? `${p.assetBaseUrl}${BRAND_LOGO_PATH}` : null;
  const stories: string[] = [];
  p.main.forEach((it, i) => {
    stories.push(itemRow(it, p.defaultPic, logoWhite));
    for (const s of AD_SLOTS) if (s.position === 'afterItem' && s.afterItem === i + 1) stories.push(p.ad(s)); // AD SLOT HOOK (task 9)
  });
  const icymi: string[] = [];
  if (p.icymi.length > 0) {
    icymi.push(sectionHeading('In case you missed it', 'icymi'));
    for (const it of p.icymi) icymi.push(itemRow(it, null, null));
  }
  const beforeFooter = AD_SLOTS.filter((s) => s.position === 'beforeFooter').map((s) => p.ad(s)); // AD SLOT HOOK (task 9)

  // Five fixed links, centred, small, each icon with alt text; no UTM. Needs the asset host for the icons.
  const social = p.assetBaseUrl
    ? `<tr><td class="ts-pad" data-social="1" align="center" style="${WRAP}padding:20px 20px 4px 20px;background-color:${C.page};text-align:center;">` +
      SOCIAL_LINKS.map(
        (l) =>
          `<a href="${esc(l.href)}" style="display:inline-block;margin:0 5px;text-decoration:none;"><img src="${esc(`${p.assetBaseUrl}/email/social-${l.key}.png`)}" width="${SOCIAL_ICON_SIZE}" height="${SOCIAL_ICON_SIZE}" alt="${esc(l.label)}" style="display:block;width:${SOCIAL_ICON_SIZE}px;height:${SOCIAL_ICON_SIZE}px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:12px;color:${C.muted};"></a>`,
      ).join('') +
      `</td></tr>`
    : '';

  const reason = premium ? PREMIUM_REASON : FREE_REASON;
  const footer =
    `<tr><td class="ts-pad" data-footer="1" style="${WRAP}padding:24px 20px 32px 20px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.muted};" align="left">` +
    `<p style="${WRAP}margin:0 0 12px 0;font-size:14px;line-height:21px;color:${C.muted};" class="ts-muted">${esc(reason)} Questions or feedback? Write to <a href="${CONTACT_MAILTO}" class="ts-link" style="color:${C.link};text-decoration:underline;padding:9px 0;">${CONTACT_EMAIL}</a></p>` +
    `<p style="${WRAP}margin:0;font-size:14px;line-height:21px;color:${C.muted};" class="ts-muted">${esc(p.postal)}</p>` +
    `</td></tr>`;

  return {
    preheader: `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(p.preheader)}${PREVIEW_FILLER}</div>`,
    stories: stories.filter(Boolean).join('\n'),
    icymi: icymi.join('\n'),
    ad_slot_3: beforeFooter.filter(Boolean).join('\n'),
    footer,
    social,
    subject: esc(p.subject),
    date: esc(p.dateText),
    home_url: esc(p.homeHref),
    logo,
    premium_badge: badge,
    audience: premium ? 'Premium' : 'Free',
  };
}

/** An image a template may show: https, on the allowlist or the digest asset host. */
export function isAllowedTemplateImage(url: string, assetBaseUrl: string | null): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return false;
    if (assetBaseUrl && u.host === new URL(assetBaseUrl).host) return true;
    // The story pictures: exactly documents.taxscan.in, an original .jpg/.jpeg/.png (never a general allowance).
    if (isAllowedArticleImage(url)) return true;
  } catch {
    return false;
  }
  return isAllowedDigestUrl(url);
}

/** Decodes an attribute value the way a browser would for the characters that matter to a URL check. */
export function decodeAttr(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_m, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/&period;/gi, '.')
    .replace(/&commat;/gi, '@')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** One attribute of a start tag, with the offsets (in the whole html) of the full `name=value` text. */
export type ScannedAttr = { name: string; value: string; raw: string; start: number; end: number };
export type ScannedTag = { name: string; start: number; end: number; attrs: ScannedAttr[] };

/** Elements whose content is text, never tags (an HTML tokenizer's RAWTEXT/RCDATA states). */
const RAW_TEXT = new Set(['style', 'script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

/**
 * Every start tag in `html` with its attributes, read the way a browser's
 * tokenizer reads them (QA of task 10): attributes may be unquoted, separated
 * by `/` or follow a quoted value directly (`<a/href=x>`, `<a href=x>`,
 * `<img src="a"/onerror=…>`); the content of <style>/<title> is not tags, but
 * comment content IS scanned (Outlook conditional comments are rendered).
 * The regex scans this replaces only saw `\shref="…"`, so an unquoted
 * or slash-separated link skipped both the checklist and the send-time refusal.
 */
export function scanStartTags(html: string): ScannedTag[] {
  const out: ScannedTag[] = [];
  const n = html.length;
  let i = 0;
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      // Comment CONTENT is scanned too: Outlook renders `<!--[if mso]> … <![endif]-->`
      // (VML buttons carry href), so a link in there must be checked like any other.
      i = lt + 4;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?' || html[lt + 1] === '/') {
      // Doctype / bogus comment / end tag: skip to the next '>'.
      const gt = html.indexOf('>', lt + 1);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(html[lt + 1] ?? '')) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    const attrs: ScannedAttr[] = [];
    while (j < n && html[j] !== '>') {
      if (isSpace(html[j]) || html[j] === '/') {
        j++;
        continue;
      }
      const aStart = j;
      // The attribute name: up to whitespace, '/', '>' or '=' (an '=' first in the name is part of it).
      j++;
      while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
      const aName = html.slice(aStart, j).toLowerCase();
      let k = j;
      while (k < n && isSpace(html[k])) k++;
      if (html[k] !== '=') {
        attrs.push({ name: aName, value: '', raw: '', start: aStart, end: j });
        continue;
      }
      k++;
      while (k < n && isSpace(html[k])) k++;
      let raw: string;
      if (html[k] === '"' || html[k] === "'") {
        const q = html[k];
        const close = html.indexOf(q, k + 1);
        const e = close < 0 ? n : close;
        raw = html.slice(k + 1, e);
        j = Math.min(n, e + 1);
      } else {
        let e = k;
        while (e < n && !isSpace(html[e]) && html[e] !== '>') e++;
        raw = html.slice(k, e);
        j = e;
      }
      attrs.push({ name: aName, value: decodeAttr(raw), raw, start: aStart, end: j });
    }
    const end = Math.min(n, j + 1);
    out.push({ name, start: lt, end, attrs });
    i = end;
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, end);
      i = close < 0 ? n : close;
    }
  }
  return out;
}

/** Attributes that load or link a URL in an email (the template checks and the send-time refusal read these). */
export const LINK_ATTRS = new Set(['href']);
export const IMAGE_ATTRS = new Set(['src', 'background', 'poster', 'lowsrc', 'dynsrc']);

/** The URLs in a `srcset` value. */
export const srcsetUrls = (v: string): string[] =>
  v
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .filter((u) => u !== '');

/**
 * A custom template's OWN links (not the renderer's): every allowlisted
 * `href` gets the digest UTM (`utm_content=template`); in 'send' mode an
 * off-allowlist link or a non-https / off-host image is a refusal (fail
 * closed), in 'check' mode it is left for the validator to report.
 * Placeholders and the provider's unsubscribe tag are left alone.
 */
function templateLinks(html: string, o: { utmCampaign: string; mode: 'send' | 'check'; assetBaseUrl: string | null }): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const isPlaceholder = (v: string) => v === UNSUBSCRIBE_TAG || /^\{\{\s*[A-Za-z0-9_.]+\s*\}\}$/.test(v);
  const refuseImage = (value: string) => {
    if (o.mode === 'check') return;
    throw new RenderError('link_not_allowed', `a template image is on ${hostOf(value)}; template images must be https on ALLOWED_PUSH_HOSTS or the digest asset host`);
  };
  for (const tag of scanStartTags(html)) {
    for (const a of tag.attrs) {
      const value = a.value.trim();
      if (IMAGE_ATTRS.has(a.name) || a.name === 'srcset') {
        const urls = a.name === 'srcset' ? srcsetUrls(value) : [value];
        for (const u of urls) if (!isPlaceholder(u) && !isAllowedTemplateImage(u, o.assetBaseUrl)) refuseImage(u);
        continue;
      }
      if (!LINK_ATTRS.has(a.name) || isPlaceholder(value)) continue;
      if (isSocialUrl(value) || isContactMailto(value)) continue; // a fixed footer link: allowed exactly, and no UTM
      if (isAllowedDigestUrl(value)) {
        // Rewritten in the canonical quoted form whatever form it was written in.
        edits.push({ start: a.start, end: a.end, text: `href="${esc(withUtm(value, { campaign: o.utmCampaign, content: 'template' }))}"` });
        continue;
      }
      if (o.mode === 'check') continue;
      throw new RenderError('link_not_allowed', `a template link goes to ${hostOf(value)}, which is not on ALLOWED_PUSH_HOSTS`);
    }
  }
  let out = html;
  for (const e of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/* ------------------------------------------------------------------ */
/* Plain-text part                                                     */
/* ------------------------------------------------------------------ */

function renderText(p: {
  audience: DigestAudience;
  dateText: string;
  main: Prepared[];
  icymi: Prepared[];
  postal: string;
  homeHref: string;
  ads: Map<number, string>;
}): string {
  const premium = p.audience === 'PREMIUM';
  const adAfter = (n: number): string[] => {
    const out: string[] = [];
    for (const s of AD_SLOTS) if (s.position === 'afterItem' && s.afterItem === n && p.ads.has(s.slot)) out.push(p.ads.get(s.slot) as string, '');
    return out;
  };
  const t = defuseMergeTags;
  const block = (it: Prepared, n: number) =>
    [`${n}. ${t(it.title)}`, it.label ? `   ${t(it.label)}` : null, it.summary ? `   ${t(it.summary)}` : null, `   ${textUrl(it.href)}`]
      .filter((l): l is string => l !== null)
      .join('\n');
  const out: string[] = [`TAXSCAN DAILY DIGEST${premium ? ' (PREMIUM)' : ''}`, p.dateText, ''];
  p.main.forEach((it, i) => out.push(block(it, i + 1), '', ...adAfter(i + 1)));
  if (p.icymi.length > 0) {
    out.push('IN CASE YOU MISSED IT', '');
    p.icymi.forEach((it, i) => out.push(block(it, i + 1), ''));
  }
  for (const s of AD_SLOTS) if (s.position === 'beforeFooter' && p.ads.has(s.slot)) out.push(p.ads.get(s.slot) as string, '');
  out.push(
    '----',
    `${premium ? PREMIUM_REASON : FREE_REASON} ${CONTACT_LINE}`,
    t(p.postal),
    textUrl(p.homeHref),
    '',
  );
  return out.join('\n');
}
