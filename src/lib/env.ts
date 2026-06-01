import dotenv from 'dotenv';

dotenv.config();

const parsedPort = Number(process.env.PORT);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const env = {
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  allowedOrigins,
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? '',
  },
};
