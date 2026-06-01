import { createApp } from './app';
import { env } from './lib/env';
import { startPoller } from './services/poller';

const app = createApp();

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`taxscan-push listening on http://localhost:${env.port}`);
  startPoller();
});
