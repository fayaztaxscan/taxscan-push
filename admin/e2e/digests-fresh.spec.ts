import { test, expect, type Locator, type Page, type Route } from '@playwright/test';

/**
 * Digests stays fresh (brief 2026-11-27-digest-screen-fresh): it reloads when someone comes back to it and after a
 * press that is refused or unanswered, and the Audience card says "held" only while the send guard is on. Follow-up 1:
 * that press's red message is scrolled to and focused, and nothing fetched before the press may replace it.
 *
 * Every /api reply is answered here (page.route), so nothing needs a database, a digest or Mailercloud, and the
 * server's state can be changed under an open screen. Only Vite on :5173 is used (playwright.config starts the stack).
 * The page clock is pinned (setFixedTime moves Date.now, timers still run), so "30 seconds later" is exact.
 */

const NOW = Date.parse('2026-11-27T03:30:00Z');
const RUN = 'run-today';
const REFUSAL = 'This digest cannot be approved now: it is not waiting for approval, or it is already sent, skipped or past the cut-off.';
const NO_REPLY_PRESS = 'No reply from the server in time — the change may still have gone through. Check before trying again.';
const NO_REPLY_DOOR = 'No reply from the server in time — the digest may still be sending. Refresh this page before trying again.';
const NO_REPLY_FREE = 'No reply from the server in time — the Free digest may still be sending. Check this screen before pressing anything again.';
const HELD_PLAIN = '82 Premium members are still waiting to be tagged in Mailercloud (limit 27)';
const PAST = 'run-old';
const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };

type Door = 'send-now' | 'send-free' | 'retry';
type Press = 'approve' | 'hold' | 'subject' | Door;
type Name = 'status' | 'detail' | 'past' | Press;
type Reply = { status: number; body: unknown } | 'no-reply';

/** The server as the screen sees it. Change it under an open screen, as another device would. */
type World = {
  approved: boolean;
  /** Which send doors the run offers. */
  doors: Door[];
  subject: string;
  /** What a press answers; an unlisted one succeeds. */
  replies: Partial<Record<Press, Reply>>;
  statusFails: boolean;
  detailFails: boolean;
  /** One earlier day in "Last 14 days"; opening it can fail. */
  withHistory: boolean;
  pastFails: boolean;
  card: unknown;
  /** Requests received, by name. */
  seen: Partial<Record<Name | 'history', number>>;
  bodies: Partial<Record<Press, unknown>>;
  held: Partial<Record<Name, Promise<void>>>;
};

function newWorld(over: Partial<World> = {}): World {
  return {
    approved: false,
    doors: [],
    subject: 'Supreme Court on reassessment limitation',
    replies: {},
    statusFails: false,
    detailFails: false,
    withHistory: false,
    pastFails: false,
    card: { enabled: false },
    seen: {},
    bodies: {},
    held: {},
    ...over,
  };
}

/** Hold back the next reply of this name until the returned function is called. Its content is fixed when it is asked for. */
function holdNext(w: World, name: Name): () => void {
  let release!: () => void;
  w.held[name] = new Promise<void>((resolve) => (release = resolve));
  return release;
}

const ON = { show: true, enabled: true, reason: null };
const HIDDEN = { show: false, enabled: false, reason: null };

function detailOf(w: World) {
  const offered = (d: Door) => (w.doors.includes(d) ? ON : HIDDEN);
  const variant = (audience: 'FREE' | 'PREMIUM') => ({
    audience,
    state: 'CREATED',
    subject: w.subject,
    subjectEdit: { editable: !w.approved, reason: w.approved ? 'Locked — approved' : null },
    preheader: 'Top rulings today',
    htmlBytes: 40960,
    hasPreview: true,
    mcCampaignId: 'mock-1',
    sendAfter: '2026-11-27T03:30:00.000Z',
    scheduledAt: null,
    sentConfirmedAt: null,
    nextAttemptAt: null,
    attempts: 0,
    lastError: null,
    reached: null,
    approval: w.approved ? 'approved' : 'waiting',
  });
  return {
    runId: RUN,
    runDate: '2026-11-27',
    isToday: true,
    state: 'created',
    build: 'BUILT',
    skipText: null,
    candidateCount: 40,
    approval: w.approved ? 'APPROVED' : 'PENDING',
    approvedBy: null,
    approvedAt: null,
    readsLine: null,
    variants: [variant('FREE'), variant('PREMIUM')],
    items: { FREE: [], PREMIUM: [] },
    actions: {
      approve: w.approved ? HIDDEN : ON,
      hold: ON,
      sendNow: offered('send-now'),
      retry: offered('retry'),
      sendFree: offered('send-free'),
      testSend: { FREE: ON, PREMIUM: ON },
    },
    audienceEstimate: { FREE: null, PREMIUM: null },
    timeline: [],
  };
}

const PAST_ROW = {
  runId: PAST,
  runDate: '2026-11-26',
  state: 'sent',
  items: { FREE: 8, PREMIUM: 8 },
  variants: [],
};

/** The Audience card as an ADMIN gets it. Tall on a phone, so the digest's buttons sit far below the top, as in real use. */
const card = (guardActive: boolean, guardOk = false) => ({
  enabled: true,
  ok: guardOk,
  line: `Audience sync needs attention: Mailercloud has not caught up with the latest changes.${guardActive ? '' : ' (the send guard is off)'}`,
  writesLive: true,
  guardActive,
  counts: { premiumCms: 2600, premiumOurs: 2600, premiumApplied: 2518, premiumMailercloud: 2518, former: 7000, noMarketing: 10, pendingWrites: 82 },
  refused: { premium: 79, former: 0 },
  last: { webhookAt: null, incrementalAt: null, fullAt: null },
  errors24h: { writerRetryable: 0, writerFatal: 0, seqConflict: 0, unknownStatus: 0 },
  guard: guardOk ? { ok: true } : { ok: false, check: 'pending_writes', plain: HELD_PLAIN },
  breaker: { open: false, reason: null, plain: null, openedAt: null, review: {} },
});

async function serve(page: Page, w: World): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const post = request.method() === 'POST';
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body as object });
      const arrive = async (name: Name | 'history', answer: () => Promise<void>) => {
        w.seen[name] = (w.seen[name] ?? 0) + 1;
        const wait = name === 'history' ? undefined : w.held[name];
        if (name !== 'history') delete w.held[name];
        // The reply is decided now; only its delivery waits.
        if (wait) await wait;
        await answer();
      };

      if (path === '/api/auth/me') {
        return json({ id: 'u1', email: 'editor@digests-e2e.example.com', role: 'ADMIN', passwordResetRequired: false, lastLoginAt: null, features: {} });
      }
      if (path === '/api/digest/status') {
        const fails = w.statusFails;
        const body = {
          enabled: true,
          config: { sendLive: true, approvalRequired: true, sendAt: '09:00', buildAt: '08:00', cutoff: '17:00' },
          today: { runId: RUN, builtAt: '2026-11-27T02:30:00.000Z' },
          attention: null,
        };
        return arrive('status', () => (fails ? json({ message: 'The screen could not be read.' }, 500) : json(body)));
      }
      if (path === '/api/digest/runs') return arrive('history', () => json({ runs: w.withHistory ? [PAST_ROW] : [] }));
      const failedRead = () => json({ message: 'The digest could not be read.' }, 500);
      if (path === `/api/digest/runs/${RUN}`) {
        const fails = w.detailFails;
        const body = detailOf(w);
        return arrive('detail', () => (fails ? failedRead() : json(body)));
      }
      if (path === `/api/digest/runs/${PAST}`) {
        const fails = w.pastFails;
        const today = detailOf(w);
        const actions = { ...today.actions, approve: HIDDEN, hold: HIDDEN, sendNow: HIDDEN, retry: HIDDEN, sendFree: HIDDEN };
        const body = { ...today, runId: PAST, runDate: PAST_ROW.runDate, isToday: false, state: 'sent', actions };
        return arrive('past', () => (fails ? failedRead() : json(body)));
      }
      if (path.startsWith(`/api/digest/runs/${RUN}/preview/`)) {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Preview</p>' });
      }
      const press = post ? (path.match(new RegExp(`^/api/digest/runs/${RUN}/(approve|hold|send-now|send-free|retry|subject)(?:/|$)`))?.[1] as Press | undefined) : undefined;
      if (press) {
        w.bodies[press] = request.postDataJSON();
        const reply = w.replies[press];
        if (!reply && press === 'approve') w.approved = true;
        return arrive(press, () => {
          if (reply === 'no-reply') return route.abort('failed');
          if (reply) return json(reply.body, reply.status);
          return json({ ok: true, message: 'Done.', result: { state: 'scheduled', audiences: {} } });
        });
      }
      if (path === '/api/digest/audience') return json(w.card);
      if (path.startsWith('/api/staff-push/')) return json({ sending: false, digestEnabled: true, staffPushEnabled: false, vapidPublicKey: '', devices: 0 });
      return json({ message: 'Not part of this test.' }, 404);
    },
  );
}

/** Signed in, on Digests, first load finished. `__loads` counts screen loads as the page starts them. */
async function openDigests(page: Page, w: World): Promise<void> {
  await serve(page, w);
  await page.addInitScript(() => {
    const win = window as unknown as { __loads: number; __scrolls: { to: string; behavior?: string }[] };
    win.__scrolls = [];
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      const to = this.classList.contains('screen-error') ? 'message' : this.id;
      win.__scrolls.push({ to, behavior: typeof arg === 'object' ? arg.behavior : undefined });
      scroll.call(this, arg);
    };
    win.__loads = 0;
    const real = window.fetch;
    window.fetch = (...args: Parameters<typeof fetch>) => {
      if (String(args[0]) === '/api/digest/status') win.__loads += 1;
      return real.apply(window, args);
    };
  });
  await page.clock.setFixedTime(NOW);
  await page.goto('/digests');
  await expect(today(page).getByText('Drafts ready')).toBeVisible();
  await loaded(page);
}

const later = (page: Page, seconds: number) => page.clock.setFixedTime(NOW + seconds * 1000);
const loads = (page: Page) => page.evaluate(() => (window as unknown as { __loads: number }).__loads);

type Return = 'visible' | 'hidden' | 'restored' | 'first-show';
/** Fire these in one go and report how many screen loads they started (fetch is called in the same task). */
function fire(page: Page, ...events: Return[]): Promise<number> {
  return page.evaluate((list) => {
    const win = window as unknown as { __loads: number };
    const before = win.__loads;
    for (const e of list) {
      if (e === 'visible' || e === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => e });
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: e === 'restored' }));
      }
    }
    return win.__loads - before;
  }, events);
}

const today = (page: Page) => page.locator('#digest-today');
const button = (page: Page, name: string) => today(page).getByRole('button', { name, exact: true });
/** Approve under either of its labels. "Gone" must not be satisfied by the button merely reading "Approving…". */
const approveAnyLabel = (page: Page) => today(page).getByRole('button', { name: /^Approv/ });
const dialog = (page: Page) => page.getByRole('alertdialog');
/** The screen's own red banner (the cards below have their own). */
const redBanner = (page: Page) => page.locator('main > .banner.err');
const refresh = (page: Page) => page.locator('main > .toolbar').getByRole('button');
const loaded = (page: Page) => expect(refresh(page)).toHaveText('Refresh');
const scrolls = (page: Page) => page.evaluate(() => (window as unknown as { __scrolls: { to: string; behavior?: string }[] }).__scrolls);
const messageScrolls = async (page: Page) => (await scrolls(page)).filter((s) => s.to === 'message');

/** Scroll so that this button is in view and the top of the screen, where messages appear, is not. */
async function farDownAt(page: Page, target: Locator): Promise<void> {
  await target.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2));
  await expect(target).toBeInViewport();
  await expect(page.locator('main > .toolbar')).not.toBeInViewport();
}

/** The red message was brought to the reader: at the top of the window, nothing over it, and focused. */
async function expectBroughtToReader(page: Page): Promise<void> {
  const banner = redBanner(page);
  await expect(banner).toBeInViewport({ ratio: 1 });
  // block: 'start' with 12 px of air; poll because the scroll is smooth.
  await expect.poll(() => banner.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(12);
  await expect(banner).toBeFocused();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toHaveAttribute('tabindex', '-1');
  const uncovered = await banner.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 3));
  });
  expect(uncovered).toBe(true);
}

test.describe('coming back to the screen', () => {
  test('1. approved elsewhere: becoming visible reloads and Approve is gone', async ({ page }) => {
    const w = newWorld();
    await openDigests(page, w);
    await expect(button(page, 'Approve')).toBeEnabled();

    w.approved = true; // another device
    await later(page, 31);
    expect(await fire(page, 'hidden')).toBe(0);
    expect(await fire(page, 'visible')).toBe(1);
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await expect(button(page, 'Hold')).toBeVisible();
  });

  test('2. not again within 30 seconds of the last load finishing', async ({ page }) => {
    const w = newWorld();
    await openDigests(page, w);
    await later(page, 29);
    expect(await fire(page, 'visible')).toBe(0);
    await later(page, 31);
    expect(await fire(page, 'visible')).toBe(1);
    await loaded(page);
    expect(await fire(page, 'visible')).toBe(0);
    await later(page, 60); // 29 s after the reload at 31 s
    expect(await fire(page, 'visible', 'restored')).toBe(0);
    await later(page, 62);
    expect(await fire(page, 'visible', 'restored')).toBe(1); // both events together: one load
    await loaded(page);

    // The 30 seconds count from when a load FINISHED: a slow one started 60 s ago but finished 20 s ago does not repeat.
    const release = holdNext(w, 'status');
    await later(page, 100);
    expect(await fire(page, 'visible')).toBe(1);
    await later(page, 140);
    expect(await fire(page, 'visible', 'restored')).toBe(0); // one is already on its way
    release();
    await loaded(page);
    await later(page, 160);
    expect(await fire(page, 'visible')).toBe(0);
    await later(page, 171);
    expect(await fire(page, 'visible')).toBe(1);
  });

  test('2. never while a press is busy', async ({ page }) => {
    const w = newWorld();
    await openDigests(page, w);
    const release = holdNext(w, 'approve');
    await button(page, 'Approve').click();
    await expect(button(page, 'Approving…')).toBeVisible();
    await later(page, 31);
    expect(await fire(page, 'visible', 'restored')).toBe(0);
    release();
    await expect(page.locator('main > .banner.ok')).toHaveText('Approved.');
    await expect(approveAnyLabel(page)).toHaveCount(0);
    expect(await loads(page)).toBe(2); // the first load and the one after the press
  });

  test('2. never while a confirm box is open, nor while a subject is saving', async ({ page }) => {
    const w = newWorld({ doors: ['send-now'] });
    await openDigests(page, w);
    await button(page, 'Send now').click();
    await expect(dialog(page)).toBeVisible();
    await later(page, 31);
    expect(await fire(page, 'visible', 'restored')).toBe(0);
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    expect(await fire(page, 'visible')).toBe(1);
    await loaded(page);

    await page.getByRole('button', { name: 'Edit subject' }).click();
    await page.locator('#subject-input').fill('A new subject');
    const release = holdNext(w, 'subject');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
    await later(page, 62);
    expect(await fire(page, 'visible')).toBe(0);
    release();
    await expect(page.locator('main > .banner.ok')).toHaveText('Free subject updated.');
  });

  test('3. restored from the back-forward cache reloads; a first show does not', async ({ page }) => {
    const w = newWorld();
    const release = holdNext(w, 'status');
    await serve(page, w);
    await page.goto('/digests');
    await expect.poll(() => w.seen.status).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
    release();
    await expect(today(page).getByText('Drafts ready')).toBeVisible();
    await loaded(page);
    expect(w.seen.status).toBe(1); // the browser's own first pageshow and the one above added nothing
  });

  test('3. persisted decides', async ({ page }) => {
    const w = newWorld();
    await openDigests(page, w);
    expect(await loads(page)).toBe(1);
    await later(page, 31);
    expect(await fire(page, 'first-show')).toBe(0);
    w.approved = true;
    expect(await fire(page, 'restored')).toBe(1);
    await expect(approveAnyLabel(page)).toHaveCount(0);
  });

  test('a failed reload says so, and the next return tries again at once', async ({ page }) => {
    const w = newWorld();
    await openDigests(page, w);
    w.statusFails = true;
    await later(page, 5); // well inside 30 seconds of the first load
    await refresh(page).click();
    await expect(redBanner(page)).toHaveText('The screen could not be read.');
    await loaded(page);
    w.statusFails = false;
    w.approved = true;
    expect(await fire(page, 'visible')).toBe(1); // no 30-second wait after a failure
    await expect(redBanner(page)).toHaveCount(0);
    await expect(approveAnyLabel(page)).toHaveCount(0);
  });

  test('an older reply arriving late does not bring Approve back', async ({ page }) => {
    const w = newWorld({ replies: { approve: { status: 409, body: { message: REFUSAL } } } });
    await openDigests(page, w);
    const release = holdNext(w, 'detail'); // the return reload's reply, decided while still unapproved
    await later(page, 31);
    expect(await fire(page, 'visible')).toBe(1);
    await expect.poll(() => w.seen.detail).toBe(2);
    w.approved = true;
    await button(page, 'Approve').click();
    await expect(approveAnyLabel(page)).toHaveCount(0);
    const stale = page.waitForResponse((r) => r.url().endsWith(`/api/digest/runs/${RUN}`));
    release();
    await (await stale).finished();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await expect(redBanner(page)).toHaveText(REFUSAL);
  });

  test('an open subject box still tells the server what the editor saw', async ({ page }) => {
    const w = newWorld();
    const seenWhenOpened = w.subject;
    await openDigests(page, w);
    await page.getByRole('button', { name: 'Edit subject' }).click();
    await page.locator('#subject-input').fill('My new subject');
    w.subject = 'Changed by someone else';
    await later(page, 31);
    expect(await fire(page, 'visible')).toBe(1);
    await expect(page.locator('.inbox-subject')).toHaveText('Changed by someone else');
    await expect(page.locator('#subject-input')).toHaveValue('My new subject');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => w.bodies.subject).toEqual({ subject: 'My new subject', from: seenWhenOpened });
  });

  test('6. leaving the screen removes the listeners', async ({ page }) => {
    const w = newWorld();
    await openDigests(page, w);
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    await page.locator('a[href="/dashboard"]').first().click();
    await page.waitForURL(/\/dashboard$/);
    await expect(page.locator('#digest-today')).toHaveCount(0);
    const historyBefore = w.seen.history;
    await later(page, 31);
    expect(await fire(page, 'hidden', 'visible', 'restored')).toBe(0);
    expect(w.seen.history).toBe(historyBefore);
    // Still the same document, so nothing but the unmount could have removed them.
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

    // Back again: one screen, one set of listeners.
    await page.goBack();
    await expect(today(page).getByText('Drafts ready')).toBeVisible();
    await loaded(page);
    await later(page, 62);
    expect(await fire(page, 'visible')).toBe(1);
  });
});

test.describe('after a press that is refused or unanswered', () => {
  for (const status of [409, 400]) {
    test(`4. Approve on a stale screen answered ${status}: the message stays and the screen reloads`, async ({ page }) => {
      const w = newWorld({ replies: { approve: { status, body: { error: 'not_allowed', message: REFUSAL } } } });
      await openDigests(page, w);
      w.approved = true; // approved elsewhere; this screen has not heard
      const release = holdNext(w, 'status');
      await button(page, 'Approve').click();
      await expect.poll(() => w.seen.status).toBe(2);
      await expect(redBanner(page)).toHaveText(REFUSAL); // up while the reload is still on its way
      release();
      await expect(approveAnyLabel(page)).toHaveCount(0);
      await loaded(page);
      await expect(redBanner(page)).toHaveText(REFUSAL); // and after it
      await expect(button(page, 'Hold')).toBeEnabled();
    });
  }

  test('4. Hold refused: the same', async ({ page }) => {
    const message = 'This digest cannot be held now: it is already held, handed to Mailercloud, skipped or past the cut-off.';
    const w = newWorld({ card: card(false), replies: { hold: { status: 409, body: { message } } } });
    await page.setViewportSize(PHONE);
    await openDigests(page, w);
    w.approved = true;
    await farDownAt(page, button(page, 'Hold'));
    await button(page, 'Hold').click();
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await loaded(page);
    await expect(redBanner(page)).toHaveText(message);
    await expectBroughtToReader(page);
    expect(await loads(page)).toBe(2);
  });

  test('4. the reload fails too: the refusal is not replaced', async ({ page }) => {
    const w = newWorld({ replies: { approve: { status: 409, body: { message: REFUSAL } } } });
    await openDigests(page, w);
    w.statusFails = true;
    await button(page, 'Approve').click();
    await expect.poll(() => w.seen.status).toBe(2);
    await loaded(page);
    await expect(button(page, 'Approve')).toBeEnabled();
    await expect(redBanner(page)).toHaveText(REFUSAL);
  });

  test('Approve with no reply: today’s wording, and the screen reloads', async ({ page }) => {
    const w = newWorld({ card: card(false), replies: { approve: 'no-reply' } });
    await page.setViewportSize(PHONE);
    await openDigests(page, w);
    w.approved = true; // it did go through
    await farDownAt(page, button(page, 'Approve'));
    await button(page, 'Approve').click();
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await loaded(page);
    await expect(redBanner(page)).toHaveText(NO_REPLY_PRESS);
    await expectBroughtToReader(page);
    expect(await loads(page)).toBe(2);
  });

  const DOORS: { door: Door; label: string; refused: string; unanswered: string }[] = [
    { door: 'send-now', label: 'Send now', refused: 'Not sent: it has already gone out.', unanswered: NO_REPLY_DOOR },
    { door: 'send-free', label: 'Send Free', refused: 'Send Free has already been pressed today.', unanswered: NO_REPLY_FREE },
    { door: 'retry', label: 'Retry now', refused: 'Not sent: nothing is waiting to be retried.', unanswered: NO_REPLY_DOOR },
  ];
  for (const { door, label, refused, unanswered } of DOORS) {
    for (const [kind, reply, message] of [
      ['refused', { status: 409, body: { error: 'refused', message: refused } }, refused],
      ['unanswered', 'no-reply', unanswered],
    ] as [string, Reply, string][]) {
      test(`5. ${label} ${kind}: the message stays and the screen reloads`, async ({ page }) => {
        const w = newWorld({ card: card(false), doors: [door], replies: { [door]: reply } });
        await page.setViewportSize(PHONE);
        await openDigests(page, w);
        await farDownAt(page, button(page, label));
        await button(page, label).click();
        w.doors = []; // no longer on offer; this screen has not heard
        const release = holdNext(w, 'status');
        await dialog(page).getByRole('button', { name: label, exact: true }).click();
        await expect.poll(() => w.seen.status).toBe(2);
        await expect(redBanner(page)).toHaveText(message);
        release();
        await expect(button(page, label)).toHaveCount(0);
        await loaded(page);
        await expect(redBanner(page)).toHaveText(message);
        await expectBroughtToReader(page);
        await expect(dialog(page)).toHaveCount(0);
      });
    }
  }

  test('5. a door refused and the reload fails too: the refusal is not replaced', async ({ page }) => {
    const message = 'Not sent: it has already gone out.';
    const w = newWorld({ doors: ['send-now'], replies: { 'send-now': { status: 409, body: { message } } } });
    await openDigests(page, w);
    await button(page, 'Send now').click();
    w.statusFails = true;
    await dialog(page).getByRole('button', { name: 'Send now', exact: true }).click();
    await expect.poll(() => w.seen.status).toBe(2);
    await loaded(page);
    await expect(redBanner(page)).toHaveText(message);
  });

  test('Refresh still reloads and clears an old message', async ({ page }) => {
    const w = newWorld({ replies: { approve: { status: 409, body: { message: REFUSAL } } } });
    await openDigests(page, w);
    await button(page, 'Approve').click();
    await expect(redBanner(page)).toHaveText(REFUSAL);
    await loaded(page);
    await refresh(page).click();
    await expect(redBanner(page)).toHaveCount(0);
    expect(await loads(page)).toBe(3);
  });
});

test.describe('the red message is brought to the reader', () => {
  const refused = { approve: { status: 409, body: { error: 'not_allowed', message: REFUSAL } } };

  for (const [name, size] of [['phone', PHONE], ['desktop', DESKTOP]] as const) {
    test(`13. refused Approve from far down a ${name} screen: scrolled to and focused`, async ({ page }) => {
      const w = newWorld({ card: card(false), replies: refused });
      await page.setViewportSize(size);
      await openDigests(page, w);
      w.approved = true;
      await farDownAt(page, button(page, 'Approve'));
      const release = holdNext(w, 'status');
      await button(page, 'Approve').click();
      await expect.poll(() => w.seen.status).toBe(2);
      expect(await messageScrolls(page)).toEqual([]); // not before the reload has landed
      release();
      await expect(approveAnyLabel(page)).toHaveCount(0);
      await expectBroughtToReader(page);
      await expect(redBanner(page)).toHaveText(REFUSAL);
      expect(await messageScrolls(page)).toEqual([{ to: 'message', behavior: 'smooth' }]);
    });
  }

  test('13. the reload fails too: the message is still scrolled to', async ({ page }) => {
    const w = newWorld({ card: card(false), replies: refused });
    await page.setViewportSize(PHONE);
    await openDigests(page, w);
    w.statusFails = true;
    await farDownAt(page, button(page, 'Approve'));
    await button(page, 'Approve').click();
    await expect.poll(() => w.seen.status).toBe(2);
    await loaded(page);
    await expectBroughtToReader(page);
    await expect(redBanner(page)).toHaveText(REFUSAL);
  });

  test('13. reduced motion: no smooth scroll', async ({ page }) => {
    const w = newWorld({ card: card(false), replies: refused });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(PHONE);
    await openDigests(page, w);
    await farDownAt(page, button(page, 'Approve'));
    await button(page, 'Approve').click();
    await expectBroughtToReader(page);
    expect(await messageScrolls(page)).toEqual([{ to: 'message', behavior: 'instant' }]);
  });

  for (const [label, press] of [['Hold', 'hold'], ['Retry now', 'retry']] as const) {
    test(`a second refusal with the same words is scrolled to and focused again (${label})`, async ({ page }) => {
      const message = 'Someone else changed it a moment ago. Refresh.';
      const w = newWorld({ card: card(false), doors: ['retry'], replies: { [press]: { status: 409, body: { message } } } });
      await page.setViewportSize(PHONE);
      await openDigests(page, w);
      for (const times of [1, 2]) {
        await farDownAt(page, button(page, label));
        await button(page, label).click();
        if (press === 'retry') await dialog(page).getByRole('button', { name: label, exact: true }).click();
        await expect.poll(async () => (await messageScrolls(page)).length).toBe(times);
        await expectBroughtToReader(page);
        await expect(redBanner(page)).toHaveText(message);
        await loaded(page);
      }
    });
  }

  test('a press that answers but leaves a version failed is red, so it is scrolled to as well', async ({ page }) => {
    const audiences = { FREE: { state: 'FAILED', error: 'Mailercloud rejected the request', errorKind: 'FATAL' } };
    const w = newWorld({ card: card(false), doors: ['retry'], replies: { retry: { status: 200, body: { ok: true, result: { state: 'failed', audiences } } } } });
    await page.setViewportSize(PHONE);
    await openDigests(page, w);
    await farDownAt(page, button(page, 'Retry now'));
    await button(page, 'Retry now').click();
    await dialog(page).getByRole('button', { name: 'Retry now', exact: true }).click();
    await expectBroughtToReader(page);
    await expect(redBanner(page)).toContainText('Mailercloud rejected the request');
  });

  test('14. a successful Approve does not scroll', async ({ page }) => {
    const w = newWorld({ card: card(false) });
    await page.setViewportSize(PHONE);
    await openDigests(page, w);
    await farDownAt(page, button(page, 'Approve'));
    await button(page, 'Approve').click();
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await loaded(page);
    await expect(page.locator('main > .banner.ok')).toHaveText('Approved.');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600))); // long enough for a smooth scroll to show
    expect(await messageScrolls(page)).toEqual([]);
    await expect(button(page, 'Hold')).toBeInViewport(); // still where the reader was
    await expect(page.locator('main > .banner.ok')).not.toBeInViewport(); // the notice behaves as before
    expect(await page.evaluate(() => !!document.activeElement?.closest('.banner'))).toBe(false);
  });

  test('14. a successful Send now does not scroll either', async ({ page }) => {
    const done = { state: 'SCHEDULED', error: null, errorKind: null };
    const reply = { status: 200, body: { ok: true, result: { state: 'scheduled', audiences: { FREE: done, PREMIUM: done } } } };
    const w = newWorld({ card: card(false), doors: ['send-now'], replies: { 'send-now': reply } });
    await page.setViewportSize(PHONE);
    await openDigests(page, w);
    await farDownAt(page, button(page, 'Send now'));
    await button(page, 'Send now').click();
    await dialog(page).getByRole('button', { name: 'Send now', exact: true }).click();
    await expect(page.locator('main > .banner.ok')).toHaveText('Handed to Mailercloud. It is sending now.');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(await messageScrolls(page)).toEqual([]);
    await expect(button(page, 'Send now')).toBeInViewport();
    await expect(redBanner(page)).toHaveCount(0);
  });
});

test.describe('15. nothing fetched before a press may talk over it', () => {
  const refused = { approve: { status: 409, body: { error: 'not_allowed', message: REFUSAL } } };

  /** Let a held reply arrive and give the screen time to react to it. */
  async function deliver(page: Page, release: () => void, path: string): Promise<void> {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === path);
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  }
  /** Come back to the screen, with the named reply of that reload held back. */
  async function slowReturnReload(page: Page, w: World, name: 'status' | 'detail', fails: boolean): Promise<() => void> {
    w.statusFails = fails && name === 'status';
    w.detailFails = fails && name === 'detail';
    const release = holdNext(w, name);
    await later(page, 31);
    expect(await fire(page, 'visible')).toBe(1);
    await expect.poll(() => w.seen[name]).toBe(2); // asked for, its answer fixed
    w.statusFails = false;
    w.detailFails = false;
    return release;
  }
  async function refusedPress(page: Page, w: World): Promise<void> {
    w.approved = true;
    await button(page, 'Approve').click();
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await expect(redBanner(page)).toHaveText(REFUSAL);
    await loaded(page);
  }
  const stillTheRefusal = async (page: Page) => {
    await expect(redBanner(page)).toHaveText(REFUSAL, { timeout: 1000 });
    await expect(approveAnyLabel(page)).toHaveCount(0, { timeout: 1000 });
    await expect(refresh(page)).toBeEnabled({ timeout: 1000 });
  };

  for (const [name, fails] of [['status', true], ['detail', true], ['status', false], ['detail', false]] as const) {
    test(`a slow return reload (${name}) that ${fails ? 'fails' : 'lands'} after the refusal changes nothing`, async ({ page }) => {
      const w = newWorld({ replies: refused });
      await openDigests(page, w);
      const release = await slowReturnReload(page, w, name, fails);
      await refusedPress(page, w);
      const asked = { ...w.seen };
      await deliver(page, release, name === 'status' ? '/api/digest/status' : `/api/digest/runs/${RUN}`);
      await stillTheRefusal(page);
      expect(w.seen).toEqual(asked); // the dropped reload asks for nothing further
    });
  }

  test('it fails while the press is still waiting for its answer: nothing shows, then the refusal', async ({ page }) => {
    const w = newWorld({ replies: refused });
    await openDigests(page, w);
    const release = await slowReturnReload(page, w, 'status', true);
    const answer = holdNext(w, 'approve');
    w.approved = true;
    await button(page, 'Approve').click();
    await expect(button(page, 'Approving…')).toBeVisible();
    await deliver(page, release, '/api/digest/status');
    await expect(redBanner(page)).toHaveCount(0, { timeout: 1000 });
    answer();
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await expect(redBanner(page)).toHaveText(REFUSAL);
  });

  test('after a successful press, its late failure does not appear', async ({ page }) => {
    const w = newWorld();
    await openDigests(page, w);
    const release = await slowReturnReload(page, w, 'status', true);
    await button(page, 'Approve').click();
    await expect(approveAnyLabel(page)).toHaveCount(0);
    await loaded(page);
    await deliver(page, release, '/api/digest/status');
    await expect(redBanner(page)).toHaveCount(0, { timeout: 1000 });
    await expect(page.locator('main > .banner.ok')).toHaveText('Approved.');
  });

  test('a send button, too: the late failure does not replace its refusal', async ({ page }) => {
    const message = 'Not sent: it has already gone out.';
    const w = newWorld({ doors: ['send-now'], replies: { 'send-now': { status: 409, body: { message } } } });
    await openDigests(page, w);
    const release = await slowReturnReload(page, w, 'status', true);
    await button(page, 'Send now').click();
    await dialog(page).getByRole('button', { name: 'Send now', exact: true }).click();
    await expect(redBanner(page)).toHaveText(message);
    await loaded(page);
    await deliver(page, release, '/api/digest/status');
    await expect(redBanner(page)).toHaveText(message, { timeout: 1000 });
  });

  test('Refresh in flight when the press is made: its late failure changes nothing', async ({ page }) => {
    const w = newWorld({ replies: refused });
    await openDigests(page, w);
    w.statusFails = true;
    const release = holdNext(w, 'status');
    await refresh(page).click();
    await expect.poll(() => w.seen.status).toBe(2);
    w.statusFails = false;
    await refusedPress(page, w);
    await deliver(page, release, '/api/digest/status');
    await stillTheRefusal(page);
  });

  for (const fails of [true, false]) {
    test(`a history row opened just before the press, whose reply ${fails ? 'fails' : 'lands'} late: no new message, no scroll away`, async ({ page }) => {
      const w = newWorld({ card: card(false), withHistory: true, replies: refused });
      await page.setViewportSize(PHONE);
      await openDigests(page, w);
      w.pastFails = fails;
      const release = holdNext(w, 'past');
      await page.getByRole('button', { name: /26 Nov/ }).click();
      await expect.poll(() => w.seen.past).toBe(1);
      w.pastFails = false;
      w.approved = true;
      await farDownAt(page, button(page, 'Approve'));
      await button(page, 'Approve').click();
      await expectBroughtToReader(page);
      await loaded(page);
      await deliver(page, release, `/api/digest/runs/${PAST}`);
      await expect(redBanner(page)).toHaveText(REFUSAL, { timeout: 1000 });
      await expectBroughtToReader(page);
      expect((await scrolls(page)).map((s) => s.to)).toEqual(['message']);
    });
  }

  test('a subject still saving when the press is refused: its reload keeps the message', async ({ page }) => {
    const w = newWorld({ replies: refused });
    await openDigests(page, w);
    await page.getByRole('button', { name: 'Edit subject' }).click();
    await page.locator('#subject-input').fill('A new subject');
    const release = holdNext(w, 'subject');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => w.seen.subject).toBe(1);
    await refusedPress(page, w);
    const before = w.seen.status ?? 0;
    release();
    await expect(page.locator('main > .banner.ok')).toHaveText('Free subject updated.');
    await expect.poll(() => w.seen.status).toBe(before + 1);
    await loaded(page);
    await expect(redBanner(page)).toHaveText(REFUSAL);
  });
});

test.describe('Audience card: "held" only while the send guard is on', () => {
  test('9. guard off and failing: "Would hold … if the send guard were on"', async ({ page }) => {
    await openDigests(page, newWorld({ card: card(false) }));
    await expect(page.locator('#audience-card .aud-held')).toHaveText(`Would hold the Premium digest if the send guard were on: ${HELD_PLAIN}.`);
    await expect(page.locator('#audience-card')).not.toContainText('Premium digest held');
  });

  test('9. guard on and failing: "Premium digest held" as before', async ({ page }) => {
    await openDigests(page, newWorld({ card: card(true) }));
    await expect(page.locator('#audience-card .aud-held')).toHaveText(`Premium digest held: ${HELD_PLAIN}.`);
    await expect(page.locator('#audience-card')).not.toContainText('Would hold');
  });

  for (const guardActive of [false, true]) {
    test(`9. guard passing (send guard ${guardActive ? 'on' : 'off'}): neither line`, async ({ page }) => {
      await openDigests(page, newWorld({ card: card(guardActive, true) }));
      await expect(page.locator('#audience-card .aud-line')).toBeVisible();
      await expect(page.locator('#audience-card .aud-held')).toHaveCount(0);
    });
  }
});
