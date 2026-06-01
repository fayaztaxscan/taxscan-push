import { isQuietHours, nextAllowedAt, startOfTodayIST } from '../lib/quietHours';

const IST_OFFSET_MIN = 5 * 60 + 30;

function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MIN * 60 * 1000);
}

describe('isQuietHours — overnight window 23:00→07:00 IST', () => {
  const start = '23:00';
  const end = '07:00';

  it('is quiet at 02:00 IST', () => {
    expect(isQuietHours(ist(2026, 6, 1, 2, 0), start, end)).toBe(true);
  });
  it('is quiet at 23:00 IST (inclusive start)', () => {
    expect(isQuietHours(ist(2026, 6, 1, 23, 0), start, end)).toBe(true);
  });
  it('is quiet at 06:59 IST', () => {
    expect(isQuietHours(ist(2026, 6, 1, 6, 59), start, end)).toBe(true);
  });
  it('is NOT quiet at 07:00 IST (exclusive end)', () => {
    expect(isQuietHours(ist(2026, 6, 1, 7, 0), start, end)).toBe(false);
  });
  it('is NOT quiet at 12:00 IST', () => {
    expect(isQuietHours(ist(2026, 6, 1, 12, 0), start, end)).toBe(false);
  });
  it('is NOT quiet at 22:59 IST', () => {
    expect(isQuietHours(ist(2026, 6, 1, 22, 59), start, end)).toBe(false);
  });
});

describe('isQuietHours — same-day window 13:00→15:00 IST', () => {
  const start = '13:00';
  const end = '15:00';

  it('is quiet at 13:30 IST', () => {
    expect(isQuietHours(ist(2026, 6, 1, 13, 30), start, end)).toBe(true);
  });
  it('is NOT quiet at 12:59 IST', () => {
    expect(isQuietHours(ist(2026, 6, 1, 12, 59), start, end)).toBe(false);
  });
  it('is NOT quiet at 15:00 IST', () => {
    expect(isQuietHours(ist(2026, 6, 1, 15, 0), start, end)).toBe(false);
  });
});

describe('nextAllowedAt — overnight window 23:00→07:00 IST', () => {
  it('returns 07:00 IST today when called at 02:00 IST', () => {
    const now = ist(2026, 6, 1, 2, 0);
    const next = nextAllowedAt(now, '23:00', '07:00');
    expect(next.toISOString()).toBe(ist(2026, 6, 1, 7, 0).toISOString());
  });

  it('returns next-day 07:00 IST when called at 23:30 IST', () => {
    const now = ist(2026, 6, 1, 23, 30);
    const next = nextAllowedAt(now, '23:00', '07:00');
    expect(next.toISOString()).toBe(ist(2026, 6, 2, 7, 0).toISOString());
  });
});

describe('startOfTodayIST', () => {
  it('returns midnight IST for an early-morning UTC instant', () => {
    const now = ist(2026, 6, 1, 2, 30);
    expect(startOfTodayIST(now).toISOString()).toBe(ist(2026, 6, 1, 0, 0).toISOString());
  });

  it('handles the IST/UTC date rollover', () => {
    // 2026-06-01 23:30 IST is 2026-06-01 18:00 UTC — IST date is June 1
    const now = ist(2026, 6, 1, 23, 30);
    expect(startOfTodayIST(now).toISOString()).toBe(ist(2026, 6, 1, 0, 0).toISOString());
  });
});
