// IMPORTANT: env import runs dotenv.config() as a side effect — must happen
// before the startup check so .env values are loaded into process.env first.
import { env } from './lib/env';
import { assertRequiredEnv } from './lib/startupCheck';

// Fail-fast if any required deploy var is unset. Exits non-zero so Railway
// (or any orchestrator) marks the deploy as failed instead of routing traffic.
assertRequiredEnv();

import { createApp } from './app';
import { startPoller } from './services/poller';
import { startSweeper } from './services/sweeper';
import { startPacer } from './services/pacer';
import { startReportScheduler } from './services/reportScheduler';
import { startReconciler, startRetention } from './services/reconciler';
import { startAuditRetentionSweeper } from './sweepers/auditRetention';
import type { Sender } from './services/send';

// When E2E_MOCK_SENDER=true, swap web-push for an in-memory success sender so
// the Playwright spec can exercise the real dispatch path without touching FCM.
const mockSender: Sender | undefined =
  process.env.E2E_MOCK_SENDER === 'true'
    ? async () => ({ ok: true, statusCode: 201 })
    : undefined;

const app = createApp({ sender: mockSender });

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `taxscan-push listening on http://localhost:${env.port}${mockSender ? ' [MOCK SENDER]' : ''}`,
  );
  startPoller();
  startSweeper();
  startPacer();
  startReportScheduler();
  startReconciler();
  startRetention();
  startAuditRetentionSweeper();
});
