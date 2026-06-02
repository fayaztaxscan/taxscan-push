import { createApp } from './app';
import { env } from './lib/env';
import { startPoller } from './services/poller';
import { startSweeper } from './services/sweeper';
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
});
