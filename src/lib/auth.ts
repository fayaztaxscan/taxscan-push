import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from './env';

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !env.adminToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(env.adminToken);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
