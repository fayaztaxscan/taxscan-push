import { prisma } from '../lib/prisma';
import {
  pollAllFeeds,
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
      cooled: 0,
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
    const result = await pollOnce({
      feedUrl,
      topic: 'gst',
      mode: 'live',
      fetcher: fakeFetcher(items),
      dispatcher,
    });

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
    await pollOnce({ feedUrl, topic: 'gst', mode: 'live', fetcher, dispatcher: first.dispatcher });
    expect(first.calls.length).toBe(2);

    const second = recordingDispatcher();
    const result = await pollOnce({
      feedUrl,
      topic: 'gst',
      mode: 'live',
      fetcher,
      dispatcher: second.dispatcher,
    });
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
      topic: 'gst',
      mode: 'live',
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
      topic: 'gst',
      mode: 'live',
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
    const r1 = await pollOnce({
      feedUrl,
      topic: 'gst',
      mode: 'live',
      fetcher: fakeFetcher(items),
      dispatcher: failing.dispatcher,
    });
    expect(r1.errors).toBe(1);
    expect(r1.sent).toBe(0);

    const row = await prisma.feedItem.findUnique({ where: { guid: 'fail-1' } });
    expect(row).not.toBeNull();
    expect(row?.campaignId).toBeNull();

    // Next tick: should not retry
    const second = recordingDispatcher();
    const r2 = await pollOnce({
      feedUrl,
      topic: 'gst',
      mode: 'live',
      fetcher: fakeFetcher(items),
      dispatcher: second.dispatcher,
    });
    expect(r2.newItems).toBe(0);
    expect(r2.sent).toBe(0);
    expect(second.calls.length).toBe(0);
  });
});

describe('pollOnce per-feed topic tagging', () => {
  it('tags every item with the feed\'s configured topic, ignoring <category> entirely', async () => {
    const feedUrl = freshFeedUrl('gst-feed');
    trackFeed(feedUrl);
    const { dispatcher, calls } = recordingDispatcher();
    await pollOnce({
      feedUrl,
      topic: 'gst',
      mode: 'live',
      fetcher: fakeFetcher([
        // These categories would have mapped to ['income-tax'] under the old
        // category-parsing logic, but the feed itself is the source of truth.
        {
          guid: 'tag-1',
          title: 'GST piece',
          link: 'https://taxscan.in/gst',
          categories: ['Income Tax,Top Stories'],
        },
        {
          guid: 'tag-2',
          title: 'Another',
          link: 'https://taxscan.in/x',
          categories: ['Whatever,Top Stories'],
        },
      ]),
      dispatcher,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].target).toEqual({ type: 'topics', topics: ['gst'] });
    expect(calls[1].target).toEqual({ type: 'topics', topics: ['gst'] });
  });

  it('uses a trimmed contentSnippet as the body and stays under the cap', async () => {
    const feedUrl = freshFeedUrl('body');
    trackFeed(feedUrl);
    const long = 'word '.repeat(60).trim();
    const { dispatcher, calls } = recordingDispatcher();
    await pollOnce({
      feedUrl,
      topic: 'customs',
      mode: 'live',
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

describe('cross-feed dedupe (guid-only)', () => {
  it('the same GUID arriving from two section feeds dispatches exactly once', async () => {
    const gstFeed = freshFeedUrl('gst');
    const itFeed = freshFeedUrl('it');
    trackFeed(gstFeed);
    trackFeed(itFeed);
    const sharedGuid = 'cross-feed-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    const sharedItem: FakeItem = {
      guid: sharedGuid,
      title: 'Cross-fed article',
      link: 'https://taxscan.in/cross',
    };

    const first = recordingDispatcher();
    const r1 = await pollOnce({
      feedUrl: gstFeed,
      topic: 'gst',
      mode: 'live',
      fetcher: fakeFetcher([sharedItem]),
      dispatcher: first.dispatcher,
    });
    expect(r1.sent).toBe(1);
    expect(first.calls).toHaveLength(1);
    // First feed to claim the guid wins — target reflects gst, not income-tax.
    expect(first.calls[0].target).toEqual({ type: 'topics', topics: ['gst'] });

    // Now Income Tax feed surfaces the same article. Dedupe must hold.
    const second = recordingDispatcher();
    const r2 = await pollOnce({
      feedUrl: itFeed,
      topic: 'income-tax',
      mode: 'live',
      fetcher: fakeFetcher([sharedItem]),
      dispatcher: second.dispatcher,
    });
    expect(r2.alreadySeen).toBe(1);
    expect(r2.newItems).toBe(0);
    expect(r2.sent).toBe(0);
    expect(second.calls).toHaveLength(0);

    // Exactly one FeedItem row, recording the feed that won the race.
    const rows = await prisma.feedItem.findMany({ where: { guid: sharedGuid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].feedUrl).toBe(gstFeed);
  });
});

describe('SEND_MODE capture_only', () => {
  it('writes the Campaign as DRAFT, links the FeedItem, and never calls the dispatcher', async () => {
    const feedUrl = freshFeedUrl('capture');
    trackFeed(feedUrl);
    const { dispatcher, calls } = recordingDispatcher();
    const guid = 'capture-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);

    const result = await pollOnce({
      feedUrl,
      topic: 'gst',
      mode: 'capture_only',
      fetcher: fakeFetcher([
        { guid, title: 'Captured', link: 'https://taxscan.in/cap', contentSnippet: 'body' },
      ]),
      dispatcher,
    });

    expect(result.mode).toBe('capture_only');
    expect(result.captured).toBe(1);
    expect(result.sent).toBe(0);
    expect(calls).toHaveLength(0);

    const feedItem = await prisma.feedItem.findUnique({ where: { guid } });
    expect(feedItem).not.toBeNull();
    expect(feedItem?.campaignId).not.toBeNull();
    const campaign = await prisma.campaign.findUnique({ where: { id: feedItem!.campaignId! } });
    expect(campaign?.status).toBe('DRAFT');
    expect(campaign?.title).toBe('Captured');
  });
});

describe('pollAllFeeds iteration', () => {
  it('hits every configured feed sequentially and aggregates totals', async () => {
    const feedA = freshFeedUrl('all-a');
    const feedB = freshFeedUrl('all-b');
    trackFeed(feedA);
    trackFeed(feedB);
    const seenFeeds: string[] = [];
    const fetcher: Fetcher = async (url) => {
      seenFeeds.push(url);
      if (url === feedA) {
        return {
          items: [
            { guid: 'all-a-1', title: 'A1', link: 'https://taxscan.in/a1' },
            { guid: 'all-a-2', title: 'A2', link: 'https://taxscan.in/a2' },
          ],
        } as never;
      }
      return {
        items: [
          { guid: 'all-b-1', title: 'B1', link: 'https://taxscan.in/b1' },
        ],
      } as never;
    };
    const { dispatcher } = recordingDispatcher();
    const result = await pollAllFeeds(
      { fetcher, dispatcher, mode: 'live' },
      [
        { topic: 'gst', url: feedA },
        { topic: 'customs', url: feedB },
      ],
    );
    expect(seenFeeds).toEqual([feedA, feedB]); // sequential, in config order
    expect(result.feeds).toHaveLength(2);
    expect(result.feeds[0].topic).toBe('gst');
    expect(result.feeds[1].topic).toBe('customs');
    expect(result.totals.itemsFound).toBe(3);
    expect(result.totals.sent).toBe(3);
  });
});

describe('editorial classifier routing (Stage 1)', () => {
  // FeedItem dedupe is by GUID globally and the dev DB is not reset between
  // runs, so GUIDs + URLs must be unique per run or a second run sees them as
  // already-claimed and skips them.
  function uid(): string {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }

  it('editorialFilter on + live: dispatches only QUALIFIED, holds FALLBACK + REVIEW as DRAFT', async () => {
    const feedUrl = freshFeedUrl('editorial');
    const u = uid();
    const scUrl = `https://taxscan.in/sc1-${u}`;
    const cestatUrl = `https://taxscan.in/cestat1-${u}`;
    const explainerUrl = `https://taxscan.in/explainer1-${u}`;
    const fetcher = fakeFetcher([
      { guid: `q-${u}`, title: 'Supreme Court upholds reassessment [Read Judgment]', link: scUrl },
      { guid: `f-${u}`, title: 'Refund allowed: CESTAT [Read Order]', link: cestatUrl },
      { guid: `r-${u}`, title: 'Understanding GST on Renting of Property', link: explainerUrl },
    ]);
    const { dispatcher, calls } = recordingDispatcher();
    const result = await pollOnce({
      feedUrl,
      topic: 'income-tax',
      mode: 'live',
      editorialFilter: true,
      fetcher,
      dispatcher,
    });

    expect(result.sent).toBe(1);
    expect(result.held).toBe(2);
    expect(result.captured).toBe(0);
    // Only the Supreme Court item reached the dispatcher, tagged QUALIFIED.
    expect(calls.map((c) => c.title)).toEqual([
      'Supreme Court upholds reassessment [Read Judgment]',
    ]);
    expect(calls[0].sendQueue).toBe('QUALIFIED');
    expect(calls[0].authority).toBe('Supreme Court');

    // Held items persisted as DRAFT with their queue + authority.
    const drafts = await prisma.campaign.findMany({
      where: { url: { in: [cestatUrl, explainerUrl] } },
      select: { status: true, sendQueue: true, authority: true, url: true },
    });
    const byUrl = Object.fromEntries(drafts.map((d) => [d.url, d]));
    expect(byUrl[cestatUrl]).toMatchObject({
      status: 'DRAFT',
      sendQueue: 'FALLBACK',
      authority: 'CESTAT',
    });
    expect(byUrl[explainerUrl]).toMatchObject({
      status: 'DRAFT',
      sendQueue: 'REVIEW',
      authority: null,
    });
  });

  it('editorialFilter off + live: dispatches everything (legacy) but still stamps classification', async () => {
    const feedUrl = freshFeedUrl('editorial-off');
    const u = uid();
    const fetcher = fakeFetcher([
      { guid: `off-q-${u}`, title: 'CBDT notifies new TDS rates [Read Notification]', link: `https://taxscan.in/cbdt1-${u}` },
      { guid: `off-f-${u}`, title: 'Penalty set aside: CESTAT [Read Order]', link: `https://taxscan.in/cestat2-${u}` },
    ]);
    const { dispatcher, calls } = recordingDispatcher();
    const result = await pollOnce({
      feedUrl,
      topic: 'income-tax',
      mode: 'live',
      editorialFilter: false,
      fetcher,
      dispatcher,
    });

    expect(result.sent).toBe(2);
    expect(result.held).toBe(0);
    expect(calls.map((c) => c.authority).sort()).toEqual(['CBDT', 'CESTAT']);
    expect(calls.find((c) => c.authority === 'CESTAT')?.sendQueue).toBe('FALLBACK');
  });

  it('editorialFilter + pacerEnabled: QUALIFIED is queued as DRAFT (held), nothing dispatched', async () => {
    const feedUrl = freshFeedUrl('editorial-pacer');
    const u = uid();
    const scUrl = `https://taxscan.in/scp-${u}`;
    const fetcher = fakeFetcher([
      { guid: `pq-${u}`, title: 'Supreme Court ruling [Read Judgment]', link: scUrl },
    ]);
    const { dispatcher, calls } = recordingDispatcher();
    const result = await pollOnce({
      feedUrl,
      topic: 'income-tax',
      mode: 'live',
      editorialFilter: true,
      pacerEnabled: true,
      fetcher,
      dispatcher,
    });

    expect(calls).toHaveLength(0); // pacer will release it later, not the poller
    expect(result.sent).toBe(0);
    expect(result.held).toBe(1);
    const draft = await prisma.campaign.findFirst({
      where: { url: scUrl },
      select: { status: true, sendQueue: true, authority: true },
    });
    expect(draft).toMatchObject({ status: 'DRAFT', sendQueue: 'QUALIFIED', authority: 'Supreme Court' });
  });

  it('capture_only ignores the filter — everything captured (not held), nothing dispatched', async () => {
    const feedUrl = freshFeedUrl('editorial-capture');
    const u = uid();
    const fetcher = fakeFetcher([
      { guid: `cap-q-${u}`, title: 'Supreme Court ruling [Read Judgment]', link: `https://taxscan.in/sc2-${u}` },
    ]);
    const { dispatcher, calls } = recordingDispatcher();
    const result = await pollOnce({
      feedUrl,
      topic: 'income-tax',
      mode: 'capture_only',
      editorialFilter: true,
      fetcher,
      dispatcher,
    });

    expect(calls).toHaveLength(0);
    expect(result.captured).toBe(1);
    expect(result.held).toBe(0);
    expect(result.sent).toBe(0);
  });
});
