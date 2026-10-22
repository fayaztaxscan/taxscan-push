import type { DigestAudience } from '@prisma/client';
import type { BuildContent, DigestContent } from '../services/digest/renderer';

/**
 * TEST-ONLY stub content for the runner state-machine tests (task 3), which
 * exercise create/schedule/verify without the builder: the real renderer
 * refuses to render without frozen items. Lists the frozen items when given.
 * Moved here from `services/digest/placeholderContent.ts` when task 5 made
 * the renderer the runner's default.
 */

const FROZEN: Record<DigestAudience, DigestContent> = {
  FREE: {
    subject: '[PLACEHOLDER] Taxscan Digest (Free)',
    preheader: '[PLACEHOLDER] test stub content',
    html: '<!doctype html><html><body><p>[PLACEHOLDER] Taxscan Digest, Free variant. Test stub.</p></body></html>',
    text: '[PLACEHOLDER] Taxscan Digest, Free variant. Test stub.',
  },
  PREMIUM: {
    subject: '[PLACEHOLDER] Taxscan Digest (Premium)',
    preheader: '[PLACEHOLDER] test stub content',
    html: '<!doctype html><html><body><p>[PLACEHOLDER] Taxscan Digest, Premium variant. Test stub.</p></body></html>',
    text: '[PLACEHOLDER] Taxscan Digest, Premium variant. Test stub.',
  },
};

export const placeholderContent: BuildContent = async ({ audience }) => ({ ...FROZEN[audience] });
