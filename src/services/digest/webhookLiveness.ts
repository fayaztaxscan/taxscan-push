import type { DigestAudience, DigestSendState } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { redactError } from './sender';
import { recordRunAlert } from './runAlerts';

/**
 * Is Mailercloud still calling our webhook? (docs/EMAIL_DIGEST_DESIGN.md §4
 * `health.ts`/`webhook.ts`, §8 "Webhook deactivated by Mailercloud", task 8.)
 *
 * Mailercloud switches a webhook off after repeated failed deliveries and does
 * not tell us. The cheap signal used here: a variant our status poll confirmed
 * SENT (or PARTIALLY_SENT) at least `WEBHOOK_SILENT_AFTER_MS` ago, for which no
 * `campaign_sent` / `campaign_error` webhook has arrived, means the webhook is
 * silent. Polling still verifies sends; only the suppression copy lags.
 *
 * Mailercloud also has a read endpoint (`GET /v1/webhooks/detail/{id}`,
 * `status` Active/1 vs 0) that the design's daily health check could call;
 * it is NOT called from here (no live provider call outside the runner's
 * sender, and `health.ts` does not exist yet).
 *
 * One definition (`silentSends`) feeds both the alert marker (via
 * `checkWebhookLiveness`, called after every `advanceRun`) and the
 * `/api/digest/status` field (`webhookHealth`). Nothing here writes anything
 * except the `webhook_silent` marker, and nothing ever throws.
 */

export const WEBHOOK_SILENT_AFTER_MS = 2 * 60 * 60 * 1000;
/** Event types that prove Mailercloud called us about a given campaign. */
export const CAMPAIGN_WEBHOOK_TYPES = ['CAMPAIGN_SENT', 'CAMPAIGN_ERROR'] as const;
const DONE_STATES: DigestSendState[] = ['SENT', 'PARTIALLY_SENT'];
const STATUS_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export type LivenessSend = {
  id: string;
  audience: DigestAudience;
  state: DigestSendState;
  mcCampaignId: string | null;
  sentConfirmedAt: Date | null;
  sentVia: string | null;
};

/** Variants old enough to judge: confirmed done by polling ≥ 2 h before `now`. Pure. */
export function judgeableSends<T extends LivenessSend>(sends: readonly T[], now: Date): T[] {
  return sends.filter(
    (s) =>
      DONE_STATES.includes(s.state) &&
      s.mcCampaignId !== null &&
      s.sentConfirmedAt !== null &&
      s.sentVia !== 'webhook' &&
      now.getTime() - s.sentConfirmedAt.getTime() >= WEBHOOK_SILENT_AFTER_MS,
  );
}

/** The judgeable variants Mailercloud never called us about. Pure. */
export function silentSends<T extends LivenessSend>(sends: readonly T[], heard: ReadonlySet<string>, now: Date): T[] {
  return judgeableSends(sends, now).filter((s) => !heard.has(s.mcCampaignId as string));
}

/**
 * The `mcCampaignId`s of these sends that we received a campaign webhook for.
 * An event counts when it carries the campaign id OR was linked to the send
 * (`sendId`) by our campaign name: the normaliser accepts a name-only event and
 * links it, so judging by id alone would call a live webhook silent.
 */
async function heardCampaigns(sends: readonly Pick<LivenessSend, 'id' | 'mcCampaignId'>[]): Promise<Set<string>> {
  const ids = sends.map((s) => s.mcCampaignId).filter((v): v is string => !!v);
  if (sends.length === 0) return new Set();
  const rows = await prisma.emailEvent.findMany({
    where: {
      type: { in: [...CAMPAIGN_WEBHOOK_TYPES] },
      OR: [{ mcCampaignId: { in: ids } }, { sendId: { in: sends.map((s) => s.id) } }],
    },
    select: { mcCampaignId: true, sendId: true },
  });
  const byId = new Map(sends.map((s) => [s.id, s.mcCampaignId]));
  const heard = new Set<string>();
  for (const r of rows) {
    if (r.mcCampaignId) heard.add(r.mcCampaignId);
    const viaSend = r.sendId ? byId.get(r.sendId) : null;
    if (viaSend) heard.add(viaSend);
  }
  return heard;
}

const SEND_FIELDS = { id: true, audience: true, state: true, mcCampaignId: true, sentConfirmedAt: true, sentVia: true } as const;

/**
 * Raises `webhook_silent` on the run (once per run, through the shared marker
 * writer) when a variant of it is silent. Does nothing while the digest or its
 * webhooks are off. Returns the audiences found silent. Never throws.
 */
export async function checkWebhookLiveness(
  runId: string,
  opts: { now?: Date; cfg?: DigestEnv } = {},
): Promise<DigestAudience[]> {
  const cfg = opts.cfg ?? env.digest;
  if (!cfg.enabled || !cfg.webhooksEnabled) return [];
  const now = opts.now ?? new Date();
  try {
    const sends = await prisma.digestSend.findMany({ where: { runId, state: { in: DONE_STATES } }, select: SEND_FIELDS });
    const judge = judgeableSends(sends, now);
    if (judge.length === 0) return [];
    const silent = silentSends(judge, await heardCampaigns(judge), now);
    if (silent.length === 0) return [];
    await recordRunAlert(runId, 'webhook_silent', now, silent.length === 1 ? { audience: silent[0].audience } : {});
    return silent.map((s) => s.audience);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] run=${runId} webhook liveness check failed: ${redactError(err)}`);
    return [];
  }
}

export type WebhookHealth = {
  enabled: boolean;
  /**
   * true = Mailercloud called us about the most recent judgeable send;
   * false = it did not (re-enable the webhook); null = nothing to judge yet
   * (webhooks off, or no send confirmed ≥ 2 h ago in the last 14 days).
   */
  alive: boolean | null;
  /** When the last webhook event of any stored type arrived. */
  lastEventAt: string | null;
};

/** The `/api/digest/status` webhook field, judged on the most recent judgeable send. Never throws. */
export async function webhookHealth(opts: { portal: string; now?: Date; cfg?: DigestEnv }): Promise<WebhookHealth> {
  const cfg = opts.cfg ?? env.digest;
  if (!cfg.webhooksEnabled) return { enabled: false, alive: null, lastEventAt: null };
  const now = opts.now ?? new Date();
  try {
    const last = await prisma.emailEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } });
    const recent = await prisma.digestSend.findMany({
      where: {
        run: { portal: opts.portal },
        state: { in: DONE_STATES },
        mcCampaignId: { not: null },
        sentConfirmedAt: { gte: new Date(now.getTime() - STATUS_LOOKBACK_MS), lte: new Date(now.getTime() - WEBHOOK_SILENT_AFTER_MS) },
      },
      orderBy: { sentConfirmedAt: 'desc' },
      take: 4,
      select: SEND_FIELDS,
    });
    const judge = judgeableSends(recent, now);
    let alive: boolean | null = null;
    if (judge.length > 0) {
      const latest = judge[0];
      alive = (await heardCampaigns([latest])).has(latest.mcCampaignId as string);
    }
    return { enabled: true, alive, lastEventAt: last ? last.receivedAt.toISOString() : null };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] webhook health read failed: ${redactError(err)}`);
    return { enabled: true, alive: null, lastEventAt: null };
  }
}
