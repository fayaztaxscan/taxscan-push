import type { DigestBuild, DigestSendState } from '@prisma/client';

/**
 * The ONE definition of a digest run's displayed state
 * (docs/EMAIL_DIGEST_DESIGN.md §3). Derived from `DigestRun.build` and the
 * variants' `DigestSend.state`; never stored anywhere else. Pure and
 * order-insensitive, so the Digests screen, the banner and the alerts agree.
 */
export type DigestRunState =
  | 'building'
  | 'created'
  | 'scheduled'
  | 'sent'
  | 'partially_sent'
  | 'failed'
  | 'skipped';

/**
 * Precedence, first match wins:
 *  1. build SKIPPED → skipped; BUILD_FAILED → failed; BUILDING (or BUILT with
 *     no variants yet) → building.
 *  2. Any variant FAILED → failed (it needs a human, so it outranks progress).
 *  3. Any variant still in flight → the LEAST advanced one: PENDING (draft not
 *     created yet) → building, CREATED → created, SCHEDULED → scheduled.
 *  4. All variants finished: all SENT → sent; all SKIPPED → skipped; any other
 *     mix (a PARTIALLY_SENT, or SENT + SKIPPED) → partially_sent — some of the
 *     audience got today's digest and some did not.
 */
export function digestRunState(
  run: { build: DigestBuild },
  sends: ReadonlyArray<{ state: DigestSendState }>,
): DigestRunState {
  if (run.build === 'SKIPPED') return 'skipped';
  if (run.build === 'BUILD_FAILED') return 'failed';
  if (run.build === 'BUILDING' || sends.length === 0) return 'building';

  const states = new Set(sends.map((s) => s.state));
  if (states.has('FAILED')) return 'failed';
  if (states.has('PENDING')) return 'building';
  if (states.has('CREATED')) return 'created';
  if (states.has('SCHEDULED')) return 'scheduled';

  if (states.size === 1 && states.has('SENT')) return 'sent';
  if (states.size === 1 && states.has('SKIPPED')) return 'skipped';
  return 'partially_sent';
}
