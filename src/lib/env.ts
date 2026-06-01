import dotenv from 'dotenv';

dotenv.config();

const parsedPort = Number(process.env.PORT);

export const env = {
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
  nodeEnv: process.env.NODE_ENV ?? 'development',
};
