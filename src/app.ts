import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { corsMiddleware } from './lib/cors';
import { healthRouter } from './routes/health';
import { createApiRouter } from './routes/api';
import type { Sender } from './services/send';

export type CreateAppOptions = { sender?: Sender };

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();

  app.use(corsMiddleware);
  app.use(express.json({ limit: '64kb' }));

  app.use(healthRouter);
  app.use('/api', createApiRouter({ sender: opts.sender }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('unhandled error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
