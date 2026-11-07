/**
 * Brief 2026-11-07-free-digest-segment: the Send Free confirm dialog's text on the Digests screen.
 * Pure helper from the admin SPA (no database, no network) — the repo has no SPA test runner, so admin helpers are
 * imported here, as digestScreen.test.ts does.
 */
import {
  SEND_FREE_CONFIRM_DETAIL,
  SEND_FREE_SEGMENT_CHECK,
  freeConfirmDetail,
} from '../../admin/src/composables/digestView';

// The sentence the dialog has carried since 5 Nov, pinned here so a wording change in the helper cannot slip through.
const ORIGINAL =
  "It goes to the Free list straight away and only once today. Premium is not touched. A sent email can't be recalled.";

describe('freeConfirmDetail (Send Free dialog text)', () => {
  it('keeps the original sentence byte-for-byte', () => {
    expect(SEND_FREE_CONFIRM_DETAIL).toBe(ORIGINAL);
  });

  it('false or missing: exactly the original sentence, no extra line', () => {
    expect(freeConfirmDetail(false)).toBe(ORIGINAL);
    expect(freeConfirmDetail(undefined)).toBe(ORIGINAL);
  });

  it('true: the original sentence plus one check line, in plain words', () => {
    const t = freeConfirmDetail(true);
    expect(t.startsWith(ORIGINAL)).toBe(true);
    expect(t).toBe(`${ORIGINAL} ${SEND_FREE_SEGMENT_CHECK}`);
    expect(SEND_FREE_SEGMENT_CHECK).toBe('Before you press: refresh the Free segment in Mailercloud and check its count.');
    expect(SEND_FREE_SEGMENT_CHECK.split('.').filter(Boolean)).toHaveLength(1); // one short sentence
  });

  it('only a real true adds the line (a stray truthy value from a stale payload does not)', () => {
    expect(freeConfirmDetail(null as unknown as boolean)).toBe(ORIGINAL);
    expect(freeConfirmDetail('yes' as unknown as boolean)).toBe(ORIGINAL);
  });
});
