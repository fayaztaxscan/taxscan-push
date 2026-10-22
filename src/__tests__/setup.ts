import dotenv from 'dotenv';

dotenv.config();

// Jest must never send real email. The local .env can carry a live ElasticEmail
// key, and the default senders (invites, report emails, digest alerts — which
// advanceRun calls by default) would then mail the dev DB's real users. Tests
// that exercise email inject an in-memory EmailSender instead.
process.env.ELASTICEMAIL_API_KEY = '';

if (!process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = 'test-admin-token';
}
if (!process.env.SESSION_COOKIE_SECRET) {
  process.env.SESSION_COOKIE_SECRET =
    'test-session-cookie-secret-must-be-at-least-32-chars-long';
}
