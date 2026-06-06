import request from 'supertest';
import { createApp } from '../app';

// Pin rate limits high so the bursty test runner can't trip them.
const app = createApp({
  rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
});

describe('Asset delivery headers', () => {
  describe('GET /taxscan-push.js', () => {
    it('returns 200 with a JavaScript Content-Type', async () => {
      const res = await request(app).get('/taxscan-push.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/javascript/);
    });

    it('caches at the browser for 5 min with a 24 h stale-while-revalidate window', async () => {
      const res = await request(app).get('/taxscan-push.js');
      expect(res.status).toBe(200);
      const cc = res.headers['cache-control'] ?? '';
      expect(cc).toMatch(/max-age=300/);
      expect(cc).toMatch(/stale-while-revalidate=86400/);
    });

    // The cutover-blocker test. helmet defaults this to same-origin, which
    // makes the browser drop the response with ERR_BLOCKED_BY_RESPONSE
    // .NotSameOrigin when Hocalwire's loader injects the script tag into
    // taxscan.in. If anyone reverts this back to same-origin, the iZooto
    // cutover breaks for every visitor — this assertion is the guard rail.
    it('is loadable cross-origin (CORP: cross-origin, not helmet default)', async () => {
      const res = await request(app).get('/taxscan-push.js');
      expect(res.status).toBe(200);
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });
  });

  describe('GET /sw.js', () => {
    it('returns 200 with a JavaScript Content-Type', async () => {
      const res = await request(app).get('/sw.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/javascript/);
    });

    // This is the load-bearing assertion. A service worker that ships with a
    // positive max-age is the documented footgun: a stale SW outlives a fix
    // and keeps running in every registration in its scope. If someone later
    // changes /sw.js to anything other than `no-cache`, this test must fail.
    it('is no-cache (never long-cached — service-worker footgun guard)', async () => {
      const res = await request(app).get('/sw.js');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('is loadable cross-origin (CORP: cross-origin, not helmet default)', async () => {
      const res = await request(app).get('/sw.js');
      expect(res.status).toBe(200);
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });
  });

  describe('GET /healthz', () => {
    it('returns 200 with Cache-Control: no-store', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
