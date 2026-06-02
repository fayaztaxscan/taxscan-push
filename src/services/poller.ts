import cron from 'node-cron';
import Parser from 'rss-parser';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { dispatchCampaign, type CampaignInput, type DispatchResult } from './send';

type FeedItem = Parser.Item & { categories?: string[] };
type FeedOutput = { items: FeedItem[] };

export type Fetcher = (url: string) => Promise<FeedOutput>;
export type Dispatcher = (input: CampaignInput) => Promise<DispatchResult>;

export type FeedConfig = { topic: string; url: string };

export type PollDeps = {
  feedUrl?: string;
  topic?: string;
  fetcher?: Fetcher;
  dispatcher?: Dispatcher;
  portal?: string;
};

export type PollResult = {
  topic: string;
  feedUrl: string;
  itemsFound: number;
  alreadySeen: number;
  newItems: number;
  sent: number;
  errors: number;
  durationMs: number;
};

export type PollAllResult = {
  feeds: PollResult[];
  totals: Omit<PollResult, 'topic' | 'feedUrl'>;
};

const defaultParser = new Parser();
const defaultFetcher: Fetcher = (url) => defaultParser.parseURL(url) as Promise<FeedOutput>;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function trimDescription(item: FeedItem, max = 140): string {
  const raw =
    item.contentSnippet ||
    (item.content ?? (item as { description?: string }).description ?? '').replace(/<[^>]+>/g, '');
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function pickGuid(item: FeedItem): string | null {
  const g = (item.guid ?? item.link ?? '').toString().trim();
  return g || null;
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function resolveFeedConfig(deps: PollDeps): FeedConfig {
  if (deps.feedUrl && deps.topic) return { topic: deps.topic, url: deps.feedUrl };
  if (deps.feedUrl) {
    const match = env.rss.feeds.find((f) => f.url === deps.feedUrl);
    if (!match) {
      throw new Error(
        `pollOnce: no topic provided and feedUrl ${deps.feedUrl} is not in env.rss.feeds`,
      );
    }
    return match;
  }
  if (env.rss.feeds.length === 0) {
    throw new Error('pollOnce: no feedUrl provided and env.rss.feeds is empty');
  }
  return env.rss.feeds[0];
}

export async function pollOnce(deps: PollDeps = {}): Promise<PollResult> {
  const { topic, url: feedUrl } = resolveFeedConfig(deps);
  const fetcher = deps.fetcher ?? defaultFetcher;
  const dispatcher = deps.dispatcher ?? dispatchCampaign;
  const portal = deps.portal ?? env.rss.portal;
  const startedAt = Date.now();

  let itemsFound = 0;
  let alreadySeen = 0;
  let newItems = 0;
  let sent = 0;
  let errors = 0;

  try {
    const feed = await fetcher(feedUrl);
    const items = (feed.items ?? []).filter((it) => it.title && it.link && pickGuid(it));
    itemsFound = items.length;
    const guids = items.map((it) => pickGuid(it)!);

    // GUID-only dedupe: an article that ANY feed has already claimed is
    // already in the DB regardless of which feed first saw it. Skip those.
    const seen = await prisma.feedItem.findMany({
      where: { guid: { in: guids } },
      select: { guid: true },
    });
    const seenSet = new Set(seen.map((s) => s.guid));
    alreadySeen = seenSet.size;
    const fresh = items.filter((it) => !seenSet.has(pickGuid(it)!));

    for (const item of fresh) {
      const guid = pickGuid(item)!;
      let claim;
      try {
        claim = await prisma.feedItem.create({ data: { feedUrl, guid } });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          // Another feed (or this feed mid-tick) just claimed the same guid.
          alreadySeen++;
          continue;
        }
        errors++;
        // eslint-disable-next-line no-console
        console.error('[rss] failed to claim feed item', { topic, guid, err });
        continue;
      }
      newItems++;

      const input: CampaignInput = {
        portal,
        title: item.title!.trim(),
        body: trimDescription(item),
        url: item.link!.trim(),
        // The feed's configured topic IS the section. Categories on the item
        // are ignored — the source URL is the source of truth.
        target: { type: 'topics', topics: [topic] },
        breaking: false,
      };

      try {
        const result = await dispatcher(input);
        await prisma.feedItem.update({
          where: { id: claim.id },
          data: { campaignId: result.campaignId },
        });
        sent++;
      } catch (err) {
        errors++;
        // eslint-disable-next-line no-console
        console.error('[rss] dispatch failed; feed item kept to prevent re-send', {
          topic,
          guid,
          feedItemId: claim.id,
          err,
        });
      }
    }
  } catch (err) {
    errors++;
    // eslint-disable-next-line no-console
    console.error('[rss] poll failed', { topic, feedUrl, err });
  }

  const durationMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `[rss] poll topic=${topic} feed=${feedUrl} items=${itemsFound} alreadySeen=${alreadySeen} new=${newItems} sent=${sent} errors=${errors} ms=${durationMs}`,
  );
  return { topic, feedUrl, itemsFound, alreadySeen, newItems, sent, errors, durationMs };
}

export async function pollAllFeeds(
  deps: Omit<PollDeps, 'feedUrl' | 'topic'> = {},
  feeds: FeedConfig[] = env.rss.feeds,
): Promise<PollAllResult> {
  const startedAt = Date.now();
  const results: PollResult[] = [];
  // Sequential — gentler on the source, the DB, and easier to read in logs.
  // Six feeds × ~1 s each is well under the 5-minute cron window.
  for (const feed of feeds) {
    const r = await pollOnce({ ...deps, feedUrl: feed.url, topic: feed.topic });
    results.push(r);
  }
  const totals = {
    itemsFound: results.reduce((s, r) => s + r.itemsFound, 0),
    alreadySeen: results.reduce((s, r) => s + r.alreadySeen, 0),
    newItems: results.reduce((s, r) => s + r.newItems, 0),
    sent: results.reduce((s, r) => s + r.sent, 0),
    errors: results.reduce((s, r) => s + r.errors, 0),
    durationMs: Date.now() - startedAt,
  };
  // eslint-disable-next-line no-console
  console.log(
    `[rss] tick complete feeds=${results.length} items=${totals.itemsFound} alreadySeen=${totals.alreadySeen} new=${totals.newItems} sent=${totals.sent} errors=${totals.errors} ms=${totals.durationMs}`,
  );
  return { feeds: results, totals };
}

let isPolling = false;

export function startPoller(): void {
  if (!env.rss.enabled) {
    // eslint-disable-next-line no-console
    console.log('[rss] disabled (set RSS_ENABLED=true to start)');
    return;
  }
  if (!cron.validate(env.rss.cron)) {
    throw new Error(`Invalid RSS_POLL_CRON: ${env.rss.cron}`);
  }
  if (env.rss.feeds.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[rss] no feeds configured — set RSS_FEED_<TOPIC>=<url> vars');
    return;
  }
  cron.schedule(
    env.rss.cron,
    async () => {
      if (isPolling) {
        // eslint-disable-next-line no-console
        console.log('[rss] previous tick still running, skipping');
        return;
      }
      isPolling = true;
      try {
        await pollAllFeeds();
      } finally {
        isPolling = false;
      }
    },
    { timezone: env.rss.tz },
  );
  const summary = env.rss.feeds.map((f) => `${f.topic} → ${f.url}`).join('\n  ');
  // eslint-disable-next-line no-console
  console.log(
    `[rss] poller scheduled cron="${env.rss.cron}" tz=${env.rss.tz}\n  ${summary}`,
  );
}
