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
import { startGaReadsSync } from './services/gaReads';
import { startReadsReportCron } from './services/readsReport';
import { startSearchSurfacesSync } from './services/searchSurfaces';
import { startAuditRetentionSweeper } from './sweepers/auditRetention';
import { startEventRetentionSweeper } from './sweepers/eventRetention';
import { startBackupCron } from './services/backup';
import { startMetricsWarmer } from './services/metrics';
import { startDigestScheduler } from './services/digest/scheduler';
import { createMockDigestSender } from './services/digest/mockSender';
import { mockSendersEnabled } from './lib/mockSenderGuard';
import type { Sender } from './services/send';

// When E2E_MOCK_SENDER=true, swap web-push for an in-memory success sender so
// the Playwright spec can exercise the real dispatch path without touching FCM.
// Refused in production (push and digest would both be faked): log and exit.
let useMocks = false;
try {
  useMocks = mockSendersEnabled(process.env);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const mockSender: Sender | undefined = useMocks ? async () => ({ ok: true, statusCode: 201 }) : undefined;

// The same switch gives the digest routes an in-memory Mailercloud stand-in
// (no network, nobody mailed), so Send now / Retry now / Test send can be
// exercised locally. Never set in production.
const app = createApp({
  sender: mockSender,
  ...(mockSender ? { digest: { sender: createMockDigestSender() } } : {}),
});

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
  startGaReadsSync();
  startReadsReportCron();
  startSearchSurfacesSync();
  startAuditRetentionSweeper();
  startEventRetentionSweeper();
  startBackupCron();
  startMetricsWarmer();
  startDigestScheduler();
});
