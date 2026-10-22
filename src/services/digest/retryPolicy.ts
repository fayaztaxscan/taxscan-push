/**
 * Digest retry policy and IST day arithmetic (docs/EMAIL_DIGEST_DESIGN.md §4).
 *
 * Owner ruling (2026-10-22): after the FIRST failure, retry at +1, +5 and
 * +15 minutes, then every 60 minutes, until the 17:00 IST cut-off. An attempt
 * that would land at or after the cut-off is not made — the send is SKIPPED.
 *
 * Everything here is pure, so the 17:00 boundary and the IST↔UTC conversion
 * are pinned by table tests.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MINUTE = 60 * 1000;

/** Minutes after the first failure for retries 1, 2 and 3; then +60 each. */
export const RETRY_OFFSETS_MIN = [1, 5, 15] as const;
export const RETRY_HOURLY_MIN = 60;

/**
 * When the next attempt is due, or null when it would be at/after the cut-off.
 *
 * @param firstFailureAt when the first attempt failed (the schedule is anchored here,
 *                       so a slow attempt does not stretch later retries)
 * @param attempts       failed attempts so far, ≥ 1 (1 → +1 m, 2 → +5 m, 3 → +15 m,
 *                       4 → +75 m, 5 → +135 m, …)
 * @param cutoff         the run's cut-off instant (`istInstant(runDate, cfg.cutoff)`)
 */
export function nextAttemptAt(firstFailureAt: Date, attempts: number, cutoff: Date): Date | null {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`nextAttemptAt: attempts must be an integer >= 1, got ${attempts}`);
  }
  const offsetMin =
    attempts <= RETRY_OFFSETS_MIN.length
      ? RETRY_OFFSETS_MIN[attempts - 1]
      : RETRY_OFFSETS_MIN[RETRY_OFFSETS_MIN.length - 1] + (attempts - RETRY_OFFSETS_MIN.length) * RETRY_HOURLY_MIN;
  const at = new Date(firstFailureAt.getTime() + offsetMin * MINUTE);
  return at.getTime() < cutoff.getTime() ? at : null;
}

/** The IST calendar date of an instant, as a Date at 00:00 UTC (how `@db.Date` round-trips). */
export function istDateOf(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/** "2026-10-23" for a runDate (00:00 UTC of the IST day). */
export function runDateKey(runDate: Date): string {
  return runDate.toISOString().slice(0, 10);
}

/** The UTC instant of IST wall-clock `hhmm` on the IST date `runDate`. */
export function istInstant(runDate: Date, hhmm: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`istInstant: invalid HH:MM "${hhmm}"`);
  // runDate's UTC calendar date IS the IST date; any time-of-day on it is ignored.
  const day = Date.UTC(runDate.getUTCFullYear(), runDate.getUTCMonth(), runDate.getUTCDate());
  return new Date(day + (Number(m[1]) * 60 + Number(m[2])) * MINUTE - IST_OFFSET_MS);
}

/**
 * True when `now` is at or past the run's cut-off. A later IST day is always
 * past it, which is what makes "never sent late on a later day" hold.
 */
export function isPastCutoff(now: Date, runDate: Date, cutoffHhmm: string): boolean {
  return now.getTime() >= istInstant(runDate, cutoffHhmm).getTime();
}
