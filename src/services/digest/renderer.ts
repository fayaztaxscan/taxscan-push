import type { DigestAudience } from '@prisma/client';
import type { DigestEnv } from '../../lib/env';
import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import type { FrozenItem } from './builder';
import { istDateOf } from './retryPolicy';
import { adUtmContent, forbiddenForAudience } from './adRules';

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
 *  - footer    = postal address (empty → refuse), the unsubscribe tag, no
 *                "all types of emails" wording, Premium/Free reason line (#5, #6)
 *  - links     = every href passes isAllowedPushUrl() (else refuse) and
 *                carries the digest UTM (#16)
 *  - images    = every <img> has non-empty alt (#8); v0 is text-only unless a
 *                logo URL is passed
 *  - size      = HTML bytes + tracking-rewrite overhead per link: warn at
 *                DIGEST_HTML_WARN_KB, refuse above DIGEST_MAX_HTML_KB (#2)
 *  - layout    = fluid single column, 600 px max, no media queries required,
 *                MSO fixed wrapper, ≥ 16 px body, ≥ 44 px taps, dark-mode
 *                colour-scheme meta, no web fonts / JS / external CSS (#18)
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
};

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

// UNVERIFIED: Mailercloud merge tag — confirm in account (design §12 open question 3).
// Used as the href of the footer unsubscribe link and printed in the plain-text part.
// It is the ONLY href exempt from the allowlist check, and only as this exact string.
export const UNSUBSCRIBE_TAG = '{{unsubscribe_link}}';

export const SUBJECT_MAX = 90;
export const PREHEADER_MAX = 110;
/** Summary shown under a headline: about two lines on a phone. */
export const SUMMARY_MAX = 180;
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
  image: { url: string; width: number; height: number } | null;
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
  body: '#333333',
  muted: '#5f6368',
  link: '#1376c8',
  brand: '#3b3543', // the header bar (as in today's digest); fixed in dark mode too
  brandText: '#ffffff',
  button: '#FEE620', // square yellow CTA, bold dark text (today's digest)
  buttonText: '#111111',
};

/** The Taxscan logo (white on transparent, 440×106 for 2× at 220 px), served from the asset host. */
export const LOGO_PATH = '/email/taxscan-logo-white-440.png';
export const LOGO_WIDTH = 220;
export const LOGO_HEIGHT = 53;

/**
 * A "bulletproof" button: square corners, yellow, bold dark text; a VML
 * rectangle for Outlook desktop (which ignores padding on links), the plain
 * link everywhere else. `href` is already escaped.
 */
function button(href: string, label: string, widthPx: number): string {
  const text = esc(label);
  return (
    `<!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:${widthPx}px;" stroke="f" fillcolor="${C.button}"><w:anchorlock/><center style="color:${C.buttonText};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${text}</center></v:rect><![endif]-->` +
    `<!--[if !mso]><!--><a href="${href}" class="ts-btn" style="display:inline-block;min-height:44px;line-height:44px;padding:0 22px;background-color:${C.button};border-radius:0;font-family:${FONT};font-size:15px;font-weight:700;color:${C.buttonText};text-decoration:none;mso-hide:all;">${text}</a><!--<![endif]-->`
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
  | 'ad_slot_empty';

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

/** HTML-escapes text for element content AND double-quoted attributes. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
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

  const dateText = formatDigestDate(runDate);
  const subject = trimWords(main[0].title, SUBJECT_MAX);
  const second = items[1];
  const preheader = second ? preheaderFor(items.length - 1, second.title) : `Taxscan Daily Digest · ${dateText}`;
  const campaignName = digestCampaignName(runDate, audience);
  const homeHref = withUtm('https://www.taxscan.in/', { campaign: utmCampaign, content: 'header' });
  if (!isAllowedDigestUrl(homeHref)) throw new RenderError('link_not_allowed', 'the header link host is not on ALLOWED_PUSH_HOSTS');

  const renderedSlots = slotsForMainCount(main.length);
  const ad = input.ads ? adHookFor(input.ads, audience, utmCampaign, renderedSlots) : (slot: AdSlot) => (input.adSlot ?? noAds)(slot, { audience, utmCampaign });
  const textAds = input.ads ? textAdsFor(input.ads, utmCampaign) : new Map<number, string>();

  const mode = input.mode ?? 'send';
  const shell = input.template
    ? templateLinks(input.template.html, { utmCampaign, mode, assetBaseUrl: input.assetBaseUrl ?? null })
    : BUILTIN_TEMPLATE_HTML;
  const html = fillTemplate(shell, templateValues({ audience, subject, preheader, dateText, main, icymi, postal, logoUrl, homeHref, ad }));
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
    if (bySlot.has(a.slot)) throw new RenderError('ad_not_allowed', `two ads for slot ${a.slot}`);
    if (ids.has(a.adId)) throw new RenderError('ad_not_allowed', `the same ad is placed twice (slot ${a.slot})`);
    bySlot.set(a.slot, a);
    ids.add(a.adId);
  }
  const empty = renderedSlots.filter((s) => !bySlot.has(s));
  if (empty.length > 0) throw new RenderError('ad_slot_empty', `no ad for slot ${empty.join(', ')}`);
  return (slot: AdSlot) => {
    const a = bySlot.get(slot.slot);
    return a ? adRow(a, adHref(a, utmCampaign)) : '';
  };
}

function textAdsFor(ads: RenderAd[], utmCampaign: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const a of ads) {
    const lines = [`* ${clean(a.headline)}`, a.body ? `  ${clean(a.body)}` : null, `  ${clean(a.ctaText)}: ${adHref(a, utmCampaign)}`];
    out.set(a.slot, lines.filter((l): l is string => l !== null).join('\n'));
  }
  return out;
}

/** Width the creative is drawn at inside the 600 px column (24 px padding each side). */
export const AD_IMAGE_DISPLAY_WIDTH = 552;

/** One house ad: optional image (linked, alt text), live-text headline, body, a real CTA button. */
function adRow(a: RenderAd, href: string): string {
  const h = esc(href);
  let img = '';
  if (a.image) {
    const w = Math.min(a.image.width, AD_IMAGE_DISPLAY_WIDTH);
    const hgt = Math.max(1, Math.round((a.image.height * w) / a.image.width));
    img =
      `<a href="${h}" style="display:block;margin:0 0 12px 0;text-decoration:none;">` +
      `<img src="${esc(a.image.url)}" width="${w}" height="${hgt}" alt="${esc(clean(a.altText))}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:16px;color:${C.text};">` +
      `</a>`;
  }
  const body = a.body
    ? `<p style="${WRAP}margin:0 0 12px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${C.body};" class="ts-body">${esc(clean(a.body))}</p>`
    : '';
  return (
    `<tr><td class="ts-card ts-pad" data-ad-slot="${a.slot}" style="${WRAP}padding:20px 24px;background-color:${C.card};border-top:1px solid ${C.rule};">` +
    `<p style="${WRAP}margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};" class="ts-muted">From Taxscan</p>` +
    img +
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
};

/** Zero-width filler after the preheader so clients don't pull body text into the preview. */
const PREVIEW_FILLER = '&#847;&zwnj;&nbsp;'.repeat(40);

function itemRow(it: Prepared): string {
  const label = it.label
    ? `<p style="${WRAP}margin:0 0 6px 0;font-family:${FONT};font-size:14px;line-height:20px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:${C.brand};" class="ts-label">${esc(it.label)}</p>`
    : '';
  const summary = it.summary
    ? `<p style="${WRAP}margin:0 0 4px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${C.body};" class="ts-body">${esc(it.summary)}</p>`
    : '';
  const href = esc(it.href);
  return (
    `<tr><td class="ts-card ts-pad" data-item="${it.rank}" data-section="${it.section}" style="${WRAP}padding:20px 24px;background-color:${C.card};border-top:1px solid ${C.rule};">` +
    label +
    `<h2 style="${WRAP}margin:0 0 6px 0;font-family:${FONT};font-size:20px;line-height:26px;font-weight:700;color:${C.text};"><a href="${href}" class="ts-head" style="${WRAP}display:block;padding:9px 0;color:${C.text};text-decoration:none;">${esc(it.title)}</a></h2>` +
    summary +
    `<div style="margin:8px 0 0 0;">${button(href, 'Read more', 140)}</div>` +
    `</td></tr>`
  );
}

function sectionHeading(text: string, id: string): string {
  return (
    `<tr><td class="ts-card ts-pad" data-heading="${id}" style="${WRAP}padding:24px 24px 4px 24px;background-color:${C.card};border-top:4px solid ${C.brand};">` +
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
export const ROW_PLACEHOLDERS: readonly TemplatePlaceholder[] = ['stories', 'icymi', 'ad_slot_3', 'footer'];
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
  `<meta name="color-scheme" content="light dark">\n` +
  `<meta name="supported-color-schemes" content="light dark">\n` +
  `<title>{{subject}}</title>\n` +
  `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->\n` +
  // Enhancement only: the layout works with this block stripped (Gmail app, Outlook).
  `<style>\n` +
  `:root{color-scheme:light dark;supported-color-schemes:light dark}\n` +
  `@media (prefers-color-scheme:dark){.ts-bg{background-color:#111214!important}.ts-card{background-color:#1c1d20!important;border-color:#2c2e33!important}` +
  `.ts-head,.ts-text{color:#eceef1!important}.ts-body{color:#c9ccd1!important}.ts-muted{color:#a9adb3!important}.ts-link{color:#8ab4f8!important}.ts-label{color:#cdbfe0!important}` +
  // The header bar and the yellow buttons keep their colours in dark mode (white logo on #3b3543 stays legible).
  `.ts-hdr{background-color:${C.brand}!important}.ts-btn{background-color:${C.button}!important;color:${C.buttonText}!important}}\n` +
  `@media only screen and (max-width:620px){.ts-pad{padding-left:16px!important;padding-right:16px!important}}\n` +
  `</style>\n` +
  `</head>\n` +
  `<body class="ts-bg" style="margin:0;padding:0;width:100%;background-color:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">\n` +
  `{{preheader}}\n` +
  `<table role="presentation" class="ts-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${C.page};"><tr><td align="center" style="padding:16px 8px;">\n` +
  `<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td width="600"><![endif]-->\n` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;border-collapse:collapse;">\n` +
  `<tr><td class="ts-pad ts-hdr" align="center" style="${WRAP}padding:22px 24px 18px 24px;background-color:${C.brand};text-align:center;" bgcolor="${C.brand}">` +
  `<a href="{{home_url}}" style="display:inline-block;min-height:44px;text-decoration:none;color:${C.brandText};">{{logo}}</a>` +
  `<p style="${WRAP}margin:10px 0 0 0;font-family:${FONT};font-size:15px;line-height:22px;color:${C.brandText};">Daily Digest &middot; {{date}}{{premium_badge}}</p>` +
  `</td></tr>\n` +
  `{{stories}}\n` +
  `{{icymi}}\n` +
  `{{ad_slot_3}}\n` +
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
    ? `<img src="${esc(p.logoUrl)}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Taxscan" style="display:block;margin:0 auto;width:${LOGO_WIDTH}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;color:${C.brandText};font-family:${FONT};font-size:28px;line-height:${LOGO_HEIGHT}px;font-weight:700;letter-spacing:0.08em;">`
    : `<span style="font-family:${FONT};font-size:28px;line-height:36px;font-weight:700;letter-spacing:0.08em;color:${C.brandText};">TAXSCAN</span>`;
  const badge = premium
    ? ` <span style="display:inline-block;margin-left:8px;padding:0 10px;border:1px solid ${C.brandText};border-radius:12px;font-family:${FONT};font-size:14px;line-height:20px;font-weight:700;color:${C.brandText};vertical-align:middle;">Premium</span>`
    : '';

  const stories: string[] = [];
  p.main.forEach((it, i) => {
    stories.push(itemRow(it));
    for (const s of AD_SLOTS) if (s.position === 'afterItem' && s.afterItem === i + 1) stories.push(p.ad(s)); // AD SLOT HOOK (task 9)
  });
  const icymi: string[] = [];
  if (p.icymi.length > 0) {
    icymi.push(sectionHeading('In case you missed it', 'icymi'));
    for (const it of p.icymi) icymi.push(itemRow(it));
  }
  const beforeFooter = AD_SLOTS.filter((s) => s.position === 'beforeFooter').map((s) => p.ad(s)); // AD SLOT HOOK (task 9)

  const reason = premium ? PREMIUM_REASON : FREE_REASON;
  const footer =
    `<tr><td class="ts-pad" data-footer="1" style="${WRAP}padding:24px 24px 32px 24px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.muted};" align="left">` +
    `<p style="${WRAP}margin:0 0 12px 0;font-size:14px;line-height:21px;color:${C.muted};" class="ts-muted">${esc(reason)} Questions or feedback? Just reply to this email.</p>` +
    `<p style="margin:0 0 12px 0;"><a href="${UNSUBSCRIBE_TAG}" class="ts-link" style="display:inline-block;min-height:44px;line-height:44px;font-size:16px;font-weight:700;color:${C.link};text-decoration:underline;">Unsubscribe from this digest</a></p>` +
    `<p style="${WRAP}margin:0;font-size:14px;line-height:21px;color:${C.muted};" class="ts-muted">Taxscan &middot; ${esc(p.postal)}</p>` +
    `</td></tr>`;

  return {
    preheader: `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(p.preheader)}${PREVIEW_FILLER}</div>`,
    stories: stories.filter(Boolean).join('\n'),
    icymi: icymi.join('\n'),
    ad_slot_3: beforeFooter.filter(Boolean).join('\n'),
    footer,
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
  } catch {
    return false;
  }
  return isAllowedDigestUrl(url);
}

const decodeAttr = (v: string) => v.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");

/**
 * A custom template's OWN links (not the renderer's): every allowlisted
 * `href` gets the digest UTM (`utm_content=template`); in 'send' mode an
 * off-allowlist link or a non-https / off-host image is a refusal (fail
 * closed), in 'check' mode it is left for the validator to report.
 * Placeholders and the provider's unsubscribe tag are left alone.
 */
function templateLinks(html: string, o: { utmCampaign: string; mode: 'send' | 'check'; assetBaseUrl: string | null }): string {
  return html.replace(/(\s)(href|src)\s*=\s*(["'])([\s\S]*?)\3/gi, (m, sp: string, attr: string, q: string, raw: string) => {
    const value = decodeAttr(raw.trim());
    if (value === UNSUBSCRIBE_TAG || /^\{\{\s*[A-Za-z0-9_.]+\s*\}\}$/.test(value)) return m;
    if (attr.toLowerCase() === 'src') {
      if (isAllowedTemplateImage(value, o.assetBaseUrl)) return m;
      if (o.mode === 'check') return m;
      throw new RenderError('link_not_allowed', `a template image is on ${hostOf(value)}; template images must be https on ALLOWED_PUSH_HOSTS or the digest asset host`);
    }
    if (isAllowedDigestUrl(value)) return `${sp}href=${q}${esc(withUtm(value, { campaign: o.utmCampaign, content: 'template' }))}${q}`;
    if (o.mode === 'check') return m;
    throw new RenderError('link_not_allowed', `a template link goes to ${hostOf(value)}, which is not on ALLOWED_PUSH_HOSTS`);
  });
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
  const block = (it: Prepared, n: number) =>
    [`${n}. ${it.title}`, it.label ? `   ${it.label}` : null, it.summary ? `   ${it.summary}` : null, `   ${it.href}`]
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
    `${premium ? PREMIUM_REASON : FREE_REASON} Questions or feedback? Just reply to this email.`,
    `Unsubscribe from this digest: ${UNSUBSCRIBE_TAG}`,
    `Taxscan · ${p.postal}`,
    p.homeHref,
    '',
  );
  return out.join('\n');
}
