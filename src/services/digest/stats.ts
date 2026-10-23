import { prisma } from '../../lib/prisma';

/**
 * Per-variant reader-feedback counts from the Mailercloud webhook
 * (docs/EMAIL_DIGEST_DESIGN.md §3 lifecycle table): **rolled-up + live**.
 * `DigestSend.rolled*` holds what the retention fold (task 11) has already
 * counted and deleted; the live part is the `EmailEvent` rows still present.
 * The single implementation — do not count EmailEvent per send anywhere else.
 * One grouped query for any number of sends.
 */
export type DigestSendStats = { unsubscribes: number; bounces: number; complaints: number };

export async function digestSendStats(sendIds: string[]): Promise<Map<string, DigestSendStats>> {
  const out = new Map<string, DigestSendStats>();
  if (sendIds.length === 0) return out;
  const [sends, live] = await Promise.all([
    prisma.digestSend.findMany({
      where: { id: { in: sendIds } },
      select: { id: true, rolledUnsub: true, rolledBounce: true, rolledSpam: true },
    }),
    prisma.emailEvent.groupBy({
      by: ['sendId', 'type'],
      where: { sendId: { in: sendIds }, type: { in: ['UNSUBSCRIBE', 'HARD_BOUNCE', 'SPAM'] } },
      _count: { _all: true },
    }),
  ]);
  for (const s of sends) out.set(s.id, { unsubscribes: s.rolledUnsub, bounces: s.rolledBounce, complaints: s.rolledSpam });
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
