import type { DigestBuild, DigestSendState } from '@prisma/client';
import { isPastCutoff, istDateOf, istInstant, nextAttemptAt, runDateKey } from '../services/digest/retryPolicy';
import { digestRunState, type DigestRunState } from '../services/digest/runState';
import { nextVerifyAt } from '../services/digest/runner';
import { SenderError, errorKind, redactError } from '../services/digest/sender';

/**
 * Email digest task 3 (docs/EMAIL_DIGEST_DESIGN.md §4, §10): the pure parts —
 * retry schedule incl. the 17:00 IST boundary, IST↔UTC day arithmetic, the
 * derived run state, and error classification/redaction. No DB.
 */

const IST_OFFSET_MIN = 5 * 60 + 30;
/** UTC instant of an IST wall-clock time. */
function ist(y: number, m: number, d: number, h: number, min = 0, s = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min, s) - IST_OFFSET_MIN * 60 * 1000);
}
const RUN_DATE = new Date('2026-10-23T00:00:00.000Z');
const CUTOFF = ist(2026, 10, 23, 17, 0);

describe('nextAttemptAt — +1, +5, +15 min after the first failure, then hourly, until 17:00 IST', () => {
  const first = ist(2026, 10, 23, 7, 30);
  it.each([
    [1, ist(2026, 10, 23, 7, 31)],
    [2, ist(2026, 10, 23, 7, 35)],
    [3, ist(2026, 10, 23, 7, 45)],
    [4, ist(2026, 10, 23, 8, 45)],
    [5, ist(2026, 10, 23, 9, 45)],
    [10, ist(2026, 10, 23, 14, 45)],
    [11, ist(2026, 10, 23, 15, 45)],
    [12, ist(2026, 10, 23, 16, 45)],
  ])('attempt %i → %s', (attempts, expected) => {
    expect(nextAttemptAt(first, attempts, CUTOFF)?.toISOString()).toBe(expected.toISOString());
  });

  it('is anchored on the first failure, not on when the last attempt ran', () => {
    // Three failures, the third at 07:45 — the 4th attempt is 08:45 regardless of how late attempt 3 ran.
    expect(nextAttemptAt(first, 4, CUTOFF)).toEqual(ist(2026, 10, 23, 8, 45));
  });

  it('returns null once the next attempt would be at or after the cut-off', () => {
    expect(nextAttemptAt(first, 13, CUTOFF)).toBeNull(); // would be 17:45
  });

  it('17:00 boundary: an attempt landing exactly on 17:00 is not made; 16:59 is', () => {
    expect(nextAttemptAt(ist(2026, 10, 23, 16, 59), 1, CUTOFF)).toBeNull(); // 17:00 exactly
    expect(nextAttemptAt(ist(2026, 10, 23, 16, 58), 1, CUTOFF)).toEqual(ist(2026, 10, 23, 16, 59));
    expect(nextAttemptAt(ist(2026, 10, 23, 16, 45), 3, CUTOFF)).toBeNull(); // 17:00 exactly
    expect(nextAttemptAt(ist(2026, 10, 23, 16, 44, 59), 3, CUTOFF)).toEqual(ist(2026, 10, 23, 16, 59, 59));
    expect(nextAttemptAt(ist(2026, 10, 23, 15, 45), 4, CUTOFF)).toBeNull(); // 15:45+75m = 17:00
  });

  it('a first failure in the afternoon gets the short retries, then nothing', () => {
    const f = ist(2026, 10, 23, 15, 0);
    expect(nextAttemptAt(f, 1, CUTOFF)).toEqual(ist(2026, 10, 23, 15, 1));
    expect(nextAttemptAt(f, 3, CUTOFF)).toEqual(ist(2026, 10, 23, 15, 15));
    expect(nextAttemptAt(f, 4, CUTOFF)).toEqual(ist(2026, 10, 23, 16, 15));
    expect(nextAttemptAt(f, 5, CUTOFF)).toBeNull(); // 17:15
  });

  it('rejects attempts < 1 or non-integers', () => {
    expect(() => nextAttemptAt(CUTOFF, 0, CUTOFF)).toThrow();
    expect(() => nextAttemptAt(CUTOFF, 1.5, CUTOFF)).toThrow();
  });
});

describe('IST day arithmetic', () => {
  it('17:00 IST on 23 Oct is 11:30 UTC', () => {
    expect(istInstant(RUN_DATE, '17:00').toISOString()).toBe('2026-10-23T11:30:00.000Z');
    expect(istInstant(RUN_DATE, '07:30').toISOString()).toBe('2026-10-23T02:00:00.000Z');
    expect(istInstant(RUN_DATE, '00:00').toISOString()).toBe('2026-10-22T18:30:00.000Z');
  });

  it('the IST date flips at 18:30 UTC, not at UTC midnight', () => {
    expect(runDateKey(istDateOf(new Date('2026-10-22T18:29:59.000Z')))).toBe('2026-10-22');
    expect(runDateKey(istDateOf(new Date('2026-10-22T18:30:00.000Z')))).toBe('2026-10-23');
    expect(runDateKey(istDateOf(new Date('2026-10-23T11:30:00.000Z')))).toBe('2026-10-23');
  });

  it('isPastCutoff: 16:59 is not, 17:00 is, and any later IST day is', () => {
    expect(isPastCutoff(ist(2026, 10, 23, 16, 59, 59), RUN_DATE, '17:00')).toBe(false);
    expect(isPastCutoff(ist(2026, 10, 23, 17, 0), RUN_DATE, '17:00')).toBe(true);
    expect(isPastCutoff(ist(2026, 10, 24, 7, 30), RUN_DATE, '17:00')).toBe(true);
    expect(isPastCutoff(ist(2026, 10, 23, 0, 1), RUN_DATE, '17:00')).toBe(false);
  });

  it('istInstant rejects a malformed time', () => {
    expect(() => istInstant(RUN_DATE, '7.30')).toThrow();
    expect(() => istInstant(RUN_DATE, '24:00')).toThrow();
  });
});

describe('nextVerifyAt — +10, +30, +60 min after scheduling, then hourly', () => {
  const at = ist(2026, 10, 23, 7, 30);
  it.each([
    [ist(2026, 10, 23, 7, 30), ist(2026, 10, 23, 7, 40)],
    [ist(2026, 10, 23, 7, 40), ist(2026, 10, 23, 8, 0)],
    [ist(2026, 10, 23, 8, 0), ist(2026, 10, 23, 8, 30)],
    [ist(2026, 10, 23, 8, 30), ist(2026, 10, 23, 9, 30)],
    [ist(2026, 10, 23, 9, 45), ist(2026, 10, 23, 10, 30)],
  ])('at %s → %s', (now, expected) => {
    expect(nextVerifyAt(at, now)).toEqual(expected);
  });
});

describe('digestRunState — one derived state for every combination', () => {
  const S = (...states: DigestSendState[]) => states.map((state) => ({ state }));
  const cases: [DigestBuild, DigestSendState[], DigestRunState][] = [
    ['BUILDING', [], 'building'],
    ['BUILD_FAILED', [], 'failed'],
    ['SKIPPED', [], 'skipped'],
    ['SKIPPED', ['PENDING', 'PENDING'], 'skipped'],
    ['BUILT', [], 'building'],
    ['BUILT', ['PENDING', 'PENDING'], 'building'],
    ['BUILT', ['PENDING', 'CREATED'], 'building'],
    ['BUILT', ['CREATED', 'CREATED'], 'created'],
    ['BUILT', ['CREATED', 'SCHEDULED'], 'created'],
    ['BUILT', ['SCHEDULED', 'SCHEDULED'], 'scheduled'],
    ['BUILT', ['SCHEDULED', 'SENT'], 'scheduled'],
    ['BUILT', ['SENT', 'SENT'], 'sent'],
    ['BUILT', ['SENT', 'PARTIALLY_SENT'], 'partially_sent'],
    ['BUILT', ['PARTIALLY_SENT', 'PARTIALLY_SENT'], 'partially_sent'],
    ['BUILT', ['SENT', 'SKIPPED'], 'partially_sent'],
    ['BUILT', ['SKIPPED', 'SKIPPED'], 'skipped'],
    ['BUILT', ['FAILED', 'SENT'], 'failed'],
    ['BUILT', ['FAILED', 'PENDING'], 'failed'],
    ['BUILT', ['FAILED', 'SKIPPED'], 'failed'],
    ['BUILT', ['SCHEDULED', 'SKIPPED'], 'scheduled'],
    ['BUILT', ['SENT'], 'sent'],
  ];
  it.each(cases)('build=%s sends=%j → %s', (build, states, expected) => {
    expect(digestRunState({ build }, S(...states))).toBe(expected);
    // Order-insensitive.
    expect(digestRunState({ build }, S(...[...states].reverse()))).toBe(expected);
  });
});

describe('sender errors', () => {
  it('only a SenderError carries its kind; anything else is RETRYABLE', () => {
    expect(errorKind(new SenderError('FATAL', 'bad key', { http: 401 }))).toBe('FATAL');
    expect(errorKind(new SenderError('AMBIGUOUS', 'timeout'))).toBe('AMBIGUOUS');
    expect(errorKind(new Error('socket hang up'))).toBe('RETRYABLE');
  });

  it('redactError masks addresses, keeps the code/http, truncates', () => {
    const msg = redactError(new SenderError('FATAL', 'quota exceeded for a.b+c@taxscan.in', { code: '9002', http: 400 }));
    expect(msg).not.toMatch(/@/);
    expect(msg).toContain('[email]');
    expect(msg).toContain('code=9002');
    expect(msg).toContain('http=400');
    expect(redactError(new Error('x'.repeat(1000))).length).toBe(300);
  });
});

describe('QA #8 redactError masks every secret-shaped thing', () => {
  it.each([
    ['URL-encoded address', 'bad recipient a.b%40taxscan.in', /taxscan\.in/],
    ['upper-case %40', 'to=A%40Example.COM', /Example/],
    ['api_key param', 'GET /v1?api_key=abc123SECRET&x=1', /abc123SECRET/],
    ['key param', 'failed: key=zzzSECRET', /zzzSECRET/],
    ['token param', 'webhook token=tok_SECRET_9', /tok_SECRET_9/],
    ['Authorization header', 'sent Authorization: rawkeySECRET123', /rawkeySECRET123/],
    ['Authorization Bearer', 'Authorization: Bearer bearerSECRET456', /bearerSECRET456/],
    ['JSON api key', '{"apiKey": "jsonSECRET789"}', /jsonSECRET789/],
  ])('%s', (_label, input, leak) => {
    expect(redactError(new Error(input), [])).not.toMatch(leak);
  });

  it('masks the configured key value itself wherever it appears', () => {
    const key = 'mc_live_9f8e7d6c5b4a';
    const out = redactError(new Error(`provider echoed ${key} in its body`), [key]);
    expect(out).not.toContain(key);
    expect(out).toContain('[secret]');
  });

  it('leaves ordinary words and the provider code alone', () => {
    const out = redactError(new SenderError('FATAL', 'monkey business: quota exceeded', { code: '9002', http: 400 }), []);
    expect(out).toBe('monkey business: quota exceeded (http=400 code=9002)');
  });
});
