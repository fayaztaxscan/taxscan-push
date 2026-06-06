/**
 * Centralised password policy — shared by the create-admin CLI, the user
 * management API (POST /api/users + reset), and the change-password
 * endpoint, so all entry points enforce the same rules.
 */

import { randomBytes } from 'crypto';

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Returns null if the password satisfies policy; a human-readable reason
 * otherwise. Reasons are surfaced verbatim in API error responses + CLI
 * stderr, so they should be clear without leaking sensitive context.
 */
export function passwordIssue(p: string): string | null {
  if (p.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!/[a-z]/.test(p)) return 'password must contain a lowercase letter';
  if (!/[A-Z]/.test(p)) return 'password must contain an uppercase letter';
  if (!/[0-9]/.test(p)) return 'password must contain a digit';
  return null;
}

const TEMP_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const TEMP_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TEMP_DIGIT = '23456789';
const TEMP_SYMBOL = '!@#$%^&*';
const TEMP_ALL = TEMP_LOWER + TEMP_UPPER + TEMP_DIGIT + TEMP_SYMBOL;

/**
 * Generates a 16-character temporary password for `POST /api/users/:id/reset-password`.
 * Guarantees at least one of each character class so the result always
 * passes `passwordIssue`. Visually ambiguous chars (0/O, 1/l/I) are
 * excluded from the alphabet to reduce read-off-screen errors.
 */
export function generateTemporaryPassword(length = 16): string {
  if (length < 4) {
    throw new Error('temporary password length must be at least 4 to include all required classes');
  }
  // Pick exactly one from each class first.
  const guaranteed = [
    TEMP_LOWER[randomInt(TEMP_LOWER.length)],
    TEMP_UPPER[randomInt(TEMP_UPPER.length)],
    TEMP_DIGIT[randomInt(TEMP_DIGIT.length)],
    TEMP_SYMBOL[randomInt(TEMP_SYMBOL.length)],
  ];
  // Fill the rest from the full alphabet.
  const rest: string[] = [];
  for (let i = 0; i < length - guaranteed.length; i++) {
    rest.push(TEMP_ALL[randomInt(TEMP_ALL.length)]);
  }
  // Fisher-Yates shuffle so the guaranteed chars aren't always at the front.
  const chars = [...guaranteed, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  // 4 bytes is plenty for the small alphabets we use; rejection-sample to
  // avoid modulo bias.
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < limit) return n % maxExclusive;
  }
}
