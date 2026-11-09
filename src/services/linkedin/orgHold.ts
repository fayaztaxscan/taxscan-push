/**
 * LinkedIn's per-page daily limit hold (brief 2026-11-09-small-fixes, item 5), in its own small module so the worker AND the page-status
 * helper (`services/social/pageStatus.ts`, brief 2026-11-09-social-page-alerts-pause) can read it without importing each other.
 *
 * A create call answered HTTP 429 `Organization post creation limit reached` holds THAT page until the next 00:00 UTC (05:30 IST). In
 * memory only, by design: a restart forgets it and the next such 429 sets it again.
 */

/** The reason on a row a page held by LinkedIn's own per-page daily limit SKIPPED. The screen turns it into words. */
export const ORG_DAILY_LIMIT = 'org_daily_limit';

/** page → { since, until } (ms): when the hold was set and when it ends. */
const holds = new Map<string, { since: number; until: number }>();

/** Test hook (and what a restart does): forget every hold. */
export function clearOrgHolds(): void {
  holds.clear();
}

/** The next 00:00 UTC after `t` (LinkedIn's day turns then = 05:30 IST). */
export const nextUtcMidnight = (t: Date): Date => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));

/** The hold on `page` at `now`, or null. An expired hold is forgotten here. */
export function orgHoldOf(page: string, now: Date): { since: Date; until: Date } | null {
  const h = holds.get(page);
  if (!h) return null;
  if (now.getTime() < h.until) return { since: new Date(h.since), until: new Date(h.until) };
  holds.delete(page);
  return null;
}

/** Is `page` held by LinkedIn's daily limit at `now`? */
export const isOrgHeld = (page: string, now: Date): boolean => orgHoldOf(page, now) !== null;

/** Hold `page` until the next 00:00 UTC. ONE log line per hold (a repeat of the same hold is silent). */
export function holdOrgPage(page: string, now: Date): Date {
  const until = nextUtcMidnight(now);
  const had = holds.get(page);
  holds.set(page, { since: had && now.getTime() < had.until ? had.since : now.getTime(), until: until.getTime() });
  // eslint-disable-next-line no-console
  if (had?.until !== until.getTime()) console.log(`[linkedin] page=${page} ${ORG_DAILY_LIMIT} held until ${until.toISOString()}`);
  return until;
}
