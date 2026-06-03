import dotenv from 'dotenv';

dotenv.config();

if (!process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = 'test-admin-token';
}
if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = 'test-admin-pw';
}
