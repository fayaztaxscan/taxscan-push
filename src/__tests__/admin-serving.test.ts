import path from 'path';
import request from 'supertest';
import { createApp } from '../app';

const adminDistDir = path.join(__dirname, 'fixtures', 'admin-dist');
const app = createApp({
  adminDistDir,
  // Pin rate limits high so the bursty test runner can't trip them.
  rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
});

describe('Admin SPA serving', () => {
  it('GET /admin/ returns the built index.html', async () => {
    const res = await request(app).get('/admin/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('fixture admin');
  });

  it('GET /admin/campaigns (a client-side route) falls through to index.html', async () => {
    const res = await request(app).get('/admin/campaigns');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('fixture admin');
  });

  it('GET /admin/login (another client-side route) also falls through', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('fixture admin');
  });

  it('GET /admin/no-such-asset.js returns 404, not the index.html', async () => {
    const res = await request(app).get('/admin/no-such-asset.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('fixture admin');
  });

  it('GET /healthz still works — /admin mount does not shadow other routes', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/config still works — /admin never shadows /api', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.vapidPublicKey).toBe('string');
  });
});
