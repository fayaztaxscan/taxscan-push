import { defineConfig } from '@playwright/test';

// Each E2E run boots the backend with a mock sender + the Vite dev server.
// The mock-sender flag is what makes the dispatch path succeed without touching
// real push services; tests that need a "delivered" outcome use it. The spec
// itself seeds an ADMIN User row via Prisma (Phase 5+) and logs in through the
// new email + password flow.
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-token';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5173',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev',
      cwd: '..',
      url: 'http://localhost:3000/healthz',
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ADMIN_TOKEN,
        E2E_MOCK_SENDER: 'true',
        RSS_ENABLED: 'false',
        SWEEPER_ENABLED: 'false',
        AUDIT_LOG_SWEEPER_ENABLED: 'false',
        NODE_ENV: 'development',
      },
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
