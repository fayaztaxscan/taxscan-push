import dotenv from 'dotenv';

dotenv.config();

if (!process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = 'test-admin-token';
}
if (!process.env.SESSION_COOKIE_SECRET) {
  process.env.SESSION_COOKIE_SECRET =
    'test-session-cookie-secret-must-be-at-least-32-chars-long';
}
