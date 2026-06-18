import { prisma } from '../lib/prisma';
import { parseSitemap, expireStaleDrafts } from '../services/reconciler';

describe('parseSitemap', () => {
  it('extracts {title, link} from a news sitemap, decoding CDATA + entities', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://www.taxscan.in/top-stories/a-1</loc><news:news><news:title><![CDATA[Relief: ITAT & more]]></news:title></news:news></url>
      <url><loc>https://www.taxscan.in/top-stories/b-2</loc><news:news><news:title>Bombay HC quashes &amp; remands</news:title></news:news></url>
      <url><loc>https://www.taxscan.in/no-title-3</loc></url>
    </urlset>`;
    const out = parseSitemap(xml);
    expect(out).toHaveLength(2); // the third has no <news:title> → skipped
    expect(out[0]).toEqual({ link: 'https://www.taxscan.in/top-stories/a-1', title: 'Relief: ITAT & more' });
    expect(out[1].title).toBe('Bombay HC quashes & remands');
  });
});

describe('expireStaleDrafts', () => {
  it('archives DRAFTs older than N days; leaves recent DRAFTs and non-DRAFT alone', async () => {
    const portal = `test-retention-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const now = new Date('2026-06-20T00:00:00Z');
    const mk = (status: 'DRAFT' | 'SENT', at: string, suffix: string) =>
      prisma.campaign.create({
        data: { portal, title: suffix, body: '.', url: `https://taxscan.in/${suffix}`, target: { type: 'all' }, status, createdAt: new Date(at) },
      });
    const oldDraft = await mk('DRAFT', '2026-06-10T00:00:00Z', 'old'); // > 7d → expire
    const recentDraft = await mk('DRAFT', '2026-06-19T00:00:00Z', 'recent'); // within 7d → keep
    const oldSent = await mk('SENT', '2026-06-01T00:00:00Z', 'sent'); // not DRAFT → untouched
    const ids = [oldDraft.id, recentDraft.id, oldSent.id];
    try {
      const n = await expireStaleDrafts(now, 7, portal); // cutoff 2026-06-13
      expect(n).toBe(1);
      expect((await prisma.campaign.findUnique({ where: { id: oldDraft.id } }))?.status).toBe('EXPIRED');
      expect((await prisma.campaign.findUnique({ where: { id: recentDraft.id } }))?.status).toBe('DRAFT');
      expect((await prisma.campaign.findUnique({ where: { id: oldSent.id } }))?.status).toBe('SENT');
    } finally {
      await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it('does nothing when days is 0 (disabled)', async () => {
    expect(await expireStaleDrafts(new Date(), 0, 'whatever')).toBe(0);
  });
});
