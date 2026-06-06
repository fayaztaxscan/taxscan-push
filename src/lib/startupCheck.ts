/**
 * Production startup self-check. Runs at the top of src/index.ts so a deploy
 * with missing required environment variables fails immediately instead of
 * coming up half-configured.
 */

const REQUIRED_VARS = [
  'DATABASE_URL',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'ADMIN_TOKEN',
  // ADMIN_PASSWORD was retired in Phase 5 — the single-shared-password
  // admin SPA login was replaced by per-user cookie sessions. Bearer
  // auth via ADMIN_TOKEN remains for cron / external scripts.
  'SESSION_COOKIE_SECRET',
] as const;

export type RequiredVar = (typeof REQUIRED_VARS)[number];

// SESSION_COOKIE_SECRET signs cookie sessions; a short secret weakens the
// signature. Mirrors the constraint in the USER_MANAGEMENT_PLAN.md Phase 2
// spec.
export const SESSION_COOKIE_SECRET_MIN_LENGTH = 32;

export function findMissingRequiredEnv(
  env: NodeJS.ProcessEnv = process.env,
): RequiredVar[] {
  return REQUIRED_VARS.filter((k) => {
    const v = env[k];
    return v === undefined || v === '' || v.trim() === '';
  });
}

export function findShortRequiredEnv(
  env: NodeJS.ProcessEnv = process.env,
): { name: RequiredVar; minLength: number; actualLength: number }[] {
  const v = env.SESSION_COOKIE_SECRET ?? '';
  if (v && v.length < SESSION_COOKIE_SECRET_MIN_LENGTH) {
    return [
      {
        name: 'SESSION_COOKIE_SECRET',
        minLength: SESSION_COOKIE_SECRET_MIN_LENGTH,
        actualLength: v.length,
      },
    ];
  }
  return [];
}

export function assertRequiredEnv(): void {
  const missing = findMissingRequiredEnv();
  const tooShort = findShortRequiredEnv();
  if (missing.length === 0 && tooShort.length === 0) return;

  /* eslint-disable no-console */
  console.error('');
  console.error('═══════════════════════════════════════════════════════════════');
  console.error('  [startup] FATAL: required environment variables missing or invalid');
  console.error('═══════════════════════════════════════════════════════════════');
  for (const k of missing) console.error('  • ' + k + '   (not set)');
  for (const s of tooShort)
    console.error(
      '  • ' + s.name + '   (too short: ' + s.actualLength + ' < ' + s.minLength + ' chars)',
    );
  console.error('');
  console.error('  Refusing to start. Set the missing values and re-deploy.');
  console.error('  See .env.example for the full list and defaults.');
  console.error('═══════════════════════════════════════════════════════════════');
  console.error('');
  /* eslint-enable no-console */

  process.exit(1);
}
