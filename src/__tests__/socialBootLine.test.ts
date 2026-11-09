import { socialAnyLinkBootLine } from '../services/social/allPushes';

/**
 * Brief 2026-11-09-small-fixes, item 3: the one start-up line for SOCIAL_ANY_LINK_FROM, like the other every-push variables' lines.
 * Pure formatter: set / unset / invalid. Names only: never a value that is not a valid time.
 */
describe('socialAnyLinkBootLine', () => {
  it('set (a strict ISO time) → on, with the time as an ISO string', () => {
    expect(socialAnyLinkBootLine({ SOCIAL_ANY_LINK_FROM: '2026-11-07T13:45:53Z' })).toBe('[social] any allowed link posts (from 2026-11-07T13:45:53.000Z)');
    expect(socialAnyLinkBootLine({ SOCIAL_ANY_LINK_FROM: '  2026-11-07T19:15:53+05:30  ' })).toBe('[social] any allowed link posts (from 2026-11-07T13:45:53.000Z)');
    expect(socialAnyLinkBootLine({ SOCIAL_ANY_LINK_FROM: '2026-11-07' })).toBe('[social] any allowed link posts (from 2026-11-07T00:00:00.000Z)');
  });

  it('unset or blank → off, "is not set"', () => {
    const want = '[social] any-link rule off: SOCIAL_ANY_LINK_FROM is not set';
    expect(socialAnyLinkBootLine({})).toBe(want);
    expect(socialAnyLinkBootLine({ SOCIAL_ANY_LINK_FROM: '' })).toBe(want);
    expect(socialAnyLinkBootLine({ SOCIAL_ANY_LINK_FROM: '   ' })).toBe(want);
  });

  it('invalid → off, "is not a valid ISO time", and the bad value is never printed', () => {
    for (const bad of ['soon', 'Nov 7', '07/11/2026', '2026', '2026-13-45', '1700000000000']) {
      const line = socialAnyLinkBootLine({ SOCIAL_ANY_LINK_FROM: bad });
      expect(line).toBe('[social] any-link rule off: SOCIAL_ANY_LINK_FROM is not a valid ISO time');
      expect(line).not.toContain(bad);
    }
  });

  it('reads the process environment by default (the same variable the rule itself reads)', () => {
    const saved = process.env.SOCIAL_ANY_LINK_FROM;
    try {
      process.env.SOCIAL_ANY_LINK_FROM = '2026-11-09T10:00:00Z';
      expect(socialAnyLinkBootLine()).toBe('[social] any allowed link posts (from 2026-11-09T10:00:00.000Z)');
      delete process.env.SOCIAL_ANY_LINK_FROM;
      expect(socialAnyLinkBootLine()).toBe('[social] any-link rule off: SOCIAL_ANY_LINK_FROM is not set');
    } finally {
      if (saved === undefined) delete process.env.SOCIAL_ANY_LINK_FROM;
      else process.env.SOCIAL_ANY_LINK_FROM = saved;
    }
  });
});
