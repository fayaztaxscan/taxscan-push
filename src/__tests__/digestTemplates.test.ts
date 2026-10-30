import bcrypt from 'bcrypt';
import request from 'supertest';
import type { DigestAudience, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, awaitDigestAlerts, ensureRun } from '../services/digest/runner';
import { collapseRows, type DigestSelection, type FrozenItem } from '../services/digest/builder';
import { BUILTIN_TEMPLATE_HTML, renderDigest } from '../services/digest/renderer';
import { compileTemplate, resolveTemplate, validateTemplate, worstCaseFixture, type MjmlCompiler, type TemplateCheckId } from '../services/digest/templates';
import { renderDigestContent } from '../services/digest/content';
import { PREVIEW_CSP } from '../routes/digest';
import { FakeSender } from './digestFakeSender';
import { ensureTestAds } from './digestAdFixtures';

/**
 * Email digest task 10 (docs/EMAIL_DIGEST_DESIGN.md §3, §4, §6, §7, §9, §10):
 * templates. Every acceptance item, every checklist rule red and green, the
 * MJML compile-error path, override window edges, revert, ADMIN-only, audit
 * contents and the sandbox CSP on previews. Rows live under unique
 * `test-digest-tpl-*` portals and are removed afterwards; nothing is sent.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-tpl-';
const PASSWORD = 'digest-tpl-test-pw-1';
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const IST = (h: number, min = 0, day = 22) => new Date(Date.UTC(2026, 9, day, h, min) - (5 * 60 + 30) * 60_000);
const NOW = IST(10, 0);
const SENTINEL = 'tpl-source-sentinel-9c1e';

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, Kochi, Kerala 682001, India',
    ...over,
  });
}

let n = 0;
const newPortal = () => `${PORTAL_PREFIX}${RUN}-${++n}`;

/** The built-in layout with a visible marker (and a sentinel comment) — a valid template. */
const marked = (marker: string, extra = '') =>
  BUILTIN_TEMPLATE_HTML.replace('Daily Digest &middot; {{date}}{{premium_badge}}', `${marker} &middot;{{premium_badge}}`).replace('</body>', `<!-- ${SENTINEL} -->${extra}</body>`);

const check = (html: string | null, audience: DigestAudience = 'FREE', c = cfg(), compileError: string | null = null) =>
  validateTemplate({ audience, compiledHtml: html, compileError }, { cfg: c, now: NOW });
const checkOf = (html: string | null, id: TemplateCheckId, audience: DigestAudience = 'FREE') => check(html, audience).checks.find((x) => x.id === id)!;

/* ------------------------------------------------------------------ */
/* Users and app                                                       */
/* ------------------------------------------------------------------ */

const userIds: string[] = [];
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });

async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({
    data: { email: `digest-tpl-${role.toLowerCase()}-${RUN}-${++n}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true },
  });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
const appFor = (portal: string, o: { clock?: () => Date; mjml?: MjmlCompiler | null; c?: DigestEnv } = {}) =>
  createApp({
    rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
    digest: { cfg: o.c ?? cfg(), portal, clock: o.clock ?? (() => NOW), sender: new FakeSender(), alerts: false, ...(o.mjml !== undefined ? { mjml: o.mjml } : {}) },
  });

/** Creates a template through the API as the admin; returns its body. */
async function create(app: ReturnType<typeof appFor>, body: Record<string, unknown>) {
  const res = await request(app).post('/api/digest/templates').set('Cookie', adminCookie).send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; status: string; validationOk: boolean; failed: string[] };
}
const activate = (app: ReturnType<typeof appFor>, id: string) =>
  request(app).post(`/api/digest/templates/${id}/activate`).set('Cookie', adminCookie).send({ confirm: true });

beforeAll(async () => {
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
});

afterAll(async () => {
  await awaitDigestAlerts();
  const tpls = await prisma.digestTemplate.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true } });
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true } });
  const ids = [...tpls.map((t) => t.id), ...runs.map((r) => r.id)];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    if (ids.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${ids}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestAdPlacement.deleteMany({ where: { ad: { portal: { startsWith: PORTAL_PREFIX } } } });
  await prisma.digestAd.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestTemplate.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestSetting.deleteMany({ where: { key: { startsWith: PORTAL_PREFIX } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const row = (portal: string, o: Partial<{ audience: DigestAudience; status: string; name: string; html: string; startsAt: Date | null; endsAt: Date | null }> = {}) =>
  prisma.digestTemplate.create({
    data: {
      portal,
      name: o.name ?? `T${++n}`,
      audience: o.audience ?? 'FREE',
      status: o.status ?? 'DRAFT',
      source: o.html ?? BUILTIN_TEMPLATE_HTML,
      compiledHtml: o.html ?? BUILTIN_TEMPLATE_HTML,
      startsAt: o.startsAt ?? null,
      endsAt: o.endsAt ?? null,
    },
  });

/* ================================================================== */
/* ACCEPT 1: the database rejects a second ACTIVE template per audience */
/* ================================================================== */

describe('ACCEPT: a second ACTIVE template per audience is rejected by the DB', () => {
  it('insert and update both fail on the partial unique index; other audiences, portals and ARCHIVED duplicates are fine', async () => {
    const portal = newPortal();
    await row(portal, { status: 'ACTIVE' });
    await expect(row(portal, { status: 'ACTIVE' })).rejects.toMatchObject({ code: 'P2002' });
    const draft = await row(portal);
    await expect(prisma.digestTemplate.update({ where: { id: draft.id }, data: { status: 'ACTIVE' } })).rejects.toMatchObject({ code: 'P2002' });
    // Raw SQL too: it is the database, not Prisma, that says no.
    await expect(prisma.$executeRaw`UPDATE "DigestTemplate" SET status = 'ACTIVE' WHERE id = ${draft.id}`).rejects.toThrow(/23505.*\(portal, audience\)/);
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'one_active_template_per_audience'`;
    expect(idx[0].indexdef).toMatch(/CREATE UNIQUE INDEX one_active_template_per_audience ON public."DigestTemplate" USING btree \(portal, audience\) WHERE \(status = 'ACTIVE'::text\)/);
    await expect(row(portal, { status: 'ACTIVE', audience: 'PREMIUM' })).resolves.toBeTruthy();
    await expect(row(newPortal(), { status: 'ACTIVE' })).resolves.toBeTruthy();
    await row(portal, { status: 'ARCHIVED' });
    await row(portal, { status: 'ARCHIVED' });
    expect(await prisma.digestTemplate.count({ where: { portal, audience: 'FREE', status: 'ACTIVE' } })).toBe(1);
  });

  it('CHECK constraints: unknown status, a SCHEDULED row without a window or with an empty one, an ACTIVE row without compiled html', async () => {
    const portal = newPortal();
    await expect(row(portal, { status: 'LIVE' })).rejects.toThrow(/DigestTemplate_status_check/);
    await expect(row(portal, { status: 'SCHEDULED' })).rejects.toThrow(/DigestTemplate_window_check/);
    await expect(row(portal, { status: 'SCHEDULED', startsAt: NOW, endsAt: NOW })).rejects.toThrow(/DigestTemplate_window_check/);
    await expect(
      prisma.digestTemplate.create({ data: { portal, name: 'x', audience: 'FREE', status: 'ACTIVE', source: 'x', compiledHtml: null } }),
    ).rejects.toThrow(/DigestTemplate_compiled_check/);
  });
});

/* ================================================================== */
/* ACCEPT 2: an override wins inside its window and lapses after it    */
/* ================================================================== */

describe('ACCEPT: resolveTemplate — override inside its window, then the ACTIVE one, else built-in', () => {
  it('window edges: start inclusive, end exclusive; other audience unaffected', async () => {
    const portal = newPortal();
    expect((await resolveTemplate('FREE', NOW, { portal })).source).toBe('builtin');
    const active = await row(portal, { status: 'ACTIVE', name: 'Everyday', html: marked('EVERYDAY') });
    const start = IST(0, 0, 23);
    const end = IST(0, 0, 30);
    const budget = await row(portal, { status: 'SCHEDULED', name: 'Budget week', html: marked('BUDGET'), startsAt: start, endsAt: end });
    const at = (t: Date) => resolveTemplate('FREE', t, { portal });
    expect((await at(new Date(start.getTime() - 1))).id).toBe(active.id);
    expect(await at(start)).toMatchObject({ id: budget.id, source: 'override' });
    expect((await at(new Date(end.getTime() - 1))).id).toBe(budget.id);
    expect(await at(end)).toMatchObject({ id: active.id, source: 'active' });
    expect((await resolveTemplate('PREMIUM', start, { portal })).source).toBe('builtin');
  });

  it('the build uses it: the frozen email carries the template and DigestSend.templateId; the override lapses on its own', async () => {
    const portal = newPortal();
    await ensureTestAds(portal);
    const active = await row(portal, { status: 'ACTIVE', html: marked('EVERYDAY') });
    await row(portal, { status: 'SCHEDULED', html: marked('BUDGET'), startsAt: IST(0, 0, 22), endsAt: IST(0, 0, 23) });
    const items: FrozenItem[] = Array.from({ length: 5 }, (_, i) => ({
      rank: i + 1,
      section: 'MAIN',
      articleKey: `tpl:${i}`,
      campaignId: null,
      title: `High Court ruling ${i + 1}`,
      url: `https://www.taxscan.in/top-stories/r-${i}/${7000 + i}`,
      authority: 'Supreme Court',
      category: 'Income Tax',
      excerpt: null,
      capturedAt: new Date('2026-10-21T10:00:00Z'),
      readRate: null,
    }));
    const sel = (): DigestSelection => ({
      windowStart: IST(6, 30, 21),
      windowEnd: IST(6, 30),
      candidateCount: 5,
      outcome: 'ok',
      perAudience: { FREE: items, PREMIUM: items },
      mainCounts: { FREE: 5, PREMIUM: 5 },
      rows: collapseRows({ FREE: items, PREMIUM: items }),
      reads: { used: false, source: 'test', note: null },
      droppedDead: 0,
    });
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: cfg() });
    await advanceRun(run.id, 'cron', { sender: new FakeSender(), now: IST(6, 30), cfg: cfg(), quiet: { start: '23:00', end: '07:00' }, alerts: false, selectItems: async () => sel() });
    const sends = await prisma.digestSend.findMany({ where: { runId: run.id } });
    const free = sends.find((s) => s.audience === 'FREE')!;
    const premium = sends.find((s) => s.audience === 'PREMIUM')!;
    expect(free.html).toContain('BUDGET &middot;');
    expect(free.templateId).not.toBeNull();
    expect(free.templateId).not.toBe(active.id);
    expect(premium.templateId).toBeNull(); // no Premium template → built-in
    expect(premium.html).toContain('>Daily Digest');

    // The next day the override has lapsed: the ACTIVE template is used.
    const out = await renderDigestContent({ runId: 'r', runDate: new Date(Date.UTC(2026, 9, 23)), audience: 'FREE', items, cfg: cfg(), portal, at: IST(6, 30, 23) });
    expect(out.templateId).toBe(active.id);
    expect(out.html).toContain('EVERYDAY &middot;');
  });

  it('with no template at all the built-in one is used (nothing changes before an admin activates one)', async () => {
    const portal = newPortal();
    await ensureTestAds(portal);
    const items: FrozenItem[] = [1, 2, 3, 4, 5].map((i) => ({ rank: i, section: 'MAIN', articleKey: `b:${i}`, campaignId: null, title: `Story ${i}`, url: `https://www.taxscan.in/x/${i}`, authority: null, category: 'GST', excerpt: null, capturedAt: NOW, readRate: null }));
    const out = await renderDigestContent({ runId: 'r', runDate: new Date(Date.UTC(2026, 9, 22)), audience: 'FREE', items, cfg: cfg(), portal, at: NOW });
    expect(out.templateId).toBeNull();
    expect(out.html).toContain('Daily Digest &middot; 22 October 2026</p>'); // the date sits in the header bar
    expect(out.html).not.toContain('ts-date');
  });
});

/* ================================================================== */
/* The validation checklist: each rule red and green                   */
/* ================================================================== */

describe('checklist: every rule, red and green', () => {
  it('the built-in template passes every check, both audiences', () => {
    for (const a of ['FREE', 'PREMIUM'] as const) {
      const v = check(BUILTIN_TEMPLATE_HTML, a);
      expect(v.checks.filter((c) => !c.ok)).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.budgetBytes).toBeGreaterThan(20_000);
      expect(v.budgetBytes).toBeLessThan(90 * 1024);
    }
  });

  it('compiles: a compile error fails it (and everything else is "not checked")', () => {
    const v = check(null, 'FREE', cfg(), 'MJML error: mj-text cannot be used inside mj-section');
    expect(v.ok).toBe(false);
    expect(v.checks[0]).toMatchObject({ id: 'compiles', ok: false, problems: ['MJML error: mj-text cannot be used inside mj-section'] });
    expect(v.checks.slice(1).every((c) => !c.ok && /Not checked/.test(c.problems[0]))).toBe(true);
    expect(checkOf(BUILTIN_TEMPLATE_HTML, 'compiles').ok).toBe(true);
  });

  it('placeholders: missing, twice, unknown, a row placeholder outside a table / inside a cell, preheader in <head>', () => {
    expect(checkOf(BUILTIN_TEMPLATE_HTML.replace('{{footer}}', ''), 'placeholders').problems).toContain('{{footer}} is missing.');
    expect(checkOf(BUILTIN_TEMPLATE_HTML.replace('{{stories}}', '{{stories}}\n{{stories}}'), 'placeholders').problems).toContain('{{stories}} appears 2 times; it must appear exactly once.');
    expect(checkOf(BUILTIN_TEMPLATE_HTML.replace('{{date}}', '{{date}} {{reader_name}}'), 'placeholders').problems).toContain('{{reader_name}} is not a placeholder this digest fills.');
    expect(checkOf(BUILTIN_TEMPLATE_HTML.replace('{{icymi}}', '<tr><td>{{icymi}}</td></tr>'), 'placeholders').problems.join(' ')).toMatch(/\{\{icymi\}\} must sit directly inside a <table>.*inside a <td>/);
    expect(checkOf(BUILTIN_TEMPLATE_HTML.replace('<title>{{subject}}</title>', '<title>{{subject}}</title>{{preheader}}').replace('</style>\n</head>\n<body class="ts-bg" style="margin:0;padding:0;width:100%;background-color:#f2f3f5;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">\n{{preheader}}', '</style>\n</head>\n<body>'), 'placeholders').problems).toContain('{{preheader}} must be in <body>, not <head>.');
    // Optional placeholders may be left out ...
    expect(checkOf(BUILTIN_TEMPLATE_HTML.replace('{{logo}}', 'Taxscan'), 'placeholders').ok).toBe(true);
    // ... but {{unsubscribe_link}} is refused: Mailercloud adds its own unsubscribe footer and does not fill this tag.
    const dead = checkOf(BUILTIN_TEMPLATE_HTML.replace('</body>', '<a href="{{unsubscribe_link}}">Unsubscribe</a></body>'), 'placeholders');
    expect(dead.ok).toBe(false);
    expect(dead.problems.join(' ')).toMatch(/\{\{unsubscribe_link\}\} must be removed: Mailercloud adds the unsubscribe footer/);
  });

  it('footer: inside a comment, an Outlook-only block, a hidden element, <head>, or hidden by a <style> rule → red; hiding your own class is fine', () => {
    const fail = (html: string) => checkOf(html, 'footer');
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('{{footer}}', '<!-- {{footer}} -->')).problems.join(' ')).toMatch(/inside an HTML comment/);
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('{{footer}}', '<!--[if mso]>{{footer}}<![endif]-->')).ok).toBe(false);
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('{{footer}}', '<tbody style="display: none">{{footer}}</tbody>')).problems.join(' ')).toMatch(/styled to be invisible/);
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('{{footer}}', '<tbody hidden>{{footer}}</tbody>')).problems.join(' ')).toMatch(/hidden attribute/);
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('{{footer}}', '').replace('<title>', '<title>{{footer}}')).ok).toBe(false);
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('</style>', 'td[data-footer]{display:none}</style>')).problems.join(' ')).toMatch(/A <style> rule hides elements the footer uses/);
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('</style>', '@media (max-width:600px){p{font-size:0!important}}</style>')).ok).toBe(false);
    expect(fail(BUILTIN_TEMPLATE_HTML.replace('</style>', '@media (max-width:600px){.hide-mobile{display:none!important}}</style>')).ok).toBe(true);
    expect(fail(BUILTIN_TEMPLATE_HTML).ok).toBe(true);
  });

  it('no active content: script, form, iframe, event handler, external stylesheet → red', () => {
    const problems = (extra: string) => checkOf(BUILTIN_TEMPLATE_HTML.replace('</body>', `${extra}</body>`), 'no_active_content').problems.join(' ');
    expect(problems('<script src="https://www.taxscan.in/x.js"></script>')).toMatch(/<script>/);
    expect(problems('<form action="https://www.taxscan.in/"><input name="q"></form>')).toMatch(/<form>.*form control/);
    expect(problems('<iframe src="https://www.taxscan.in/"></iframe>')).toMatch(/<iframe>/);
    expect(problems('<p onclick="x()">hi</p>')).toMatch(/event handler/);
    expect(problems('<link rel="stylesheet" href="https://www.taxscan.in/a.css">')).toMatch(/<link>/);
    expect(checkOf(BUILTIN_TEMPLATE_HTML, 'no_active_content').ok).toBe(true);
  });

  it('links: an off-allowlist link, mailto:, an http or off-host image → red; allowlisted links get the digest UTM', () => {
    const problems = (extra: string) => checkOf(BUILTIN_TEMPLATE_HTML.replace('</body>', `${extra}</body>`), 'links').problems.join(' ');
    expect(problems('<a href="https://evil.example.com/promo">x</a>')).toMatch(/evil\.example\.com.*not allowed/);
    expect(problems('<a href="mailto:desk@taxscan.in">x</a>')).toMatch(/not allowed/);
    expect(problems('<img src="http://www.taxscan.in/logo.png" alt="Taxscan">')).toMatch(/Image http:\/\/www\.taxscan\.in/);
    expect(problems('<img src="https://cdn.example.com/logo.png" alt="Taxscan">')).toMatch(/cdn\.example\.com/);
    const ok = BUILTIN_TEMPLATE_HTML.replace('</body>', `<a href="https://www.taxscan.in/about">About</a><img src="https://push.taxscan.in/email-assets/${'a'.repeat(64)}.png" alt="Logo"></body>`);
    expect(checkOf(ok, 'links').ok).toBe(true);
    const r = renderDigest({ items: [{ rank: 1, section: 'MAIN', articleKey: 'k', campaignId: null, title: 'T', url: 'https://www.taxscan.in/x/1', authority: null, category: 'GST', excerpt: null, capturedAt: NOW, readRate: null }], audience: 'FREE', runDate: NOW, cfg: cfg(), template: { html: ok }, assetBaseUrl: cfg().assetBaseUrl });
    expect(r.html).toMatch(/href="https:\/\/www\.taxscan\.in\/about\?utm_source=taxscan-digest&amp;utm_medium=email&amp;utm_campaign=digest-2026-10-22-free&amp;utm_content=template"/);
    // At send time a bad link is a refusal (fail closed), never sent.
    expect(() => renderDigest({ items: [{ rank: 1, section: 'MAIN', articleKey: 'k', campaignId: null, title: 'T', url: 'https://www.taxscan.in/x/1', authority: null, category: 'GST', excerpt: null, capturedAt: NOW, readRate: null }], audience: 'FREE', runDate: NOW, cfg: cfg(), template: { html: BUILTIN_TEMPLATE_HTML.replace('</body>', '<a href="https://evil.example.com/">x</a></body>') } })).toThrow(/evil\.example\.com/);
  });

  it('alt text: an image without alt, or with an empty one → red', () => {
    const img = (attrs: string) => checkOf(BUILTIN_TEMPLATE_HTML.replace('{{logo}}', `<img src="https://www.taxscan.in/logo.png" ${attrs}>`), 'alt_text');
    expect(img('').problems.join(' ')).toMatch(/www\.taxscan\.in\/logo\.png\) has no alt text/);
    expect(img('alt=" "').ok).toBe(false);
    expect(img('alt="Taxscan"').ok).toBe(true);
  });

  it('size: the worst-case email over the budget → red; under it → green with the figure; near it → a warning note', () => {
    const big = BUILTIN_TEMPLATE_HTML.replace('</body>', `<p style="display:none">${'x'.repeat(60_000)}</p></body>`);
    expect(checkOf(big, 'size').problems.join(' ')).toMatch(/worst-case email is \d+\.\d KB .* the limit is 90 KB/);
    // The built-in worst case (12 stories with pictures, 3 image ads, the social row) is ~72 KB; +12 KB is near the 90 KB limit, not over it.
    const near = BUILTIN_TEMPLATE_HTML.replace('</body>', `<p style="display:none">${'x'.repeat(12_000)}</p></body>`);
    const n2 = checkOf(near, 'size');
    expect(n2.ok).toBe(true);
    expect(n2.note).toMatch(/close to the 90 KB limit/);
    expect(checkOf(BUILTIN_TEMPLATE_HTML, 'size').note).toMatch(/KB( of 90 KB| — close to the 90 KB limit)/);
  });

  it('Premium: a subscription link or "Subscribe now" in the Premium template → red; the same in the Free one is fine', () => {
    const withSub = BUILTIN_TEMPLATE_HTML.replace('</body>', '<a href="https://www.taxscan.in/subscribe?plan=1">Join</a></body>');
    expect(checkOf(withSub, 'premium_no_subscription', 'PREMIUM').problems.join(' ')).toMatch(/offers a subscription/);
    expect(checkOf(BUILTIN_TEMPLATE_HTML.replace('{{date}}', '{{date}} · Subscribe now'), 'premium_no_subscription', 'PREMIUM').ok).toBe(false);
    expect(checkOf(withSub, 'premium_no_subscription', 'FREE')).toMatchObject({ ok: true, note: 'Not applicable to the Free template.' });
    expect(checkOf(BUILTIN_TEMPLATE_HTML, 'premium_no_subscription', 'PREMIUM').ok).toBe(true);
  });
});

/* ================================================================== */
/* MJML                                                                 */
/* ================================================================== */

describe('MJML: compiled at save only; a compile error blocks activation with a readable message', () => {
  it('compileTemplate: HTML passes through; MJML without the compiler, with errors, or throwing → a readable error', async () => {
    expect(await compileTemplate('HTML', '<p>x</p>')).toEqual({ html: '<p>x</p>', error: null });
    expect((await compileTemplate('MJML', '<mjml/>', { mjml: null })).error).toMatch(/MJML is not available in this build: templates are plain email HTML/);
    const bad: MjmlCompiler = async () => ({ html: '<html></html>', errors: [{ formattedMessage: 'Line 3 of input (mj-text) — mj-text cannot be used inside mj-section' }] });
    expect(await compileTemplate('MJML', '<mjml/>', { mjml: bad })).toEqual({ html: null, error: 'MJML error: Line 3 of input (mj-text) — mj-text cannot be used inside mj-section' });
    const boom: MjmlCompiler = async () => {
      throw new Error('Malformed MJML.\nCheck that your structure is correct');
    };
    expect((await compileTemplate('MJML', '<mjml', { mjml: boom })).error).toBe('MJML error: Malformed MJML. Check that your structure is correct');
  });

  it('through the API: the compile error is shown, activation is refused; with a working compiler the same template activates', async () => {
    const portal = newPortal();
    const bad: MjmlCompiler = async () => ({ html: '', errors: [{ message: 'mj-text cannot be used inside mj-section', line: 3 }] });
    const t = await create(appFor(portal, { mjml: bad }), { name: 'MJML try', audience: 'FREE', format: 'MJML', source: '<mjml><mj-body/></mjml>' });
    expect(t.validationOk).toBe(false);
    expect(t.failed).toContain('compiles');
    const res = await activate(appFor(portal, { mjml: bad }), t.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.validation.checks[0].problems[0]).toBe('MJML error: mj-text cannot be used inside mj-section');
    expect((await prisma.digestTemplate.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('DRAFT');

    const good: MjmlCompiler = async () => ({ html: BUILTIN_TEMPLATE_HTML, errors: [] });
    const app = appFor(portal, { mjml: good });
    const saved = await request(app).put(`/api/digest/templates/${t.id}`).set('Cookie', adminCookie).send({ source: '<mjml><mj-body/></mjml> ' });
    expect(saved.body.validationOk).toBe(true);
    expect((await activate(app, t.id)).status).toBe(200);
    const stored = await prisma.digestTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(stored).toMatchObject({ status: 'ACTIVE', format: 'MJML', compileError: null });
    expect(stored.compiledHtml).toBe(BUILTIN_TEMPLATE_HTML); // compiled at save; the send path only reads it
  });
});

/* ================================================================== */
/* Lifecycle through the routes                                         */
/* ================================================================== */

describe('ACCEPT: activation is blocked while validation fails', () => {
  it('a failing draft is refused with its checklist; fixed, it activates', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const t = await create(app, { name: 'Broken', audience: 'FREE', source: BUILTIN_TEMPLATE_HTML.replace('{{footer}}', '') });
    expect(t).toMatchObject({ status: 'DRAFT', validationOk: false });
    expect(t.failed).toEqual(expect.arrayContaining(['placeholders', 'footer']));
    const r = await activate(app, t.id);
    expect(r.status).toBe(409);
    expect(r.body.validation.ok).toBe(false);
    expect(await prisma.digestTemplate.count({ where: { portal, status: 'ACTIVE' } })).toBe(0);
    expect((await resolveTemplate('FREE', NOW, { portal })).source).toBe('builtin');

    const fixed = await request(app).put(`/api/digest/templates/${t.id}`).set('Cookie', adminCookie).send({ source: marked('FIXED') });
    expect(fixed.body.validationOk).toBe(true);
    const ok = await activate(app, t.id);
    expect(ok.status).toBe(200);
    expect(ok.body.inUse.FREE).toMatchObject({ id: t.id, source: 'active' });
  });

  it('a passing draft is re-checked at activation: a config change since the save (allowlist) still blocks it', async () => {
    const portal = newPortal();
    const t = await create(appFor(portal), { name: 'Logo', audience: 'FREE', source: marked('LOGO').replace('{{logo}}', `<img src="https://assets.example.org/logo.png" alt="Taxscan">`) });
    expect(t.failed).toEqual(['links']);
    // A different asset host now covers the image: the same stored draft passes at activation.
    const c2 = cfg({ DIGEST_ASSET_BASE_URL: 'https://assets.example.org' });
    expect((await activate(appFor(portal, { c: c2 }), t.id)).status).toBe(200);
  });

  it('only a draft can be edited; ACTIVE cannot be archived; copy makes a new draft; scheduling is checked too', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const t = await create(app, { name: 'A', audience: 'PREMIUM', copyFrom: 'builtin' });
    expect(t.validationOk).toBe(true);
    await activate(app, t.id);
    expect((await request(app).put(`/api/digest/templates/${t.id}`).set('Cookie', adminCookie).send({ name: 'B' })).status).toBe(409);
    expect((await request(app).post(`/api/digest/templates/${t.id}/archive`).set('Cookie', adminCookie).send({ confirm: true })).body.error).toBe('active');
    const copy = await create(app, { name: 'A copy', audience: 'PREMIUM', copyFrom: t.id });
    expect(copy.status).toBe('DRAFT');

    const bad = await create(app, { name: 'Bad sched', audience: 'PREMIUM', source: BUILTIN_TEMPLATE_HTML.replace('{{ad_slot_3}}', '') });
    const s1 = await request(app).post(`/api/digest/templates/${bad.id}/schedule`).set('Cookie', adminCookie).send({ startsAt: IST(0, 0, 23).toISOString(), endsAt: IST(0, 0, 25).toISOString() });
    expect(s1.status).toBe(409);
    expect(s1.body.error).toBe('validation_failed');
    const s2 = await request(app).post(`/api/digest/templates/${copy.id}/schedule`).set('Cookie', adminCookie).send({ startsAt: IST(0, 0, 23).toISOString(), endsAt: IST(0, 0, 25).toISOString() });
    expect(s2.status).toBe(200);
    expect(s2.body.template).toMatchObject({ status: 'SCHEDULED', window: 'upcoming' });
    const third = await create(app, { name: 'Overlap', audience: 'PREMIUM', copyFrom: 'builtin' });
    const s3 = await request(app).post(`/api/digest/templates/${third.id}/schedule`).set('Cookie', adminCookie).send({ startsAt: IST(0, 0, 24).toISOString(), endsAt: IST(0, 0, 26).toISOString() });
    expect(s3.body).toMatchObject({ error: 'overlap' });
    const s4 = await request(app).post(`/api/digest/templates/${third.id}/schedule`).set('Cookie', adminCookie).send({ startsAt: IST(0, 0, 20).toISOString(), endsAt: IST(0, 0, 21).toISOString() });
    expect(s4.body).toMatchObject({ error: 'bad_window' });
  });
});

describe('revert to the previous version', () => {
  it('activating B archives A and remembers it; Revert brings A back (B → draft); Revert again → built-in; then nothing to revert', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const a = await create(app, { name: 'A', audience: 'FREE', source: marked('AAA') });
    await activate(app, a.id);
    const b = await create(app, { name: 'B', audience: 'FREE', source: marked('BBB') });
    const act = await activate(app, b.id);
    expect(act.body.revertTo.FREE).toEqual({ available: true, name: 'A' });
    expect(await prisma.digestTemplate.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'ARCHIVED' });
    expect(await prisma.digestTemplate.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'ACTIVE', replacesId: a.id });

    const r1 = await request(app).post('/api/digest/templates/revert/free').set('Cookie', adminCookie).send({ confirm: true });
    expect(r1.status).toBe(200);
    expect(r1.body.inUse.FREE).toMatchObject({ id: a.id, name: 'A' });
    expect(await prisma.digestTemplate.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'DRAFT', replacesId: null });

    const r2 = await request(app).post('/api/digest/templates/revert/free').set('Cookie', adminCookie).send({ confirm: true });
    expect(r2.body.inUse.FREE).toMatchObject({ id: null, source: 'builtin' });
    const r3 = await request(app).post('/api/digest/templates/revert/free').set('Cookie', adminCookie).send({ confirm: true });
    expect(r3.status).toBe(409);
    expect(r3.body.error).toBe('nothing_to_revert');
    expect((await request(app).post('/api/digest/templates/revert/free').set('Cookie', adminCookie).send({})).status).toBe(400);
  });

  it('the previous template is re-checked: if it no longer passes, Revert is refused and nothing changes', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const a = await create(app, { name: 'A', audience: 'FREE', source: marked('AAA') });
    await activate(app, a.id);
    const b = await create(app, { name: 'B', audience: 'FREE', source: marked('BBB') });
    await activate(app, b.id);
    // A's stored html has since become invalid (e.g. the allowlist changed under it).
    await prisma.digestTemplate.update({ where: { id: a.id }, data: { compiledHtml: marked('AAA').replace('{{footer}}', '') } });
    const r = await request(app).post('/api/digest/templates/revert/free').set('Cookie', adminCookie).send({ confirm: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('validation_failed');
    expect(await prisma.digestTemplate.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'ACTIVE' });
  });
});

/* ================================================================== */
/* Access, audit, preview                                               */
/* ================================================================== */

describe('any signed-in staff user (ADMIN or PUBLISHER, owner 29 Oct)', () => {
  const ok = (name: string, status: number) => expect([name, status >= 200 && status < 300]).toEqual([name, true]);

  it('a publisher gets 2xx on every templates route (previews, activate, revert and the large-body path included)', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const fresh = () => create(app, { name: 'X', audience: 'FREE', copyFrom: 'builtin' }).then((t) => t.id);
    const calls: [string, (id: string) => request.Test][] = [
      ['GET /templates', () => request(app).get('/api/digest/templates')],
      ['GET /templates/:id', (id) => request(app).get(`/api/digest/templates/${id}`)],
      ['POST /templates', () => request(app).post('/api/digest/templates').send({ name: 'p', audience: 'FREE', copyFrom: 'builtin' })],
      ['POST /templates (120 KB body, past the 64 KB default parser)', () => request(app).post('/api/digest/templates').send({ name: 'Big', audience: 'FREE', source: `<p>${'x'.repeat(120_000)}</p>` })],
      ['PUT /templates/:id', (id) => request(app).put(`/api/digest/templates/${id}`).send({ name: 'p' })],
      ['POST /templates/:id/validate', (id) => request(app).post(`/api/digest/templates/${id}/validate`).send({})],
      ['GET /templates/:id/preview', (id) => request(app).get(`/api/digest/templates/${id}/preview`)],
      ['GET /templates/builtin/preview/free', () => request(app).get('/api/digest/templates/builtin/preview/free')],
      ['POST /templates/:id/activate', (id) => request(app).post(`/api/digest/templates/${id}/activate`).send({ confirm: true })],
      ['POST /templates/:id/schedule', (id) => request(app).post(`/api/digest/templates/${id}/schedule`).send({ startsAt: IST(0, 0, 23).toISOString(), endsAt: IST(0, 0, 24).toISOString() })],
      ['POST /templates/:id/archive', (id) => request(app).post(`/api/digest/templates/${id}/archive`).send({ confirm: true })],
    ];
    for (const [name, run] of calls) ok(name, (await run(await fresh()).set('Cookie', publisherCookie)).status);
    for (const [name, run] of calls) expect([name, (await run(await fresh())).status]).toEqual([name, 401]);

    // Revert needs a replaced template to go back to: its own portal and history.
    const rp = newPortal();
    const rapp = appFor(rp);
    const first = await create(rapp, { name: 'R1', audience: 'FREE', source: marked('R1') });
    await activate(rapp, first.id);
    const second = await create(rapp, { name: 'R2', audience: 'FREE', source: marked('R2') });
    await activate(rapp, second.id);
    ok('POST /templates/revert/:audience', (await request(rapp).post('/api/digest/templates/revert/free').set('Cookie', publisherCookie).send({ confirm: true })).status);
    expect((await request(rapp).post('/api/digest/templates/revert/free').send({ confirm: true })).status).toBe(401);

    expect((await request(app).get('/api/digest/templates').set('Authorization', AUTH)).status).toBe(200);
    expect((await request(app).get('/api/digest/templates').set('Cookie', adminCookie)).status).toBe(200);
  });

  it('what a publisher saves, activates and archives is audited with the publisher as the actor', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const made = await request(app).post('/api/digest/templates').set('Cookie', publisherCookie).send({ name: 'By publisher', audience: 'FREE', source: marked('PUB') });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    await request(app).post(`/api/digest/templates/${id}/activate`).set('Cookie', publisherCookie).send({ confirm: true });
    const other = await create(app, { name: 'Other', audience: 'FREE', copyFrom: 'builtin' });
    await request(app).post(`/api/digest/templates/${other.id}/archive`).set('Cookie', publisherCookie).send({ confirm: true });
    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'DigestTemplate', resourceId: id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['DIGEST_TEMPLATE_SAVED', 'DIGEST_TEMPLATE_ACTIVATED']);
    expect(rows.every((r) => r.userId === publisher.id)).toBe(true);
    const archived = await prisma.auditLog.findFirstOrThrow({ where: { resourceType: 'DigestTemplate', resourceId: other.id, action: 'DIGEST_TEMPLATE_ARCHIVED' } });
    expect(archived.userId).toBe(publisher.id);
  });
});

describe('audit: a row on every save, activate, revert and archive — never the source or html', () => {
  it('rows and their contents', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const a = await create(app, { name: 'Audited A', audience: 'FREE', source: marked('AAA') });
    await request(app).put(`/api/digest/templates/${a.id}`).set('Cookie', adminCookie).send({ name: 'Audited A2', source: marked('AAA2') });
    await activate(app, a.id);
    const b = await create(app, { name: 'Audited B', audience: 'FREE', source: marked('BBB') });
    await activate(app, b.id);
    await request(app).post('/api/digest/templates/revert/free').set('Cookie', adminCookie).send({ confirm: true });
    const c = await create(app, { name: 'Audited C', audience: 'FREE', copyFrom: 'builtin' });
    await request(app).post(`/api/digest/templates/${c.id}/schedule`).set('Cookie', adminCookie).send({ startsAt: IST(0, 0, 23).toISOString(), endsAt: IST(0, 0, 24).toISOString() });
    await request(app).post(`/api/digest/templates/${c.id}/archive`).set('Cookie', adminCookie).send({ confirm: true });

    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'DigestTemplate', resourceId: { in: [a.id, b.id, c.id] } }, orderBy: { createdAt: 'asc' } });
    const seq = rows.map((r) => `${r.action}:${r.resourceId === a.id ? 'A' : r.resourceId === b.id ? 'B' : 'C'}`);
    expect(seq).toEqual([
      'DIGEST_TEMPLATE_SAVED:A',
      'DIGEST_TEMPLATE_SAVED:A',
      'DIGEST_TEMPLATE_ACTIVATED:A',
      'DIGEST_TEMPLATE_SAVED:B',
      'DIGEST_TEMPLATE_ACTIVATED:B',
      'DIGEST_TEMPLATE_REVERTED:B',
      'DIGEST_TEMPLATE_SAVED:C',
      'DIGEST_TEMPLATE_ACTIVATED:C',
      'DIGEST_TEMPLATE_ARCHIVED:C',
    ]);
    expect(rows.every((r) => r.userId === admin.id)).toBe(true);
    const meta = rows.map((r) => r.metadata as Record<string, unknown>);
    expect(meta[0]).toMatchObject({ name: 'Audited A', audience: 'FREE', status: 'DRAFT', format: 'HTML', created: true, validationOk: true, failed: [] });
    expect(meta[1]).toMatchObject({ name: 'Audited A2', changed: ['name', 'source'] });
    expect(meta[4]).toMatchObject({ mode: 'active', replacedId: a.id, replacedName: 'Audited A2' });
    expect(meta[5]).toMatchObject({ revertedFromName: 'Audited B', restoredId: a.id, restoredName: 'Audited A2' });
    expect(meta[7]).toMatchObject({ mode: 'scheduled', status: 'SCHEDULED' });
    expect(meta[8]).toMatchObject({ from: 'SCHEDULED', status: 'ARCHIVED' });
    const json = JSON.stringify(meta);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain('<html');
    expect(json).not.toContain('{{');
  });
});

describe('previews: "Biggest case" never shows a made-up picture URL (brief item F)', () => {
  const jpeg1600 = (): Buffer => {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const sof = Buffer.alloc(19);
    sof[0] = 0xff;
    sof[1] = 0xc0;
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(840, 5);
    sof.writeUInt16BE(1600, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(300, 1), Buffer.from([0xff, 0xd9])]);
  };
  it('no default set: the brand block; default set: that picture; the size check still uses the long URLs', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const t = await create(app, { name: 'Big', audience: 'FREE', source: marked('BIG') });
    const path = `/api/digest/templates/${t.id}/preview?data=worst`;
    const none = await request(app).get(path).set('Cookie', adminCookie);
    expect(none.status).toBe(200);
    expect(none.text).not.toContain('documents.taxscan.in/cms/media');
    expect(none.text).toContain('class="ts-brand"');
    const up = await request(app).post('/api/digest/default-story-image').set('Cookie', adminCookie).set('Content-Type', 'image/jpeg').send(jpeg1600());
    expect([200, 201]).toContain(up.status);
    const set = await request(app).get(path).set('Cookie', adminCookie);
    expect(set.text).not.toContain('documents.taxscan.in/cms/media');
    expect(set.text).not.toContain('class="ts-brand"');
    expect(set.text).toContain(up.body.image.url);
    // The checklist's size figure is measured on the fixture itself, which keeps its long made-up URLs.
    expect(worstCaseFixture(cfg()).items.every((i) => (i.imageUrl ?? '').length > 120)).toBe(true);
  });
});

describe('previews: sandbox CSP, never in the SPA origin', () => {
  it('a template preview and the built-in preview carry the sandbox CSP and frame headers', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const t = await create(app, { name: 'P', audience: 'PREMIUM', source: marked('PREVIEWED') });
    for (const path of [`/api/digest/templates/${t.id}/preview`, `/api/digest/templates/${t.id}/preview?data=worst`, '/api/digest/templates/builtin/preview/premium']) {
      const res = await request(app).get(path).set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
      expect(res.headers['content-security-policy']).toMatch(/(^|; )sandbox$/);
      expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('Premium</span>');
    }
    expect((await request(app).get(`/api/digest/templates/${t.id}/preview`).set('Cookie', adminCookie)).text).toContain('PREVIEWED &middot;');
    // A template that does not compile previews as plain text, still under the CSP.
    const broken = await create(appFor(portal, { mjml: null }), { name: 'M', audience: 'FREE', format: 'MJML', source: '<mjml/>' });
    const res = await request(app).get(`/api/digest/templates/${broken.id}/preview`).set('Cookie', adminCookie);
    expect(res.status).toBe(422);
    expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
    expect(res.text).toMatch(/MJML is not available/);
  });

  it('a body over the global 64 KB JSON limit is accepted on the templates routes only (a large layout), up to its own limit', async () => {
    const portal = newPortal();
    const app = appFor(portal);
    const big = BUILTIN_TEMPLATE_HTML.replace('</body>', `<!-- ${'x'.repeat(80_000)} --></body>`);
    const res = await request(app).post('/api/digest/templates').set('Cookie', adminCookie).send({ name: 'Big', audience: 'FREE', source: big });
    expect(res.status).toBe(201);
    expect(res.body.failed).toEqual(['size']);
    const tooLong = await request(app).post('/api/digest/templates').set('Cookie', adminCookie).send({ name: 'Huge', audience: 'FREE', source: 'x'.repeat(150_001) });
    expect(tooLong.status).toBe(400);
  });
});

describe('the built-in look stays close to today’s digest (owner, 2026-10-23)', () => {
  const its: FrozenItem[] = [1, 2, 3, 4, 5].map((i) => ({ rank: i, section: 'MAIN', articleKey: `l:${i}`, campaignId: null, title: `Story ${i}`, url: `https://www.taxscan.in/x/${i}`, authority: 'Supreme Court', category: 'GST', excerpt: 'Summary', capturedAt: NOW, readRate: null }));
  const ads = [1, 3].map((slot) => ({ slot, adId: `a${slot}`, kind: 'HOUSE', headline: 'Course', body: null, ctaText: 'Enrol now', linkUrl: 'https://academy.taxscan.in/c', altText: 'Course', image: null }));
  const r = renderDigest({ items: its, audience: 'FREE', runDate: NOW, cfg: cfg(), ads, assetBaseUrl: 'https://push.taxscan.in' });

  it('a solid #3b3543 header bar (also in dark mode) with the white logo centred, 220 px, alt text; Arial throughout', () => {
    expect(r.html).toMatch(/<td class="ts-pad ts-hdr" align="center" style="[^"]*background-color:#3b3543;[^"]*" bgcolor="#3b3543">/);
    expect(r.html).toMatch(/<img class="ts-logo" src="https:\/\/push\.taxscan\.in\/email\/taxscan-logo-on-dark-440\.png" width="220" height="53" alt="Taxscan"/);
    expect(r.html).toContain('.ts-hdr{background-color:#3b3543!important}');
    expect(r.html).not.toContain('#9b1c1c');
    const fonts = new Set([...r.html.matchAll(/font-family:([^;"]+)/g)].map((m) => m[1]));
    expect([...fonts].every((f) => /^Arial/.test(f))).toBe(true);
  });
  it('square yellow buttons with bold dark text in a table cell (Outlook paints the cell; one link, no VML), for stories and ads', () => {
    const btns = r.html.match(/<a href="[^"]*" class="ts-btn" style="[^"]*">/g) ?? [];
    expect(btns.length).toBe(7); // 5 stories + 2 ads
    for (const b of btns) expect(b).toMatch(/display:block;height:38px;line-height:38px;text-align:center;background-color:#FEE620;background-image:linear-gradient\(#FEE620,#FEE620\);[^"]*font-size:15px;font-weight:700;color:#000000;text-decoration:none/);
    expect((r.html.match(/<td align="center" width="\d+" height="38" bgcolor="#FEE620"/g) ?? []).length).toBe(7);
    expect(r.html).not.toContain('v:rect');
    expect(r.html).toContain('[data-ogsb] .ts-btn{background-color:#FEE620!important}[data-ogsc] .ts-btn{color:#000000!important}');
  });
  it('headlines #000000 (the old newsletter\'s), not underlined; body #333333; other links #1376c8', () => {
    expect(r.html).toMatch(/class="ts-head" style="[^"]*color:#000000;text-decoration:none;"/);
    expect(r.html).toMatch(/class="ts-body">Summary/);
    expect(r.html).toMatch(/color:#333333;" class="ts-body"/);
    expect(r.html).toMatch(/href="mailto:info@taxscan\.in" class="ts-link" style="[^"]*color:#1376c8;/);
  });
  it('without an asset host (unit renders) the header falls back to a white TAXSCAN wordmark', () => {
    expect(renderDigest({ items: its, audience: 'FREE', runDate: NOW, cfg: cfg() }).html).toContain('>TAXSCAN</span>');
  });
  it('the logo is served cross-origin with a long cache (mail clients and their proxies load it)', async () => {
    const res = await request(appFor(newPortal())).get('/email/taxscan-logo-white-440.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['cache-control']).toMatch(/max-age=31536000.*immutable/);
    expect((await request(appFor(newPortal())).get('/email/nope.png')).status).toBe(404);
  });
  it('the push notification icon is served the same way from /brand', async () => {
    const res = await request(appFor(newPortal())).get('/brand/taxscan-icon-192.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['cache-control']).toMatch(/max-age=31536000.*immutable/);
    expect((await request(appFor(newPortal())).get('/brand/nope.png')).status).toBe(404);
    expect((await request(appFor(newPortal())).get('/brand/..%2Fsw.js')).status).toBe(404);
  });
  it('the monochrome T badge gets exactly the icon\'s headers (the CORP header is load-bearing) and is the designer\'s file', async () => {
    const icon = await request(appFor(newPortal())).get('/brand/taxscan-icon-192.png');
    const badge = await request(appFor(newPortal())).get('/brand/taxscan-badge-96.png');
    expect(badge.status).toBe(200);
    expect(badge.headers['content-type']).toBe('image/png');
    expect(badge.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(badge.headers['cache-control']).toMatch(/max-age=31536000.*immutable/);
    for (const h of ['content-type', 'cross-origin-resource-policy', 'cache-control', 'access-control-allow-origin', 'x-content-type-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']) {
      expect([h, badge.headers[h]]).toEqual([h, icon.headers[h]]);
    }
    // 96 × 96 RGBA PNG, 692 bytes: a white T on transparent (IHDR: width, height, bit depth 8, colour type 6).
    const png = badge.body as Buffer;
    expect(png.length).toBe(692);
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([96, 96, 8, 6]);
  });
});

/* ================================================================== */
/* QA verification of f23e751 (task 10)                                */
/* ================================================================== */

describe('QA of task 10: the checklist reads attributes the way a browser does', () => {
  const B = BUILTIN_TEMPLATE_HTML;
  const fails = (html: string, id: TemplateCheckId) => !checkOf(html, id).ok;
  const fixture = (html: string) =>
    renderDigest({
      items: [{ rank: 1, section: 'MAIN', articleKey: 'k', campaignId: null, title: 'T', url: 'https://www.taxscan.in/x/1', authority: null, category: 'GST', excerpt: null, capturedAt: NOW, readRate: null }],
      audience: 'FREE',
      runDate: NOW,
      cfg: cfg(),
      template: { html },
      assetBaseUrl: cfg().assetBaseUrl,
    });

  it('an off-allowlist link or image written unquoted or slash-separated is red at the checklist AND refused at send', () => {
    for (const extra of ['<a href=https://evil.example/x>x</a>', '<a/href="https://evil.example/x">x</a>', '<a title="t"href="https://evil.example/x">x</a>']) {
      const html = B.replace('</body>', `${extra}</body>`);
      expect(fails(html, 'links')).toBe(true);
      expect(() => fixture(html)).toThrow(/evil\.example/);
    }
    for (const extra of ['<img alt="x" src=https://evil.example/p.gif>', '<video poster="https://evil.example/p.gif"></video>']) {
      const html = B.replace('</body>', `${extra}</body>`);
      expect(fails(html, 'links')).toBe(true);
      expect(() => fixture(html)).toThrow(/evil\.example/);
    }
    // A link in an Outlook-only block is checked too (Outlook renders it).
    expect(fails(B.replace('</body>', '<!--[if mso]><v:rect href="https://evil.example/x"></v:rect><![endif]--></body>'), 'links')).toBe(true);
    // Allowed links in any form still pass and get the canonical quoted form with the UTM.
    const ok = B.replace('</body>', '<a href=https://www.taxscan.in/about>About</a></body>');
    expect(fails(ok, 'links')).toBe(false);
    expect(fixture(ok).html).toMatch(/href="https:\/\/www\.taxscan\.in\/about\?utm_source=taxscan-digest&amp;utm_medium=email&amp;utm_campaign=digest-2026-10-22-free&amp;utm_content=template">About/);
  });

  it('an event handler after a slash is active content', () => {
    expect(fails(B.replace('</body>', '<img alt="x" src="https://www.taxscan.in/a.png"/onerror="x()"></body>'), 'no_active_content')).toBe(true);
  });

  it('the footer is red when hidden by an unquoted, commented or entity-encoded style, a class rule on its table, an attribute, or a !mso block', () => {
    const wrap = (open: string, close = '</table>') => B.replace('{{footer}}\n</table>', `</table>${open}{{footer}}${close}<table>`);
    expect(fails(wrap('<table style=display:none>'), 'footer')).toBe(true);
    expect(fails(wrap('<table style="display:/**/none">'), 'footer')).toBe(true);
    expect(fails(wrap('<table style="display&#58;none">'), 'footer')).toBe(true);
    expect(fails(B.replace('</style>', '.box{display:none}</style>').replace('{{footer}}\n</table>', '</table><table class="x box">{{footer}}</table><table>'), 'footer')).toBe(true);
    expect(fails(B.replace('</style>', '#f{display:none}</style>').replace('{{footer}}\n</table>', '</table><table id=f>{{footer}}</table><table>'), 'footer')).toBe(true);
    expect(fails(wrap('<!--[if !mso]><!--><table>', '</table><!--<![endif]-->'), 'footer')).toBe(true);
    const inAttr = B.replace('{{footer}}', '').replace('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;', '<table title="{{footer}}" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;');
    expect(fails(inAttr, 'footer')).toBe(true);
    expect(fails(inAttr, 'placeholders')).toBe(true);
    // Hiding a class the footer does NOT sit in stays fine.
    expect(fails(B.replace('</style>', '.promo{display:none}</style>'), 'footer')).toBe(false);
  });

  it('activation is fenced on the html it checked: a save landing in between is never activated', async () => {
    const portal = newPortal();
    const t = await create(appFor(portal), { name: 'Race', audience: 'FREE', source: marked('RACE') });
    expect(t.validationOk).toBe(true);
    const real = prisma.digestTemplate.update.bind(prisma.digestTemplate);
    const spy = jest.spyOn(prisma.digestTemplate, 'update').mockImplementationOnce((async (args: Parameters<typeof real>[0]) => {
      const out = await real(args);
      // Another tab saves a template with no footer right after the activation's check.
      await prisma.digestTemplate.updateMany({ where: { id: t.id }, data: { source: B.replace('{{footer}}', ''), compiledHtml: B.replace('{{footer}}', '') } });
      return out;
    }) as never);
    const r = await activate(appFor(portal), t.id);
    spy.mockRestore();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('changed');
    expect(await prisma.digestTemplate.count({ where: { portal, status: 'ACTIVE' } })).toBe(0);
  });
});
