import cors, { type CorsOptions } from 'cors';
import { env } from './env';

const options: CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (env.allowedOrigins.length === 0) return cb(null, true);
    if (env.allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 86400,
};

export const corsMiddleware = cors(options);
