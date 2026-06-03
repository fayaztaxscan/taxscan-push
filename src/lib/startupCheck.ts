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
  'ADMIN_PASSWORD',
] as const;

export type RequiredVar = (typeof REQUIRED_VARS)[number];

export function findMissingRequiredEnv(
  env: NodeJS.ProcessEnv = process.env,
): RequiredVar[] {
  return REQUIRED_VARS.filter((k) => {
    const v = env[k];
    return v === undefined || v === '' || v.trim() === '';
  });
}

export function assertRequiredEnv(): void {
  const missing = findMissingRequiredEnv();
  if (missing.length === 0) return;

  /* eslint-disable no-console */
  console.error('');
  console.error('═══════════════════════════════════════════════════════════════');
  console.error('  [startup] FATAL: missing required environment variables');
  console.error('═══════════════════════════════════════════════════════════════');
  for (const k of missing) console.error('  • ' + k);
  console.error('');
  console.error('  Refusing to start. Set the missing values and re-deploy.');
  console.error('  See .env.example for the full list and defaults.');
  console.error('═══════════════════════════════════════════════════════════════');
  console.error('');
  /* eslint-enable no-console */

  process.exit(1);
}
