import dotenv from 'dotenv';

dotenv.config();

// Test-DB isolation. The Task 10d security audit found three jest-fixture
// subscribers had landed in the production Railway DB because tests were
// being pointed at the live connection string. The guard below:
//   1. Prefers DATABASE_URL_TEST when set — that's the test DB.
//   2. Refuses to run if DATABASE_URL looks Railway-shaped (production).
// See README → "Local test database" for setup options.
if (process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST.trim()) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

const dbUrl = process.env.DATABASE_URL ?? '';
if (/(?:proxy\.rlwy\.net|\.rlwy\.net|railway\.internal)/i.test(dbUrl)) {
  // Throw so jest surfaces the message into every failing suite. process.exit
  // here would just produce a cryptic "child process exception" with no hint
  // at the cause.
  throw new Error(
    [
      '',
      '[test setup] REFUSING to run jest against a production-shaped DATABASE_URL.',
      'Tests must use a separate database.',
      '',
      '  Fix:  set DATABASE_URL_TEST=<test-db-url> in your .env',
      '  See:  README → "Local test database" for two setup options',
      '        (docker compose, or a separate Railway Postgres).',
      '',
    ].join('\n'),
  );
}

if (!process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = 'test-admin-token';
}
if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = 'test-admin-pw';
}
