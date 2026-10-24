import { BlockList, isIP } from 'node:net';
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from './cloudflareIps';

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

// ─── the CMS webhook fence: who is the client? ───────────────────────────────

const cloudflare = new BlockList();
for (const cidr of CLOUDFLARE_IPV4) {
  const [net, bits] = cidr.split('/');
  cloudflare.addSubnet(net, Number(bits), 'ipv4');
}
for (const cidr of CLOUDFLARE_IPV6) {
  const [net, bits] = cidr.split('/');
  cloudflare.addSubnet(net, Number(bits), 'ipv6');
}

/** True when the (canonical) address is inside Cloudflare's published edge ranges (src/lib/cloudflareIps.ts). */
export function isCloudflareIp(ip: string | undefined | null): boolean {
  const c = canonicalIp(ip);
  if (c === null) return false;
  return cloudflare.check(c, isIP(c) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The address the CMS webhook fence checks (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.1, §8.2).
 *
 * `peerIp` is `req.ip`: under `trust proxy 1` in production, the `X-Forwarded-For` entry Railway's
 * own proxy appended — the machine that actually connected to Railway. Two ways in:
 *  - via push.taxscan.in, Cloudflare connected: the peer is a Cloudflare edge, and only then is
 *    Cloudflare's `CF-Connecting-IP` (the real client) believed;
 *  - straight to the Railway origin (taxscan-push-production.up.railway.app also answers): the peer
 *    is the client itself, and a `CF-Connecting-IP` header it sent is IGNORED — anyone can forge it.
 * Returns the canonical client address, or null (missing / unparseable → the fence rejects).
 */
export function cmsClientIp(peerIp: string | undefined | null, cfConnectingIp: string | undefined | null): string | null {
  const peer = canonicalIp(peerIp);
  if (peer === null) return null;
  if (!isCloudflareIp(peer)) return peer;
  return canonicalIp(cfConnectingIp);
}
