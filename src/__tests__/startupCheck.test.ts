import {
  findMissingRequiredEnv,
  findShortRequiredEnv,
  SESSION_COOKIE_SECRET_MIN_LENGTH,
} from '../lib/startupCheck';

// Mirror of the REQUIRED list in startupCheck.ts. Kept in sync by hand —
// the assertion at the bottom guards the test from drifting.
const REQUIRED = [
  'DATABASE_URL',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'ADMIN_TOKEN',
  'ADMIN_PASSWORD',
  'SESSION_COOKIE_SECRET',
] as const;

const LONG_SECRET = 'x'.repeat(SESSION_COOKIE_SECRET_MIN_LENGTH);

function fullEnv(overrides: Partial<Record<(typeof REQUIRED)[number], string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of REQUIRED) env[k] = k === 'SESSION_COOKIE_SECRET' ? LONG_SECRET : 'present';
  Object.assign(env, overrides);
  return env;
}

describe('startup self-check: missing required vars', () => {
  it('returns empty when every required variable is set', () => {
    expect(findMissingRequiredEnv(fullEnv())).toEqual([]);
  });

  it('reports a single missing variable', () => {
    const env = fullEnv();
    delete env.ADMIN_PASSWORD;
    expect(findMissingRequiredEnv(env)).toEqual(['ADMIN_PASSWORD']);
  });

  it('treats empty string and whitespace as missing', () => {
    const env = fullEnv({ ADMIN_TOKEN: '', VAPID_PRIVATE_KEY: '   ' });
    expect(findMissingRequiredEnv(env).sort()).toEqual(
      ['ADMIN_TOKEN', 'VAPID_PRIVATE_KEY'].sort(),
    );
  });

  it('reports every missing var when none are set', () => {
    expect(findMissingRequiredEnv({}).sort()).toEqual([...REQUIRED].sort());
  });
});

describe('startup self-check: SESSION_COOKIE_SECRET length', () => {
  it('returns empty when the secret meets the minimum length', () => {
    expect(findShortRequiredEnv(fullEnv())).toEqual([]);
  });

  it('flags a secret that is set but too short', () => {
    const env = fullEnv({ SESSION_COOKIE_SECRET: 'too-short' });
    const result = findShortRequiredEnv(env);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('SESSION_COOKIE_SECRET');
    expect(result[0].actualLength).toBe('too-short'.length);
    expect(result[0].minLength).toBe(SESSION_COOKIE_SECRET_MIN_LENGTH);
  });

  it('does not flag a missing secret as too-short (the missing check owns that)', () => {
    expect(findShortRequiredEnv({})).toEqual([]);
  });
});
