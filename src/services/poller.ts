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

/**
 * Map raw RSS category labels (after entity-decode + lowercase + trim) to the
 * four user-facing topic slugs the SDK chooser exposes. Anything not in this
 * table is dropped — see the poller test for the canonical taxscan.in inputs.
 */
const CATEGORY_TO_TOPIC: Record<string, string> = {
  gst: 'gst',
  // Taxscan's current label for the GST bucket. CST and VAT are legacy indirect
  // taxes folded into the same editorial category as GST coverage.
  'cst & vat / gst': 'gst',
  'income tax': 'income-tax',
  'income-tax': 'income-tax',
  customs: 'customs',
  'excise & customs': 'customs',
  'excise and customs': 'customs',
  excise: 'customs',
  corporate: 'corporate',
  'corporate law': 'corporate',
  'company law': 'corporate',
};

// "Top Stories" is on every taxscan.in item — a meta tag, not a content
// category. Stripping it prevents a flood-everyone target.
const SKIP_CATEGORIES = new Set(['top stories']);

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function mapCategoriesToTopics(raws: string[] | undefined): string[] {
  if (!raws) return [];
  const topics = new Set<string>();
  for (const raw of raws) {
    // Taxscan packs multiple categories into a single <category> element
    // separated by commas. Split before lookup.
    for (const piece of String(raw).split(',')) {
      const cleaned = decodeHtmlEntities(piece).trim().toLowerCase();
      if (!cleaned || SKIP_CATEGORIES.has(cleaned)) continue;
      const topic = CATEGORY_TO_TOPIC[cleaned];
      if (topic) topics.add(topic);
    }
  }
  return Array.from(topics);
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

      const topics = mapCategoriesToTopics(item.categories);
      // If nothing maps (e.g. "Other Taxations,Top Stories"), fall through to
      // the synthetic 'all' topic so only "All news" subscribers receive it —
      // not topic-specific subscribers who didn't sign up for it.
      const input: CampaignInput = {
        portal,
        title: item.title!.trim(),
        body: trimDescription(item),
        url: item.link!.trim(),
        target: topics.length
          ? { type: 'topics', topics }
          : { type: 'topics', topics: ['all'] },
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
