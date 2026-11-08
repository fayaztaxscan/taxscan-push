/**
 * Brief 2026-11-07-free-digest-segment (+ follow-up 1): the Send Free confirm dialog's title and text on the Digests screen.
 * Pure helpers from the admin SPA (no database, no network) — the repo has no SPA test runner, so admin helpers are
 * imported here, as digestScreen.test.ts does.
 */
import {
  SEND_FREE_CONFIRM_DETAIL,
  SEND_FREE_CONFIRM_DETAIL_SEGMENT,
  SEND_FREE_CONFIRM_TITLE_SEGMENT,
  SEND_FREE_SEGMENT_CHECK,
  freeConfirmDetail,
  freeConfirmTitle,
} from '../../admin/src/composables/digestView';

// The sentence the dialog has carried since 5 Nov, pinned here so a wording change in the helper cannot slip through.
const ORIGINAL =
  "It goes to the Free list straight away and only once today. Premium is not touched. A sent email can't be recalled.";
// The same sentence for a segment target (follow-up 1): only "list" becomes "segment".
const SEGMENT =
  "It goes to the Free segment straight away and only once today. Premium is not touched. A sent email can't be recalled.";
const CHECK = 'Before you press: refresh the Free segment in Mailercloud and check its count.';

describe('freeConfirmDetail (Send Free dialog text)', () => {
  it('keeps the original sentence byte-for-byte', () => {
    expect(SEND_FREE_CONFIRM_DETAIL).toBe(ORIGINAL);
  });

  it('false or missing: exactly the original sentence, no extra line', () => {
    expect(freeConfirmDetail(false)).toBe(ORIGINAL);
    expect(freeConfirmDetail(undefined)).toBe(ORIGINAL);
  });

  it('true: the segment sentence plus one check line, in plain words', () => {
    const t = freeConfirmDetail(true);
    expect(SEND_FREE_CONFIRM_DETAIL_SEGMENT).toBe(SEGMENT);
    expect(t).toBe(`${SEGMENT} ${CHECK}`);
    expect(t).toBe(`${SEND_FREE_CONFIRM_DETAIL_SEGMENT} ${SEND_FREE_SEGMENT_CHECK}`);
    expect(SEND_FREE_SEGMENT_CHECK).toBe(CHECK);
    expect(SEND_FREE_SEGMENT_CHECK.split('.').filter(Boolean)).toHaveLength(1); // one short sentence
  });

  it('true: says "the Free segment" and never "the Free list"', () => {
    const t = freeConfirmDetail(true);
    expect(t).toContain('It goes to the Free segment straight away');
    expect(t).not.toContain('Free list');
  });

  it('true: the segment sentence differs from the original in that one word only', () => {
    expect(SEGMENT.replace('Free segment', 'Free list')).toBe(ORIGINAL);
  });

  it('only a real true switches to the segment wording (a stray truthy value from a stale payload does not)', () => {
    expect(freeConfirmDetail(null as unknown as boolean)).toBe(ORIGINAL);
    expect(freeConfirmDetail('yes' as unknown as boolean)).toBe(ORIGINAL);
    expect(freeConfirmDetail(1 as unknown as boolean)).toBe(ORIGINAL);
  });
});

describe('freeConfirmTitle (Send Free dialog title)', () => {
  // The estimates the server can send: a size, no size yet (null / 0), or the field missing from an old payload.
  const estimates: Array<number | null | undefined> = [10066, 1, null, 0, undefined];

  // Today's rule, computed here with the same toLocaleString() call so no thousands separator is hard-coded.
  const today = (n: number | null | undefined) => (n ? `Free: ~${n.toLocaleString()} readers` : 'Free: full list');

  it('true: exactly "Free: the Free segment", whatever the last Free send reported', () => {
    expect(SEND_FREE_CONFIRM_TITLE_SEGMENT).toBe('Free: the Free segment');
    for (const n of estimates) expect(freeConfirmTitle(true, n)).toBe('Free: the Free segment');
  });

  it('true: no digit anywhere in the title, even with a large stale estimate', () => {
    expect(freeConfirmTitle(true, 10066)).not.toMatch(/\d/);
    expect(freeConfirmTitle(true, 10066)).not.toContain(Number(10066).toLocaleString());
  });

  it('false: today\'s title for every estimate', () => {
    for (const n of estimates) expect(freeConfirmTitle(false, n)).toBe(today(n));
  });

  it('missing (undefined): today\'s title for every estimate', () => {
    for (const n of estimates) expect(freeConfirmTitle(undefined, n)).toBe(today(n));
  });

  it('pins the two shapes of today\'s title', () => {
    expect(freeConfirmTitle(false, 10066)).toBe(`Free: ~${(10066).toLocaleString()} readers`);
    expect(freeConfirmTitle(false, 10066)).toMatch(/^Free: ~.*10.?066 readers$/);
    expect(freeConfirmTitle(false, null)).toBe('Free: full list');
    expect(freeConfirmTitle(false, 0)).toBe('Free: full list');
    expect(freeConfirmTitle(undefined, undefined)).toBe('Free: full list');
  });

  it('only a real true drops the number (null, a string or a number from a stale payload keep today\'s title)', () => {
    for (const stray of [null, 'yes', 1, 'true'] as unknown as boolean[]) {
      for (const n of estimates) expect(freeConfirmTitle(stray, n)).toBe(today(n));
    }
  });
});
