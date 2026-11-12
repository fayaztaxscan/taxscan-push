/**
 * Jest environment = jest-environment-node + ONE database lock for the audience suites.
 *
 * Why (brief 2026-11-09-audience-test-flake): `AudienceMember` and `CmsAccount` have no portal
 * scope, and the pull's change cap (`pull.ts`, `mailedBefore`) is a percentage of ALL mailed
 * members in the table. Every audience suite uses its own portal for sync state, but the members
 * themselves are shared, so two suites in parallel jest workers saw each other's rows: the cap
 * moved under a running test and the Release check failed on its first run (9 Nov, twice).
 *
 * How: a suite whose source names those tables (or imports a service that writes them) takes a
 * Postgres session advisory lock in `setup()` and gives it back in `teardown()`. `teardown()` runs
 * AFTER the file's own `afterAll` cleanup (a lock released from an `afterAll` hook would be
 * released first: circus runs same-level hooks in definition order), so the next suite always
 * starts on a table its predecessor has already cleaned. Everything else runs in parallel as before.
 *
 * - Automatic: a new audience suite is covered by what its source says, with no list to forget.
 * - Crash-safe: the lock belongs to a database session, so a killed worker releases it at once.
 * - Per database: advisory locks are per DB, so the dev DB and a build DB never wait on each other.
 * - One connection, kept warm: Prisma may close an idle connection (and with it the lock).
 *
 * Plain CommonJS on purpose: Jest loads a test environment before any TypeScript transform.
 */
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { TestEnvironment: NodeEnvironment } = require('jest-environment-node');

/** Arbitrary constant, only has to be the same in every worker. */
const LOCK_KEY = 827411;
const POLL_MS = 250;
/** Longest a suite waits for the others: far above any audience suite, far below "hung". */
const MAX_WAIT_MS = 20 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

/** Suites that read or write the shared audience tables, directly or through the services that do. */
const SHARED_AUDIENCE_TABLES = /\b(?:audienceMember|cmsAccount)\b|services\/audience\/(?:pull|writer|ingest|statusImport)\b/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function needsAudienceLock(testPath) {
  try {
    return SHARED_AUDIENCE_TABLES.test(fs.readFileSync(testPath, 'utf8'));
  } catch {
    return false;
  }
}

/** DATABASE_URL (from the same .env the suites load in setup.ts) limited to one connection. */
function lockConnectionUrl(rootDir) {
  // Never overrides a variable already set, exactly like src/__tests__/setup.ts.
  require('dotenv').config({ path: path.join(rootDir, '.env') });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('jest.environment.js: DATABASE_URL is not set, cannot take the audience-tables lock');
  const url = new URL(raw);
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

async function takeAudienceLock(rootDir, testPath) {
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: lockConnectionUrl(rootDir), log: [] });
  const deadline = Date.now() + MAX_WAIT_MS;
  try {
    for (;;) {
      const rows = await db.$queryRaw`SELECT pg_try_advisory_lock(${LOCK_KEY}::bigint) AS ok`;
      if (rows[0] && rows[0].ok === true) break;
      if (Date.now() > deadline) {
        throw new Error(`jest.environment.js: ${path.basename(testPath)} waited ${MAX_WAIT_MS / 60000} min for the audience-tables lock`);
      }
      await sleep(POLL_MS);
    }
  } catch (err) {
    await db.$disconnect().catch(() => undefined);
    throw err;
  }
  const heartbeat = setInterval(() => {
    db.$queryRaw`SELECT 1`.catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    async release() {
      clearInterval(heartbeat);
      try {
        await db.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`;
      } finally {
        await db.$disconnect();
      }
    },
  };
}

class AudienceLockEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.audienceRootDir = config.projectConfig.rootDir;
    this.audienceTestPath = context.testPath;
    this.audienceLock = null;
  }

  async setup() {
    await super.setup();
    if (needsAudienceLock(this.audienceTestPath)) {
      this.audienceLock = await takeAudienceLock(this.audienceRootDir, this.audienceTestPath);
    }
  }

  async teardown() {
    try {
      if (this.audienceLock) await this.audienceLock.release();
    } finally {
      this.audienceLock = null;
      await super.teardown();
    }
  }
}

module.exports = AudienceLockEnvironment;
