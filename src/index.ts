import express from 'express';
import { env } from './lib/env';
import { healthRouter } from './routes/health';

const app = express();

app.use(express.json());

app.use(healthRouter);

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`taxscan-push listening on http://localhost:${env.port}`);
});
