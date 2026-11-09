import { randomBytes } from 'node:crypto';
import type { Campaign, Prisma } from '@prisma/client';
import { env, LINKEDIN_HEADROOM_DEFAULTS, type SharedLinkedInPage } from '../lib/env';
import { prisma } from '../lib/prisma';
import { pushKey } from '../services/social/allPushes';
import { alertEmail, alertIfNeeded, alertKey } from '../services/social/pageAlerts';
import {
  FAILING_AT,
  activePages,
  describeStatus,
  facebookAuthKey,
  facebookPolicyKey,
  failingStreak,
  getPageStatus,
  istClock,
  linkedinAuthKey,
  listPageStatuses,
  pageLabel,
  shortReason,
  telegramStopKey,
  type PageStatus,
} from '../services/social/pageStatus';
import { PAGE_PAUSED, pauseKey, setPause } from '../services/social/pause';
import { clearOrgHolds, holdOrgPage, ORG_DAILY_LIMIT } from '../services/linkedin/orgHold';
import { authKey as liAuthKey, resetLinkedInStops, runLinkedInTick, type WorkerDeps as LiDeps } from '../services/linkedin/worker';
import { authKey as fbAuthKey, policyKey as fbPolicyKey, resetFacebookStops, runFacebookTick, type WorkerDeps as FbDeps } from '../services/facebook/worker';
import { stopKey as tgStopKey, alertKey as tgAlertKey, runTelegramTick, type WorkerDeps as TgDeps } from '../services/telegram/worker';
import type { LinkedInRequest, LinkedInResult } from '../services/linkedin/client';
import type { FacebookResult } from '../services/facebook/client';
import type { TelegramRequest, TelegramResult } from '../services/telegram/client';

/**
 * Brief 2026-11-09-social-page-alerts-pause, acceptance 1, 2 and 8: the one page-status helper (ok / paused / stopped / held / failing),
 * and the alert email for `held` and `failing` (one per page per kind per IST day; the existing stop alerts never doubled; no secret in
 * an email). All LinkedIn / Facebook / Telegram / e-mail calls are mocked. Rows live on PRIVATE pages (`pstat-t` plays Taxscan and owns the
 * LinkedIn token, `pstat-s` plays Shopscan, `pstatfb` the Facebook page, `pstattg` the Telegram channel) under a unique portal.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-pstat-${RUN}`;
const LI_T = 'pstat-t';
const LI_S = 'pstat-s';
const FB = 'pstatfb';
const TG = 'pstattg';
const ORG_T = 'urn:li:organization:101';
const ORG_S = 'urn:li:organization:80241094';
const SECRET = `SECRET-PROVIDER-TEXT-${RUN}`;
const LI_TOKEN = `PSTAT-LI-TOKEN-${RUN}`;
const FB_TOKEN = `PSTAT-FB-TOKEN-${RUN}-EAAB1234567890`;
const TG_TOKEN = '987654321:AAFsecretSECRET-tokenvalue_0123456789xyz';
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 25) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0);
const NEXT_DAY = ist(10, 0, 26);
const FROM = ist(4, 0);
const PAUSE_NOW = at(NOW, -5);

/* ---------- pure pieces ---------- */
describe('shortReason: a provider error becomes a short reason code, never its words', () => {
  it('HTTP status (+ code), Telegram codes, network and unknown outcomes; anything else is a fixed phrase', () => {
    expect(shortReason('HTTP 422: invalid content, secret stuff')).toBe('HTTP 422');
    expect(shortReason('HTTP 400 code 100 subcode 33: Invalid parameter')).toBe('HTTP 400 code 100');
    expect(shortReason('HTTP 429')).toBe('HTTP 429');
    expect(shortReason('telegram_400_photo_refused')).toBe('telegram_400_photo_refused');
    expect(shortReason('network error')).toBe('network error');
    expect(shortReason('timeout')).toBe('timeout');
    expect(shortReason('unknown — check the page')).toBe('outcome unknown');
    expect(shortReason('unknown_outcome')).toBe('outcome unknown');
    expect(shortReason(null)).toBe('an error shown on the screen');
    expect(shortReason(`something ${SECRET} Bearer abc.def`)).toBe('an error shown on the screen');
  });
});

describe('failingStreak: the last 2 finished posts FAILED with no POSTED after them', () => {
  const f = (m: number, error: string | null = 'HTTP 422: x'): { status: 'FAILED'; error: string | null; updatedAt: Date } => ({ status: 'FAILED', error, updatedAt: at(NOW, m) });
  const p = (m: number): { status: 'POSTED'; error: null; updatedAt: Date } => ({ status: 'POSTED', error: null, updatedAt: at(NOW, m) });
  it('two (or more) failures at the top → failing, since the OLDEST of the run, the latest error kept', () => {
    expect(FAILING_AT).toBe(2);
    const s = failingStreak([f(-1, 'HTTP 500'), f(-2, 'HTTP 422: a'), p(-3), f(-4)]);
    expect(s).toEqual({ count: 2, since: at(NOW, -2), latestError: 'HTTP 500' });
    expect(failingStreak([f(-1), f(-2), f(-3), f(-4)])?.count).toBe(4);
  });
  it('one failure, or a POSTED on top, is not failing; a POSTED after them clears it', () => {
    expect(failingStreak([f(-1)])).toBeNull();
    expect(failingStreak([f(-1), p(-2), f(-3), f(-4)])).toBeNull();
    expect(failingStreak([p(-1), f(-2), f(-3)])).toBeNull();
    expect(failingStreak([])).toBeNull();
  });
  it('an "already posted" duplicate is neither a failure nor a recovery', () => {
    const dup = (m: number) => f(m, 'LinkedIn says this was already posted');
    expect(failingStreak([dup(-1), dup(-2), f(-3)])).toBeNull();
    expect(failingStreak([f(-1), dup(-2), f(-3)])?.count).toBe(2);
    expect(failingStreak([dup(-1), p(-2), f(-3), f(-4)])).toBeNull();
  });
});

describe('words: describeStatus / istClock / pageLabel / alertEmail', () => {
  const base = { channel: 'linkedin', page: 'shopscan', status: 'ok', reason: null, since: null, resumesAt: null, by: null, note: null, detail: null, failures: 0 } as const;
  it('the three banner sentences, in IST', () => {
    const now = ist(10, 0);
    expect(describeStatus({ ...base, status: 'paused', reason: PAGE_PAUSED, since: ist(14, 5).toISOString(), by: 'anagha' }, now)).toBe('Paused by anagha at 14:05 IST');
    expect(describeStatus({ ...base, status: 'paused', reason: PAGE_PAUSED, since: ist(14, 5).toISOString(), by: 'anagha', note: 'waiting for LinkedIn' }, now)).toBe('Paused by anagha at 14:05 IST — waiting for LinkedIn');
    expect(describeStatus({ ...base, status: 'held', reason: ORG_DAILY_LIMIT, resumesAt: ist(5, 30, 26).toISOString() }, now)).toBe("Held by LinkedIn's daily limit for this page until 05:30 IST tomorrow");
    expect(describeStatus({ ...base, status: 'held', reason: ORG_DAILY_LIMIT, resumesAt: ist(23, 0).toISOString() }, now)).toBe("Held by LinkedIn's daily limit for this page until 23:00 IST");
    expect(describeStatus({ ...base, status: 'failing', failures: 2, detail: 'HTTP 422' }, now)).toBe('Last 2 posts failed — HTTP 422');
    expect(describeStatus({ ...base }, now)).toBeNull();
  });
  it('istClock names the date only when it is not today; pageLabel capitalises', () => {
    expect(istClock(ist(5, 30), ist(1, 0))).toBe('05:30 IST');
    expect(istClock(ist(5, 30, 26), ist(1, 0))).toBe('05:30 IST tomorrow');
    expect(istClock(ist(5, 30, 27), ist(1, 0))).toBe('05:30 IST on 2026-11-27');
    expect(istClock(ist(23, 0), ist(1, 0))).toBe('23:00 IST');
    expect(pageLabel('linkedin', 'shopscan')).toBe('LinkedIn · Shopscan');
    expect(pageLabel('telegram', 'taxscan')).toBe('Telegram · Taxscan');
  });
  it('alertEmail: held and failing only; says the page, since, when it resumes and what to do; never a secret', () => {
    const held: PageStatus = { ...base, status: 'held', reason: ORG_DAILY_LIMIT, since: ist(15, 18).toISOString(), resumesAt: ist(5, 30, 26).toISOString(), message: 'x' };
    const m = alertEmail(held, ist(15, 20))!;
    expect(m.subject).toBe("LinkedIn · Shopscan: posting is held (LinkedIn's daily limit for this page)");
    expect(m.text).toContain('15:18 IST');
    expect(m.text).toContain('05:30 IST tomorrow');
    expect(m.text).toContain('NOT posted later');
    expect(m.text).toContain('Pause');
    const failing: PageStatus = { ...base, channel: 'facebook', page: 'taxscan', status: 'failing', reason: 'recent_posts_failed', since: ist(9, 0).toISOString(), detail: 'HTTP 400 code 100', failures: 3, message: 'x' };
    const f = alertEmail(failing, ist(10, 0))!;
    expect(f.subject).toBe('Facebook · Taxscan: the last 3 posts failed');
    expect(f.text).toContain('HTTP 400 code 100');
    expect(f.text).toContain('SOCIAL → Facebook');
    for (const s of ['ok', 'paused', 'stopped'] as const) expect(alertEmail({ ...base, status: s, message: null }, NOW)).toBeNull();
  });
});

/* ---------- the stop markers are the workers' own keys ---------- */
describe('the helper reads the workers\' own stop markers (one key each)', () => {
  it('pinned to the workers\' key functions', () => {
    expect(linkedinAuthKey('shopscan')).toBe(liAuthKey('shopscan'));
    expect(facebookAuthKey('taxscan')).toBe(fbAuthKey('taxscan'));
    expect(facebookPolicyKey('taxscan')).toBe(fbPolicyKey('taxscan'));
    expect(telegramStopKey('taxscan')).toBe(tgStopKey('taxscan'));
  });
});

/* ---------- the DB-backed parts ---------- */
const saved = {
  shared: env.linkedin.sharedPages,
  headroom: env.linkedin.dailyHeadroom,
  allPushes: env.linkedin.allPushesFrom,
  taxscan: env.linkedin.pages.taxscan,
  liPage: env.linkedin.pages[LI_T],
  from: env.linkedin.postFrom,
  fbPage: env.facebook.pages[FB],
  telegram: { ...env.telegram },
  tr: { ...env.linkedin.tokenRefresh },
};
const campIds = async () => (await prisma.campaign.findMany({ where: { portal: PORTAL }, select: { id: true } })).map((c) => c.id);
const KEYS = [
  ...[LI_T, LI_S].flatMap((p) => [liAuthKey(p), pauseKey('linkedin', p), alertKey('linkedin', p, 'held'), alertKey('linkedin', p, 'failing')]),
  fbAuthKey(FB), fbPolicyKey(FB), pauseKey('facebook', FB), alertKey('facebook', FB, 'failing'), alertKey('facebook', FB, 'held'),
  tgStopKey(TG), tgAlertKey(TG), pauseKey('telegram', TG), alertKey('telegram', TG, 'failing'), alertKey('telegram', TG, 'held'),
];
async function wipe() {
  const ids = await campIds();
  await prisma.linkedInPost.deleteMany({ where: { OR: [{ campaignId: { in: ids } }, { page: { in: [LI_T, LI_S] } }] } });
  await prisma.facebookPost.deleteMany({ where: { OR: [{ campaignId: { in: ids } }, { page: FB }] } });
  await prisma.telegramPost.deleteMany({ where: { OR: [{ campaignId: { in: ids } }, { page: TG }] } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: KEYS } } });
  await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
}
let seq = 0;
async function camp(slug: string, lastSentAt: Date): Promise<Campaign> {
  return prisma.campaign.create({
    data: { portal: PORTAL, title: `Story ${slug}`, body: 'b', url: `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`, target: {} as Prisma.InputJsonValue, status: 'SENT', lastSentAt, authority: 'Supreme Court', categories: ['GST'] } as never,
  });
}
type Kind = 'POSTED' | 'FAILED' | 'SKIPPED';
async function row(channel: 'linkedin' | 'facebook' | 'telegram', page: string, status: Kind, error: string | null, minutes: number): Promise<void> {
  const c = await camp(`row${seq}`, at(NOW, minutes));
  const key = pushKey({ id: c.id, lastSentAt: c.lastSentAt! });
  const stamp = { updatedAt: at(NOW, minutes), createdAt: at(NOW, minutes) };
  if (channel === 'linkedin') await prisma.linkedInPost.create({ data: { page, articleKey: key, campaignId: c.id, status, error, attempts: 1, ...stamp } });
  else if (channel === 'facebook') await prisma.facebookPost.create({ data: { page, articleKey: key, campaignId: c.id, status, error, attempts: 1, ...stamp } });
  else await prisma.telegramPost.create({ data: { page, pushKey: key, campaignId: c.id, status, error, attempts: 1, ...stamp } });
}
const setMarker = (key: string, value: unknown) => prisma.digestSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });

beforeAll(() => {
  env.linkedin.sharedPages = {};
});
beforeEach(async () => {
  env.linkedin.pages[LI_T] = { orgUrn: ORG_T, accessToken: LI_TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
  const shared: SharedLinkedInPage = { orgUrn: ORG_S, postFrom: FROM, tokenFrom: LI_T };
  env.linkedin.sharedPages = { [LI_S]: shared };
  env.linkedin.dailyHeadroom = { [LI_S]: LINKEDIN_HEADROOM_DEFAULTS.shopscan };
  env.linkedin.allPushesFrom = { [LI_T]: FROM, [LI_S]: FROM };
  env.linkedin.postFrom = FROM;
  Object.assign(env.linkedin.tokenRefresh, { ...saved.tr, enabled: false });
  env.facebook.pages[FB] = { pageId: '1234567890', accessToken: FB_TOKEN };
  logs.length = 0;
  resetLinkedInStops();
  resetFacebookStops();
  clearOrgHolds();
  await wipe();
});
afterAll(async () => {
  env.linkedin.sharedPages = saved.shared;
  env.linkedin.dailyHeadroom = saved.headroom;
  env.linkedin.allPushesFrom = saved.allPushes;
  env.linkedin.pages.taxscan = saved.taxscan;
  if (saved.liPage) env.linkedin.pages[LI_T] = saved.liPage;
  else delete env.linkedin.pages[LI_T];
  env.linkedin.postFrom = saved.from;
  if (saved.fbPage) env.facebook.pages[FB] = saved.fbPage;
  else delete env.facebook.pages[FB];
  Object.assign(env.telegram, saved.telegram);
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  resetLinkedInStops();
  clearOrgHolds();
  await wipe();
  await prisma.$disconnect();
});

describe('1. getPageStatus: ok / paused / stopped / held / failing from fixtures', () => {
  it('ok: no marker, no failures; a lone failure is still ok', async () => {
    for (const [c, p] of [['linkedin', LI_S], ['facebook', FB], ['telegram', TG]] as const) {
      expect(await getPageStatus(c, p, NOW)).toMatchObject({ channel: c, page: p, status: 'ok', reason: null, since: null, resumesAt: null, message: null, failures: 0 });
    }
    await row('linkedin', LI_S, 'FAILED', 'HTTP 422: x', -10);
    expect((await getPageStatus('linkedin', LI_S, NOW)).status).toBe('ok');
  });

  it('paused: who, when, the note; the banner words', async () => {
    expect(await setPause('linkedin', LI_S, { byUserId: null, by: 'anagha', note: 'waiting for LinkedIn', now: PAUSE_NOW })).toBe(true);
    const s = await getPageStatus('linkedin', LI_S, NOW);
    expect(s).toMatchObject({ status: 'paused', reason: PAGE_PAUSED, by: 'anagha', note: 'waiting for LinkedIn', since: PAUSE_NOW.toISOString() });
    expect(s.message).toBe('Paused by anagha at 09:55 IST — waiting for LinkedIn');
    // a second pause keeps the first one's who / when
    expect(await setPause('linkedin', LI_S, { byUserId: null, by: 'someone-else', note: null, now: NOW })).toBe(false);
    expect((await getPageStatus('linkedin', LI_S, NOW)).by).toBe('anagha');
  });

  it('stopped: LinkedIn token, Facebook token and policy, Telegram channel: their own markers, a reason code each', async () => {
    await setMarker(liAuthKey(LI_S), { stoppedAt: at(NOW, -20).toISOString(), alertedDay: '2026-11-25', status: 403 });
    expect(await getPageStatus('linkedin', LI_S, NOW)).toMatchObject({ status: 'stopped', reason: 'login_rejected', since: at(NOW, -20).toISOString(), detail: 'HTTP 403' });
    await setMarker(fbAuthKey(FB), { stoppedAt: at(NOW, -30).toISOString(), alertedDay: null, status: 190 });
    expect(await getPageStatus('facebook', FB, NOW)).toMatchObject({ status: 'stopped', reason: 'login_rejected' });
    await setMarker(fbPolicyKey(FB), { stoppedAt: at(NOW, -15).toISOString(), status: 400, code: 368, subcode: null, message: SECRET });
    const fb = await getPageStatus('facebook', FB, NOW);
    expect(fb).toMatchObject({ status: 'stopped', reason: 'policy_block', since: at(NOW, -15).toISOString(), detail: 'HTTP 400 code 368' });
    expect(JSON.stringify(fb)).not.toContain(SECRET); // Facebook's own message is never carried
    await setMarker(tgStopKey(TG), { stoppedAt: at(NOW, -10).toISOString(), status: 403, error: 'telegram_403_bot_removed' });
    expect(await getPageStatus('telegram', TG, NOW)).toMatchObject({ status: 'stopped', reason: 'channel_refused', detail: 'telegram_403_bot_removed' });
  });

  it('held: LinkedIn\'s daily limit, with a since and a resumes-at; clears at its resume time; not for the quota guard', async () => {
    const heldAt = NOW; // 04:30 UTC on 25 Nov: the next 00:00 UTC is 26 Nov
    holdOrgPage(LI_S, heldAt);
    const s = await getPageStatus('linkedin', LI_S, at(NOW, 5));
    expect(s).toMatchObject({ status: 'held', reason: ORG_DAILY_LIMIT, since: heldAt.toISOString(), resumesAt: '2026-11-26T00:00:00.000Z' });
    expect(s.message).toBe("Held by LinkedIn's daily limit for this page until 05:30 IST tomorrow");
    expect((await getPageStatus('linkedin', LI_S, new Date('2026-11-25T23:59:59.999Z'))).status).toBe('held');
    expect((await getPageStatus('linkedin', LI_S, new Date('2026-11-26T00:00:00.000Z'))).status).toBe('ok'); // clears at its resume time
    // other pages / channels are not held by it; and a quota_headroom row is not a hold
    expect((await getPageStatus('linkedin', LI_T, NOW)).status).toBe('ok');
    await row('linkedin', LI_T, 'SKIPPED', 'quota_headroom', -5);
    expect((await getPageStatus('linkedin', LI_T, NOW)).status).toBe('ok');
  });

  it('failing: the last 2 finished posts FAILED, clears after a POSTED row; SKIPPED and duplicates do not count; the reason is a short code', async () => {
    await row('facebook', FB, 'FAILED', `HTTP 400 code 100: ${SECRET}`, -30);
    await row('facebook', FB, 'SKIPPED', 'compose_skip', -25);
    await row('facebook', FB, 'FAILED', 'Facebook says this was already posted', -22);
    expect((await getPageStatus('facebook', FB, NOW)).status).toBe('ok'); // one real failure; the duplicate and the skip are neutral
    await row('facebook', FB, 'FAILED', 'HTTP 500: boom', -20);
    const s = await getPageStatus('facebook', FB, NOW);
    expect(s).toMatchObject({ status: 'failing', reason: 'recent_posts_failed', failures: 2, detail: 'HTTP 500', since: at(NOW, -30).toISOString() });
    expect(s.message).toBe('Last 2 posts failed — HTTP 500');
    expect(JSON.stringify(s)).not.toContain(SECRET);
    await row('facebook', FB, 'POSTED', null, -10);
    expect((await getPageStatus('facebook', FB, NOW)).status).toBe('ok'); // a POSTED row after them clears it
    await row('facebook', FB, 'FAILED', 'HTTP 500', -5);
    expect((await getPageStatus('facebook', FB, NOW)).status).toBe('ok'); // only one since the post
    await row('facebook', FB, 'FAILED', 'HTTP 500', -4);
    expect((await getPageStatus('facebook', FB, NOW))).toMatchObject({ status: 'failing', failures: 2 });
  });

  it('failing works the same on LinkedIn and Telegram', async () => {
    await row('linkedin', LI_S, 'FAILED', 'HTTP 422: a', -8);
    await row('linkedin', LI_S, 'FAILED', 'HTTP 422: b', -7);
    expect(await getPageStatus('linkedin', LI_S, NOW)).toMatchObject({ status: 'failing', detail: 'HTTP 422' });
    await row('telegram', TG, 'FAILED', 'telegram_400', -8);
    await row('telegram', TG, 'FAILED', 'telegram_502', -7);
    expect(await getPageStatus('telegram', TG, NOW)).toMatchObject({ status: 'failing', detail: 'telegram_502' });
  });

  it('precedence: paused, then stopped, then held, then failing', async () => {
    await row('linkedin', LI_S, 'FAILED', 'HTTP 422', -8);
    await row('linkedin', LI_S, 'FAILED', 'HTTP 422', -7);
    expect((await getPageStatus('linkedin', LI_S, NOW)).status).toBe('failing');
    holdOrgPage(LI_S, NOW);
    expect((await getPageStatus('linkedin', LI_S, at(NOW, 1))).status).toBe('held');
    await setMarker(liAuthKey(LI_S), { stoppedAt: at(NOW, -1).toISOString(), alertedDay: null, status: 401 });
    expect((await getPageStatus('linkedin', LI_S, at(NOW, 1))).status).toBe('stopped');
    await setPause('linkedin', LI_S, { byUserId: null, by: 'a', note: null, now: NOW });
    expect((await getPageStatus('linkedin', LI_S, at(NOW, 1))).status).toBe('paused');
  });

  it('activePages / listPageStatuses: every active automatic page, in display order', async () => {
    Object.assign(env.telegram, { enabled: true, config: { token: TG_TOKEN, channel: '@taxscan_in', postFrom: FROM }, off: null });
    const pages = activePages();
    expect(pages).toContainEqual({ channel: 'telegram', page: 'taxscan' });
    expect(pages.filter((p) => p.channel === 'telegram')).toEqual([{ channel: 'telegram', page: 'taxscan' }]);
    if (env.linkedin.enabled) expect(pages[0].channel).toBe('linkedin');
    const all = await listPageStatuses(NOW);
    expect(all.map((s) => [s.channel, s.page])).toEqual(pages.map((p) => [p.channel, p.page]));
    Object.assign(env.telegram, { enabled: false, config: null });
    expect(activePages().some((p) => p.channel === 'telegram')).toBe(false);
  });
});

/* ---------- the alerts, through the workers ---------- */
describe('2. the alert email: held and failing, once per page per kind per IST day', () => {
  let mails: { to: string; subject: string; text: string; html?: string }[] = [];
  const mail = { emailSender: async (m: { to: string; subject: string; text: string; html?: string }) => (mails.push(m), { ok: true as const }), isEmailConfigured: () => true, recipients: async () => ['admin@team.test'] };
  beforeEach(() => {
    mails = [];
  });
  const alertsOf = (re: RegExp) => mails.filter((m) => re.test(m.subject));

  // ---- Telegram: failing ----
  let tgCalls: TelegramRequest[] = [];
  let tgScript: (r: TelegramRequest) => TelegramResult = () => ({ kind: 'posted', messageId: 1 });
  const tgDeps = (now: Date, over: TgDeps = {}): TgDeps => ({
    now: () => now,
    call: async (r) => (tgCalls.push(r), tgScript(r)),
    fetchCms: async () => null,
    fetchArticle: async () => ({ image: null }),
    fetchStore: async () => ({ ok: false, reason: 'page_host' }),
    socialPicture: false,
    ...mail,
    portals: { [PORTAL]: TG },
    config: { token: TG_TOKEN, channel: '@taxscan_in', postFrom: FROM },
    quiet: { start: '23:00', end: '07:00' },
    ...over,
  });
  const tgFail = (error = 'telegram_400'): TelegramResult => ({ kind: 'failed', status: 400, code: 400, retryAfterSec: null, error });

  it('Telegram: the 2nd failed post in a row sends ONE "last 2 posts failed" email; a 3rd the same day sends nothing; the next IST day sends again', async () => {
    tgCalls = [];
    tgScript = () => tgFail();
    await camp('t1', at(NOW, -30));
    await runTelegramTick(tgDeps(NOW));
    expect(mails).toHaveLength(0); // one failure is not "failing"
    await camp('t2', at(NOW, -20));
    await runTelegramTick(tgDeps(at(NOW, 1)));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'admin@team.test', subject: 'Telegram · Pstattg: the last 2 posts failed' });
    await camp('t3', at(NOW, -10));
    await runTelegramTick(tgDeps(at(NOW, 2))); // a third failure, same IST day
    expect(mails).toHaveLength(1);
    await camp('t4', at(NOW, 24 * 60 - 5)); // pushed late on 25 Nov so it is a new candidate on the 26th
    await runTelegramTick(tgDeps(NEXT_DAY)); // a new IST day
    expect(mails).toHaveLength(2);
    expect(mails[1].subject).toBe('Telegram · Pstattg: the last 4 posts failed');
    expect(JSON.parse((await prisma.digestSetting.findUniqueOrThrow({ where: { key: alertKey('telegram', TG, 'failing') } })).value)).toEqual({ day: '2026-11-26' });
  });

  it('a POSTED row clears failing: the next lone failure does not alert', async () => {
    tgCalls = [];
    await camp('c1', at(NOW, -30));
    await camp('c2', at(NOW, -29));
    tgScript = () => tgFail();
    await runTelegramTick(tgDeps(NOW));
    expect(mails).toHaveLength(1); // both failed in the same tick: failing after the second
    mails = [];
    tgScript = () => ({ kind: 'posted', messageId: 9 });
    await camp('c3', at(NOW, 10));
    await runTelegramTick(tgDeps(at(NOW, 11)));
    expect((await getPageStatus('telegram', TG, at(NOW, 12))).status).toBe('ok');
    tgScript = () => tgFail();
    await camp('c4', at(NOW, 20));
    await runTelegramTick(tgDeps(at(NOW, 21)));
    expect(mails).toHaveLength(0); // one failure after the post
  });

  it('a duplicate ("already posted") is no failure, and the email holds only our words and a short code (no provider text, no token)', async () => {
    // Facebook duplicates
    const fbDeps = (now: Date, over: FbDeps = {}): FbDeps => ({
      now: () => now,
      post: async () => ({ kind: 'duplicate', status: 400, code: 506, subcode: null, error: `HTTP 400 code 506: ${SECRET}` } as FacebookResult),
      fetchCms: async () => null,
      ...mail,
      portals: { [PORTAL]: FB },
      postFrom: FROM,
      quiet: { start: '23:00', end: '07:00' },
      minGapMinutes: 0,
      dailyCap: 100,
      ...over,
    });
    await camp('d1', at(NOW, -30));
    await camp('d2', at(NOW, -29));
    await runFacebookTick(fbDeps(NOW));
    await runFacebookTick(fbDeps(at(NOW, 1)));
    expect(mails).toHaveLength(0);
    expect((await getPageStatus('facebook', FB, at(NOW, 2))).status).toBe('ok'); // two duplicate FAILED rows: not failing
    // a failing page whose last error carries provider text: the email has the code only
    await row('linkedin', LI_S, 'FAILED', `HTTP 422: ${SECRET} Bearer ${LI_TOKEN}`, -9);
    await row('linkedin', LI_S, 'FAILED', `HTTP 422: ${SECRET}`, -8);
    expect(await alertIfNeeded('linkedin', LI_S, NOW, mail)).toBe('sent');
    expect(mails).toHaveLength(1);
    const all = JSON.stringify(mails);
    expect(all).toContain('HTTP 422');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(LI_TOKEN);
    expect(all).not.toContain(FB_TOKEN);
    expect(all).not.toContain(TG_TOKEN);
  });

  it('alertIfNeeded: paused, stopped and ok pages are not alertable; no email service = no marker and no throw; no admins = no marker', async () => {
    await row('linkedin', LI_S, 'FAILED', 'HTTP 422', -9);
    await row('linkedin', LI_S, 'FAILED', 'HTTP 422', -8);
    expect(await alertIfNeeded('linkedin', LI_S, NOW, { ...mail, isEmailConfigured: () => false })).toBe('email_not_configured');
    expect(await alertIfNeeded('linkedin', LI_S, NOW, { ...mail, recipients: async () => [] })).toBe('no_recipients');
    expect(await prisma.digestSetting.findUnique({ where: { key: alertKey('linkedin', LI_S, 'failing') } })).toBeNull(); // not marked: it can still be sent
    expect(await alertIfNeeded('linkedin', LI_S, NOW, mail)).toBe('sent');
    expect(await alertIfNeeded('linkedin', LI_S, at(NOW, 5), mail)).toBe('already_today');
    expect(await alertIfNeeded('linkedin', LI_S, NEXT_DAY, mail)).toBe('sent');
    expect(mails).toHaveLength(2);
    expect(await alertIfNeeded('linkedin', LI_T, NOW, mail)).toBe('not_alertable'); // ok
    await setPause('linkedin', LI_S, { byUserId: null, by: 'a', note: null, now: NOW });
    expect(await alertIfNeeded('linkedin', LI_S, NEXT_DAY, mail)).toBe('not_alertable'); // paused on purpose
    await prisma.digestSetting.deleteMany({ where: { key: pauseKey('linkedin', LI_S) } });
    await setMarker(liAuthKey(LI_S), { stoppedAt: NOW.toISOString(), alertedDay: null, status: 403 });
    expect(await alertIfNeeded('linkedin', LI_S, NEXT_DAY, mail)).toBe('not_alertable'); // stopped: the existing alert's business
  });

  // ---- LinkedIn: held ----
  let liCalls: LinkedInRequest[] = [];
  let liScript: (r: LinkedInRequest) => LinkedInResult = (r) => ({ kind: 'posted', postId: `urn:li:share:${r.orgUrn === ORG_S ? 'S' : 'T'}${liCalls.length}` });
  const liDeps = (now: Date, over: LiDeps = {}): LiDeps => ({
    now: () => now,
    post: async (r) => (liCalls.push(r), liScript(r)),
    fetchCms: async () => null,
    waitImage: async () => ({ ok: true }),
    ...mail,
    portals: { [PORTAL]: [LI_T, LI_S] },
    postFrom: { [LI_T]: FROM },
    quiet: { start: '23:00', end: '07:00' },
    ...over,
  });
  const orgLimit: LinkedInResult = { kind: 'org_limit', status: 429, error: 'HTTP 429: Organization post creation limit reached' };

  it('LinkedIn org limit on Shopscan: ONE "posting is held" email; the same day again (after a restart) nothing; the next IST day again', async () => {
    liCalls = [];
    liScript = (r) => (r.orgUrn === ORG_S ? orgLimit : { kind: 'posted', postId: 'urn:li:share:T1' });
    await camp('h1', at(NOW, -30));
    await runLinkedInTick(liDeps(NOW));
    expect(alertsOf(/posting is held/)).toHaveLength(1);
    expect(mails[0].subject).toBe("LinkedIn · Pstat-s: posting is held (LinkedIn's daily limit for this page)");
    expect(mails[0].text).toContain('05:30 IST tomorrow');
    expect(mails).toHaveLength(1); // Taxscan posted; nothing else was sent
    resetLinkedInStops(); // a restart forgets the hold; the next 429 sets it again
    await camp('h2', at(NOW, 30));
    await runLinkedInTick(liDeps(at(NOW, 31)));
    expect(alertsOf(/posting is held/)).toHaveLength(1); // same IST day: nothing more
    resetLinkedInStops();
    await camp('h3', at(NOW, 24 * 60 - 5));
    await runLinkedInTick(liDeps(NEXT_DAY));
    expect(alertsOf(/posting is held/)).toHaveLength(2); // a new IST day
  });

  it('the EXISTING stop alerts are never doubled: a LinkedIn token stop, a Facebook policy stop and a Telegram channel stop each send their own ONE email and no "held" / "failing" one', async () => {
    liCalls = [];
    liScript = (r) => (r.orgUrn === ORG_S ? { kind: 'auth', status: 403, error: 'HTTP 403' } : { kind: 'posted', postId: 'urn:li:share:T1' });
    await camp('s1', at(NOW, -30));
    await runLinkedInTick(liDeps(NOW));
    const li = mails.filter((m) => /LinkedIn posting stopped/i.test(m.subject));
    expect(li.length).toBeGreaterThan(0);
    const liCount = mails.length;
    // Facebook policy block
    await runFacebookTick({
      now: () => at(NOW, 2),
      post: async () => ({ kind: 'policy', status: 400, code: 368, subcode: null, error: 'HTTP 400 code 368' } as FacebookResult),
      fetchCms: async () => null,
      ...mail,
      portals: { [PORTAL]: FB },
      postFrom: FROM,
      quiet: { start: '23:00', end: '07:00' },
      minGapMinutes: 0,
      dailyCap: 100,
    });
    expect(mails.filter((m) => /Facebook blocked a post/i.test(m.subject))).toHaveLength(1);
    // Telegram channel stop
    tgCalls = [];
    tgScript = () => ({ kind: 'stop', status: 403, code: 403, retryAfterSec: null, error: 'telegram_403' });
    await runTelegramTick(tgDeps(at(NOW, 3)));
    expect(mails.filter((m) => /Telegram posting stopped/i.test(m.subject))).toHaveLength(1);
    expect(mails.filter((m) => /posting is held|posts failed/.test(m.subject))).toHaveLength(0);
    expect(mails.length).toBe(liCount + 2);
    expect(await getPageStatus('facebook', FB, at(NOW, 4))).toMatchObject({ status: 'stopped', reason: 'policy_block' });
    expect(await getPageStatus('telegram', TG, at(NOW, 4))).toMatchObject({ status: 'stopped', reason: 'channel_refused' });
  });
});
