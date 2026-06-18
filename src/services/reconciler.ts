import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { pollOnce, type Fetcher } from './poller';

/**
 * No-miss backstop + retention.
 *
 * RECONCILER: the RSS feeds only expose the latest ~11 items per poll, so a
 * publish burst can scroll off before we poll. taxscan's daily sitemap
 * (news-sitemap-daily.xml) is a COMPLETE list of the day's articles, each with
 * its title and a permalink that equals the RSS <guid>. We feed those entries
 * through the normal pollOnce() path, which dedups on guid (so feed-captured
 * articles are skipped) and captures anything missing — guaranteeing every
 * published article enters the system and gets a fair chance.
 *
 * RETENTION: DRAFT articles never sent within RETENTION_DAYS are archived
 * (status EXPIRED) so the Queue/Review backlog stays bounded. Reports count by
 * capture date regardless of status, so an expired article is still counted.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();
}

/** Parse a (news) sitemap into {title, link} entries. */
export function parseSitemap(xml: string): { title: string; link: string }[] {
  const out: { title: string; link: string }[] = [];
  for (const block of xml.split(/<url>/i).slice(1)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(block)?.[1];
    const title = /<news:title>([\s\S]*?)<\/news:title>/i.exec(block)?.[1];
    if (loc && title) out.push({ link: decodeXml(loc), title: decodeXml(title) });
  }
  return out;
}

/** Fetcher (pollOnce-compatible) that reads the daily sitemap as RSS-like items. */
export const sitemapFetcher: Fetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sitemap fetch ${res.status}`);
  const entries = parseSitemap(await res.text());
  // guid = link so pollOnce dedups against feed-captured rows; categories empty
  // (the report infers the category from the title).
  const items = entries.map((e) => ({ title: e.title, link: e.link, guid: e.link, categories: [] }));
  return { items } as Awaited<ReturnType<Fetcher>>;
};

/** One reconcile pass: capture any sitemap article not already in the DB. */
export async function reconcileOnce(deps: { fetcher?: Fetcher } = {}) {
  return pollOnce({
    feedUrl: env.reconciler.sitemapUrl,
    topic: 'news',
    fetcher: deps.fetcher ?? sitemapFetcher,
  });
}

/** Archive DRAFT articles older than `days` that never sent. Returns the count. */
export async function expireStaleDrafts(now: Date, days: number, portal: string): Promise<number> {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const res = await prisma.campaign.updateMany({
    where: { portal, status: 'DRAFT', createdAt: { lt: cutoff } },
    data: { status: 'EXPIRED' },
  });
  return res.count;
}

let reconcilerStarted = false;
export function startReconciler(): void {
  if (!env.reconciler.enabled) {
    // eslint-disable-next-line no-console
    console.log('[reconciler] disabled (set RECONCILER_ENABLED=true to start)');
    return;
  }
  if (!cron.validate(env.reconciler.cron)) throw new Error(`Invalid RECONCILER_CRON: ${env.reconciler.cron}`);
  if (reconcilerStarted) return;
  reconcilerStarted = true;
  cron.schedule(
    env.reconciler.cron,
    async () => {
      try {
        const r = await reconcileOnce();
        if (r.newItems > 0) {
          // eslint-disable-next-line no-console
          console.log(`[reconciler] back-filled ${r.newItems} missed article(s) from the sitemap`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[reconciler] run failed', e);
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(`[reconciler] scheduled cron="${env.reconciler.cron}" sitemap=${env.reconciler.sitemapUrl}`);
}

let retentionStarted = false;
export function startRetention(): void {
  if (!env.retention.days || env.retention.days <= 0) {
    // eslint-disable-next-line no-console
    console.log('[retention] disabled (set RETENTION_DAYS>0 to enable)');
    return;
  }
  if (!cron.validate(env.retention.cron)) throw new Error(`Invalid RETENTION_CRON: ${env.retention.cron}`);
  if (retentionStarted) return;
  retentionStarted = true;
  cron.schedule(
    env.retention.cron,
    async () => {
      try {
        const n = await expireStaleDrafts(new Date(), env.retention.days, env.rss.portal);
        if (n > 0) {
          // eslint-disable-next-line no-console
          console.log(`[retention] archived ${n} stale DRAFT article(s) (> ${env.retention.days}d)`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[retention] run failed', e);
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(`[retention] scheduled cron="${env.retention.cron}" days=${env.retention.days}`);
}
