import { env } from '../../lib/env';
import { articleContentOf } from '../whatsapp/postText';

/**
 * Is this campaign a public article push a social channel (WhatsApp queue, LinkedIn page) should carry?
 * ONE predicate for every social channel (brief 2026-11-02-linkedin-page-posting, follow-up 1).
 *
 * It looks at what was sent, never at who sent it: the pacer's sends, Compose "Send now", a scheduled Compose send that
 * the sweeper marked SENT, Queue/Review "Push now" and Breaking all qualify alike. Do NOT add `createdByUserId`,
 * `sendQueue` or `breaking` tests here. The caller has already selected `status = SENT` and the portal.
 *
 * What does NOT qualify:
 *  - a link that is not a taxscan.in article (the home page, a section page, academy / shop);
 *  - a TEST send: a campaign whose target is ONLY the test-segment topic (`env.testSegmentTopic`, the one the ADMIN
 *    "test segment" tool puts a staff device on). A topics target that also names a real topic is a real send.
 */
export type SocialCampaignShape = { url: string; target?: unknown };

/** True when `target` is `{type:'topics', topics:[…]}` and every topic is the test-segment topic. */
export function isTestSegmentOnly(target: unknown, testTopic: string = env.testSegmentTopic): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as { type?: unknown; topics?: unknown };
  if (t.type !== 'topics' || !Array.isArray(t.topics) || t.topics.length === 0) return false;
  const norm = (s: unknown) => String(s).trim().toLowerCase();
  return t.topics.every((x) => norm(x) === norm(testTopic));
}

export function isPublicArticleCampaign(c: SocialCampaignShape, testTopic: string = env.testSegmentTopic): boolean {
  return articleContentOf(c) !== null && !isTestSegmentOnly(c.target, testTopic);
}
