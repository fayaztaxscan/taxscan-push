import { test, expect, request as pwRequest } from '@playwright/test';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { resolve } from 'path';
// Node's resolution walks upward; the @prisma/client + bcrypt installs
// live in the project root's node_modules, so this works without a
// duplicate install in admin/.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const PROJECT_ROOT = resolve(process.cwd(), '..');

const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-token';
const TEST_PREFIX = 'https://e2e-test.example.com/sub/';

// The bcrypt cost is intentionally low (4) — this user only exists for
// the duration of the spec, and the lower cost shaves ~1s off the test.
const BCRYPT_COST = 4;

// Unique per-run admin email so concurrent runs don't collide.
const E2E_ADMIN_EMAIL = `e2e-admin-${Date.now()}-${randomBytes(4).toString(
  'hex',
)}@e2e-test.example.com`.toLowerCase();
const E2E_ADMIN_PASSWORD = 'E2eTestPassword123A';

let prisma: PrismaClient;
let seededUserId: string | null = null;

test.beforeAll(async () => {
  prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(E2E_ADMIN_PASSWORD, BCRYPT_COST);
  const u = await prisma.user.create({
    data: {
      email: E2E_ADMIN_EMAIL,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
      passwordResetRequired: false,
    },
  });
  seededUserId = u.id;
});

test.afterAll(async () => {
  if (seededUserId) {
    // The carve-out lets us purge AuditLog rows the test wrote (LOGIN_SUCCESS
    // for this admin, CAMPAIGN_DISPATCHED for the sent campaign, etc.).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${seededUserId!}`;
    });
    await prisma.user.delete({ where: { id: seededUserId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

test('compose, send via UI, then dashboard shows the new campaign with a CTR', async ({
  page,
}) => {
  const api = await pwRequest.newContext({ baseURL: 'http://localhost:3000' });

  // 1) Pre-seed one subscriber under topic `gst`.
  const endpoint = `${TEST_PREFIX}${Date.now()}-${randomBytes(4).toString('hex')}`;
  const keys = {
    p256dh: randomBytes(65).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
  const subscribeRes = await api.post('/api/subscribe', {
    data: {
      subscription: { endpoint, keys },
      portal: 'taxscan',
      topics: ['gst'],
      userAgent: 'e2e-playwright',
    },
  });
  expect(subscribeRes.status()).toBe(201);

  let createdCampaignId: string | null = null;

  try {
    // 2) Log in through the UI — new email + password flow.
    await page.goto('/login');
    await page.fill('input[type=email]', E2E_ADMIN_EMAIL);
    await page.fill('input[type=password]', E2E_ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/dashboard$/),
      page.click('button[type=submit]'),
    ]);

    // Header should show the user's email + role.
    await expect(page.locator('.nav-email')).toHaveText(E2E_ADMIN_EMAIL);
    await expect(page.locator('.role-badge')).toHaveText('ADMIN');

    // 3) Open compose, fill the form, target topic=gst, send now.
    await page.click('a[href="/compose"]');
    const uniqueTitle = `E2E ${Date.now()}`;
    await page.fill('#title', uniqueTitle);
    await page.fill('#body', 'Playwright happy path');
    await page.fill('#url', 'https://www.taxscan.in/e2e');
    await page.check('input[type=radio][value=topics]');
    await page.check('input[type=checkbox][value=gst]');

    const sendResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/send') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.click('button:has-text("Send now")');
    const resp = await sendResponse;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe('SENT');
    expect(body.sent).toBeGreaterThanOrEqual(1);
    createdCampaignId = body.campaignId;
    expect(createdCampaignId).toBeTruthy();

    await expect(page.locator('.banner.ok')).toContainText(createdCampaignId!);

    // 4) Track a CLICKED event for the same campaign.
    const trackRes = await api.post('/api/track', {
      data: { type: 'CLICKED', campaignId: createdCampaignId, endpoint },
    });
    expect(trackRes.status()).toBe(204);

    // 5) Dashboard reflects the new campaign with a CTR.
    await page.click('a[href="/dashboard"]');
    await page.click('button:has-text("Refresh")');
    const row = page.locator('table tbody tr', { hasText: uniqueTitle }).first();
    await expect(row).toBeVisible();
    await expect(row.locator('td').last()).toHaveText(/100\.0%|^\d+\.\d+%$/);

    // 6) Campaigns page shows the same row.
    await page.click('a[href="/campaigns"]');
    await page.click('button:has-text("Refresh")');
    const listRow = page.locator('table tbody tr', { hasText: uniqueTitle }).first();
    await expect(listRow).toBeVisible();
    await expect(listRow.locator('td').nth(3)).toHaveText(/^\d+$/); // sent
    await expect(listRow.locator('td').nth(4)).toHaveText(/^[1-9]\d*$/); // clicked >= 1

    // 7) Verify Phase 4 attribution: the campaign was attributed to the
    //    logged-in admin via the cookie session.
    expect(createdCampaignId).toBeTruthy();
    const reloaded = await prisma.campaign.findUnique({
      where: { id: createdCampaignId! },
    });
    expect(reloaded?.createdByUserId).toBe(seededUserId);

    // 8) Log out — should redirect to /login and prevent further API calls.
    await page.click('button.logout');
    await page.waitForURL(/\/login$/);
  } finally {
    await api.dispose();
    try {
      const out = execSync('npm run db:cleanup-e2e', {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
      });
      // eslint-disable-next-line no-console
      console.log(
        out
          .split('\n')
          .filter((l) => l.includes('[e2e-cleanup]'))
          .join('\n'),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[e2e-cleanup] failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
});

// Suppress unused-var warning — kept for env parity with playwright.config.ts.
void ADMIN_TOKEN;
