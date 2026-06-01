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

export type PollDeps = {
  feedUrl?: string;
  fetcher?: Fetcher;
  dispatcher?: Dispatcher;
  portal?: string;
};

export type PollResult = {
  feedUrl: string;
  itemsFound: number;
  newItems: number;
  sent: number;
  errors: number;
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

export async function pollOnce(deps: PollDeps = {}): Promise<PollResult> {
  const feedUrl = deps.feedUrl ?? env.rss.feedUrl;
  const fetcher = deps.fetcher ?? defaultFetcher;
  const dispatcher = deps.dispatcher ?? dispatchCampaign;
  const portal = deps.portal ?? env.rss.portal;
  const startedAt = Date.now();

  let itemsFound = 0;
  let newItems = 0;
  let sent = 0;
  let errors = 0;

  try {
    const feed = await fetcher(feedUrl);
    const items = (feed.items ?? []).filter((it) => it.title && it.link && pickGuid(it));
    itemsFound = items.length;
    const guids = items.map((it) => pickGuid(it)!);

    const seen = await prisma.feedItem.findMany({
      where: { feedUrl, guid: { in: guids } },
      select: { guid: true },
    });
    const seenSet = new Set(seen.map((s) => s.guid));
    const fresh = items.filter((it) => !seenSet.has(pickGuid(it)!));

    for (const item of fresh) {
      const guid = pickGuid(item)!;
      let claim;
      try {
        claim = await prisma.feedItem.create({ data: { feedUrl, guid } });
      } catch (err) {
        if (isUniqueConstraintError(err)) continue;
        errors++;
        // eslint-disable-next-line no-console
        console.error('[rss] failed to claim feed item', { guid, err });
        continue;
      }
      newItems++;

      const categories = (item.categories ?? []).map((c) => slugify(String(c))).filter(Boolean);
      const input: CampaignInput = {
        portal,
        title: item.title!.trim(),
        body: trimDescription(item),
        url: item.link!.trim(),
        target: categories.length ? { type: 'topics', topics: categories } : { type: 'all' },
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
          guid,
          feedItemId: claim.id,
          err,
        });
      }
    }
  } catch (err) {
    errors++;
    // eslint-disable-next-line no-console
    console.error('[rss] poll failed', { feedUrl, err });
  }

  const ms = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `[rss] poll feed=${feedUrl} items=${itemsFound} new=${newItems} sent=${sent} errors=${errors} ms=${ms}`,
  );
  return { feedUrl, itemsFound, newItems, sent, errors };
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
  cron.schedule(
    env.rss.cron,
    async () => {
      if (isPolling) {
        // eslint-disable-next-line no-console
        console.log('[rss] previous poll still running, skipping tick');
        return;
      }
      isPolling = true;
      try {
        await pollOnce();
      } finally {
        isPolling = false;
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(`[rss] poller scheduled cron="${env.rss.cron}" tz=${env.rss.tz} feed=${env.rss.feedUrl}`);
}
