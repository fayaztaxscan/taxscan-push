const IST_OFFSET_MIN = 5 * 60 + 30;

function parseHHMM(s: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) throw new Error(`Invalid HH:MM value: ${s}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid HH:MM value: ${s}`);
  }
  return { hours, minutes };
}

function toMinutes(t: { hours: number; minutes: number }): number {
  return t.hours * 60 + t.minutes;
}

function getISTComponents(now: Date) {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    day: ist.getUTCDate(),
    hours: ist.getUTCHours(),
    minutes: ist.getUTCMinutes(),
  };
}

function makeISTInstant(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): Date {
  return new Date(Date.UTC(year, month, day, hours, minutes) - IST_OFFSET_MIN * 60 * 1000);
}

export function isQuietHours(now: Date, startHHMM: string, endHHMM: string): boolean {
  const start = toMinutes(parseHHMM(startHHMM));
  const end = toMinutes(parseHHMM(endHHMM));
  if (start === end) return false;
  const c = getISTComponents(now);
  const nowMin = c.hours * 60 + c.minutes;
  if (start < end) {
    return nowMin >= start && nowMin < end;
  }
  return nowMin >= start || nowMin < end;
}

export function nextAllowedAt(now: Date, _startHHMM: string, endHHMM: string): Date {
  const end = parseHHMM(endHHMM);
  const c = getISTComponents(now);
  let candidate = makeISTInstant(c.year, c.month, c.day, end.hours, end.minutes);
  if (candidate <= now) {
    candidate = makeISTInstant(c.year, c.month, c.day + 1, end.hours, end.minutes);
  }
  return candidate;
}

export function startOfTodayIST(now: Date): Date {
  const c = getISTComponents(now);
  return makeISTInstant(c.year, c.month, c.day, 0, 0);
}

/** IST minutes-since-midnight for an instant (e.g. 07:30 IST → 450). */
export function istMinutesOfDay(now: Date): number {
  const c = getISTComponents(now);
  return c.hours * 60 + c.minutes;
}

/** True if `now` (IST) is at or after midnight and strictly before HH:MM. */
export function isBeforeIST(now: Date, hhmm: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Invalid HH:MM value: ${hhmm}`);
  return istMinutesOfDay(now) < Number(m[1]) * 60 + Number(m[2]);
}
