import request from 'supertest';
import { createApp } from '../app';
import { validKeys } from './helpers';

const TEST_PREFIX = 'https://test-security.example.com/sub/';

function makeSubscription(suffix: string) {
  return {
    endpoint: `${TEST_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    keys: validKeys(),
  };
}

describe('security: helmet', () => {
  const app = createApp();

  it('sets standard hardening headers', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['referrer-policy']).toBeDefined();
  });
});

describe('security: rate limiting', () => {
  it('returns 429 after the public per-minute cap is hit on /api/subscribe', async () => {
    // Pin a tiny per-IP cap for this app instance.
    const app = createApp({ rateLimit: { publicPerMin: 3 } });
    const responses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/subscribe')
        .send({ subscription: makeSubscription('rl-' + i), portal: 'test-sec' });
      responses.push(res.status);
    }
    const blocked = responses.filter((s) => s === 429);
    expect(blocked.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 429 after the login per-minute cap is hit on /api/auth/login', async () => {
    const app = createApp({ rateLimit: { loginPerMin: 2 } });
    const responses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'definitely-wrong' });
      responses.push(res.status);
    }
    expect(responses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });
});

describe('security: CORS not open when ALLOWED_ORIGINS is set', () => {
  // The env was read at module load; this test directly proves the rule by
  // poking at the cors lib config via a request with an Origin header.
  it('emits no Access-Control-Allow-Origin for a foreign origin when allowedOrigins is configured', async () => {
    process.env.ALLOWED_ORIGINS = 'https://www.taxscan.in';
    // Re-require app + env so the new env is picked up by a fresh CORS module.
    jest.resetModules();
    const { createApp: freshApp } = await import('../app');
    const app = freshApp();
    const res = await request(app)
      .get('/api/config')
      .set('Origin', 'https://evil.example.com');
    // CORS denial = response is still served (CORS is browser-enforced) but
    // the header is absent.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Reset so other suites aren't affected.
    delete process.env.ALLOWED_ORIGINS;
    jest.resetModules();
  });
});

describe('security: push URL allowlist', () => {
  it('rejects /api/send with a url outside ALLOWED_PUSH_HOSTS', async () => {
    const app = createApp({ rateLimit: { publicPerMin: 1000, loginPerMin: 1000 } });
    const res = await request(app)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({
        portal: 'taxscan',
        title: 'phishing',
        body: 'b',
        url: 'https://evil.example.com/track?u=…',
        target: { type: 'all' },
        breaking: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    const issue = (res.body.issues as { path: string[]; message: string }[]).find((i) =>
      i.path.includes('url'),
    );
    expect(issue).toBeDefined();
  });

  it('accepts /api/send with a url on www.taxscan.in', async () => {
    const app = createApp({ rateLimit: { publicPerMin: 1000, loginPerMin: 1000 } });
    const res = await request(app)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({
        portal: 'taxscan-allowlist',
        title: 'good',
        body: 'b',
        url: 'https://www.taxscan.in/article/1',
        target: { type: 'all' },
        breaking: true,
      });
    expect(res.status).toBe(200);
  });

  it.each([
    'https://academy.taxscan.in/course/live-webinar',
    'https://shop.taxscan.in/products/gst-handbook',
  ])('accepts /api/send with an academy/shop url (%s)', async (url) => {
    const app = createApp({ rateLimit: { publicPerMin: 1000, loginPerMin: 1000 } });
    const res = await request(app)
      .post('/api/send')
      .set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)
      .send({ portal: 'taxscan-allowlist', title: 'promo', body: 'b', url, target: { type: 'all' }, breaking: true });
    expect(res.status).toBe(200);
  });
});
