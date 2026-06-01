import { prisma } from '../lib/prisma';
import {
  pollOnce,
  slugify,
  trimDescription,
  type Dispatcher,
  type Fetcher,
} from '../services/poller';
import type { CampaignInput, DispatchResult } from '../services/send';

const TEST_FEED_PREFIX = 'https://test-feed.example.com/';

function freshFeedUrl(name: string): string {
  return `${TEST_FEED_PREFIX}${name}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

type FakeItem = {
  guid: string;
  title: string;
  link: string;
  categories?: string[];
  contentSnippet?: string;
  content?: string;
};

function fakeFetcher(items: FakeItem[]): Fetcher {
  return async () => ({ items: items as unknown as Parameters<Dispatcher>[0][] }) as never;
}

type DispatcherSpy = {
  dispatcher: Dispatcher;
  calls: CampaignInput[];
};
function recordingDispatcher(result?: Partial<DispatchResult>): DispatcherSpy {
  const calls: CampaignInput[] = [];
  const dispatcher: Dispatcher = async (input) => {
    calls.push(input);
    const campaign = await prisma.campaign.create({
      data: {
        portal: input.portal,
        title: input.title,
        body: input.body,
        url: input.url,
        icon: input.icon ?? null,
        target: input.target as object,
        status: 'SENT',
      },
    });
    return {
      campaignId: campaign.id,
      status: 'SENT',
      sent: 1,
      capped: 0,
      expiredPruned: 0,
      failed: 0,
      ...result,
    };
  };
  return { dispatcher, calls };
}

function failingDispatcher(): DispatcherSpy {
  const calls: CampaignInput[] = [];
  const dispatcher: Dispatcher = async (input) => {
    calls.push(input);
    throw new Error('boom');
  };
  return { dispatcher, calls };
}

const createdFeeds: string[] = [];
function trackFeed(url: string) {
  createdFeeds.push(url);
}

afterAll(async () => {
  if (createdFeeds.length) {
    const rows = await prisma.feedItem.findMany({
      where: { feedUrl: { in: createdFeeds } },
      select: { campaignId: true },
    });
    const campaignIds = rows.map((r) => r.campaignId).filter((x): x is string => Boolean(x));
    await prisma.feedItem.deleteMany({ where: { feedUrl: { in: createdFeeds } } });
    if (campaignIds.length) {
      await prisma.event.deleteMany({ where: { campaignId: { in: campaignIds } } });
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    }
  }
  await prisma.$disconnect();
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugify('Income Tax')).toBe('income-tax');
    expect(slugify('GST')).toBe('gst');
    expect(slugify("  Customs & Trade  ")).toBe('customs-trade');
  });
});

describe('trimDescription', () => {
  it('prefers contentSnippet, collapses whitespace, leaves short text alone', () => {
    expect(trimDescription({ contentSnippet: '  hello   world  ' } as never)).toBe('hello world');
  });
  it('strips HTML when only content/description are present', () => {
    expect(trimDescription({ content: '<p>hi <b>there</b></p>' } as never)).toBe('hi there');
  });
  it('trims to max length with an ellipsis', () => {
    const long = 'word '.repeat(60).trim();
    const out = trimDescription({ contentSnippet: long } as never, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('pollOnce dedupe', () => {
  it('dispatches every item on the first run and records FeedItem rows', async () => {
    const feedUrl = freshFeedUrl('first-run');
    trackFeed(feedUrl);
    const items: FakeItem[] = [
      { guid: 'a', title: 'Article A', link: 'https://taxscan.in/a' },
      { guid: 'b', title: 'Article B', link: 'https://taxscan.in/b' },
      { guid: 'c', title: 'Article C', link: 'https://taxscan.in/c' },
    ];
    const { dispatcher, calls } = recordingDispatcher();
    const result = await pollOnce({ feedUrl, fetcher: fakeFetcher(items), dispatcher });

    expect(result).toMatchObject({ itemsFound: 3, newItems: 3, sent: 3, errors: 0 });
    expect(calls.map((c) => c.title).sort()).toEqual(['Article A', 'Article B', 'Article C']);

    const rows = await prisma.feedItem.findMany({ where: { feedUrl } });
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.campaignId)).toBe(true);
  });

  it('a second run with the same feed dispatches nothing', async () => {
    const feedUrl = freshFeedUrl('rerun');
    trackFeed(feedUrl);
    const items: FakeItem[] = [
      { guid: 'x', title: 'X', link: 'https://taxscan.in/x' },
      { guid: 'y', title: 'Y', link: 'https://taxscan.in/y' },
    ];
    const fetcher = fakeFetcher(items);
    const first = recordingDispatcher();
    await pollOnce({ feedUrl, fetcher, dispatcher: first.dispatcher });
    expect(first.calls.length).toBe(2);

    const second = recordingDispatcher();
    const result = await pollOnce({ feedUrl, fetcher, dispatcher: second.dispatcher });
    expect(result.newItems).toBe(0);
    expect(result.sent).toBe(0);
    expect(second.calls.length).toBe(0);
  });

  it('after restart, only newly-appeared items are dispatched', async () => {
    const feedUrl = freshFeedUrl('restart');
    trackFeed(feedUrl);
    const original: FakeItem[] = [
      { guid: 'one', title: 'One', link: 'https://taxscan.in/1' },
      { guid: 'two', title: 'Two', link: 'https://taxscan.in/2' },
    ];
    await pollOnce({
      feedUrl,
      fetcher: fakeFetcher(original),
      dispatcher: recordingDispatcher().dispatcher,
    });

    // simulate restart: same DB, fresh dispatcher, feed gained a new item
    const updated: FakeItem[] = [
      ...original,
      { guid: 'three', title: 'Three', link: 'https://taxscan.in/3' },
    ];
    const second = recordingDispatcher();
    const result = await pollOnce({
      feedUrl,
      fetcher: fakeFetcher(updated),
      dispatcher: second.dispatcher,
    });
    expect(result.newItems).toBe(1);
    expect(result.sent).toBe(1);
    expect(second.calls.map((c) => c.title)).toEqual(['Three']);
  });

  it('keeps the FeedItem row when dispatch fails and never retries it', async () => {
    const feedUrl = freshFeedUrl('fail');
    trackFeed(feedUrl);
    const items: FakeItem[] = [
      { guid: 'fail-1', title: 'Will Fail', link: 'https://taxscan.in/fail' },
    ];

    const failing = failingDispatcher();
    const r1 = await pollOnce({ feedUrl, fetcher: fakeFetcher(items), dispatcher: failing.dispatcher });
    expect(r1.errors).toBe(1);
    expect(r1.sent).toBe(0);

    const row = await prisma.feedItem.findUnique({
      where: { feedUrl_guid: { feedUrl, guid: 'fail-1' } },
    });
    expect(row).not.toBeNull();
    expect(row?.campaignId).toBeNull();

    // Next tick: should not retry
    const second = recordingDispatcher();
    const r2 = await pollOnce({ feedUrl, fetcher: fakeFetcher(items), dispatcher: second.dispatcher });
    expect(r2.newItems).toBe(0);
    expect(r2.sent).toBe(0);
    expect(second.calls.length).toBe(0);
  });
});

describe('pollOnce target resolution', () => {
  it('maps RSS categories to slugged topic targets', async () => {
    const feedUrl = freshFeedUrl('topics');
    trackFeed(feedUrl);
    const { dispatcher, calls } = recordingDispatcher();
    await pollOnce({
      feedUrl,
      fetcher: fakeFetcher([
        {
          guid: 'cat-1',
          title: 'GST verdict',
          link: 'https://taxscan.in/gst-1',
          categories: ['GST', 'Income Tax'],
        },
      ]),
      dispatcher,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toEqual({ type: 'topics', topics: ['gst', 'income-tax'] });
  });

  it('falls back to target=all when no categories are present', async () => {
    const feedUrl = freshFeedUrl('all');
    trackFeed(feedUrl);
    const { dispatcher, calls } = recordingDispatcher();
    await pollOnce({
      feedUrl,
      fetcher: fakeFetcher([
        { guid: 'noc-1', title: 'No categories', link: 'https://taxscan.in/noc' },
      ]),
      dispatcher,
    });
    expect(calls[0].target).toEqual({ type: 'all' });
    expect(calls[0].breaking).toBe(false);
  });

  it('uses a trimmed contentSnippet as the body', async () => {
    const feedUrl = freshFeedUrl('body');
    trackFeed(feedUrl);
    const long = 'word '.repeat(60).trim();
    const { dispatcher, calls } = recordingDispatcher();
    await pollOnce({
      feedUrl,
      fetcher: fakeFetcher([
        {
          guid: 'body-1',
          title: 'Long article',
          link: 'https://taxscan.in/long',
          contentSnippet: long,
        },
      ]),
      dispatcher,
    });
    expect(calls[0].body.length).toBeLessThanOrEqual(140);
    expect(calls[0].body.endsWith('…')).toBe(true);
  });
});
