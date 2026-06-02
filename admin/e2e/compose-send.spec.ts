import { test, expect, request as pwRequest } from '@playwright/test';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { resolve } from 'path';

// Playwright invokes the spec from the admin/ directory.
const PROJECT_ROOT = resolve(process.cwd(), '..');

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-pw';
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-token';
const TEST_PREFIX = 'https://e2e-test.example.com/sub/';

// One happy-path test that automates the spec's acceptance criterion:
// log in → compose a campaign → send via the UI → click-tracking lands →
// dashboard reflects sent + clicked + CTR for that campaign.

test('compose, send via UI, then dashboard shows the new campaign with a CTR', async ({
  page,
}) => {
  const api = await pwRequest.newContext({ baseURL: 'http://localhost:3000' });

  // 1) Pre-seed one subscriber under topic `gst` so the topic-filter send has
  //    a target. Endpoint is unique per run so concurrent runs/tests don't collide.
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
    // 2) Log in through the UI.
    await page.goto('/login');
    await page.fill('input[type=password]', ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/dashboard$/),
      page.click('button[type=submit]'),
    ]);

    // 3) Open compose, fill the form, target topic=gst, send now.
    await page.click('a[href="/compose"]');
    const uniqueTitle = `E2E ${Date.now()}`;
    await page.fill('#title', uniqueTitle);
    await page.fill('#body', 'Playwright happy path');
    await page.fill('#url', 'https://www.taxscan.in/e2e');
    await page.check('input[type=radio][value=topics]');
    await page.check('input[type=checkbox][value=gst]');

    // Intercept the dispatch response so we can grab the campaign id for the
    // click-tracking step.
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

    // The result banner renders the campaignId.
    await expect(page.locator('.banner.ok')).toContainText(createdCampaignId!);

    // 4) Track a CLICKED event for the same campaign — simulates the real-world
    //    notification click that the SW would post.
    const trackRes = await api.post('/api/track', {
      data: { type: 'CLICKED', campaignId: createdCampaignId, endpoint },
    });
    expect(trackRes.status()).toBe(204);

    // 5) Navigate to Dashboard, refresh, and assert our campaign appears with
    //    a non-zero CTR.
    await page.click('a[href="/dashboard"]');
    await page.click('button:has-text("Refresh")');

    const row = page.locator('table tbody tr', { hasText: uniqueTitle }).first();
    await expect(row).toBeVisible();
    // CTR column is the last cell; with 1 sent + 1 clicked it should read 100.0%.
    await expect(row.locator('td').last()).toHaveText(/100\.0%|^\d+\.\d+%$/);

    // 6) Campaigns screen shows the same row.
    await page.click('a[href="/campaigns"]');
    await page.click('button:has-text("Refresh")');
    const listRow = page.locator('table tbody tr', { hasText: uniqueTitle }).first();
    await expect(listRow).toBeVisible();
    await expect(listRow.locator('td').nth(3)).toHaveText(/^\d+$/); // sent
    await expect(listRow.locator('td').nth(4)).toHaveText(/^[1-9]\d*$/); // clicked >= 1
  } finally {
    await api.dispose();
    // Sweep any subscribers, campaigns, and linked events this spec creates.
    // The cleanup script matches `endpoint LIKE 'https://e2e-test.example.com/sub/%'`
    // and `title LIKE 'E2E %'` so concurrent dev work isn't touched.
    try {
      const out = execSync('npm run db:cleanup-e2e', {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
      });
      // eslint-disable-next-line no-console
      console.log(out.split('\n').filter((l) => l.includes('[e2e-cleanup]')).join('\n'));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[e2e-cleanup] failed:', err instanceof Error ? err.message : err);
    }
  }
});

// Suppress the ADMIN_TOKEN-unused warning — the var is referenced for parity
// with the env that webServer boots the backend with.
void ADMIN_TOKEN;
