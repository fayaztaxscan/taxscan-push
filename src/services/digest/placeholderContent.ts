import type { DigestAudience } from '@prisma/client';

/**
 * TEMPORARY — task 3 only (docs/EMAIL_DIGEST_DESIGN.md §13).
 *
 * Fixed placeholder content so the runner's state machine can be built and
 * tested before the builder (task 4) and renderer (task 5) exist. Task 5
 * replaces `placeholderContent` as the runner's default `buildContent`.
 * Nothing here is ever meant to reach a reader: with the default flags the
 * runner does not run at all, and no cron calls it yet.
 */

/** What the build step freezes onto each DigestSend. */
export type DigestContent = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
};

/** Builds one variant's frozen content. Task 4/5 provide the real implementation. */
export type BuildContent = (input: { runId: string; runDate: Date; audience: DigestAudience }) => Promise<DigestContent>;

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

/** TEMPORARY: the frozen placeholder for an audience. */
export const placeholderContent: BuildContent = async ({ audience }) => ({ ...FROZEN[audience] });
