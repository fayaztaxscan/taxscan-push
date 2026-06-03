import { findMissingRequiredEnv } from '../lib/startupCheck';

describe('startup self-check', () => {
  const REQUIRED = [
    'DATABASE_URL',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
    'ADMIN_TOKEN',
    'ADMIN_PASSWORD',
  ];

  it('returns empty when every required variable is set', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of REQUIRED) env[k] = 'present';
    expect(findMissingRequiredEnv(env)).toEqual([]);
  });

  it('reports a single missing variable', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of REQUIRED) env[k] = 'present';
    delete env.ADMIN_PASSWORD;
    expect(findMissingRequiredEnv(env)).toEqual(['ADMIN_PASSWORD']);
  });

  it('treats empty string and whitespace as missing', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of REQUIRED) env[k] = 'present';
    env.ADMIN_TOKEN = '';
    env.VAPID_PRIVATE_KEY = '   ';
    expect(findMissingRequiredEnv(env).sort()).toEqual(
      ['ADMIN_TOKEN', 'VAPID_PRIVATE_KEY'].sort(),
    );
  });

  it('reports every missing var when none are set', () => {
    expect(findMissingRequiredEnv({}).sort()).toEqual(REQUIRED.slice().sort());
  });
});
