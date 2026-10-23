import bcrypt from 'bcrypt';
import request from 'supertest';
import type { DigestAudience, User } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, awaitDigestAlerts, ensureRun } from '../services/digest/runner';
import { collapseRows, type DigestSelection, type FrozenItem } from '../services/digest/builder';
import { renderDigestContent } from '../services/digest/content';
import { BUILTIN_TEMPLATE_HTML, RenderError, UNSUBSCRIBE_TAG, defuseMergeTags, renderDigest } from '../services/digest/renderer';
import { sendDigestAlerts } from '../services/digest/alerts';
import { digestAttention, digestStatus } from '../services/digest/status';
import { digestRunDetail } from '../services/digest/screen';
import type { EmailMessage } from '../lib/email';
import { FakeSender } from './digestFakeSender';
import { ensureTestAds } from './digestAdFixtures';

/**
 * Owner decisions of 2026-10-23 (docs/EMAIL_DIGEST_DESIGN.md §12, §13 task 10 notes):
 *  B. a custom template that fails at send time falls back to the built-in template
 *     (only when the failure is the template's), with one `template_fallback` alert;
 *  C. a variant rendered after the run was approved needs its OWN approval;
 *  D1. reader text never carries a live `{{…}}` merge tag.
 * Rows live under `test-digest-owner-*` portals and are removed afterwards. Nothing is sent
 * (FakeSender; alert email goes to an in-memory sender).
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
const warns: string[] = [];
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-owner-';
const PASSWORD = 'digest-owner-test-pw-1';
const QUIET = { start: '23:00', end: '07:00' };
const IST = (h: number, min = 0, day = 22) => new Date(Date.UTC(2026, 9, day, h, min) - (5 * 60 + 30) * 60_000);
const AT = IST(6, 30);
const RUN_DATE = new Date(Date.UTC(2026, 9, 22));

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
const userIds: string[] = [];

function item(i: number, o: Partial<FrozenItem> = {}): FrozenItem {
  return {
    rank: i,
    section: 'MAIN',
    articleKey: `article:${7000 + i}`,
    campaignId: null,
    title: `High Court ruling ${i} on assessment`,
    url: `https://www.taxscan.in/top-stories/ruling-${i}/${7000 + i}`,
    authority: 'Bombay High Court',
    category: 'Income Tax',
    excerpt: null,
    capturedAt: new Date('2026-10-21T10:00:00Z'),
    readRate: null,
    ...o,
  };
}
const items = (count: number, o: Partial<FrozenItem> = {}) => Array.from({ length: count }, (_, i) => item(i + 1, o));

function selection(perAudience: Record<DigestAudience, FrozenItem[]>): DigestSelection {
  return {
    windowStart: IST(6, 30, 21),
    windowEnd: AT,
    candidateCount: perAudience.FREE.length,
    outcome: 'ok',
    perAudience,
    mainCounts: { FREE: perAudience.FREE.length, PREMIUM: perAudience.PREMIUM.length },
    rows: collapseRows(perAudience),
    reads: { used: false, source: 'test', note: null },
    droppedDead: 0,
  };
}

async function dbAd(portal: string, o: { name?: string; kind?: string; linkUrl?: string } = {}) {
  return prisma.digestAd.create({
    data: {
      portal,
      name: o.name ?? `DB ad ${++n}`,
      kind: o.kind ?? 'HOUSE',
      headline: 'Learn GST litigation',
      altText: 'Course banner',
      ctaText: 'Enrol now',
      linkUrl: o.linkUrl ?? `https://academy.taxscan.in/course-${n}`,
      audience: 'ALL',
      slots: [],
      status: 'ACTIVE',
    },
  });
}

/** An ACTIVE custom template written straight to the DB (as if it passed the checklist before a config change). */
async function activeTemplate(portal: string, audience: DigestAudience, html: string, name = `Custom ${audience}`) {
  return prisma.digestTemplate.create({
    data: { portal, name, audience, status: 'ACTIVE', format: 'HTML', source: html, compiledHtml: html, activatedAt: AT },
  });
}

/** The built-in layout plus a link the allowlist refuses at send time. */
const OFF_ALLOWLIST_TEMPLATE = BUILTIN_TEMPLATE_HTML.replace('{{footer}}', '<tr><td><a href="https://evil.example.com/offer">Offer</a></td></tr>\n{{footer}}');

function go(runId: string, c: DigestEnv, sender: FakeSender, now: Date, its: FrozenItem[], trigger: 'cron' | 'retry' = 'cron') {
  return advanceRun(runId, trigger, { sender, now, cfg: c, quiet: QUIET, alerts: false, selectItems: async () => selection({ FREE: its, PREMIUM: its }) });
}

async function sendsOf(runId: string) {
  const rows = await prisma.digestSend.findMany({ where: { runId } });
  return { FREE: rows.find((s) => s.audience === 'FREE')!, PREMIUM: rows.find((s) => s.audience === 'PREMIUM')! };
}

const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
async function editorCookie(): Promise<{ user: User; cookie: string }> {
  const email = `digest-owner-${Date.now()}-${Math.floor(Math.random() * 1e9)}@team.test`;
  const user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'PUBLISHER', isActive: true } });
  userIds.push(user.id);
  const res = await request(loginApp).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc as unknown as string];
  return { user, cookie: arr.map((l) => l.split(';')[0]).join('; ') };
}

afterAll(async () => {
  await awaitDigestAlerts();
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true, sends: { select: { id: true } } } });
  const ids = [...runs.map((r) => r.id), ...runs.flatMap((r) => r.sends.map((s) => s.id))];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    if (ids.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${ids}::text[])`;
    if (userIds.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestAdPlacement.deleteMany({ where: { ad: { portal: { startsWith: PORTAL_PREFIX } } } });
  await prisma.digestAd.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestTemplate.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/* ================================================================== */
/* B. Built-in fallback when a custom template fails at send time      */
/* ================================================================== */

describe('B: built-in template fallback', () => {
  it('a custom template refused at send time → the built-in one, templateId null, one alert naming it', async () => {
    const c = cfg();
    const portal = newPortal();
    await ensureTestAds(portal);
    const tpl = await activeTemplate(portal, 'PREMIUM', OFF_ALLOWLIST_TEMPLATE, 'Budget week layout');
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    const sender = new FakeSender();
    await go(run.id, c, sender, AT, items(6));

    const s = await sendsOf(run.id);
    expect(s.PREMIUM).toMatchObject({ state: 'CREATED', templateId: null, templateFallbackFromId: tpl.id });
    expect(s.PREMIUM.templateFallbackReason).toMatch(/^link_not_allowed: .*evil\.example\.com/);
    expect(s.PREMIUM.html).not.toContain('evil.example.com');
    expect(s.FREE).toMatchObject({ templateId: null, templateFallbackFromId: null });
    expect(sender.count('createDraft')).toBe(2);

    const after = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    const marker = (after.alerts as Record<string, Record<string, unknown>>).template_fallback;
    expect(marker).toMatchObject({ audience: 'PREMIUM', templateName: 'Budget week layout', audiences: ['PREMIUM'] });

    // The alert goes out once, however often the mailer runs.
    const mails: EmailMessage[] = [];
    const deps = {
      cfg: c,
      now: IST(6, 31),
      isConfigured: () => true,
      recipients: async () => ['admin.one@team.test'],
      emailSender: async (m: EmailMessage) => {
        mails.push(m);
        return { ok: true as const };
      },
    };
    await sendDigestAlerts(run.id, deps);
    await sendDigestAlerts(run.id, deps);
    await go(run.id, c, sender, IST(6, 40), items(6));
    await sendDigestAlerts(run.id, deps);
    const fallbackMails = mails.filter((m) => /built-in template was used/.test(m.subject));
    expect(fallbackMails).toHaveLength(1);
    expect(fallbackMails[0].text).toContain('"Budget week layout" (Premium)');

    // …and a banner, derived from the variant row.
    const status = await digestStatus({ cfg: c, portal, now: IST(6, 45) });
    expect(status.attention?.code).toBe('template_fallback');
  });

  it('an over-budget custom template falls back; the built-in render keeps the size budget', async () => {
    const c = cfg();
    const portal = newPortal();
    await ensureTestAds(portal);
    const fat = BUILTIN_TEMPLATE_HTML.replace('{{footer}}', `<tr><td>${'x'.repeat(95 * 1024)}</td></tr>\n{{footer}}`);
    await activeTemplate(portal, 'FREE', fat);
    const content = await renderDigestContent({ runId: 'r', runDate: RUN_DATE, audience: 'FREE', items: items(6), cfg: c, portal, at: AT });
    expect(content.templateId).toBeNull();
    expect(content.templateFallback?.reason).toMatch(/^over_size_limit/);
    expect(Buffer.byteLength(content.html, 'utf8')).toBeLessThan(c.maxHtmlKb * 1024);
  });

  it('no fallback when the built-in template refuses too — the cause is not the template (off-allowlist story)', async () => {
    const c = cfg();
    const portal = newPortal();
    await ensureTestAds(portal);
    await activeTemplate(portal, 'FREE', OFF_ALLOWLIST_TEMPLATE);
    const bad = [...items(5), item(6, { url: 'https://evil.example.com/story/6' })];
    await expect(renderDigestContent({ runId: 'r', runDate: RUN_DATE, audience: 'FREE', items: bad, cfg: c, portal, at: AT })).rejects.toMatchObject({
      code: 'link_not_allowed',
    });
    // The same with a size limit the built-in render cannot meet either.
    const tiny = cfg({ DIGEST_MAX_HTML_KB: '10', DIGEST_HTML_WARN_KB: '5' });
    await expect(renderDigestContent({ runId: 'r', runDate: RUN_DATE, audience: 'FREE', items: items(6), cfg: tiny, portal, at: AT })).rejects.toBeInstanceOf(RenderError);
  });

  it('no fallback for an ads failure: the variant waits for its ads, no template_fallback alert', async () => {
    const c = cfg();
    const portal = newPortal();
    await dbAd(portal);
    await dbAd(portal, { kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' });
    const tpl = await activeTemplate(portal, 'PREMIUM', OFF_ALLOWLIST_TEMPLATE);
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    await go(run.id, c, new FakeSender(), AT, items(5));
    const s = await sendsOf(run.id);
    expect(s.PREMIUM).toMatchObject({ state: 'FAILED', html: null, templateFallbackFromId: null });
    expect(s.PREMIUM.lastError).toMatch(/^ads_unfillable/);
    const after = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.alerts as Record<string, unknown>).template_fallback).toBeUndefined();
    // Once the ads are fixed, the later render falls back (that IS the template's fault) and says so.
    await dbAd(portal, { name: 'fix' });
    await go(run.id, c, new FakeSender(), IST(6, 40), items(5), 'retry');
    const s2 = await sendsOf(run.id);
    expect(s2.PREMIUM).toMatchObject({ templateId: null, templateFallbackFromId: tpl.id });
    const after2 = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after2.alerts as Record<string, unknown>).template_fallback).toBeDefined();
  });

  it('the built-in fallback still never puts a SUBSCRIPTION ad in front of Premium readers', async () => {
    const c = cfg();
    const portal = newPortal();
    await ensureTestAds(portal);
    await dbAd(portal, { kind: 'SUBSCRIPTION', name: 'Subscribe', linkUrl: 'https://www.taxscan.in/subscribe-now' });
    await activeTemplate(portal, 'PREMIUM', OFF_ALLOWLIST_TEMPLATE);
    const content = await renderDigestContent({ runId: 'r', runDate: RUN_DATE, audience: 'PREMIUM', items: items(12), cfg: c, portal, at: AT });
    expect(content.templateFallback).toBeDefined();
    expect(content.html).not.toContain('subscribe-now');
    const kinds = await prisma.digestAd.findMany({ where: { id: { in: (content.placements ?? []).map((p) => p.adId) } }, select: { kind: true } });
    expect(kinds.map((k) => k.kind)).not.toContain('SUBSCRIPTION');
  });

  it('banner: a fallback is shown, and only when nothing more urgent is', () => {
    const base = {
      enabled: true,
      now: IST(7, 0),
      cfg: { sendLive: true, approvalRequired: false, sanityMaxCandidates: 150, cutoff: '17:00' },
      run: { build: 'BUILT' as const, approval: 'NOT_REQUIRED' as const, skipReason: null, candidateCount: 10 },
    };
    const send = (o: Record<string, unknown> = {}) => ({ audience: 'FREE' as const, state: 'CREATED' as const, sendAfter: IST(7, 30), lastError: null, lastErrorKind: null, ...o });
    expect(digestAttention({ ...base, sends: [send({ templateFallbackFromId: 't1' })] })?.code).toBe('template_fallback');
    expect(digestAttention({ ...base, sends: [send()] })).toBeNull();
    expect(digestAttention({ ...base, sends: [send({ templateFallbackFromId: 't1', state: 'FAILED', lastErrorKind: 'FATAL', lastError: 'x' })] })?.code).toBe('fatal');
  });
});

/* ================================================================== */
/* C. A later-rendered variant needs its own approval                  */
/* ================================================================== */

describe('C: separate approval for a variant rendered after the approval', () => {
  const conf = cfg({ DIGEST_APPROVAL_REQUIRED: 'true' });

  /** Free fills (HOUSE + SUBSCRIPTION); Premium cannot until a second house ad is added. */
  async function setup(c = conf) {
    const portal = newPortal();
    await dbAd(portal);
    await dbAd(portal, { kind: 'SUBSCRIPTION', linkUrl: 'https://www.taxscan.in/subscribe' });
    const run = await ensureRun({ portal, now: IST(6, 0), cfg: c });
    const sender = new FakeSender();
    await go(run.id, c, sender, AT, items(5));
    const app = (at: Date) =>
      createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: c, clock: () => at, portal, sender, quiet: QUIET, alerts: false } });
    return { portal, run, sender, app };
  }
  const approve = (app: ReturnType<typeof createApp>, runId: string, cookie: string, audiences?: DigestAudience[]) =>
    request(app).post(`/api/digest/runs/${runId}/approve`).set('Cookie', cookie).send(audiences ? { audiences } : {});

  it('the run approval does not cover it; its own Approve (publisher, audited) releases it alone', async () => {
    const t = await setup();
    const { user, cookie } = await editorCookie();
    expect((await approve(t.app(IST(6, 45)), t.run.id, cookie, ['FREE'])).status).toBe(200);
    await dbAd(t.portal, { name: 'fixed after the approval' });
    await go(t.run.id, conf, t.sender, IST(7, 30), items(5));
    let s = await sendsOf(t.run.id);
    expect(s.FREE.state).toBe('SCHEDULED');
    expect(s.PREMIUM).toMatchObject({ state: 'CREATED', ownApprovalRequired: true, approvedAt: null });
    expect(t.sender.count('schedule')).toBe(1);

    // The screen shows it as waiting, with Approve on offer although Free already went out.
    const detail = await digestRunDetail(t.run.id, { cfg: conf, now: IST(7, 31), quiet: QUIET, providerReady: true, viewerCanTest: false });
    expect(detail?.variants.find((v) => v.audience === 'PREMIUM')?.approval).toBe('waiting');
    expect(detail?.variants.find((v) => v.audience === 'FREE')?.approval).toBe('approved');
    expect(detail?.actions.approve.show).toBe(true);
    expect((await digestStatus({ cfg: conf, portal: t.portal, now: IST(7, 31) })).attention?.code).toBe('awaiting_approval');

    // Approve with nothing listed approves nothing (the run is already approved).
    expect((await approve(t.app(IST(7, 32)), t.run.id, cookie, [])).status).toBe(409);
    const res = await approve(t.app(IST(7, 33)), t.run.id, cookie, ['PREMIUM']);
    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual(['PREMIUM']);
    s = await sendsOf(t.run.id);
    expect(s.PREMIUM).toMatchObject({ approvedByUserId: user.id });
    const audit = await prisma.auditLog.findMany({ where: { resourceId: t.run.id, action: 'DIGEST_APPROVED' }, orderBy: { createdAt: 'asc' } });
    expect(audit).toHaveLength(2);
    expect(audit[1].metadata).toMatchObject({ scope: 'variant', audiences: ['PREMIUM'] });

    await go(t.run.id, conf, t.sender, IST(7, 34), items(5));
    expect((await sendsOf(t.run.id)).PREMIUM.state).toBe('SCHEDULED');
    expect(t.sender.count('schedule')).toBe(2);
  });

  it('race: an approval sent while Premium was still pending never counts for it, even if it names it', async () => {
    const t = await setup();
    const { cookie } = await editorCookie();
    // The editor's screen raced the render: the request names PREMIUM, but it has no content yet.
    const res = await approve(t.app(IST(6, 45)), t.run.id, cookie, ['FREE', 'PREMIUM']);
    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual([]);
    await dbAd(t.portal, { name: 'fix' });
    await go(t.run.id, conf, t.sender, IST(7, 30), items(5));
    const s = await sendsOf(t.run.id);
    expect(s.PREMIUM).toMatchObject({ state: 'CREATED', approvedAt: null });
    expect(t.sender.count('schedule')).toBe(1);
  });

  it('race: rendered just before the run approval, but not on the editor’s screen → still waiting', async () => {
    const t = await setup();
    const { cookie } = await editorCookie();
    await dbAd(t.portal, { name: 'fix' });
    await go(t.run.id, conf, t.sender, IST(6, 40), items(5), 'retry'); // Premium rendered now
    // The editor's screen still showed Premium as waiting for ads, so it lists only FREE.
    expect((await approve(t.app(IST(6, 45)), t.run.id, cookie, ['FREE'])).status).toBe(200);
    await go(t.run.id, conf, t.sender, IST(7, 30), items(5));
    const s = await sendsOf(t.run.id);
    expect(s.FREE.state).toBe('SCHEDULED');
    expect(s.PREMIUM).toMatchObject({ state: 'CREATED', approvedAt: null });
  });

  it('…and is approved together with the run when the editor saw it', async () => {
    const t = await setup();
    const { cookie } = await editorCookie();
    await dbAd(t.portal, { name: 'fix' });
    await go(t.run.id, conf, t.sender, IST(6, 40), items(5), 'retry');
    const res = await approve(t.app(IST(6, 45)), t.run.id, cookie, ['FREE', 'PREMIUM']);
    expect(res.body.variants).toEqual(['PREMIUM']);
    await go(t.run.id, conf, t.sender, IST(7, 30), items(5));
    const s = await sendsOf(t.run.id);
    expect([s.FREE.state, s.PREMIUM.state]).toEqual(['SCHEDULED', 'SCHEDULED']);
  });

  it('unapproved at the cut-off → SKIPPED with reason not_approved', async () => {
    const t = await setup();
    const { cookie } = await editorCookie();
    await approve(t.app(IST(6, 45)), t.run.id, cookie, ['FREE']);
    await dbAd(t.portal, { name: 'fix' });
    await go(t.run.id, conf, t.sender, IST(7, 30), items(5));
    await go(t.run.id, conf, t.sender, IST(17, 0), items(5));
    const s = await sendsOf(t.run.id);
    expect(s.PREMIUM.state).toBe('SKIPPED');
    const skipped = await prisma.auditLog.findFirst({ where: { resourceId: s.PREMIUM.id, action: 'DIGEST_SKIPPED' } });
    expect(skipped?.metadata).toMatchObject({ reason: 'not_approved', audience: 'PREMIUM' });
    expect(t.sender.count('schedule')).toBe(1);
  });

  it('non-approval mode is unchanged: the later-rendered variant goes out without an approval', async () => {
    const c = cfg();
    const t = await setup(c);
    await dbAd(t.portal, { name: 'fix' });
    await go(t.run.id, c, t.sender, IST(7, 30), items(5));
    const s = await sendsOf(t.run.id);
    expect([s.FREE.state, s.PREMIUM.state]).toEqual(['SCHEDULED', 'SCHEDULED']);
  });
});

/* ================================================================== */
/* D1. Merge-tag braces in reader text                                 */
/* ================================================================== */

describe('D1: no live merge tags from reader text', () => {
  const c = cfg();
  const tricky = [
    item(1, { title: 'Ruling on {{unsubscribe_link}} and {{ footer }}', excerpt: 'Excerpt says {{contact.email}} here' }),
    item(2, { title: 'Second {{first_name}} story' }),
    ...items(4).map((x, i) => ({ ...x, rank: i + 3, articleKey: `article:${8100 + i}`, url: `https://www.taxscan.in/x/${8100 + i}` })),
  ];
  const ads = [1, 3].map((slot) => ({
    slot,
    adId: `ad-${slot}`,
    kind: 'HOUSE',
    headline: `Offer {{coupon}} ${slot}`,
    body: 'Use code {{code}}',
    ctaText: 'Buy {{now}}',
    linkUrl: `https://shop.taxscan.in/p/${slot}`,
    altText: 'Alt {{x}}',
    image: null,
  }));

  it('subject, preheader, html and text carry no reader-supplied {{…}}; our own tag still works', () => {
    const r = renderDigest({ items: tricky, audience: 'FREE', runDate: RUN_DATE, cfg: c, ads });
    expect(r.subject).not.toContain('{{');
    expect(r.subject).toBe(defuseMergeTags(r.subject));
    expect(r.preheader).not.toContain('{{');
    // The only {{…}} left in either part is the renderer's own unsubscribe tag.
    expect(r.html.match(/\{\{[^}]*\}\}/g)).toEqual([UNSUBSCRIBE_TAG]);
    expect(r.text.match(/\{\{[^}]*\}\}/g)).toEqual([UNSUBSCRIBE_TAG]);
    expect(r.html).toContain('Ruling on &#123;&#123;unsubscribe_link&#125;&#125;');
    expect(r.html).toContain('Offer &#123;&#123;coupon&#125;&#125;');
    expect(r.text).toContain('Ruling on { {unsubscribe_link} }');
    expect(r.text).toContain('Use code { {code} }');
    expect(r.html).toContain(`href="${UNSUBSCRIBE_TAG}"`);
  });

  it('a custom template’s placeholders still fill, and the postal address cannot smuggle a tag either', () => {
    const c2 = cfg({ DIGEST_POSTAL_ADDRESS: 'PO Box {{x}}, Kochi' });
    const r = renderDigest({ items: tricky, audience: 'PREMIUM', runDate: RUN_DATE, cfg: c2, ads, template: { html: BUILTIN_TEMPLATE_HTML } });
    expect(r.html).not.toMatch(/\{\{\s*(subject|date|stories|footer|preheader|logo|home_url|premium_badge|icymi|ad_slot_3)\s*\}\}/);
    expect(r.html).toContain('PO Box &#123;&#123;x&#125;&#125;');
    expect(r.text).toContain('PO Box { {x} }');
  });

  it('single braces are left alone in text; doubled ones are split', () => {
    expect(defuseMergeTags('a {b} c')).toBe('a {b} c');
    expect(defuseMergeTags('{{{x}}}')).toBe('{ { {x} } }');
  });
});
