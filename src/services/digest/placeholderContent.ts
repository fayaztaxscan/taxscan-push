import type { DigestAudience } from '@prisma/client';
import type { FrozenItem } from './builder';

/**
 * TEMPORARY — tasks 3–4 only (docs/EMAIL_DIGEST_DESIGN.md §13).
 *
 * Fixed placeholder content so the runner's state machine can be built and
 * tested before the renderer (task 5) exists. Since task 4 it is fed the
 * real frozen items (when the builder is wired in) and lists them in a bare,
 * escaped list — just enough to see what was frozen. Task 5 replaces
 * `placeholderContent` as the runner's default `buildContent` (subject = lead
 * headline, preheader, template). Nothing here is ever meant to reach a
 * reader: with the default flags the runner does not run at all, and no cron
 * calls it yet.
 */

/** What the build step freezes onto each DigestSend. */
export type DigestContent = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
};

/**
 * Builds one variant's frozen content. `items` is that audience's frozen list
 * (MAIN by rank, then ICYMI) when the builder ran; undefined without one.
 */
export type BuildContent = (input: {
  runId: string;
  runDate: Date;
  audience: DigestAudience;
  items?: FrozenItem[];
}) => Promise<DigestContent>;

const FROZEN: Record<DigestAudience, DigestContent> = {
  FREE: {
    subject: '[PLACEHOLDER] Taxscan Digest (Free)',
    preheader: '[PLACEHOLDER] Task 3 stub content, not for readers',
    html: '<!doctype html><html><body><p>[PLACEHOLDER] Taxscan Digest, Free variant. TEMPORARY task 3 stub.</p></body></html>',
    text: '[PLACEHOLDER] Taxscan Digest, Free variant. TEMPORARY task 3 stub.',
  },
  PREMIUM: {
    subject: '[PLACEHOLDER] Taxscan Digest (Premium)',
    preheader: '[PLACEHOLDER] Task 3 stub content, not for readers',
    html: '<!doctype html><html><body><p>[PLACEHOLDER] Taxscan Digest, Premium variant. TEMPORARY task 3 stub.</p></body></html>',
    text: '[PLACEHOLDER] Taxscan Digest, Premium variant. TEMPORARY task 3 stub.',
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** TEMPORARY: the frozen placeholder for an audience, listing the frozen items when given. */
export const placeholderContent: BuildContent = async ({ audience, items }) => {
  const base = FROZEN[audience];
  if (!items || items.length === 0) return { ...base };
  const li = items
    .map((it) => `<li data-section="${it.section}"><a href="${esc(it.url)}">${esc(it.title)}</a></li>`)
    .join('');
  return {
    ...base,
    html: base.html.replace('</body>', `<ol>${li}</ol></body>`),
    text: `${base.text}\n${items.map((it) => `${it.rank}. [${it.section}] ${it.title} ${it.url}`).join('\n')}`,
  };
};
