import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

// The admin menu: a top row of sections (Dashboard, Push, Social, Email, Reports, Admin ▾, Account ▾) and, under it, a tab row
// with the screens of the section you are in; on a phone (720px and below) the top row is the brand and ☰. Needs the usual e2e
// stack (backend + DB + Vite on :5173), like users.spec.ts.
//
// Logins are limited to 5 a minute per address, so each role logs in ONCE (beforeAll) and every test reuses that cookie in a
// fresh browser context. The server switches that show or hide Social are patched into GET /api/auth/me per test: the e2e
// backend runs with every social channel off. No test logs out (that would end the shared session).
const PASSWORD = 'NavGroupsEndToEndPw1Aa';
const DOMAIN = '@navgroups-e2e.example.com';
// Short on purpose: it has to look like a real address next to the role badge (the width checks assert it is not truncated).
const uniq = (p: string) => `${p}-${randomBytes(3).toString('hex')}${DOMAIN}`;

type Role = 'ADMIN' | 'PUBLISHER';
type Features = Partial<{ whatsappQueue: boolean; linkedinPosting: boolean; facebookPosting: boolean; telegramPosting: boolean }>;
const ALL: Features = { whatsappQueue: true, linkedinPosting: true, facebookPosting: true, telegramPosting: true };

let prisma: PrismaClient;
const emails: Record<Role, string> = { ADMIN: '', PUBLISHER: '' };
type State = Awaited<ReturnType<BrowserContext['storageState']>>;
const states: Partial<Record<Role, State>> = {};

test.use({ viewport: { width: 1440, height: 900 } });
// The reachability sweep makes ~65 navigations.
test.setTimeout(180_000);

test.beforeAll(async ({ browser }) => {
  prisma = new PrismaClient();
  for (const role of ['ADMIN', 'PUBLISHER'] as const) {
    emails[role] = uniq(role.toLowerCase());
    await prisma.user.create({
      data: {
        email: emails[role],
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role,
        isActive: true,
        passwordResetRequired: false,
      },
    });
    const ctx = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.fill('input[type=email]', emails[role]);
    await page.fill('input[type=password]', PASSWORD);
    await Promise.all([
      page.waitForURL((url: URL) => !url.pathname.endsWith('/login')),
      page.click('button[type=submit]'),
    ]);
    states[role] = await ctx.storageState();
    await ctx.close();
  }
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

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

type OpenOpts = {
  width?: number;
  height?: number;
  features?: Features;
  /** Make `window.localStorage` throw on access, as in a browser with storage blocked. */
  blockStorage?: boolean;
  /** localStorage entries to start with (ignored when storage is blocked). */
  seed?: Record<string, string>;
};

/** A signed-in page (no login round trip) with the given server switches patched into /api/auth/me. */
async function openAs(browser: Browser, role: Role, opts: OpenOpts = {}): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: 'http://localhost:5173',
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    storageState: states[role],
  });
  opened.push(ctx);
  if (opts.blockStorage) {
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
  } else if (opts.seed) {
    await ctx.addInitScript((entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) if (window.localStorage.getItem(k) === null) window.localStorage.setItem(k, v);
    }, opts.seed);
  }
  const page = await ctx.newPage();
  const features = opts.features ?? {};
  await page.route('**/api/auth/me', async (route) => {
    const res = await route.fetch();
    if (!res.ok()) return route.fulfill({ response: res });
    const body = await res.json();
    body.features = { ...(body.features ?? {}), ...features };
    await route.fulfill({ response: res, json: body });
  });
  return page;
}

// ---- Locators -------------------------------------------------------------------------------------------------------
const topBar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const tabRow = (page: Page, section: string) => page.getByRole('navigation', { name: `${section} screens` });
const anyTabRow = (page: Page) => page.locator('.nav-tabs');
const topLink = (page: Page, name: string) => topBar(page).getByRole('link', { name, exact: true });
const tab = (page: Page, section: string, name: string) => tabRow(page, section).getByRole('link', { name, exact: true });
const dropBtn = (page: Page, name: 'Admin' | 'Account') => topBar(page).getByRole('button', { name: new RegExp(`^${name}`) });
const path = (page: Page) => new URL(page.url()).pathname;

const PUSH_TABS = ['Compose', 'Review', 'Queue', 'Campaigns'];
const SOCIAL_TABS = ['WhatsApp', 'LinkedIn', 'Facebook', 'Telegram'];
const EMAIL_TABS = ['Digests', 'Ads', 'Templates'];

// ---- 1. Laptop widths ----------------------------------------------------------------------------------------------

for (const width of [1280, 1366, 1440]) {
  test(`${width}px: no hamburger; the whole top row and tab row show, unsqueezed, with the email`, async ({ browser }) => {
    const page = await openAs(browser, 'ADMIN', { width, features: ALL });
    // The widest case: ADMIN, all four channels on, on the screen with the longest tab row.
    await page.goto('/telegram');
    await expect(tab(page, 'Social', 'Telegram')).toBeVisible();

    await expect(page.locator('.nav-toggle')).toHaveCount(0);
    for (const n of ['Dashboard', 'Push', 'Social', 'Email', 'Reports']) await expect(topLink(page, n)).toBeVisible();
    await expect(dropBtn(page, 'Admin')).toBeVisible();
    await expect(dropBtn(page, 'Account')).toBeVisible();
    await expect(page.locator('.role-badge')).toBeVisible();
    // The email is shown, in full.
    const email = page.locator('.nav-email');
    await expect(email).toBeVisible();
    await expect(email).toHaveText(emails.ADMIN);
    const truncated = await email.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(truncated).toBe(false);

    // One line, nothing wider than the window, no squeezed padding.
    const m = await page.evaluate(() => {
      const bar = document.querySelector('nav.nav') as HTMLElement;
      const first = bar.querySelector('.nav-link') as HTMLElement;
      const box = bar.getBoundingClientRect();
      const kids = Array.from(bar.querySelectorAll('a, button, .nav-user')).map((e) => e.getBoundingClientRect());
      return {
        barHeight: box.height,
        pad: getComputedStyle(first).paddingLeft,
        maxRight: Math.max(...kids.map((r) => r.right)),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(m.barHeight).toBeLessThan(60); // a wrapped row would be ~90
    expect(m.pad).toBe('12px');
    expect(m.maxRight).toBeLessThanOrEqual(width - 14);
    expect(m.docOverflow).toBe(0);

    // The tab row: every tab visible, nothing clipped inside its scroll box, none of the box scrolls.
    const t = await anyTabRow(page).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const tabs = Array.from(el.querySelectorAll('a')).map((a) => a.getBoundingClientRect());
      return {
        clipped: el.scrollWidth > el.clientWidth,
        n: tabs.length,
        allInside: tabs.every((r) => r.left >= box.left && r.right <= box.right && r.height > 0),
      };
    });
    expect(t.n).toBe(4);
    expect(t.clipped).toBe(false);
    expect(t.allInside).toBe(true);
  });
}

test('721px, 768px and 1024px (tablets): still the full menu, no hamburger, nothing wider than the window', async ({ browser }) => {
  for (const width of [721, 768, 1024]) {
    const page = await openAs(browser, 'ADMIN', { width, features: ALL });
    await page.goto('/queue');
    await expect(tab(page, 'Push', 'Queue')).toBeVisible();
    await expect(page.locator('.nav-toggle')).toHaveCount(0);
    await expect(dropBtn(page, 'Account')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `page overflow at ${width}`).toBe(0);
    const right = await dropBtn(page, 'Account').evaluate((el) => el.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(width);
  }
});

// ---- 2. Reachability -----------------------------------------------------------------------------------------------

const ALL_SCREENS = [
  '/dashboard', '/compose', '/review', '/queue', '/campaigns', '/whatsapp', '/linkedin', '/facebook', '/telegram',
  '/reports', '/digests', '/ads', '/templates', '/users', '/activity', '/guide', '/change-password',
];
const SECTION_OF: Record<string, { key: string; label: string } | undefined> = {};
for (const p of ['/compose', '/review', '/queue', '/campaigns']) SECTION_OF[p] = { key: 'push', label: 'Push' };
for (const p of ['/whatsapp', '/linkedin', '/facebook', '/telegram']) SECTION_OF[p] = { key: 'social', label: 'Social' };
for (const p of ['/digests', '/ads', '/templates']) SECTION_OF[p] = { key: 'email', label: 'Email' };

/** Go to `target` the way a person would, by the fewest clicks the menu offers. Returns how many clicks it took. */
async function clickTo(page: Page, target: string): Promise<number> {
  const visibleDirect = page.locator(`header.nav-shell a[href="${target}"]:visible`);
  if ((await visibleDirect.count()) > 0) {
    await visibleDirect.first().click();
    await expect.poll(() => path(page)).toBe(target);
    return 1;
  }
  if (target === '/users' || target === '/activity') {
    await dropBtn(page, 'Admin').click();
    await topBar(page).locator(`a[href="${target}"]`).click();
    await expect.poll(() => path(page)).toBe(target);
    return 2;
  }
  if (target === '/guide' || target === '/change-password') {
    await dropBtn(page, 'Account').click();
    await topBar(page).locator(`a[href="${target}"]`).click();
    await expect.poll(() => path(page)).toBe(target);
    return 2;
  }
  const section = SECTION_OF[target];
  expect(section, `no way found to reach ${target}`).toBeTruthy();
  await page.locator(`header.nav-shell a[data-group="${section!.key}"]`).click();
  if (path(page) === target) return 1;
  await tabRow(page, section!.label).locator(`a[href="${target}"]`).click();
  await expect.poll(() => path(page)).toBe(target);
  return 2;
}

test('every screen is reachable within two clicks from any kind of screen; Push screens are one click apart', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { width: 1440, features: ALL });
  // One start per kind of screen: those with no tab row (Dashboard stands for Reports/Users/Activity/Guide/Change password,
  // which share its menu) and one in each of the three tabbed sections.
  for (const start of ['/dashboard', '/compose', '/whatsapp', '/digests']) {
    for (const target of ALL_SCREENS) {
      if (target === start) continue;
      await page.goto(start);
      await expect(topBar(page)).toBeVisible();
      const clicks = await clickTo(page, target);
      expect(clicks, `${start} → ${target}`).toBeLessThanOrEqual(2);
    }
  }
  // Compose ↔ Review ↔ Queue ↔ Campaigns: always exactly one click.
  const pushPaths = ['/compose', '/review', '/queue', '/campaigns'];
  for (const from of pushPaths) {
    for (const to of pushPaths) {
      if (from === to) continue;
      await page.goto(from);
      await expect(tabRow(page, 'Push')).toBeVisible();
      await tabRow(page, 'Push').locator(`a[href="${to}"]`).click();
      await expect.poll(() => path(page)).toBe(to);
    }
  }
});

// ---- 3. A section opens the screen last used in it -----------------------------------------------------------------

test('a section link opens the screen last used in it, and the first screen when nothing is remembered', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { features: ALL });
  await page.goto('/dashboard');
  // Nothing remembered yet: first screen of each section.
  await expect(topLink(page, 'Push')).toHaveAttribute('href', '/compose');
  await expect(topLink(page, 'Social')).toHaveAttribute('href', '/whatsapp');
  await expect(topLink(page, 'Email')).toHaveAttribute('href', '/digests');

  await topLink(page, 'Push').click();
  await tab(page, 'Push', 'Queue').click();
  await expect(page).toHaveURL(/\/queue$/);
  await topLink(page, 'Dashboard').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await topLink(page, 'Push').click();
  await expect(page).toHaveURL(/\/queue$/);
  expect(await page.evaluate(() => window.localStorage.getItem('tsp.nav.last.push'))).toBe('/queue');

  // Each section remembers on its own.
  await topLink(page, 'Email').click();
  await tab(page, 'Email', 'Templates').click();
  await topLink(page, 'Social').click();
  await tab(page, 'Social', 'LinkedIn').click();
  await topLink(page, 'Reports').click();
  await topLink(page, 'Push').click();
  await expect(page).toHaveURL(/\/queue$/);
  await topLink(page, 'Email').click();
  await expect(page).toHaveURL(/\/templates$/);
  await topLink(page, 'Social').click();
  await expect(page).toHaveURL(/\/linkedin$/);

  // A reload or deep link counts too.
  await page.goto('/review');
  await topLink(page, 'Dashboard').click();
  await topLink(page, 'Push').click();
  await expect(page).toHaveURL(/\/review$/);
});

test('with storage blocked the menu still works and a section always opens on its first screen', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { blockStorage: true, features: ALL });
  await page.goto('/queue');
  const blocked = await page.evaluate(() => {
    try {
      void window.localStorage;
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
  await expect(tab(page, 'Push', 'Queue')).toBeVisible();
  await topLink(page, 'Dashboard').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await topLink(page, 'Push').click();
  await expect(page).toHaveURL(/\/compose$/);
  // The tab row works as ever.
  await tab(page, 'Push', 'Campaigns').click();
  await expect(page).toHaveURL(/\/campaigns$/);
});

test('a remembered screen that is no longer available is replaced by the first one', async ({ browser }) => {
  // Telegram was the last Social screen, but its switch is now off.
  const page = await openAs(browser, 'ADMIN', {
    features: { whatsappQueue: true, linkedinPosting: true },
    seed: { 'tsp.nav.last.social': '/telegram', 'tsp.nav.last.push': '/not-a-screen' },
  });
  await page.goto('/dashboard');
  await expect(topLink(page, 'Social')).toHaveAttribute('href', '/whatsapp');
  await expect(topLink(page, 'Push')).toHaveAttribute('href', '/compose');
});

// ---- 4. Social follows the channel switches ------------------------------------------------------------------------

test('Social and its tabs follow the channel switches; Telegram is a tab only while it is on', async ({ browser }) => {
  // None on: no Social section anywhere.
  let page = await openAs(browser, 'ADMIN', { features: {} });
  await page.goto('/dashboard');
  await expect(topLink(page, 'Push')).toBeVisible();
  await expect(topLink(page, 'Social')).toHaveCount(0);
  await expect(page.locator('[data-group="social"]')).toHaveCount(0);

  // Only Telegram on: Social appears, with the one tab.
  page = await openAs(browser, 'ADMIN', { features: { telegramPosting: true } });
  await page.goto('/telegram');
  await expect(topLink(page, 'Social')).toHaveClass(/active/);
  await expect(tabRow(page, 'Social').getByRole('link')).toHaveText(['Telegram']);

  // WhatsApp only: one tab, no Telegram.
  page = await openAs(browser, 'ADMIN', { features: { whatsappQueue: true } });
  await page.goto('/whatsapp');
  await expect(tabRow(page, 'Social').getByRole('link')).toHaveText(['WhatsApp']);

  // Three on, Telegram off: three tabs in order and no Telegram.
  page = await openAs(browser, 'ADMIN', { features: { whatsappQueue: true, linkedinPosting: true, facebookPosting: true } });
  await page.goto('/linkedin');
  await expect(tabRow(page, 'Social').getByRole('link')).toHaveText(['WhatsApp', 'LinkedIn', 'Facebook']);
  await expect(tab(page, 'Social', 'Telegram')).toHaveCount(0);

  // All four on, in the menu's order.
  page = await openAs(browser, 'ADMIN', { features: ALL });
  await page.goto('/facebook');
  await expect(tabRow(page, 'Social').getByRole('link')).toHaveText(SOCIAL_TABS);
});

test('the tab row belongs to Push, Social and Email only', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { features: ALL });
  for (const p of ['/dashboard', '/reports', '/users', '/activity', '/guide', '/change-password']) {
    await page.goto(p);
    await expect(topBar(page)).toBeVisible();
    await expect(anyTabRow(page), p).toHaveCount(0);
  }
  for (const [p, section, names] of [
    ['/campaigns', 'Push', PUSH_TABS],
    ['/ads', 'Email', EMAIL_TABS],
    ['/whatsapp', 'Social', SOCIAL_TABS],
  ] as const) {
    await page.goto(p);
    await expect(tabRow(page, section).getByRole('link')).toHaveText([...names]);
  }
});

// ---- 5. Roles ------------------------------------------------------------------------------------------------------

test('ADMIN: Admin ▾ holds Users and Activity; Account ▾ holds Guide, Change password and Log out', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN');
  await page.goto('/dashboard');
  const admin = dropBtn(page, 'Admin');
  await expect(admin).toHaveAttribute('aria-expanded', 'false');
  await expect(admin).toHaveAttribute('aria-controls', 'nav-admin-menu');
  await expect(topBar(page).getByRole('link', { name: 'Users', exact: true })).toBeHidden();

  await admin.click();
  await expect(admin).toHaveAttribute('aria-expanded', 'true');
  await expect(topBar(page).getByRole('link', { name: 'Users', exact: true })).toBeVisible();
  await expect(topBar(page).getByRole('link', { name: 'Activity', exact: true })).toBeVisible();
  await admin.click();
  await expect(admin).toHaveAttribute('aria-expanded', 'false');

  const account = dropBtn(page, 'Account');
  await expect(account).toHaveAttribute('aria-controls', 'nav-account-menu');
  await account.click();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await expect(topBar(page).getByRole('link', { name: 'Guide', exact: true })).toBeVisible();
  await expect(topBar(page).getByRole('link', { name: 'Change password', exact: true })).toBeVisible();
  await expect(topBar(page).getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await expect(topBar(page).getByRole('link', { name: 'Guide', exact: true })).toHaveAttribute('href', '/guide');
  await expect(topBar(page).getByRole('link', { name: 'Change password', exact: true })).toHaveAttribute('href', '/change-password');
});

test('PUBLISHER: no Admin ▾, no Users or Activity anywhere; Account ▾ holds Guide, Change password and Log out', async ({ browser }) => {
  const page = await openAs(browser, 'PUBLISHER');
  await page.goto('/compose');
  await expect(tab(page, 'Push', 'Compose')).toBeVisible();
  await expect(dropBtn(page, 'Admin')).toHaveCount(0);
  await expect(page.locator('nav a[href="/users"], nav a[href="/activity"]')).toHaveCount(0);
  await expect(page.locator('.role-badge')).toHaveText('PUBLISHER');

  const account = dropBtn(page, 'Account');
  await account.click();
  await expect(topBar(page).getByRole('link', { name: 'Guide', exact: true })).toBeVisible();
  await expect(topBar(page).getByRole('link', { name: 'Change password', exact: true })).toBeVisible();
  await expect(topBar(page).getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  // Still nothing for Users/Activity once Account is open.
  await expect(page.locator('nav a[href="/users"], nav a[href="/activity"]')).toHaveCount(0);

  // Ads and Templates are open to publishers (owner, 29 Oct).
  await page.goto('/ads');
  await expect(tabRow(page, 'Email').getByRole('link')).toHaveText(EMAIL_TABS);
});

test('dropdowns: click, Escape returns focus, outside click, route change; only one open at a time', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN');
  await page.goto('/dashboard');
  const admin = dropBtn(page, 'Admin');
  const account = dropBtn(page, 'Account');
  const users = topBar(page).getByRole('link', { name: 'Users', exact: true });

  // Escape closes and returns focus to the button.
  await admin.click();
  await page.keyboard.press('Escape');
  await expect(admin).toHaveAttribute('aria-expanded', 'false');
  await expect(admin).toBeFocused();
  await account.click();
  await page.keyboard.press('Escape');
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await expect(account).toBeFocused();

  // Outside click closes.
  await admin.click();
  await page.locator('main, .page').first().click({ position: { x: 5, y: 5 } });
  await expect(admin).toHaveAttribute('aria-expanded', 'false');

  // Opening one closes the other.
  await admin.click();
  await account.click();
  await expect(admin).toHaveAttribute('aria-expanded', 'false');
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await account.click();

  // A route change closes: a link in the panel, a top-row link, and the browser's Back button.
  await admin.click();
  await users.click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(admin).toHaveAttribute('aria-expanded', 'false');
  await account.click();
  await topLink(page, 'Reports').click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await admin.click();
  await page.goBack();
  await expect(page).toHaveURL(/\/users$/);
  await expect(admin).toHaveAttribute('aria-expanded', 'false');
  // The Admin button is lit while you are on one of its screens.
  await expect(admin).toHaveClass(/active/);
});

// ---- 6. Active section and tab -------------------------------------------------------------------------------------

test('the section you are in is marked, and the current tab says aria-current="page"', async ({ browser }) => {
  const page = await openAs(browser, 'PUBLISHER');
  await page.goto('/ads');
  await expect(page.locator('a[data-group="email"]')).toHaveClass(/active/);
  await expect(page.locator('a[data-group="push"]')).not.toHaveClass(/active/);
  await expect(tabRow(page, 'Email').locator('[aria-current="page"]')).toHaveText('Ads');
  await expect(tabRow(page, 'Email').locator('[aria-current="page"]')).toHaveCount(1);

  await page.goto('/review');
  await expect(page.locator('a[data-group="push"]')).toHaveClass(/active/);
  await expect(page.locator('a[data-group="email"]')).not.toHaveClass(/active/);
  await expect(tabRow(page, 'Push').locator('[aria-current="page"]')).toHaveText('Review');

  // Clicking a tab moves the mark.
  await tab(page, 'Push', 'Queue').click();
  await expect(tabRow(page, 'Push').locator('[aria-current="page"]')).toHaveText('Queue');

  // Dashboard and Reports are lit on their own pages.
  await page.goto('/reports');
  await expect(topLink(page, 'Reports')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('a[data-group].active')).toHaveCount(0);
});

// ---- 7. Keyboard ---------------------------------------------------------------------------------------------------

test('keyboard: Tab reaches every item; dropdowns open with Enter or Space, close with Escape', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { features: ALL });
  await page.goto('/queue');
  await expect(tab(page, 'Push', 'Queue')).toBeVisible();

  // Tab through the page from the top and collect what takes focus until the tab row is passed.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const seen: string[] = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return (el?.innerText || el?.getAttribute('aria-label') || el?.tagName || '').replace(/\s+/g, ' ').trim();
      }),
    );
  }
  const order = ['Dashboard', 'Push', 'Social', 'Email', 'Reports', 'Admin', 'Account', 'Compose', 'Review', 'Queue', 'Campaigns'];
  let at = -1;
  for (const name of order) {
    const idx = seen.findIndex((s, i) => i > at && s.startsWith(name));
    expect(idx, `Tab never reached "${name}" in order; saw ${JSON.stringify(seen)}`).toBeGreaterThan(at);
    at = idx;
  }

  // Enter opens Admin ▾; Tab walks into it; Escape closes it and returns focus to the button.
  const admin = dropBtn(page, 'Admin');
  await admin.focus();
  await page.keyboard.press('Enter');
  await expect(admin).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(topBar(page).getByRole('link', { name: 'Users', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(topBar(page).getByRole('link', { name: 'Activity', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(admin).toHaveAttribute('aria-expanded', 'false');
  await expect(admin).toBeFocused();

  // Tabbing out of an open panel closes it.
  await page.keyboard.press('Enter');
  await expect(admin).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(admin).toHaveAttribute('aria-expanded', 'false');

  // Space opens Account ▾; Tab reaches Guide, Change password, Log out.
  const account = dropBtn(page, 'Account');
  await account.focus();
  await page.keyboard.press('Space');
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(topBar(page).getByRole('link', { name: 'Guide', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(topBar(page).getByRole('link', { name: 'Change password', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(topBar(page).getByRole('button', { name: 'Log out', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(account).toBeFocused();
  await expect(account).toHaveAttribute('aria-expanded', 'false');

  // A tab is a link: Enter on it navigates.
  await tab(page, 'Push', 'Review').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/review$/);
});

// ---- 8. Phones -----------------------------------------------------------------------------------------------------

test('375px: ☰ opens ONE list that fits the screen, with every section heading; any navigation closes it, Back included', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { width: 375, height: 667, features: ALL });
  await page.goto('/queue');
  const toggle = page.getByRole('button', { name: 'Toggle navigation menu' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Closed: only the brand, ☰ and the section's tab row. No desktop top row.
  await expect(topLink(page, 'Dashboard')).toHaveCount(0);
  await expect(dropBtn(page, 'Account')).toHaveCount(0);
  await expect(tab(page, 'Push', 'Queue')).toBeVisible();
  const closed = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(closed.overflow).toBe(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const menu = page.locator('#nav-menu');
  await expect(menu).toBeVisible();
  // One list, in the desktop order: Dashboard, the sections with their screens, Reports, Admin, Account.
  for (const h of ['push', 'social', 'email', 'admin', 'account']) await expect(menu.locator(`.nav-label[data-group="${h}"]`)).toBeVisible();
  await expect(menu.locator('.nav-label')).toHaveText(['Push', 'Social', 'Email', 'Admin', 'Account']);
  for (const n of [
    'Dashboard', ...PUSH_TABS, ...SOCIAL_TABS, ...EMAIL_TABS, 'Reports', 'Users', 'Activity', 'Guide', 'Change password',
  ]) {
    await expect(menu.getByRole('link', { name: n, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await expect(menu.locator('.nav-email')).toHaveText(emails.ADMIN);
  await expect(menu.locator('.nav-label[data-group="push"]')).toHaveClass(/active/);
  // It fits one phone screen, Log out included, and does not widen the page.
  const fit = await page.evaluate(() => {
    const logout = document.querySelector('#nav-menu .logout')!.getBoundingClientRect();
    const m = document.querySelector('#nav-menu')!.getBoundingClientRect();
    return {
      logoutBottom: logout.bottom,
      menuHeight: Math.round(m.height),
      headerHeight: Math.round(document.querySelector('.nav-shell')!.getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scrollY: window.scrollY,
    };
  });
  // eslint-disable-next-line no-console
  console.log(`[menu 375x667 ADMIN, 4 channels] list ${fit.menuHeight}px, whole header ${fit.headerHeight}px`);
  expect(fit.logoutBottom).toBeLessThanOrEqual(667);
  expect(fit.headerHeight).toBeLessThanOrEqual(667);
  expect(fit.overflow).toBe(0);
  expect(fit.scrollY).toBe(0);

  // A link click closes it.
  await menu.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.locator('#nav-menu')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Browser Back closes it too.
  await toggle.click();
  await expect(page.locator('#nav-menu')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.locator('#nav-menu')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Escape closes it and returns focus to ☰.
  await toggle.click();
  await expect(page.locator('#nav-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#nav-menu')).toHaveCount(0);
  await expect(toggle).toBeFocused();

  // Tapping the link of the screen you are already on closes it as well (no route change to do it).
  await toggle.click();
  await page.locator('#nav-menu').getByRole('link', { name: 'Queue', exact: true }).click();
  await expect(page.locator('#nav-menu')).toHaveCount(0);
});

test('375px as PUBLISHER with Social off: the list has no Social and no Admin heading, and still fits', async ({ browser }) => {
  const page = await openAs(browser, 'PUBLISHER', { width: 375, height: 667, features: {} });
  await page.goto('/digests');
  await page.getByRole('button', { name: 'Toggle navigation menu' }).click();
  const menu = page.locator('#nav-menu');
  await expect(menu.locator('.nav-label')).toHaveText(['Push', 'Email', 'Account']);
  await expect(menu.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: 'WhatsApp' })).toHaveCount(0);
  const bottom = await page.evaluate(() => document.querySelector('#nav-menu .logout')!.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual(667);
  await expect(menu.locator('.nav-label[data-group="email"]')).toHaveClass(/active/);
});

test('375px: the tab row scrolls inside its own box, keeps the current tab in view and never widens the page', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { width: 375, height: 667, features: ALL });
  await page.goto('/telegram');
  const current = tab(page, 'Social', 'Telegram');
  await expect(current).toHaveAttribute('aria-current', 'page');
  const m = await page.evaluate(() => {
    const strip = document.querySelector('.nav-tabs') as HTMLElement;
    const box = strip.getBoundingClientRect();
    const cur = strip.querySelector('[aria-current="page"]')!.getBoundingClientRect();
    return {
      boxRight: box.right,
      curLeft: cur.left,
      curRight: cur.right,
      scrolls: strip.scrollWidth > strip.clientWidth,
      scrollLeft: strip.scrollLeft,
      overflowX: getComputedStyle(strip).overflowX,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(m.overflowX).toBe('auto');
  expect(m.scrolls).toBe(true); // four channels do not fit 375px: it scrolls, in its own box
  expect(m.pageOverflow).toBe(0); // and the page does not
  expect(m.scrollLeft).toBeGreaterThan(0); // moved to show the current tab
  expect(m.curLeft).toBeGreaterThanOrEqual(0);
  expect(m.curRight).toBeLessThanOrEqual(m.boxRight);

  // The first tab can be swiped back into view.
  await page.locator('.nav-tabs').evaluate((el) => (el.scrollLeft = 0));
  await expect(tab(page, 'Social', 'WhatsApp')).toBeInViewport();
});

test('phone to desktop width: the menu swaps trees and nothing is left open', async ({ browser }) => {
  const page = await openAs(browser, 'ADMIN', { width: 375, height: 700, features: ALL });
  await page.goto('/queue');
  await page.getByRole('button', { name: 'Toggle navigation menu' }).click();
  await expect(page.locator('#nav-menu')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 700 });
  await expect(page.locator('.nav-toggle')).toHaveCount(0);
  await expect(page.locator('#nav-menu')).toHaveCount(0);
  await expect(topLink(page, 'Push')).toBeVisible();
  await expect(dropBtn(page, 'Account')).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(page.locator('.nav-toggle')).toBeVisible();
  await expect(page.locator('#nav-menu')).toHaveCount(0);
});
