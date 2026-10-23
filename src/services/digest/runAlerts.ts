import { prisma } from '../../lib/prisma';
import { redactError } from './sender';

/**
 * Records an "alert needed" marker on `DigestRun.alerts`, at most once per
 * kind per run (docs/EMAIL_DIGEST_DESIGN.md §3 `alerts {kind: …}`).
 * `alerts.ts` emails it and stamps `emailedAt`; `/api/digest/status` lists it.
 *
 * The single writer for runner markers: the state machine (`runner.ts`) and
 * the webhook liveness check (`webhookLiveness.ts`) both come through here.
 * Atomic in SQL, so two callers cannot both raise the same kind. Never throws.
 * Returns true when THIS call wrote the marker.
 */
export async function recordRunAlert(
  runId: string,
  kind: string,
  now: Date,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const value = JSON.stringify({ raisedAt: now.toISOString(), emailedAt: null, ...detail });
  try {
    const n = await prisma.$executeRaw`
      UPDATE "DigestRun"
         SET alerts = alerts || jsonb_build_object(${kind}::text, ${value}::jsonb)
       WHERE id = ${runId} AND alerts -> ${kind}::text IS NULL`;
    return n === 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[digest] run=${runId} could not record alert ${kind}: ${redactError(err)}`);
    return false;
  }
}
