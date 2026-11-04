import { Router } from 'express';
import { requireBearerOrUser } from '../lib/auth';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { safeErrorLog } from '../lib/httpErrors';
import { articleKey } from '../services/reports';
import { isPublicArticleCampaign } from '../services/social/publicCampaign';
import { isAllPushesCampaign, isPushKey, newRuleFrom, PUSH_KEY_PREFIX, pushKey } from '../services/social/allPushes';
import { dayProblem, istDay, istDayBounds, istTime, MAX_DAYS_BACK } from '../services/whatsapp/queue';
import { PAGE_TAXSCAN, normalizePortals, pagesOf, portalPages, portalsOfPage, resolveAllPushesFrom, resolvePostFrom, type PortalMap, type PostFromInput } from '../services/linkedin/pages';
import { loginProblem, retryNow, skipPost, type WorkerDeps } from '../services/linkedin/worker';
import { tokenPageOf, tokenStatus } from '../services/linkedin/token';

/**
 * LinkedIn page posting screen API (brief 2026-11-02-linkedin-page-posting). ADMIN or PUBLISHER (or the bearer).
 * Behind LINKEDIN_POSTING_ENABLED: off = 404 on every endpoint, before auth. The request path reads Postgres only; the one
 * exception is Retry, which makes ONE LinkedIn call and then answers.
 *
 *   GET  /api/linkedin/posts?date=YYYY-MM-DD&page=<key>
 *                                                IST day, default today, up to 14 days back. `page` = one of the ACTIVE pages
 *                                                (`pages` in the answer, Taxscan first), default the first (taxscan); anything
 *                                                else (an unknown page, or `academy` while it is not active) is 400 invalid_page.
 *   POST /api/linkedin/posts/:id/retry          a FAILED row: post it now
 *   POST /api/linkedin/posts/:id/skip           a FAILED row, or one waiting for a retry
 *
 * EVERY PUSH POSTS (brief 2026-11-04-academy-store-posts): on a page with an all-pushes time, a push at or after it is its own row
 * (articles, courses and products alike; a repeat is another row, with its own Retry and Skip) and is WAITING until posted. A push
 * before it follows today's rule: one row per article, WAITING / NOT_POSTED by the page's go-live. A page without the time lists
 * exactly what it did before.
 */
export type LinkedInRouterOptions = {
  enabled?: () => boolean;
  clock?: () => Date;
  /** Campaign.portal → page(s) (tests inject their own portal): one page name or a list per portal, Taxscan first. */
  portals?: () => PortalMap;
  /** Go-live: one time for every page (the old shape) or one per page. Default: each page's own configured time. */
  postFrom?: () => PostFromInput;
  /** The time from which a page posts EVERY push (brief 2026-11-04-academy-store-posts): one time for every page or one per page; null = today's rule. Default: each page's own variable. */
  allPushesFrom?: () => PostFromInput;
  worker?: WorkerDeps;
};

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);

export type ScreenStatus = 'WAITING' | 'RETRYING' | 'POSTED' | 'FAILED' | 'SKIPPED' | 'NOT_POSTED';

export function createLinkedInRouter(o: LinkedInRouterOptions = {}): Router {
  const router = Router();
  const enabled = o.enabled ?? (() => env.linkedin.enabled);
  const nowOf = o.clock ?? (() => new Date());
  const portalsOf = o.portals ?? portalPages;
  const postFromOf = o.postFrom ?? (() => undefined);
  const allPushesFromOf = o.allPushesFrom ?? (() => undefined);

  router.use((_req, res, next) => (enabled() ? next() : void res.status(404).json({ error: 'not_found' })));

  router.get('/posts', STAFF, async (req, res) => {
    try {
      const now = nowOf();
      const day = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : istDay(now);
      const problem = dayProblem(day, now);
      if (problem) return res.status(400).json({ error: 'invalid_date', message: problem });
      // The ACTIVE pages, Taxscan first (the SPA shows a page switch only when there is more than one). `?page=` must be one of them:
      // an unknown page, or `academy` while it is not active, is refused before anything is read.
      const portals = normalizePortals(portalsOf());
      const pages = pagesOf(portals);
      const wanted = req.query.page;
      if (wanted !== undefined && wanted !== '' && (typeof wanted !== 'string' || !pages.includes(wanted))) return res.status(400).json({ error: 'invalid_page' });
      const page = typeof wanted === 'string' && wanted !== '' ? wanted : pages[0] ?? PAGE_TAXSCAN;
      const { start, end } = istDayBounds(day);
      const since = new Date(start.getTime() - MAX_DAYS_BACK * 24 * 60 * 60_000);
      const sent = await prisma.campaign.findMany({
        where: { portal: { in: portalsOfPage(portals, page) }, status: 'SENT', lastSentAt: { gte: since } },
        select: { id: true, title: true, url: true, target: true, lastSentAt: true },
        orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
      });
      // This page's OWN go-live (Academy has its own), and its all-pushes time (null = it stays on today's rule).
      const postFrom = resolvePostFrom(postFromOf(), page);
      const pushesFrom = newRuleFrom(resolveAllPushesFrom(allPushesFromOf(), page), postFrom); // never earlier than the page's own go-live
      // One row per article (its oldest push) for a push before the all-pushes time, one row per PUSH at or after it. Pushes come
      // in time order, so the rows do too.
      const first = new Map<string, (typeof sent)[number]>();
      // For each of today's-rule rows, the id of EVERY push of that article in this window (the `push:` fallback below needs them all).
      const idsOfArticle = new Map<string, string[]>();
      for (const c of sent) {
        if (!c.lastSentAt) continue;
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
        ? await prisma.linkedInPost.findMany({
            where: { page, OR: [{ articleKey: { in: inDay.map(([k]) => k) } }, ...(todaysIds.length ? [{ campaignId: { in: todaysIds }, articleKey: { startsWith: PUSH_KEY_PREFIX } }] : [])] },
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
        // No row yet: pushed since go-live (the new rule never starts before it) → the worker will post it, however long ago (no age
        // limit); before go-live → never.
        if (p) status = p.status === 'PENDING' ? (p.nextAttemptAt ? 'RETRYING' : 'WAITING') : (p.status as ScreenStatus);
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
          postUrl: p?.status === 'POSTED' && p.linkedinPostId ? `https://www.linkedin.com/feed/update/${encodeURIComponent(p.linkedinPostId)}/` : null,
          /** Retry on this row needs "check the page first" (the outcome is unknown). */
          unknownOutcome: p?.status === 'FAILED' && (p.error ?? '').startsWith('unknown'),
        };
      });
      const n = (s: ScreenStatus) => rows.filter((r) => r.status === s).length;
      return res.json({
        date: day,
        page,
        pages,
        rows,
        counts: { waiting: n('WAITING') + n('RETRYING'), posted: n('POSTED'), failed: n('FAILED'), skipped: n('SKIPPED'), notPosted: n('NOT_POSTED'), all: rows.length },
        // this page's own banner state (a stop is per page)
        login: await loginProblem(page),
        // dates and a status only (never a token); absent while renewal is switched off. A page that shares a token reports the
        // owner's: it is the one token.
        ...(await tokenStatus(page, now).then((t) => (t ? { token: t } : {}))),
        // present (true) only when two pages post with the same token, so the screen can say so; absent otherwise (old answer unchanged)
        ...(pages.some((p) => tokenPageOf(p) !== p) ? { tokenShared: true } : {}),
        // present only while this page posts EVERY push (its all-pushes time, as the new rule really starts), so the screen can say so;
        // absent otherwise (old answer unchanged)
        ...(pushesFrom ? { everyPushFrom: pushesFrom.toISOString() } : {}),
      });
    } catch (err) {
      console.error('[linkedin] list failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/retry', STAFF, async (req, res) => {
    try {
      const r = await retryNow(String(req.params.id), { now: nowOf, ...(o.worker ?? {}) });
      if (!r.ok) return res.status(r.reason === 'not_found' ? 404 : 409).json({ error: r.reason });
      return res.json({ ok: true, status: r.status });
    } catch (err) {
      console.error('[linkedin] retry failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/skip', STAFF, async (req, res) => {
    try {
      return (await skipPost(String(req.params.id))) ? res.json({ ok: true, status: 'SKIPPED' }) : res.status(409).json({ error: 'not_skippable' });
    } catch (err) {
      console.error('[linkedin] skip failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
