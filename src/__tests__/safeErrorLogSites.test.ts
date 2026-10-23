import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { prisma } from '../lib/prisma';
import { executeCampaign, type Sender } from '../services/send';
import { sweepScheduledCampaigns } from '../services/sweeper';
import { pollOnce, type Fetcher, type Dispatcher } from '../services/poller';
import { startMetricsWarmer, __resetHeavyAggregates } from '../services/metrics';
import { validKeys } from './helpers';

/**
 * No raw error object reaches a log line (QA, 2026-10-23). A Prisma error's
 * message quotes the query's arguments — an email address, a push endpoint —
 * and a raw `err` in console.* prints that message and its stack. Every cron
 * and send-path catch now logs through `safeErrorLog`, with its prefix kept
 * exactly (operators search Railway logs by it). One representative per file
 * where the catch is reachable from a test, plus a source scan that keeps any
 * new bare `err` / `e` / `error` argument out of `src/`.
 *
 * Nothing here sends: the push sender is a stub, the subscribers are on a
 * unique test portal with fake endpoints, and every row is removed afterwards.
 */

const ADDRESS = 'reader.logs@example.invalid';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/secret-endpoint-token';

/** What Prisma throws on a unique violation: the message quotes the value. */
function prismaLikeError(): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`email\`) for value ${ADDRESS} ${ENDPOINT}`), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
    clientVersion: '6.0.0',
    meta: { target: ['email'], modelName: 'Subscriber' },
  });
}

/** Every console line, rendered the way Node renders it (util.inspect prints an Error's message and stack). */
const lines: { level: string; text: string }[] = [];
for (const level of ['log', 'warn', 'error', 'info'] as const) {
  jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
    lines.push({ level, text: args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' ') });
  });
}

function linesWith(prefix: string): string[] {
  return lines.filter((l) => l.text.includes(prefix)).map((l) => l.text);
}

function expectClean(prefix: string): void {
  const hit = linesWith(prefix);
  expect(hit.length).toBeGreaterThan(0);
  for (const t of hit) {
    expect(t).not.toContain(ADDRESS);
    expect(t).not.toContain('secret-endpoint-token');
    expect(t).toContain('P2002'); // still says what failed
  }
}

const PORTAL = `test-logs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const FEED_PREFIX = `https://test-feed.example.com/logs-${Date.now()}-`;
const campaignIds: string[] = [];

beforeEach(() => {
  lines.length = 0;
});

afterAll(async () => {
  __resetHeavyAggregates();
  const feeds = await prisma.feedItem.findMany({ where: { feedUrl: { startsWith: FEED_PREFIX } }, select: { campaignId: true } });
  await prisma.feedItem.deleteMany({ where: { feedUrl: { startsWith: FEED_PREFIX } } });
  const ids = [...campaignIds, ...feeds.map((f) => f.campaignId).filter((x): x is string => !!x)];
  if (ids.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'campaign' AND "resourceId" = ANY(${ids}::text[])`;
    });
    await prisma.event.deleteMany({ where: { campaignId: { in: ids } } });
    await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.subscriber.deleteMany({ where: { portal: PORTAL } });
  await prisma.$disconnect();
});

describe('send.ts — the live push path logs no address (behaviour unchanged)', () => {
  it('[send] event write failed mid-send: the rows are retried, the log has code but no address', async () => {
    const keys = validKeys();
    await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        prisma.subscriber.create({
          data: { endpoint: `https://test-logs.example.com/sub/${PORTAL}-${i}`, p256dh: keys.p256dh, auth: keys.auth, portal: PORTAL, topics: [] },
        }),
      ),
    );
    const c = await prisma.campaign.create({
      data: { portal: PORTAL, title: 't', body: 'b', url: 'https://taxscan.in/x', target: { type: 'all' }, status: 'SCHEDULED' },
    });
    campaignIds.push(c.id);
    const real = prisma.event.createMany.bind(prisma.event);
    let first = true;
    const spy = jest.spyOn(prisma.event, 'createMany').mockImplementation(((args: Parameters<typeof real>[0]) => {
      if (first) {
        first = false;
        return Promise.reject(prismaLikeError());
      }
      return real(args);
    }) as unknown as typeof prisma.event.createMany);
    const sender: Sender = async () => ({ ok: true, statusCode: 201 });
    try {
      const r = await executeCampaign(c, { sender, cap: Infinity, minGapMinutes: 0, concurrency: 2 });
      expect(r.sent).toBe(150);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.event.count({ where: { campaignId: c.id, type: 'SENT' } })).toBe(150);
    expectClean('[send] event write failed mid-send — will retry');
    expect(linesWith('[send] event write failed mid-send')[0]).toContain(c.id); // campaignId kept
  });
});

describe('sweeper.ts', () => {
  it('[sweeper] executeCampaign threw', async () => {
    const c = await prisma.campaign.create({
      data: {
        portal: PORTAL,
        title: 't',
        body: 'b',
        url: 'https://taxscan.in/x',
        target: { type: 'all' },
        status: 'SCHEDULED',
        scheduledAt: new Date('2000-01-01T00:00:00Z'),
      },
    });
    campaignIds.push(c.id);
    const spy = jest.spyOn(prisma.subscriber, 'findMany').mockRejectedValueOnce(prismaLikeError());
    const sender: Sender = async () => ({ ok: true, statusCode: 201 });
    try {
      // 12:00 IST on 2 Jan 2000: only this test's row is due, and it is not quiet hours.
      const r = await sweepScheduledCampaigns({ sender, now: new Date('2000-01-02T06:30:00Z'), quietStart: '23:00', quietEnd: '07:00' });
      expect(r.errors).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expectClean('[sweeper] executeCampaign threw');
  });
});

describe('poller.ts', () => {
  let n = 0;
  const feed = () => `${FEED_PREFIX}${++n}`;
  const items = (tag: string): Fetcher => async () =>
    ({ items: [{ guid: `${FEED_PREFIX}${tag}`, title: `Logs ${tag}`, link: `https://taxscan.in/logs-${tag}` }] }) as never;

  it('[rss] dispatch failed', async () => {
    const dispatcher: Dispatcher = async () => {
      throw prismaLikeError();
    };
    const r = await pollOnce({ feedUrl: feed(), topic: 'gst', mode: 'live', fetcher: items('dispatch'), dispatcher, editorialFilter: false, pacerEnabled: false });
    expect(r.errors).toBe(1);
    expectClean('[rss] dispatch failed; feed item kept to prevent re-send');
  });

  it('[rss] poll failed', async () => {
    const fetcher: Fetcher = async () => {
      throw prismaLikeError();
    };
    await pollOnce({ feedUrl: feed(), topic: 'gst', mode: 'live', fetcher });
    expectClean('[rss] poll failed');
  });

  it('[rss] failed to claim feed item', async () => {
    const spy = jest.spyOn(prisma.feedItem, 'create').mockRejectedValueOnce(Object.assign(prismaLikeError(), { code: 'P2003' }));
    try {
      await pollOnce({ feedUrl: feed(), topic: 'gst', mode: 'live', fetcher: items('claim'), dispatcher: async () => { throw new Error('unreached'); } });
    } finally {
      spy.mockRestore();
    }
    const hit = linesWith('[rss] failed to claim feed item');
    expect(hit.length).toBe(1);
    expect(hit[0]).not.toContain(ADDRESS);
    expect(hit[0]).toContain('P2003');
  });
});

describe('metrics.ts', () => {
  it('[metrics] lifetime aggregate refresh failed', async () => {
    __resetHeavyAggregates();
    const prev = process.env.METRICS_HEAVY_REFRESH_MS;
    process.env.METRICS_HEAVY_REFRESH_MS = '3600000';
    const spy = jest.spyOn(prisma.event, 'groupBy').mockRejectedValueOnce(prismaLikeError() as never);
    try {
      startMetricsWarmer();
      for (let i = 0; i < 50 && linesWith('[metrics] lifetime aggregate refresh failed').length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      spy.mockRestore();
      __resetHeavyAggregates();
      if (prev === undefined) delete process.env.METRICS_HEAVY_REFRESH_MS;
      else process.env.METRICS_HEAVY_REFRESH_MS = prev;
    }
    expectClean('[metrics] lifetime aggregate refresh failed (serving previous values)');
  });
});

describe('source scan: no bare error argument to console.* anywhere in src/', () => {
  type Frame = { t: 'code'; paren: number; brace: number; tplExpr: boolean } | { t: 'str'; q: string } | { t: 'tpl' };

  /**
   * Every `console.x(...)` call's argument text. Plain string contents are blanked
   * (`""`); a template literal's text is blanked too, but each `${…}` expression is
   * KEPT, between commas, so an error interpolated into a message (`${err}`,
   * `${err.message}`) is checked like any other argument (task 13, 7c).
   */
  function consoleCalls(src: string): { line: number; args: string }[] {
    const out: { line: number; args: string }[] = [];
    const re = /console\.(log|warn|error|info|debug)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const stack: Frame[] = [{ t: 'code', paren: 1, brace: 0, tplExpr: false }];
      let args = '';
      for (let i = m.index + m[0].length; i < src.length && stack.length > 0; i++) {
        const top = stack[stack.length - 1];
        const ch = src[i];
        if (top.t === 'str') {
          if (ch === '\\') i++;
          else if (ch === top.q) stack.pop();
          continue; // string contents are not code
        }
        if (top.t === 'tpl') {
          if (ch === '\\') i++;
          else if (ch === '`') stack.pop();
          else if (ch === '$' && src[i + 1] === '{') {
            i++;
            args += ',';
            stack.push({ t: 'code', paren: 0, brace: 0, tplExpr: true });
          }
          continue;
        }
        if (ch === '"' || ch === "'") { stack.push({ t: 'str', q: ch }); args += '""'; continue; }
        if (ch === '`') { stack.push({ t: 'tpl' }); args += '""'; continue; }
        if (top.tplExpr && ch === '}' && top.brace === 0) { stack.pop(); args += ','; continue; }
        if (ch === '{') top.brace++;
        if (ch === '}') top.brace--;
        if (ch === '(') top.paren++;
        if (ch === ')') {
          top.paren--;
          if (stack.length === 1 && top.paren === 0) break;
        }
        args += ch;
      }
      out.push({ line: src.slice(0, m.index).split('\n').length, args });
    }
    return out;
  }

  /** The calls that make an error safe to log, removed with their (balanced) arguments. */
  const SAFE_CALL = /\b(safeErrorLog|redactError|redactText|safeDetail)\(/g;
  function stripSafe(args: string): string {
    let out = args;
    for (let m = SAFE_CALL.exec(out); m; m = SAFE_CALL.exec(out)) {
      let depth = 1;
      let j = m.index + m[0].length;
      for (; j < out.length && depth > 0; j++) {
        if (out[j] === '(') depth++;
        if (out[j] === ')') depth--;
      }
      out = `${out.slice(0, m.index)}""${out.slice(j)}`;
      SAFE_CALL.lastIndex = m.index + 2;
    }
    SAFE_CALL.lastIndex = 0;
    return out;
  }

  const ERR = '(?:err|e|error|ex)';
  /** A bare `err` / `e` / `error` / `ex` as a whole argument, a shorthand field or a `${err}` interpolation. */
  const BARE = new RegExp(`(^|[,{(]\\s*)${ERR}\\s*(?=[,})]|$)`);
  /** An error as a field VALUE: `{ cause: err }`, `{ error: e }` (also the `: err` arm of a ternary). */
  const FIELD = new RegExp(`:\\s*${ERR}\\s*(?=[,})]|$)`);
  /** The raw message, unredacted: `err.message`, `e.message` (an argument or inside `${…}`). */
  const MESSAGE = new RegExp(`\\b${ERR}\\.message\\b`);
  /** The whole error stringified: `String(err)`, `JSON.stringify(e)`. */
  const STRINGIFIED = new RegExp(`\\b(String|JSON\\.stringify)\\(\\s*${ERR}\\s*[),]`);
  /** The argument text, minus the calls that make an error safe to log. */
  const offends = (args: string) => {
    const a = stripSafe(args);
    return BARE.test(a) || FIELD.test(a) || MESSAGE.test(a) || STRINGIFIED.test(a);
  };

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === '__tests__' ? [] : walk(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  }

  it('finds the pattern it is meant to find (self-check)', () => {
    const hit = (code: string) => consoleCalls(code).some((c) => offends(c.args));
    // Task 13 (7c): a cause field, a raw message and an interpolated error are caught too …
    expect(hit("console.warn('[x]', { cause: err });")).toBe(true);
    expect(hit("console.warn('[x]', { id, error: e });")).toBe(true);
    expect(hit("console.error('[x]', err.message);")).toBe(true);
    expect(hit("console.error('[x]', { message: e.message });")).toBe(true);
    expect(hit('console.error(`[x] failed: ${err}`);')).toBe(true);
    expect(hit('console.error(`[x] failed: ${err.message}`);')).toBe(true);
    expect(hit('console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);')).toBe(true);
    expect(hit('console.warn(`[x] ${id} ${String(e)}`);')).toBe(true);
    // … with no false positive on the safe forms or on ordinary values.
    expect(hit('console.warn(`[x] failed: ${redactError(err)}`);')).toBe(false);
    expect(hit('console.warn(`[x] failed: ${safeDetail(err instanceof Error ? err.message : err)}`);')).toBe(false);
    expect(hit("console.error('[x]', safeErrorLog(err, { stack: true }), { id });")).toBe(false);
    expect(hit('console.error(`[x] failed: ${err instanceof Error ? err.name : "error"}`);')).toBe(false);
    expect(hit('console.log(`[x] ${items.length} items, ${e2e ? "on" : "off"} error=${errors}`);')).toBe(false);
    expect(hit("console.log('[x]', { errors: 3, element: el, code: err.code });")).toBe(false);
    expect(hit('console.log(`[x] {not an expression} ${a}:${b}`);')).toBe(false);
    expect(hit("console.error('[x] failed', e);")).toBe(true);
    expect(consoleCalls("console.warn('[x]', { id, err });").some((c) => offends(c.args))).toBe(true);
    expect(consoleCalls("console.error('[x]', {\n  id,\n  err,\n});").some((c) => offends(c.args))).toBe(true);
    expect(consoleCalls("console.error('[x]', safeErrorLog(e, { stack: true }));").some((c) => offends(c.args))).toBe(false);
    expect(consoleCalls("console.warn('[x]', { id, err: safeErrorLog(err) });").some((c) => offends(c.args))).toBe(false);
    // Was allowed before task 13 (template contents were not scanned): the raw message is now caught.
    expect(consoleCalls('console.error(`FATAL: ${err instanceof Error ? err.message : err}`);').some((c) => offends(c.args))).toBe(true);
  });

  it('every catch in src/ logs through safeErrorLog / redactError, never the raw object', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of walk(root)) {
      for (const c of consoleCalls(fs.readFileSync(file, 'utf8'))) {
        if (offends(c.args)) offenders.push(`${path.relative(root, file)}:${c.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
