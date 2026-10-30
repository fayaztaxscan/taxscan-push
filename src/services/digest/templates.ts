import type { DigestAudience, DigestTemplate } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import type { FrozenItem } from './builder';
import {
  BUILTIN_TEMPLATE_HTML,
  PLACEHOLDER_RE,
  REQUIRED_PLACEHOLDERS,
  ROW_PLACEHOLDERS,
  RenderError,
  TEMPLATE_PLACEHOLDERS,
  CONTACT_EMAIL,
  IMAGE_ATTRS,
  LINK_ATTRS,
  decodeAttr,
  esc,
  isAllowedDigestUrl,
  isAllowedTemplateImage,
  isSocialUrl,
  isContactMailto,
  renderDigest,
  scanStartTags,
  srcsetUrls,
  type RenderAd,
  type RenderedDigest,
} from './renderer';

/**
 * Digest templates (docs/EMAIL_DIGEST_DESIGN.md §3 DigestTemplate, §4
 * renderer, §6, §7 Templates, §9, §13 task 10).
 *
 *  - `resolveTemplate(audience, at)` is the SINGLE definition of which layout
 *    a digest uses: a SCHEDULED override whose window holds `at` (start
 *    inclusive, end exclusive) → else the ACTIVE template → else the built-in
 *    one (`BUILTIN_TEMPLATE_HTML`, the v0 layout), so nothing changes until an
 *    admin activates a template.
 *  - Templates compile at SAVE time (`compileTemplate`); the send path only
 *    substitutes into the stored `compiledHtml`.
 *  - `validateTemplate` is the checklist; activation and scheduling are refused
 *    while any check fails. It is pure: the worst-case fixture is rendered
 *    through the real renderer (in its 'check' mode) and the output inspected.
 *  - The database enforces one ACTIVE template per (portal, audience) with a
 *    partial unique index (migration `…_digest_templates`).
 */

export const TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'SCHEDULED', 'ARCHIVED'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
export const TEMPLATE_FORMATS = ['HTML', 'MJML'] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];
/** Longest template source accepted (characters). The route's own JSON limit sits above it. */
export const TEMPLATE_SOURCE_MAX = 150_000;
/**
 * Merge tags that may appear in a template besides our placeholders: none. `{{unsubscribe_link}}` used to pass; since
 * 30 Oct 2026 it is refused (Mailercloud does not expand it, and appends its own unsubscribe footer to every campaign).
 */
const PASS_THROUGH = new Set<string>();

/* ------------------------------------------------------------------ */
/* Compile (save time only)                                            */
/* ------------------------------------------------------------------ */

export type MjmlCompiler = (source: string) => Promise<{ html: string; errors?: { message?: string; formattedMessage?: string; line?: number }[] }>;

/**
 * The MJML compiler, when the `mjml` package is installed; null otherwise.
 *
 * NOT ADOPTED (owner, 2026-10-23): templates are plain email HTML. This lazy
 * seam stays so MJML can be added later — that needs the owner's go-ahead,
 * `mjml@5.4.1` (234 packages, ~57 MB; Node ≥ 20.18) and one verified Railway
 * branch build. Without it an MJML template fails to compile with a readable
 * message, which blocks activation (fail safe). The Templates screen offers
 * HTML only. Loaded lazily so nothing at boot depends on it.
 */
export function loadMjml(): MjmlCompiler | null {
  const name = 'mjml';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(name) as unknown;
    const fn = (typeof mod === 'function' ? mod : (mod as { default?: unknown }).default) as ((s: string, o: object) => unknown) | undefined;
    if (typeof fn !== 'function') return null;
    return async (source) => (await fn(source, { validationLevel: 'strict', keepComments: false })) as Awaited<ReturnType<MjmlCompiler>>;
  } catch {
    return null;
  }
}

export type CompileResult = { html: string | null; error: string | null };

/** Compiles a source once, at save. Never throws: a failure is a readable `error` and `html: null`. */
export async function compileTemplate(format: TemplateFormat, source: string, opts: { mjml?: MjmlCompiler | null } = {}): Promise<CompileResult> {
  if (format === 'HTML') return { html: source, error: null };
  const mjml = opts.mjml === undefined ? loadMjml() : opts.mjml;
  if (!mjml) {
    return { html: null, error: 'MJML is not available in this build: templates are plain email HTML. Save the template as HTML.' };
  }
  try {
    const out = await mjml(source);
    const errors = out.errors ?? [];
    if (errors.length > 0) {
      const lines = errors.slice(0, 3).map((e) => (e.formattedMessage ?? e.message ?? 'invalid MJML').replace(/\s+/g, ' ').trim());
      return { html: null, error: `MJML error: ${lines.join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}` };
    }
    if (typeof out.html !== 'string' || out.html.trim() === '') return { html: null, error: 'MJML error: the compiler returned no HTML.' };
    return { html: out.html, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { html: null, error: `MJML error: ${msg.replace(/\s+/g, ' ').trim().slice(0, 300)}` };
  }
}

/* ------------------------------------------------------------------ */
/* Resolve (the single definition)                                     */
/* ------------------------------------------------------------------ */

export type ResolvedTemplate = {
  /** Null = the built-in template. */
  id: string | null;
  name: string;
  source: 'builtin' | 'active' | 'override';
  html: string;
  startsAt: Date | null;
  endsAt: Date | null;
};

export const BUILTIN_NAME = 'Built-in (v0)';

export function builtinTemplate(): ResolvedTemplate {
  return { id: null, name: BUILTIN_NAME, source: 'builtin', html: BUILTIN_TEMPLATE_HTML, startsAt: null, endsAt: null };
}

/**
 * The layout a digest for `audience` built at `at` uses — the ONE rule:
 *  1. a SCHEDULED override with startsAt ≤ at < endsAt (the latest start wins
 *     if two ever overlap; scheduling refuses overlaps);
 *  2. else the ACTIVE template (the DB allows at most one);
 *  3. else the built-in template.
 */
export async function resolveTemplate(audience: DigestAudience, at: Date, opts: { portal?: string } = {}): Promise<ResolvedTemplate> {
  const portal = opts.portal ?? env.rss.portal;
  const override = await prisma.digestTemplate.findFirst({
    where: { portal, audience, status: 'SCHEDULED', startsAt: { lte: at }, endsAt: { gt: at }, compiledHtml: { not: null } },
    orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
  });
  if (override?.compiledHtml) {
    return { id: override.id, name: override.name, source: 'override', html: override.compiledHtml, startsAt: override.startsAt, endsAt: override.endsAt };
  }
  const active = await prisma.digestTemplate.findFirst({ where: { portal, audience, status: 'ACTIVE', compiledHtml: { not: null } } });
  if (active?.compiledHtml) return { id: active.id, name: active.name, source: 'active', html: active.compiledHtml, startsAt: null, endsAt: null };
  return builtinTemplate();
}

/* ------------------------------------------------------------------ */
/* The worst-case fixture                                               */
/* ------------------------------------------------------------------ */

const LONG_TITLE = (n: number) =>
  `Supreme Court & Bombay High Court: "Section 148A" notice under Income Tax Act quashed — ₹${n},00,00,000 addition on alleged bogus purchases, cash credits and unexplained investment set aside as AO failed to consider reply, CIT(A) order reversed and matter remanded ${n}`.slice(0, 300);
const LONG_EXCERPT = (n: number) =>
  `The Supreme Court of India, in a significant ruling number ${n}, has held that the reassessment notice issued under Section 148A of the Income Tax Act, 1961 was invalid where the Assessing Officer failed to consider the assessee's reply & the evidence of ₹ payments; the Bench set aside the order and remanded the matter.`.slice(0, 280);
const long = (s: string, len: number) => s.repeat(Math.ceil(len / s.length)).slice(0, len);

/**
 * The biggest digest the builder can freeze: DIGEST_MAX_ITEMS stories, the
 * last DIGEST_ROLLFORWARD_ITEMS of them "In case you missed it" (so all three
 * ad slots and the ICYMI heading are drawn), maximal headlines, summaries and
 * URLs, and three maximal ads with images. The size check renders THIS.
 */
export function worstCaseFixture(cfg: Pick<DigestEnv, 'maxItems' | 'rollforwardItems' | 'assetBaseUrl'>): { items: FrozenItem[]; ads: RenderAd[] } {
  const icymi = Math.max(0, Math.min(cfg.rollforwardItems, cfg.maxItems - 1));
  const total = Math.max(cfg.maxItems, 1);
  const items: FrozenItem[] = Array.from({ length: total }, (_, i) => ({
    rank: i + 1,
    section: i < total - icymi ? 'MAIN' : 'ICYMI',
    articleKey: `fixture:${400000 + i}`,
    campaignId: null,
    title: LONG_TITLE(i),
    url: `https://www.taxscan.in/top-stories/supreme-court-bombay-high-court-section-148a-notice-income-tax-act-quashed-addition-bogus-purchases-cash-credits-unexplained-investment-set-aside-${i}/${400000 + i}?ref=feed&amp=1`,
    authority: i % 2 ? 'Bombay High Court' : 'Supreme Court',
    category: 'Income Tax',
    excerpt: LONG_EXCERPT(i),
    capturedAt: new Date('2026-10-22T04:00:00Z'),
    readRate: null,
    imageUrl: `https://documents.taxscan.in/cms/media/supreme-court-bombay-high-court-section-148a-notice-income-tax-act-quashed-addition-bogus-purchases-${i}-${400000 + i}.jpg`,
  }));
  const ads: RenderAd[] = [1, 2, 3].map((slot) => ({
    slot,
    adId: `sample-ad-${slot}`,
    kind: 'HOUSE',
    headline: long(`Sample ad ${slot}: master GST litigation with live classes `, 120),
    body: long('Live classes by practising advocates, recorded sessions and case notes you keep. ', 300),
    ctaText: long('Enrol now ', 30).trim(),
    linkUrl: `https://academy.taxscan.in/courses/sample-course-${slot}`,
    altText: long('Sample course banner ', 150).trim(),
    image: { url: `${cfg.assetBaseUrl}/email-assets/${String(slot).repeat(64)}.jpg`, width: 1720, height: 400 },
    mobileImage: { url: `${cfg.assetBaseUrl}/email-assets/${String(slot + 3).repeat(64)}.jpg`, width: 1080, height: 1080 },
  }));
  return { items, ads };
}

/**
 * The worst-case stories for DISPLAY (Templates -> Biggest case preview): the same text, but no picture URL, because
 * the fixture's long made-up documents.taxscan.in addresses exist only to size the email and would 404. The renderer then
 * shows the default story picture if one is set, else the brand block. The size check keeps using `worstCaseFixture`.
 */
export function worstCaseDisplayItems(items: FrozenItem[]): FrozenItem[] {
  return items.map((i) => ({ ...i, imageUrl: null }));
}

/**
 * The worst-case sample ads for DISPLAY: the fixture's banner/square URLs are made up (they only size the email) and
 * would 404, so the preview draws them as text-only ads. The size check keeps using `worstCaseFixture`.
 */
export function worstCaseDisplayAds(ads: RenderAd[]): RenderAd[] {
  return ads.map((a) => ({ ...a, image: null, mobileImage: null }));
}

/* ------------------------------------------------------------------ */
/* Scanning a template                                                 */
/* ------------------------------------------------------------------ */

type El = { name: string; attrs: string };
type Occurrence = { name: string; inComment: boolean; ancestors: El[]; inAttr?: boolean; notMso?: boolean };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TOKEN = /<!--([\s\S]*?)(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Every `{{placeholder}}` with its open-element ancestors (a small tag-stack walk; email html is simple). */
export function placeholderOccurrences(html: string): Occurrence[] {
  const out: Occurrence[] = [];
  const stack: El[] = [];
  // Inside `<!--[if !mso]><!--> … <!--<![endif]-->`: real markup for every client EXCEPT Outlook.
  let notMso = false;
  for (const m of html.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      if (/^\[if\s+!\s*mso[^\]]*\]>\s*<!\s*$/i.test(m[1])) notMso = true;
      else if (/<!\[endif\]\s*$/i.test(m[1])) notMso = false;
      for (const p of m[1].matchAll(PLACEHOLDER_RE)) out.push({ name: p[1], inComment: true, ancestors: [...stack] });
    } else if (m[3] !== undefined) {
      const name = m[3].toLowerCase();
      const attrs = m[4] ?? '';
      if (m[2] === '/') {
        const at = stack.map((e) => e.name).lastIndexOf(name);
        if (at >= 0) stack.length = at;
      } else if (!VOID.has(name) && !/\/\s*$/.test(attrs)) {
        stack.push({ name, attrs });
        for (const p of attrs.matchAll(PLACEHOLDER_RE)) out.push({ name: p[1], inComment: false, inAttr: true, notMso, ancestors: [...stack] });
      } else {
        for (const p of attrs.matchAll(PLACEHOLDER_RE)) out.push({ name: p[1], inComment: false, inAttr: true, notMso, ancestors: [...stack, { name, attrs }] });
      }
    } else if (m[5] !== undefined) {
      out.push({ name: m[5], inComment: false, notMso, ancestors: [...stack] });
    }
  }
  return out;
}

const HIDING_STYLE = /(?:^|[;\s"'])(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d]*[1-9])|max-height\s*:\s*0(?![.\d]*[1-9])|(?<!-)height\s*:\s*0(?![.\d]*[1-9])|(?<!-)width\s*:\s*0(?![.\d]*[1-9])|font-size\s*:\s*0(?![.\d]*[1-9])|mso-hide\s*:\s*all)/i;
const HIDING_CONTAINERS = new Set(['head', 'title', 'style', 'script', 'template', 'noscript', 'textarea', 'select', 'option', 'xml', 'iframe', 'object']);

/** An element's attributes as the browser reads them (quoted or not), by lower-case name. */
function elAttrs(a: El): Map<string, string> {
  const tag = scanStartTags(`<${a.name} ${a.attrs}>`)[0];
  return new Map((tag?.attrs ?? []).map((x) => [x.name, x.value]));
}

/** A style value as CSS reads it for our pattern: entities decoded, comments removed. */
const normCss = (css: string) => decodeAttr(css).replace(/\/\*[\s\S]*?\*\//g, '');

/** Why an occurrence would not be seen by a reader, or null. */
function hiddenBy(o: Occurrence): string | null {
  if (o.inComment) return 'it is inside an HTML comment (including Outlook-only <!--[if mso]> blocks)';
  if (o.inAttr) return 'it is inside an attribute value, not in the page';
  if (o.notMso) return 'it is inside a <!--[if !mso]> block, which Outlook does not show';
  for (const a of o.ancestors) {
    if (HIDING_CONTAINERS.has(a.name)) return `it is inside <${a.name}>`;
    const at = elAttrs(a);
    if (at.has('hidden')) return `it is inside a <${a.name}> with the hidden attribute`;
    if (HIDING_STYLE.test(` ${normCss(at.get('style') ?? '')}`)) return `it is inside a <${a.name}> styled to be invisible`;
  }
  return null;
}

/** The classes and ids on the footer's ancestors: a <style> rule hiding one of them hides the footer. */
function footerAncestorNames(occ: Occurrence[]): { classes: Set<string>; ids: Set<string> } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  for (const o of occ.filter((x) => x.name === 'footer')) {
    for (const a of o.ancestors) {
      const at = elAttrs(a);
      for (const c of (at.get('class') ?? '').split(/\s+/)) if (c) classes.add(c.toLowerCase());
      const id = (at.get('id') ?? '').trim();
      if (id) ids.add(id.toLowerCase());
    }
  }
  return { classes, ids };
}

/** <style> rules that hide something the footer could match (an element, *, [attr], or one of the footer's classes). */
function footerHidingCss(html: string, ancestors: { classes: Set<string>; ids: Set<string> } = { classes: new Set(), ids: new Set() }): string[] {
  const out: string[] = [];
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const rule of block[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].trim();
      if (!HIDING_STYLE.test(` ${rule[2]}`)) continue;
      const risky = selector.split(',').some((sel) => {
        const s = sel.trim();
        if (/[*[]|data-footer|\bts-(pad|muted|link|card)\b/.test(s)) return true;
        // A class or id carried by an element the footer sits inside.
        for (const m of s.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)) {
          if ((m[1] === '.' ? ancestors.classes : ancestors.ids).has(m[2].toLowerCase())) return true;
        }
        // An element selector (td, p, a, table, body …) anywhere in the compound selector.
        return s.split(/[\s>+~]+/).some((part) => /^[a-z][a-z0-9]*([.:#]|$)/i.test(part));
      });
      if (risky) out.push(selector.slice(0, 60));
    }
  }
  return out;
}

const ACTIVE_CONTENT: [RegExp, string][] = [
  [/<script\b/i, 'a <script>'],
  [/<iframe\b/i, 'an <iframe>'],
  [/<frame(set)?\b/i, 'a <frame>'],
  [/<object\b/i, 'an <object>'],
  [/<embed\b/i, 'an <embed>'],
  [/<applet\b/i, 'an <applet>'],
  [/<form\b/i, 'a <form>'],
  [/<(input|button|textarea|select)\b/i, 'a form control'],
  [/<base\b/i, 'a <base>'],
  [/<link\b/i, 'a <link> (external stylesheet or font)'],
  [/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, 'a <meta> refresh'],
  [/@import\b/i, 'a CSS @import'],
  [/<svg\b/i, 'an <svg> (it can carry scripts)'],
  [/[\s/"']on[a-z]+\s*=/i, 'an event handler attribute (on…=)'],
  [/(javascript|vbscript)\s*:/i, 'a javascript: or vbscript: URL'],
  [/data\s*:\s*text\/html/i, 'a data:text/html URL'],
  [/expression\s*\(/i, 'a CSS expression()'],
];

/** Static links in the template that offer a subscription — a Premium reader already has one (§1 #12). */
const SUBSCRIPTION_PATH = /\/(subscribe|subscription|subscriptions|pricing|plans?|membership|join)(?:[/?#.-]|$)/i;
const SUBSCRIPTION_TEXT = /\b(subscribe now|buy (?:a )?subscription|get premium|upgrade to premium)\b/i;

/* ------------------------------------------------------------------ */
/* Validate (the checklist)                                            */
/* ------------------------------------------------------------------ */

export type TemplateCheckId = 'compiles' | 'placeholders' | 'footer' | 'no_active_content' | 'links' | 'alt_text' | 'size' | 'premium_no_subscription';
export type TemplateCheck = { id: TemplateCheckId; label: string; ok: boolean; problems: string[]; note?: string };
export type TemplateValidation = {
  ok: boolean;
  checkedAt: string;
  audience: DigestAudience;
  checks: TemplateCheck[];
  /** The worst-case fixture's budget figure (html bytes + tracking allowance), or null when it could not render. */
  budgetBytes: number | null;
  maxBytes: number;
  warnBytes: number;
};

export const CHECK_LABELS: Record<TemplateCheckId, string> = {
  compiles: 'Compiles',
  placeholders: 'Required placeholders, each exactly once',
  footer: 'Footer with reason line, contact line and postal address, visible and not removable',
  no_active_content: 'No scripts, forms, iframes or external styles',
  links: 'Every link and image passes the digest URL check',
  alt_text: 'Every image has alt text',
  size: 'Worst-case email under the size budget',
  premium_no_subscription: 'No subscription offer in the Premium template',
};

/** Every value of the named attributes, read the way a browser reads them (quoted or not, `/`-separated). */
const attrValues = (html: string, names: ReadonlySet<string>) =>
  scanStartTags(html).flatMap((t) => t.attrs.filter((a) => names.has(a.name)).map((a) => a.value.trim()));

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.length > 30 ? `${x.pathname.slice(0, 30)}…` : x.pathname}`;
  } catch {
    return u.length > 40 ? `${u.slice(0, 40)}…` : u || '(empty)';
  }
}

/**
 * Runs the checklist on a compiled template for `audience`. Pure (no DB, no
 * clock beyond `now`). `ok` only when every check passes; activation and
 * scheduling call this again and refuse while it fails.
 */
export function validateTemplate(
  input: { audience: DigestAudience; compiledHtml: string | null; compileError: string | null },
  o: { cfg: DigestEnv; now: Date },
): TemplateValidation {
  const { audience } = input;
  const cfg = o.cfg;
  const maxBytes = cfg.maxHtmlKb * 1024;
  const warnBytes = cfg.htmlWarnKb * 1024;
  const checks: TemplateCheck[] = [];
  const add = (id: TemplateCheckId, problems: string[], note?: string) =>
    checks.push({ id, label: CHECK_LABELS[id], ok: problems.length === 0, problems, ...(note ? { note } : {}) });

  const html = input.compiledHtml;
  add('compiles', html === null ? [input.compileError ?? 'The template did not compile.'] : []);
  if (html === null) {
    for (const id of ['placeholders', 'footer', 'no_active_content', 'links', 'alt_text', 'size', 'premium_no_subscription'] as const) {
      add(id, ['Not checked: the template did not compile.']);
    }
    return { ok: false, checkedAt: o.now.toISOString(), audience, checks, budgetBytes: null, maxBytes, warnBytes };
  }

  // 1. Placeholders
  const occ = placeholderOccurrences(html);
  const counts = new Map<string, number>();
  for (const x of occ) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
  const ph: string[] = [];
  for (const r of REQUIRED_PLACEHOLDERS) {
    const n = counts.get(r) ?? 0;
    if (n === 0) ph.push(`{{${r}}} is missing.`);
    else if (n > 1) ph.push(`{{${r}}} appears ${n} times; it must appear exactly once.`);
  }
  for (const [name] of counts) {
    if (name === 'unsubscribe_link') {
      ph.push('{{unsubscribe_link}} must be removed: Mailercloud adds the unsubscribe footer to every campaign itself, and does not fill this tag, so it would arrive as a dead link.');
    } else if (!(name in TEMPLATE_PLACEHOLDERS) && !PASS_THROUGH.has(name)) ph.push(`{{${name}}} is not a placeholder this digest fills.`);
  }
  for (const x of occ) {
    if (!ROW_PLACEHOLDERS.includes(x.name as never) || x.inComment) continue;
    const nearest = [...x.ancestors].reverse().find((a) => ['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th'].includes(a.name));
    if (!nearest || !['table', 'tbody', 'thead', 'tfoot'].includes(nearest.name)) {
      ph.push(`{{${x.name}}} must sit directly inside a <table> (it becomes table rows), not ${nearest ? `inside a <${nearest.name}>` : 'outside any table'}.`);
    }
  }
  for (const x of occ) if (x.name === 'preheader' && x.ancestors.some((a) => a.name === 'head')) ph.push('{{preheader}} must be in <body>, not <head>.');
  for (const x of occ) {
    if (x.inAttr && (REQUIRED_PLACEHOLDERS.includes(x.name as never) || x.name === 'logo' || x.name === 'premium_badge')) {
      ph.push(`{{${x.name}}} must be in the page, not inside an attribute value (it becomes markup).`);
    }
  }
  add('placeholders', [...new Set(ph)]);

  // 2. Footer: placed, visible, not hidden by CSS
  const ft: string[] = [];
  for (const x of occ.filter((y) => y.name === 'footer')) {
    const why = hiddenBy(x);
    if (why) ft.push(`The footer would not be seen: ${why}.`);
  }
  for (const sel of footerHidingCss(html, footerAncestorNames(occ))) ft.push(`A <style> rule hides elements the footer uses (${sel}); hide only your own classes.`);

  // 3. No active content
  const ac = ACTIVE_CONTENT.filter(([re]) => re.test(html)).map(([, what]) => `The template contains ${what}.`);
  // The same, read the way a browser reads attributes (`<img src=x/onerror=…>`).
  if (scanStartTags(html).some((t) => t.attrs.some((a) => /^on[a-z]/.test(a.name)))) ac.push(`The template contains ${'an event handler attribute (on…=)'}.`);
  add('no_active_content', [...new Set(ac)]);

  // Render the worst case through the real renderer ('check' mode keeps bad template links for us to name).
  const fixture = worstCaseFixture(cfg);
  let rendered: RenderedDigest | null = null;
  let renderProblem: string | null = null;
  try {
    rendered = renderDigest({
      items: fixture.items,
      audience,
      runDate: o.now,
      cfg: { ...cfg, postalAddress: cfg.postalAddress || 'Postal address (DIGEST_POSTAL_ADDRESS)' },
      ads: fixture.ads,
      template: { html },
      mode: 'check',
      assetBaseUrl: cfg.assetBaseUrl,
    });
  } catch (err) {
    renderProblem = err instanceof RenderError ? err.message : `The template could not be rendered: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (rendered) {
    const postal = esc(cfg.postalAddress || 'Postal address (DIGEST_POSTAL_ADDRESS)');
    if (!rendered.html.includes(CONTACT_EMAIL)) ft.push('The rendered email has no contact line.');
    if (!rendered.html.includes(postal)) ft.push('The rendered email has no postal address.');
  } else if (renderProblem) {
    ft.push(renderProblem);
  }
  add('footer', [...new Set(ft)]);

  // 4. Links and images (on the rendered email, so template links and ours are judged alike)
  const ln: string[] = [];
  const al: string[] = [];
  if (rendered) {
    for (const href of attrValues(rendered.html, LINK_ATTRS)) {
      if (isSocialUrl(href) || isContactMailto(href)) continue;
      if (!isAllowedDigestUrl(href)) ln.push(`Link ${shortUrl(href)} is not allowed (only https/http links to ALLOWED_PUSH_HOSTS).`);
    }
    const images = [
      ...attrValues(rendered.html, IMAGE_ATTRS),
      ...attrValues(rendered.html, new Set(['srcset'])).flatMap(srcsetUrls),
      ...[...rendered.html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => decodeAttr(m[1].trim())),
    ];
    for (const src of images) {
      if (!isAllowedTemplateImage(src, cfg.assetBaseUrl)) ln.push(`Image ${shortUrl(src)} is not allowed (https on ALLOWED_PUSH_HOSTS or ${new URL(cfg.assetBaseUrl).host} only).`);
    }
    for (const tag of scanStartTags(rendered.html).filter((t) => t.name === 'img')) {
      const alt = tag.attrs.find((a) => a.name === 'alt');
      if (!alt || alt.value.trim() === '') {
        al.push(`An image (${shortUrl(tag.attrs.find((a) => a.name === 'src')?.value.trim() ?? '')}) has no alt text.`);
      }
    }
  } else {
    ln.push('Not checked: the worst-case email could not be rendered.');
    al.push('Not checked: the worst-case email could not be rendered.');
  }
  add('links', [...new Set(ln)]);
  add('alt_text', [...new Set(al)]);

  // 5. Size
  if (rendered) {
    const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
    if (rendered.overBudget) add('size', [`The worst-case email is ${kb(rendered.budgetBytes)} with the tracking allowance; the limit is ${cfg.maxHtmlKb} KB.`]);
    else add('size', [], rendered.budgetBytes >= warnBytes ? `${kb(rendered.budgetBytes)} — close to the ${cfg.maxHtmlKb} KB limit (warning from ${cfg.htmlWarnKb} KB).` : `${kb(rendered.budgetBytes)} of ${cfg.maxHtmlKb} KB.`);
  } else {
    add('size', ['Not checked: the worst-case email could not be rendered.']);
  }

  // 6. Premium: no subscription offer of the template's own
  if (audience === 'PREMIUM') {
    const sub: string[] = [];
    for (const href of attrValues(html, LINK_ATTRS)) if (SUBSCRIPTION_PATH.test(href)) sub.push(`Link ${shortUrl(href)} offers a subscription; Premium readers already have one.`);
    const text = html.replace(/<[^>]*>/g, ' ');
    const t = SUBSCRIPTION_TEXT.exec(text);
    if (t) sub.push(`The text “${t[1]}” offers a subscription; Premium readers already have one.`);
    add('premium_no_subscription', sub);
  } else {
    add('premium_no_subscription', [], 'Not applicable to the Free template.');
  }

  return {
    ok: checks.every((c) => c.ok),
    checkedAt: o.now.toISOString(),
    audience,
    checks,
    budgetBytes: rendered?.budgetBytes ?? null,
    maxBytes,
    warnBytes,
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle (the routes call these)                                   */
/* ------------------------------------------------------------------ */

export class TemplateRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly validation?: TemplateValidation,
  ) {
    super(message);
    this.name = 'TemplateRefused';
  }
}

/** Compiles + validates a source for storage (save time). */
export async function prepareTemplate(
  input: { audience: DigestAudience; format: TemplateFormat; source: string },
  o: { cfg: DigestEnv; now: Date; mjml?: MjmlCompiler | null },
): Promise<{ compiledHtml: string | null; compileError: string | null; validation: TemplateValidation }> {
  const c = await compileTemplate(input.format, input.source, { mjml: o.mjml });
  const validation = validateTemplate({ audience: input.audience, compiledHtml: c.html, compileError: c.error }, o);
  return { compiledHtml: c.html, compileError: c.error, validation };
}

/** Re-validates a stored template now (config such as the allowlist may have changed since it was saved). */
export async function revalidate(t: DigestTemplate, o: { cfg: DigestEnv; now: Date }): Promise<TemplateValidation> {
  const v = validateTemplate({ audience: t.audience, compiledHtml: t.compiledHtml, compileError: t.compileError }, o);
  await prisma.digestTemplate.update({ where: { id: t.id }, data: { validation: v as never, validatedAt: o.now } });
  return v;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === 'P2002' || /one_active_template_per_audience|23505/.test(String((err as Error)?.message ?? ''));

/**
 * DRAFT → ACTIVE. Refused while the checklist fails. The ACTIVE template it
 * replaces goes to ARCHIVED and is remembered in `replacesId` (Revert brings
 * it back). One transaction; the partial unique index makes a concurrent
 * second activation fail rather than leave two ACTIVE.
 */
export async function activateTemplate(id: string, o: { portal: string; cfg: DigestEnv; now: Date }): Promise<{ template: DigestTemplate; replaced: DigestTemplate | null; validation: TemplateValidation }> {
  const t = await prisma.digestTemplate.findFirst({ where: { id, portal: o.portal } });
  if (!t) throw new TemplateRefused('not_found', 'Template not found.', 404);
  if (t.status !== 'DRAFT') throw new TemplateRefused('not_draft', `Only a draft can be activated; this template is ${t.status.toLowerCase()}. Make a copy to use it again.`);
  const validation = await revalidate(t, o);
  if (!validation.ok) throw new TemplateRefused('validation_failed', 'Activation is blocked until every check passes.', 409, validation);
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.digestTemplate.findFirst({ where: { portal: o.portal, audience: t.audience, status: 'ACTIVE' } });
      if (current) await tx.digestTemplate.update({ where: { id: current.id }, data: { status: 'ARCHIVED', archivedAt: o.now } });
      // Fenced on the html that was just checked: a save landing between the check and here
      // (another tab) would otherwise activate html the checklist never saw (QA of task 10).
      const r = await tx.digestTemplate.updateMany({
        where: { id: t.id, status: 'DRAFT', compiledHtml: t.compiledHtml },
        data: { status: 'ACTIVE', activatedAt: o.now, replacesId: current?.id ?? null, startsAt: null, endsAt: null },
      });
      if (r.count !== 1) throw new TemplateRefused('changed', 'Someone else changed this template a moment ago. Refresh.');
      return { template: await tx.digestTemplate.findUniqueOrThrow({ where: { id: t.id } }), replaced: current, validation };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new TemplateRefused('conflict', 'Another template was activated for this audience at the same moment. Refresh.');
    throw err;
  }
}

/**
 * DRAFT → SCHEDULED for [startsAt, endsAt): an override that wins inside its
 * window and lapses after it (the ACTIVE template is untouched). Refused while
 * the checklist fails, for an empty or past window, or when it overlaps
 * another override for the same audience.
 */
export async function scheduleTemplate(
  id: string,
  window: { startsAt: Date; endsAt: Date },
  o: { portal: string; cfg: DigestEnv; now: Date },
): Promise<{ template: DigestTemplate; validation: TemplateValidation }> {
  const t = await prisma.digestTemplate.findFirst({ where: { id, portal: o.portal } });
  if (!t) throw new TemplateRefused('not_found', 'Template not found.', 404);
  if (t.status !== 'DRAFT') throw new TemplateRefused('not_draft', `Only a draft can be scheduled; this template is ${t.status.toLowerCase()}.`);
  if (!(window.endsAt.getTime() > window.startsAt.getTime())) throw new TemplateRefused('bad_window', 'The end must be after the start.', 400);
  if (window.endsAt.getTime() <= o.now.getTime()) throw new TemplateRefused('bad_window', 'The window has already ended.', 400);
  const overlap = await prisma.digestTemplate.findFirst({
    where: { portal: o.portal, audience: t.audience, status: 'SCHEDULED', id: { not: t.id }, startsAt: { lt: window.endsAt }, endsAt: { gt: window.startsAt } },
    select: { name: true },
  });
  if (overlap) throw new TemplateRefused('overlap', `It overlaps the scheduled template “${overlap.name}” for this audience.`);
  const validation = await revalidate(t, o);
  if (!validation.ok) throw new TemplateRefused('validation_failed', 'Scheduling is blocked until every check passes.', 409, validation);
  const r = await prisma.digestTemplate.updateMany({
    where: { id: t.id, status: 'DRAFT', compiledHtml: t.compiledHtml },
    data: { status: 'SCHEDULED', startsAt: window.startsAt, endsAt: window.endsAt },
  });
  if (r.count !== 1) throw new TemplateRefused('changed', 'Someone else changed this template a moment ago. Refresh.');
  return { template: await prisma.digestTemplate.findUniqueOrThrow({ where: { id: t.id } }), validation };
}

/** DRAFT / SCHEDULED → ARCHIVED (final). The ACTIVE template is replaced by activating another, or reverted. */
export async function archiveTemplate(id: string, o: { portal: string; now: Date }): Promise<{ template: DigestTemplate; from: string }> {
  const t = await prisma.digestTemplate.findFirst({ where: { id, portal: o.portal } });
  if (!t) throw new TemplateRefused('not_found', 'Template not found.', 404);
  if (t.status === 'ACTIVE') throw new TemplateRefused('active', 'The active template cannot be archived. Activate another one, or use Revert to previous.');
  if (t.status === 'ARCHIVED') return { template: t, from: 'ARCHIVED' };
  const r = await prisma.digestTemplate.updateMany({ where: { id: t.id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { status: 'ARCHIVED', archivedAt: o.now } });
  if (r.count !== 1) throw new TemplateRefused('changed', 'Someone else changed this template a moment ago. Refresh.');
  return { template: await prisma.digestTemplate.findUniqueOrThrow({ where: { id: t.id } }), from: t.status };
}

/**
 * One-click revert for an audience: the ACTIVE template goes back to DRAFT and
 * the one it replaced (`replacesId`) becomes ACTIVE again — after passing the
 * checklist again (the allowlist may have changed). With nothing to go back to,
 * the built-in template takes over.
 */
export async function revertTemplate(
  audience: DigestAudience,
  o: { portal: string; cfg: DigestEnv; now: Date },
): Promise<{ from: DigestTemplate; to: DigestTemplate | null; validation: TemplateValidation | null }> {
  const current = await prisma.digestTemplate.findFirst({ where: { portal: o.portal, audience, status: 'ACTIVE' } });
  if (!current) throw new TemplateRefused('nothing_to_revert', 'No template is active for this audience; the built-in template is already in use.');
  const previous = current.replacesId
    ? await prisma.digestTemplate.findFirst({ where: { id: current.replacesId, portal: o.portal, audience } })
    : null;
  let validation: TemplateValidation | null = null;
  if (previous) {
    validation = await revalidate(previous, o);
    if (!validation.ok) {
      throw new TemplateRefused('validation_failed', `The previous template “${previous.name}” no longer passes every check, so it cannot come back. Fix a copy of it instead.`, 409, validation);
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const r = await tx.digestTemplate.updateMany({ where: { id: current.id, status: 'ACTIVE' }, data: { status: 'DRAFT', activatedAt: null, replacesId: null } });
      if (r.count !== 1) throw new TemplateRefused('changed', 'Someone else changed the active template a moment ago. Refresh.');
      let to: DigestTemplate | null = null;
      if (previous) {
        to = await tx.digestTemplate.update({ where: { id: previous.id }, data: { status: 'ACTIVE', activatedAt: o.now, archivedAt: null, startsAt: null, endsAt: null } });
      }
      return { from: await tx.digestTemplate.findUniqueOrThrow({ where: { id: current.id } }), to, validation };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new TemplateRefused('conflict', 'Another template was activated for this audience at the same moment. Refresh.');
    throw err;
  }
}

/** What an audit row may say about a template: never its source or html. */
export function templateAuditMeta(t: Pick<DigestTemplate, 'name' | 'audience' | 'status' | 'format' | 'source' | 'startsAt' | 'endsAt'>, extra: Record<string, unknown> = {}) {
  return {
    name: t.name,
    audience: t.audience,
    status: t.status,
    format: t.format,
    sourceChars: t.source.length,
    startsAt: t.startsAt ? t.startsAt.toISOString() : null,
    endsAt: t.endsAt ? t.endsAt.toISOString() : null,
    ...extra,
  };
}

/** The ids of the checks that failed (for audit rows and lists). */
export function failedChecks(v: TemplateValidation | null | undefined): string[] {
  return v?.checks?.filter((c) => !c.ok).map((c) => c.id) ?? [];
}
