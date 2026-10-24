import { isIP } from 'node:net';

/**
 * IP literals in ONE canonical form, so an allow-list entry and a request address compare equal
 * however either was written (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.1, §8):
 *  - IPv4: as is (Node's `isIP` already refuses leading zeros and out-of-range octets);
 *  - IPv6: lower-case, RFC 5952 compressed (via the WHATWG URL host serialiser), so
 *    `2001:DB8:0:0::1` and `2001:db8::1` are the same entry;
 *  - an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, `::ffff:0102:0304`, as Node reports some IPv4
 *    peers) → its IPv4 form.
 * Anything else — a range, a zone id (`fe80::1%en0`), a host name, brackets, a port — is `null`,
 * and a caller treats `null` as "not allowed" (fail closed).
 */
export function canonicalIp(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind !== 6 || s.includes('%')) return null;
  let host: string;
  try {
    host = new URL(`http://[${s}]/`).hostname; // "[…]", compressed + lower-case
  } catch {
    return null;
  }
  const v6 = host.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return isIP(v6) === 6 ? v6 : null;
}
