import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

// Nav groups (Push / Email / Admin). Needs the usual e2e stack (backend + DB
// + Vite on :5173), like users.spec.ts. Desktop width so the Admin dropdown
// (not the hamburger) is exercised.
const PASSWORD = 'NavGroupsEndToEndPw1Aa';
const DOMAIN = '@navgroups-e2e.example.com';
const uniq = (p: string) => `${p}-${Date.now()}-${randomBytes(4).toString('hex')}${DOMAIN}`;

let prisma: PrismaClient;
test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  prisma = new PrismaClient();
});
test.afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`
      DELETE FROM "AuditLog"
      WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE '%@navgroups-e2e.example.com')
         OR (metadata->>'email') LIKE '%@navgroups-e2e.example.com'
    `;
  });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await prisma.$disconnect();
});

async function loginAs(page: Page, role: 'ADMIN' | 'PUBLISHER'): Promise<void> {
  const email = uniq(role.toLowerCase());
  await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role,
      isActive: true,
      passwordResetRequired: false,
    },
  });
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await Promise.all([
    page.waitForURL((url: URL) => !url.pathname.endsWith('/login')),
    page.click('button[type=submit]'),
  ]);
}

const link = (page: Page, name: string) =>
  page.locator('.nav-menu').getByRole('link', { name, exact: true });

test('ADMIN sees every group and the Admin menu reveals Users + Activity', async ({ page }) => {
  await loginAs(page, 'ADMIN');
  for (const n of ['Dashboard', 'Compose', 'Review', 'Queue', 'Campaigns', 'Digests', 'Ads', 'Templates', 'Reports']) {
    await expect(link(page, n)).toBeVisible();
  }
  const btn = page.getByRole('button', { name: /^Admin/ });
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(link(page, 'Users')).toBeHidden();

  // click opens / closes
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(link(page, 'Users')).toBeVisible();
  await expect(link(page, 'Activity')).toBeVisible();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');

  // Escape closes and returns focus to the button
  await btn.click();
  await page.keyboard.press('Escape');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toBeFocused();

  // outside click closes
  await btn.click();
  await page.locator('main, .page').first().click({ position: { x: 5, y: 5 } });
  await expect(btn).toHaveAttribute('aria-expanded', 'false');

  // route change closes
  await btn.click();
  await link(page, 'Users').click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('PUBLISHER has no Admin button and no Users/Activity links', async ({ page }) => {
  await loginAs(page, 'PUBLISHER');
  await expect(link(page, 'Compose')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Admin/ })).toHaveCount(0);
  await expect(page.locator('.nav-menu a[href="/users"], .nav-menu a[href="/activity"]')).toHaveCount(0);
});

test('active route emphasises its group label', async ({ page }) => {
  await loginAs(page, 'PUBLISHER');
  await page.goto('/ads');
  await expect(page.locator('.nav-label[data-group="email"]')).toHaveClass(/active/);
  await expect(page.locator('.nav-label[data-group="push"]')).not.toHaveClass(/active/);
  await expect(link(page, 'Ads')).toHaveClass(/router-link-active/);
  await page.goto('/review');
  await expect(page.locator('.nav-label[data-group="push"]')).toHaveClass(/active/);
});
