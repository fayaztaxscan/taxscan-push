import { gunzipSync } from 'node:zlib';
import { prisma } from '../lib/prisma';
import {
  BACKUP_TABLES,
  buildBackup,
  lastBackupRun,
  objectKeyFor,
  pruneOldBackups,
  runBackup,
} from '../services/backup';
import type { R2Config } from '../lib/r2';

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const subscriberIds: string[] = [];
const campaignIds: string[] = [];
const runIds: string[] = [];

afterAll(async () => {
  if (subscriberIds.length) await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
  if (campaignIds.length) await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  if (runIds.length) await prisma.backupRun.deleteMany({ where: { id: { in: runIds } } });
  await prisma.$disconnect();
});

/** Parses the NDJSON body back into a header + rows. */
function parse(body: Buffer) {
  const lines = body.toString('utf8').trim().split('\n');
  return { header: JSON.parse(lines[0]), rows: lines.slice(1).map((l) => JSON.parse(l)) };
}

describe('buildBackup', () => {
  it('writes a self-describing header and one JSON object per row', async () => {
    const tag = uniq();
    const s = await prisma.subscriber.create({
      data: { portal: 'taxscan', endpoint: `https://push.example/${tag}`, p256dh: 'p', auth: 'a', topics: ['all'] },
    });
    subscriberIds.push(s.id);

    const { body, result } = await buildBackup({ now: new Date('2026-09-08T06:55:00Z') });
    const { header, rows } = parse(body);

    expect(header._format).toBe('taxscan-push-backup');
    expect(header.version).toBe(1);
    expect(header.generatedAt).toBe('2026-09-08T06:55:00.000Z');
    // The header must name the tables, so a restorer knows what to expect.
    expect(header.tables).toEqual([...BACKUP_TABLES]);

    const mine = rows.find((r) => r._table === 'Subscriber' && r.id === s.id);
    expect(mine).toBeTruthy();
    // The three fields web-push cannot work without.
    expect(mine.endpoint).toBe(`https://push.example/${tag}`);
    expect(mine.p256dh).toBe('p');
    expect(mine.auth).toBe('a');
    expect(result.rows).toBe(rows.length);
    expect(result.tables.Subscriber).toBeGreaterThan(0);
  });

  it('carries live subscribers but not EXPIRED ones', async () => {
    const tag = uniq();
    const live = await prisma.subscriber.create({
      data: { portal: 'taxscan', endpoint: `https://push.example/live-${tag}`, p256dh: 'p', auth: 'a', topics: ['all'] },
    });
    const dead = await prisma.subscriber.create({
      data: {
        portal: 'taxscan',
        endpoint: `https://push.example/dead-${tag}`,
        p256dh: 'p',
        auth: 'a',
        topics: ['all'],
        status: 'EXPIRED',
      },
    });
    subscriberIds.push(live.id, dead.id);

    const { body, result } = await buildBackup();
    const { rows } = parse(body);
    const ids = new Set(rows.filter((r) => r._table === 'Subscriber').map((r) => r.id));

    expect(ids.has(live.id)).toBe(true);
    // An expired row means the push service returned 404/410 and permanently
    // retired that endpoint — it can never be presented again, so the row can
    // never be revived and carrying it only stores a dead personal identifier.
    expect(ids.has(dead.id)).toBe(false);

    // And the header says so, so a future restorer is not left guessing why
    // the subscriber count is lower than production's row count.
    const { header } = parse(body);
    expect(header.excludes).toContain('EXPIRED');
    expect(result.tables.Subscriber).toBe(ids.size);
  });

  it('excludes the tables that would make the export enormous or misleading', async () => {
    const { body } = await buildBackup();
    const { rows } = parse(body);
    const tables = new Set(rows.map((r) => r._table));
    // Event is 86% of the database; the stat tables are re-fetchable mirrors;
    // AuditLog is an immutable compliance record that must not be re-inserted.
    for (const excluded of ['Event', 'ArticleReadStat', 'ArticleSurfaceStat', 'AuditLog', 'UserSession']) {
      expect(tables.has(excluded)).toBe(false);
    }
  });

  it('never contains the VAPID private key — the file must be inert without it', async () => {
    const { body } = await buildBackup();
    const text = body.toString('utf8');
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (priv) expect(text).not.toContain(priv);
    expect(text).not.toContain('VAPID_PRIVATE_KEY');
  });
});

describe('objectKeyFor', () => {
  it('sorts chronologically and carries no characters that need escaping', () => {
    const key = objectKeyFor(new Date('2026-09-08T06:55:00.000Z'), 'taxscan-push');
    expect(key).toBe('taxscan-push/2026/2026-09-08T06-55-00Z.ndjson.gz');
    expect(key).not.toMatch(/[:\s]/);
  });
});

describe('runBackup', () => {
  it('uploads a gzipped body that unzips to the NDJSON, and records the run', async () => {
    const uploaded: Array<{ key: string; body: Buffer }> = [];
    const r = await runBackup({
      now: new Date('2026-09-08T07:00:00Z'),
      upload: async (key, body) => void uploaded.push({ key, body }),
    });

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].key).toBe('taxscan-push/2026/2026-09-08T07-00-00Z.ndjson.gz');
    const round = gunzipSync(uploaded[0].body).toString('utf8');
    expect(JSON.parse(round.split('\n')[0])._format).toBe('taxscan-push-backup');
    expect(r.bytes).toBe(uploaded[0].body.length);

    const run = await lastBackupRun();
    runIds.push(run!.id);
    expect(run).toMatchObject({ ok: true, objectKey: uploaded[0].key, error: null });
    expect((run!.tables as Record<string, number>).Subscriber).toBeGreaterThanOrEqual(0);
  });

  it('records a FAILED run and rethrows, so a broken backup is not silent', async () => {
    await expect(
      runBackup({
        now: new Date('2026-09-08T08:00:00Z'),
        upload: async () => {
          throw new Error('R2 PUT failed: 403 InvalidAccessKeyId');
        },
      }),
    ).rejects.toThrow('InvalidAccessKeyId');

    const run = await lastBackupRun();
    runIds.push(run!.id);
    expect(run!.ok).toBe(false);
    expect(run!.objectKey).toBeNull();
    expect(run!.error).toContain('InvalidAccessKeyId');
  });

  it('honours record:false so a manual dump does not pose as the scheduled copy', async () => {
    const before = await lastBackupRun();
    await runBackup({ now: new Date('2026-09-08T09:00:00Z'), upload: async () => {}, record: false });
    const after = await lastBackupRun();
    expect(after?.id).toBe(before?.id);
  });
});

describe('pruneOldBackups', () => {
  const cfg: R2Config = { accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' };
  const now = new Date('2026-09-08T00:00:00Z');

  it('deletes only objects older than the window, and leaves foreign keys alone', async () => {
    const listed = [
      'taxscan-push/2026/2026-01-01T02-00-00Z.ndjson.gz', // old -> delete
      'taxscan-push/2026/2026-09-01T02-00-00Z.ndjson.gz', // recent -> keep
      'taxscan-push/notes/handwritten.txt', // no date -> never touch
    ];
    const deleted: string[] = [];
    jest.resetModules();
    const r2 = await import('../lib/r2');
    const listSpy = jest.spyOn(r2, 'listObjects').mockResolvedValue(listed);
    const delSpy = jest.spyOn(r2, 'deleteObject').mockImplementation(async (_c, k) => void deleted.push(k));

    // Re-import so the service picks up the mocked module bindings.
    const { pruneOldBackups: prune } = await import('../services/backup');
    const n = await prune(cfg, 'taxscan-push', 30, now);

    expect(n).toBe(1);
    expect(deleted).toEqual(['taxscan-push/2026/2026-01-01T02-00-00Z.ndjson.gz']);
    listSpy.mockRestore();
    delSpy.mockRestore();
  });

  it('is a no-op when retention is disabled', async () => {
    await expect(pruneOldBackups(cfg, 'taxscan-push', 0, now)).resolves.toBe(0);
  });
});
