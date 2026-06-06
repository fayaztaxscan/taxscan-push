import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/healthz', (_req, res) => {
  // no-store so an external uptime pinger always reaches the live worker.
  // The whole point of the pinger is to keep Railway warm; a cached 200
  // would defeat that.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});
