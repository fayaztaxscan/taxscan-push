import { prisma } from '../../lib/prisma';
import { isAllPushesCampaign, pushKey } from './allPushes';
import { isPublicArticleCampaign } from './publicCampaign';

/**
 * Compose "Post to" (brief 2026-11-09-compose-skip-pages), the part the LinkedIn and Facebook workers share.
 *
 * A push whose sender unticked a page (`Campaign.socialSkip` names the page's key) gets NO post on that page: the worker writes the page's
 * normal row as SKIPPED with the reason `compose_skip` and makes no call. THE ROW KEY IS ALWAYS THE PUSH'S OWN (`push:<id>:<ms>`), never
 * the article's, and such a push is taken OUT of the page's candidates altogether. Both halves matter under today's rule (one post per
 * article, keyed by the article): if the skip row took the article's key, or the skipped push stayed the article's "oldest push", a later
 * push of the same URL from Push now or the pacer would find the article already handled and never post. This way it posts normally,
 * and a skip row can never block any other push (each push's key is its own).
 */

export type SkippedPush = { id: string; url: string; target: unknown; lastSentAt: Date | null };

/**
 * The SENT pushes since `postFrom`, on the portals that feed the page, whose sender unticked `skipKey`. One small query per page per
 * tick, and nearly always empty (the column is empty on every push that was not composed with an untick).
 */
export async function composeSkippedPushes(portals: string[], skipKey: string, postFrom: Date): Promise<SkippedPush[]> {
  return prisma.campaign.findMany({
    where: { portal: { in: portals }, status: 'SENT', lastSentAt: { gte: postFrom }, socialSkip: { has: skipKey } },
    select: { id: true, url: true, target: true, lastSentAt: true },
    orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Which of them would have POSTED on this page under the page's own rules, and under which row key. A push at or after the page's
 * all-pushes time qualifies as any push (`isAllPushesCampaign`); an earlier one only as a public article (`isPublicArticleCampaign`,
 * today's rule). One that would never have posted (a link that is not allowed, a test-segment-only send) gets no row: nothing to skip.
 */
export function skipRows(list: readonly SkippedPush[], pushesFrom: Date | null): { key: string; campaignId: string }[] {
  const out: { key: string; campaignId: string }[] = [];
  for (const c of list) {
    if (!c.lastSentAt) continue;
    const newRule = !!pushesFrom && c.lastSentAt >= pushesFrom;
    const qualifies = newRule ? isAllPushesCampaign(c) : isPublicArticleCampaign(c);
    if (qualifies) out.push({ key: pushKey({ id: c.id, lastSentAt: c.lastSentAt }), campaignId: c.id });
  }
  return out;
}
