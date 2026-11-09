import { Router } from 'express';
import { requireBearerOrUser, requireUser } from '../lib/auth';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { recordAudit } from '../lib/audit';
import { requestClientIp } from '../lib/clientIp';
import { safeErrorLog } from '../lib/httpErrors';
import { articleKey } from '../services/reports';
import { isPublicArticleCampaign } from '../services/social/publicCampaign';
import { isAllPushesCampaign, isPushKey, newRuleFrom, PUSH_KEY_PREFIX, pushKey } from '../services/social/allPushes';
import { dayProblem, istDay, istDayBounds, istTime, MAX_DAYS_BACK } from '../services/whatsapp/queue';
import { PORTAL_TO_PAGE, PAGE_TAXSCAN, pageConfig, postUrlOf } from '../services/facebook/pages';
import { checkConnection } from '../services/facebook/client';
import { COMPOSE_SKIP, loginProblem, policyProblem, resumePolicy, retryNow, skipPost, type WorkerDeps } from '../services/facebook/worker';
import { facebookSkipKey, isComposeSkipped } from '../services/social/pages';
import { addPauseRoutes } from './socialPause';
import { getPageStatus } from '../services/social/pageStatus';
import { PAGE_PAUSED } from '../services/social/pause';
import type { FetchLike } from '../services/linkedin/post';

/**
 * Facebook page posting screen API (brief 2026-11-03-facebook-page-posting). ADMIN or PUBLISHER (or the bearer); Check
 * connection and Resume are ADMIN only. Behind FACEBOOK_POSTING_ENABLED: off = 404 on every endpoint, before auth. The request
 * path reads Postgres only, except Retry (ONE Graph post) and Check connection (ONE Graph GET).
 *
 *   GET  /api/facebook/posts?date=YYYY-MM-DD    IST day, default today, up to 14 days back
 *   POST /api/facebook/posts/:id/retry          a FAILED row: post it now (409 policy_stop while stopped)
 *   POST /api/facebook/posts/:id/skip           a FAILED row, or one waiting for a retry
 *   POST /api/facebook/check                    ADMIN: "Connected to page: <name>" or the error class; posts nothing
 *   POST /api/facebook/resume                   ADMIN: clears a policy stop (audited)
 *
 * EVERY PUSH POSTS (brief 2026-11-04-academy-store-posts): once FACEBOOK_ALL_PUSHES_FROM is set, a push at or after it is its own row
 * (articles, courses and products alike; a repeat is another row, with its own Retry and Skip) and is WAITING until posted. A push
 * before it follows today's rule: one row per article, WAITING / NOT_POSTED by FACEBOOK_POST_FROM. Without the time the list is
 * exactly what it was before.
 */
export type FacebookRouterOptions = {
  enabled?: () => boolean;
  clock?: () => Date;
  portals?: () => Readonly<Record<string, string>>;
  postFrom?: () => Date | null;
  /** The time from which the page posts EVERY push (brief 2026-11-04-academy-store-posts); null = today's rule. Default FACEBOOK_ALL_PUSHES_FROM. */
  allPushesFrom?: () => Date | null;
  worker?: WorkerDeps;
  /** The Graph fetch used by Check connection (tests inject a fake). */
  fetch?: FetchLike;
};

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);
const ADMIN = requireUser(['ADMIN']);

export type ScreenStatus = 'WAITING' | 'RETRYING' | 'POSTED' | 'FAILED' | 'SKIPPED' | 'NOT_POSTED';

export function createFacebookRouter(o: FacebookRouterOptions = {}): Router {
  const router = Router();
  const enabled = o.enabled ?? (() => env.facebook.enabled);
  const nowOf = o.clock ?? (() => new Date());
  const portalsOf = o.portals ?? (() => PORTAL_TO_PAGE);
  const postFromOf = o.postFrom ?? (() => env.facebook.postFrom);
  const allPushesFromOf = o.allPushesFrom ?? (() => env.facebook.allPushesFrom);
  const pageOf = (): string => Object.values(portalsOf())[0] ?? PAGE_TAXSCAN;

  router.use((_req, res, next) => (enabled() ? next() : void res.status(404).json({ error: 'not_found' })));
  // Pause / Resume the page (ADMIN), brief 2026-11-09-social-page-alerts-pause: `page-pause` / `page-resume` (the policy `/resume` below is another thing).
  addPauseRoutes(router, { channel: 'facebook', pages: () => [pageOf()], clock: nowOf });

  router.get('/posts', STAFF, async (req, res) => {
    try {
      const now = nowOf();
      const day = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : istDay(now);
      const problem = dayProblem(day, now);
      if (problem) return res.status(400).json({ error: 'invalid_date', message: problem });
      const portals = portalsOf();
      const { start, end } = istDayBounds(day);
      const since = new Date(start.getTime() - MAX_DAYS_BACK * 24 * 60 * 60_000);
      const sent = await prisma.campaign.findMany({
        where: { portal: { in: Object.keys(portals) }, status: 'SENT', lastSentAt: { gte: since } },
        select: { id: true, title: true, url: true, target: true, lastSentAt: true, socialSkip: true },
        orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
      });
      const postFrom = postFromOf();
      const pushesFrom = newRuleFrom(allPushesFromOf(), postFrom); // null = the page stays on today's rule; never earlier than the page's own go-live
      // One row per article (its oldest push) for a push before the all-pushes time, one row per PUSH at or after it. Pushes come
      // in time order, so the rows do too.
      const first = new Map<string, (typeof sent)[number]>();
      // For each of today's-rule rows, the id of EVERY push of that article in this window (the `push:` fallback below needs them all).
      const idsOfArticle = new Map<string, string[]>();
      // Pushes whose sender unticked THIS page on Compose (brief 2026-11-09-compose-skip-pages): each is its own row under its own push key, shown
      // as skipped, and takes no part in the article grouping (the same split the worker makes), so it never hides a later push of the same URL.
      const composeKeys = new Set<string>();
      const skipKey = facebookSkipKey(pageOf());
      for (const c of sent) {
        if (!c.lastSentAt) continue;
        if (postFrom && c.lastSentAt >= postFrom && isComposeSkipped(c, skipKey)) {
          if (pushesFrom && c.lastSentAt >= pushesFrom ? isAllPushesCampaign(c) : isPublicArticleCampaign(c)) {
            const pk = pushKey({ id: c.id, lastSentAt: c.lastSentAt });
            first.set(pk, c);
            composeKeys.add(pk);
          }
          continue;
        }
        const k = isPublicArticleCampaign(c) ? articleKey(c) : null; // null: not a public article
        if (k !== null) idsOfArticle.get(k)?.push(c.id);
        if (pushesFrom && c.lastSentAt >= pushesFrom) {
          if (isAllPushesCampaign(c)) first.set(pushKey({ id: c.id, lastSentAt: c.lastSentAt }), c);
          continue;
        }
        if (k !== null && !first.has(k)) {
          first.set(k, c);
          idsOfArticle.set(k, [c.id]);
        }
      }
      const inDay = [...first.entries()].filter(([, c]) => c.lastSentAt! >= start && c.lastSentAt! < end);
      // An article row of TODAY'S rule may have been handled by the NEW rule (its pushes have `push:` rows) while the all-pushes time was
      // on, and the time removed or moved later since: it must show that row's status, not WAITING (follow-up 1). The same read also
      // asks for the `push:` rows of every push of those articles.
      const todaysIds = inDay.filter(([k]) => !isPushKey(k)).flatMap(([k]) => idsOfArticle.get(k) ?? []);
      const posts = inDay.length
        ? await prisma.facebookPost.findMany({
            where: { page: pageOf(), OR: [{ articleKey: { in: inDay.map(([k]) => k) } }, ...(todaysIds.length ? [{ campaignId: { in: todaysIds }, articleKey: { startsWith: PUSH_KEY_PREFIX } }] : [])] },
          })
        : [];
      const byKey = new Map(posts.map((p) => [p.articleKey, p]));
      const pushRows = new Map<string, (typeof posts)[number]>(); // campaign id → its `push:` row (the latest, if the same campaign row was sent again)
      for (const p of posts) {
        if (!isPushKey(p.articleKey)) continue;
        const cur = pushRows.get(p.campaignId);
        if (!cur || p.createdAt > cur.createdAt) pushRows.set(p.campaignId, p);
      }
      // The `push:` row to show for an article row that has no article-key row: its own push's, else the latest of the article's other pushes.
      const viaPush = (k: string, c: (typeof sent)[number]) => {
        const own = pushRows.get(c.id);
        if (own) return own;
        let best: (typeof posts)[number] | undefined;
        for (const id of idsOfArticle.get(k) ?? []) {
          const r = pushRows.get(id);
          if (r && (!best || r.createdAt > best.createdAt)) best = r;
        }
        return best;
      };
      const rows = inDay.map(([k, c]) => {
        const p = byKey.get(k) ?? (isPushKey(k) ? undefined : viaPush(k, c));
        let status: ScreenStatus;
        const composeSkipped = composeKeys.has(k);
        // No row yet: pushed since go-live (the new rule never starts before it) → the worker will post it, however long ago (no age
        // limit); before go-live → never. An unticked Compose push is skipped whether or not the worker has written its row yet.
        if (composeSkipped) status = 'SKIPPED';
        else if (p) status = p.status === 'PENDING' ? (p.nextAttemptAt ? 'RETRYING' : 'WAITING') : (p.status as ScreenStatus);
        else status = postFrom && c.lastSentAt! >= postFrom ? 'WAITING' : 'NOT_POSTED';
        return {
          id: p?.id ?? null,
          campaignId: c.id,
          pushedAt: c.lastSentAt!.toISOString(),
          pushedTime: istTime(c.lastSentAt!),
          headline: c.title,
          status,
          error: p && (p.status === 'FAILED' || p.status === 'PENDING') ? p.error : null,
          attempts: p?.attempts ?? 0,
          nextAttemptAt: p?.nextAttemptAt ? p.nextAttemptAt.toISOString() : null,
          nextAttemptTime: p?.nextAttemptAt ? istTime(p.nextAttemptAt) : null,
          postedAt: p?.postedAt ? p.postedAt.toISOString() : null,
          postUrl: p?.status === 'POSTED' && p.facebookPostId ? postUrlOf(p.facebookPostId) : null,
          /** Retry on this row needs "check the page first" (the outcome is unknown). */
          unknownOutcome: p?.status === 'FAILED' && (p.error ?? '').startsWith('unknown'),
          // `compose_skip`: the sender unticked this page on Compose for this push. Present only on such a row.
          ...(composeSkipped || (p?.status === 'SKIPPED' && p.error === COMPOSE_SKIP) ? { skipReason: COMPOSE_SKIP } : {}),
          // `page_paused`: an ADMIN paused the page; the push was skipped with no call and is never posted later.
          ...(!composeSkipped && p?.status === 'SKIPPED' && p.error === PAGE_PAUSED ? { skipReason: PAGE_PAUSED } : {}),
        };
      });
      const n = (s: ScreenStatus) => rows.filter((r) => r.status === s).length;
      return res.json({
        date: day,
        page: pageOf(),
        rows,
        counts: { waiting: n('WAITING') + n('RETRYING'), posted: n('POSTED'), failed: n('FAILED'), skipped: n('SKIPPED'), notPosted: n('NOT_POSTED'), all: rows.length },
        /** Amber banner: the token was rejected (clears by itself once a post works / the token changes). */
        login: await loginProblem(pageOf()),
        /** Red banner: Facebook blocked a post; posting is stopped until an ADMIN presses Resume. */
        policy: await policyProblem(pageOf()),
        /** brief 2026-11-09-social-page-alerts-pause: ok | paused | stopped | held | failing, with the banner's words (`message`). */
        pageStatus: await getPageStatus('facebook', pageOf(), now),
        /** Present only while the page posts EVERY push (its all-pushes time, as the new rule really starts): the screen says so. Absent otherwise. */
        ...(pushesFrom ? { everyPushFrom: pushesFrom.toISOString() } : {}),
      });
    } catch (err) {
      console.error('[facebook] list failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/retry', STAFF, async (req, res) => {
    try {
      const r = await retryNow(String(req.params.id), { now: nowOf, ...(o.worker ?? {}) });
      if (!r.ok) return res.status(r.reason === 'not_found' ? 404 : 409).json({ error: r.reason });
      return res.json({ ok: true, status: r.status });
    } catch (err) {
      console.error('[facebook] retry failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/skip', STAFF, async (req, res) => {
    try {
      return (await skipPost(String(req.params.id))) ? res.json({ ok: true, status: 'SKIPPED' }) : res.status(409).json({ error: 'not_skippable' });
    } catch (err) {
      console.error('[facebook] skip failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/check', ADMIN, async (_req, res) => {
    try {
      const cfg = pageConfig(pageOf());
      if (!cfg) return res.json({ ok: false, kind: 'not_configured', message: 'FACEBOOK page id / token are not set (or not valid) in Railway.' });
      const r = await checkConnection(cfg, o.fetch);
      if (r.kind === 'ok') return res.json({ ok: true, name: r.name, message: `Connected to page: ${r.name}` });
      return res.json({ ok: false, kind: r.kind, status: r.status, code: r.code, message: r.error });
    } catch (err) {
      console.error('[facebook] check failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/resume', ADMIN, async (req, res) => {
    try {
      const page = pageOf();
      const cleared = await resumePolicy(page);
      if (!cleared) return res.status(409).json({ error: 'not_stopped' });
      await recordAudit({ userId: req.user?.id ?? null, action: 'FACEBOOK_POSTING_RESUMED', resourceType: 'facebook_page', resourceId: page, metadata: { page }, ipAddress: requestClientIp(req) });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[facebook] resume failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
