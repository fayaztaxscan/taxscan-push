import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { PrismaClient, type User } from '@prisma/client';
import bcrypt from 'bcrypt';

const BCRYPT_COST = 4;
const ADMIN_PASSWORD = 'AdminEndToEndPw1Aa';
const PUB_PASSWORD = 'PublisherEndToEndPw1Aa';

function uniqEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString(
    'hex',
  )}@users-e2e.example.com`.toLowerCase();
}

let prisma: PrismaClient;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  prisma = new PrismaClient();
});

test.afterAll(async () => {
  // Sweep any AuditLog rows + Users created in this file's run by email
  // pattern. The carve-out lets us purge the audit rows the trigger
  // would otherwise block.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`
      DELETE FROM "AuditLog"
      WHERE (metadata->>'email') LIKE '%@users-e2e.example.com'
         OR "userId" IN (
              SELECT id FROM "User" WHERE email LIKE '%@users-e2e.example.com'
            )
    `;
  });
  await prisma.user.deleteMany({
    where: { email: { endsWith: '@users-e2e.example.com' } },
  });
  await prisma.$disconnect();
});

async function loginViaUi(
  page: Parameters<typeof test>[1]['page'] extends never ? never : import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/login')),
    page.click('button[type=submit]'),
  ]);
}

async function seedAdmin(): Promise<User> {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_COST);
  return prisma.user.create({
    data: {
      email: uniqEmail('admin'),
      passwordHash,
      role: 'ADMIN',
      isActive: true,
      passwordResetRequired: false,
    },
  });
}

async function seedPublisher(): Promise<User> {
  const passwordHash = await bcrypt.hash(PUB_PASSWORD, BCRYPT_COST);
  return prisma.user.create({
    data: {
      email: uniqEmail('pub'),
      passwordHash,
      role: 'PUBLISHER',
      isActive: true,
      passwordResetRequired: false,
    },
  });
}

test('admin can manage users end-to-end: create, reset, change role, deactivate, reactivate', async ({
  page,
}) => {
  const admin = await seedAdmin();
  await loginViaUi(page, admin.email, ADMIN_PASSWORD);

  // Nav shows Users for ADMIN.
  await page.click('a[href="/users"]');
  await page.waitForURL(/\/users$/);
  await expect(page.locator('.section-title')).toHaveText('Users');

  // === Create user ===
  await page.click('button:has-text("Create user")');
  const newEmail = uniqEmail('created');
  await page.fill('input#cu-email', newEmail);
  await page.check('input[type=radio][value=PUBLISHER]');

  // Click Create; expect the temp-password block to appear.
  await page.click('.modal-card button:has-text("Create")');
  const tempPwBlock = page.locator('[data-testid="temp-password"]');
  await expect(tempPwBlock).toBeVisible({ timeout: 5_000 });
  const tempPasswordCreate = (await tempPwBlock.locator('code').textContent())?.trim() ?? '';
  expect(tempPasswordCreate.length).toBe(16);

  // Close the success state — list refreshes and the new user appears.
  await page.click('.modal-card button:has-text("Done")');
  await expect(page.locator(`tbody tr:has-text("${newEmail}")`)).toBeVisible();

  // === Reset password ===
  const row = page.locator(`tbody tr:has-text("${newEmail}")`).first();
  await row.locator('button:has-text("Reset password")').click();
  await page.click('.modal-card button:has-text("Reset password")');
  const resetBlock = page.locator('[data-testid="temp-password"]');
  await expect(resetBlock).toBeVisible({ timeout: 5_000 });
  const tempPasswordReset = (await resetBlock.locator('code').textContent())?.trim() ?? '';
  expect(tempPasswordReset.length).toBe(16);
  expect(tempPasswordReset).not.toBe(tempPasswordCreate); // different password each time
  await page.click('.modal-card button:has-text("Done")');

  // === Change role (PUBLISHER → ADMIN) ===
  await row.locator('button:has-text("Make ADMIN")').click();
  await page.click('.modal-card button:has-text("Change role")');
  // After save the list reloads and the row should show ADMIN.
  await expect(
    page.locator(`tbody tr:has-text("${newEmail}") .role-badge`),
  ).toHaveText('ADMIN');

  // === Deactivate ===
  // With multiple ADMINs now, deactivating one is allowed.
  await row.locator('button:has-text("Deactivate")').click();
  await page.click('.modal-card button:has-text("Deactivate")');
  // Inactive rows are hidden by default; the row should disappear.
  await expect(page.locator(`tbody tr:has-text("${newEmail}")`)).toHaveCount(0);

  // === Reactivate via "Show deactivated" ===
  await page.check('input[type=checkbox]'); // the includeInactive toggle
  await expect(page.locator(`tbody tr:has-text("${newEmail}")`)).toBeVisible();
  await page
    .locator(`tbody tr:has-text("${newEmail}")`)
    .first()
    .locator('button:has-text("Reactivate")')
    .click();
  await page.click('.modal-card button:has-text("Reactivate")');
  await expect(
    page
      .locator(`tbody tr:has-text("${newEmail}")`)
      .first()
      .locator('.status-pill.active'),
  ).toBeVisible();
});

test('PUBLISHER does not see the Users nav link, and direct visit redirects to /dashboard', async ({
  page,
}) => {
  const pub = await seedPublisher();
  await loginViaUi(page, pub.email, PUB_PASSWORD);

  // No Users link in the nav.
  await expect(page.locator('nav a[href="/users"]')).toHaveCount(0);

  // Direct visit bounces to /dashboard.
  await page.goto('/users');
  await page.waitForURL(/\/dashboard$/);
});

test('last-active-admin guard: API returns 409 and the modal surfaces it cleanly', async ({
  page,
}) => {
  const onlyAdmin = await seedAdmin();
  // Snapshot every other active admin and temporarily deactivate them so
  // this admin is the genuinely sole one for the duration of the test.
  const others = await prisma.user.findMany({
    where: { id: { not: onlyAdmin.id }, role: 'ADMIN', isActive: true },
    select: { id: true },
  });
  if (others.length > 0) {
    await prisma.user.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { isActive: false },
    });
  }

  try {
    await loginViaUi(page, onlyAdmin.email, ADMIN_PASSWORD);
    await page.click('a[href="/users"]');
    await page.waitForURL(/\/users$/);

    // Find our own row and click Deactivate.
    const ownRow = page
      .locator(`tbody tr:has-text("${onlyAdmin.email}")`)
      .first();
    await ownRow.locator('button:has-text("Deactivate")').click();
    await page.click('.modal-card button:has-text("Deactivate")');

    // The modal stays open and shows the API's clean error message.
    await expect(page.locator('.modal-card .banner.err')).toContainText(
      /only remaining active admin/i,
    );
    // The row in the table is still active (deactivation rejected).
    await page.click('.modal-card button:has-text("Cancel")');
    await expect(ownRow.locator('.status-pill.active')).toBeVisible();
  } finally {
    if (others.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: others.map((o) => o.id) } },
        data: { isActive: true },
      });
    }
  }
});
