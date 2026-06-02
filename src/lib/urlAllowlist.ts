import { env } from './env';

/**
 * Returns true when the push payload's click URL points at a host on the
 * configured allowlist. Used to stop a malformed or compromised payload from
 * redirecting subscribers off-site.
 *
 * When `ALLOWED_PUSH_HOSTS` is unset, defaults to taxscan.in + www.taxscan.in.
 * If an operator explicitly sets it to empty string they get permissive mode
 * (audited deliberately).
 */
export function isAllowedPushUrl(url: string): boolean {
  if (env.allowedPushHosts.length === 0) return true; // operator opted out
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return env.allowedPushHosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
