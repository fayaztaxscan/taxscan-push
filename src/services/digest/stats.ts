import { prisma } from '../../lib/prisma';

/**
 * Per-variant reader-feedback counts from the Mailercloud webhook
 * (docs/EMAIL_DIGEST_DESIGN.md §3 lifecycle table): **rolled-up + live**.
 * `DigestSend.rolled*` holds what the retention fold (task 11) has already
 * counted and deleted; the live part is the `EmailEvent` rows still present.
 * The single implementation — do not count EmailEvent per send anywhere else.
 *
 * NULL vs 0 — a send is COVERED (its counts are real, possibly 0) only when
 * there is proof our webhook was receiving when it went out: a `campaign_sent`
 * or `campaign_error` event for that campaign (linked by `sendId`, or carrying
 * its `mcCampaignId`), or — once the nightly fold (task 11,
 * `src/sweepers/digestRetention.ts`) has deleted those events — the
 * `webhookProofAt` it stamped on the send in the same transaction. A send from
 * before the webhook was registered, or while Mailercloud had it switched off,
 * gets no entry in the map → the screen shows "—", never a fake 0. (An env flag
 * has no history, and "any event after the send" would wrongly cover sends made
 * before the webhook was registered.)
 *
 * Folded counts alone are NOT proof (changed in task 11): a reader event is not
 * proof while it is live, so it must not become proof by being folded — the
 * before/after-fold parity test pins that the map is identical either way.
 *
 * A constant 3 queries for any number of sends.
 */
export type DigestSendStats = { unsubscribes: number; bounces: number; complaints: number };

const FEEDBACK_TYPES = ['UNSUBSCRIBE', 'HARD_BOUNCE', 'SPAM'];
const COVERAGE_TYPES = ['CAMPAIGN_SENT', 'CAMPAIGN_ERROR'];

export async function digestSendStats(sendIds: string[]): Promise<Map<string, DigestSendStats>> {
  const out = new Map<string, DigestSendStats>();
  if (sendIds.length === 0) return out;
  const sends = await prisma.digestSend.findMany({
    where: { id: { in: sendIds } },
    select: { id: true, mcCampaignId: true, rolledUnsub: true, rolledBounce: true, rolledSpam: true, webhookProofAt: true },
  });
  const mcIds = sends.map((s) => s.mcCampaignId).filter((v): v is string => !!v);
  const [proof, live] = await Promise.all([
    prisma.emailEvent.findMany({
      where: { type: { in: COVERAGE_TYPES }, OR: [{ sendId: { in: sendIds } }, { mcCampaignId: { in: mcIds } }] },
      select: { sendId: true, mcCampaignId: true },
    }),
    prisma.emailEvent.groupBy({
      by: ['sendId', 'type'],
      where: { sendId: { in: sendIds }, type: { in: FEEDBACK_TYPES } },
      _count: { _all: true },
    }),
  ]);
  const coveredSend = new Set(proof.map((p) => p.sendId).filter(Boolean));
  const coveredCampaign = new Set(proof.map((p) => p.mcCampaignId).filter(Boolean));
  for (const s of sends) {
    if (s.webhookProofAt === null && !coveredSend.has(s.id) && !(s.mcCampaignId && coveredCampaign.has(s.mcCampaignId))) continue;
    out.set(s.id, { unsubscribes: s.rolledUnsub, bounces: s.rolledBounce, complaints: s.rolledSpam });
  }
  for (const g of live) {
    const row = g.sendId ? out.get(g.sendId) : undefined;
    if (!row) continue;
    const n = g._count._all;
    if (g.type === 'UNSUBSCRIBE') row.unsubscribes += n;
    else if (g.type === 'HARD_BOUNCE') row.bounces += n;
    else if (g.type === 'SPAM') row.complaints += n;
  }
  return out;
}
