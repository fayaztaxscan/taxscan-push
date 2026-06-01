import { randomBytes } from 'crypto';

/**
 * Returns base64url-encoded keys that match the byte lengths the web-push spec
 * (and our /api/subscribe validator) require: p256dh = 65 bytes, auth = 16 bytes.
 * The bytes are random — they won't actually drive a successful push, but they
 * pass every length check and stop the cleanup script from flagging test rows.
 */
export function validKeys(): { p256dh: string; auth: string } {
  return {
    p256dh: randomBytes(65).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}
