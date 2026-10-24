/**
 * CMS push-feed contract v1.3 (signing unchanged since v1.2) — signature test vectors (FAKE secret `test-secret`).
 *
 * Source: /Users/bestdoc/Documents/cms-platform/docs/design/push-feed-contract-v1.3-artefacts-2026-10-24.md
 * §8 (= their Appendix A.6; supersedes v1.1, whose POST vector 58e4dc92… is withdrawn), computed by the CMS on 2026-10-24 with Node createHmac and cross-checked
 * with `openssl dgst -sha256 -hmac test-secret`. Hex values copied verbatim; the signed strings are
 * the ones the CMS prints. Never use `test-secret` anywhere but tests.
 */
import { CMS_EVENT_BODIES } from './payloads';

export const TEST_SECRET = 'test-secret';

/** §8.1 — door W webhook POST: the v1.2 `account.created` body (345 bytes, with "erasure":false), signed string 390 bytes. */
export const WEBHOOK_POST = {
  ts: '1792640705',
  method: 'POST' as const,
  path: '/api/integrations/cms/events',
  eventId: 'evt_01JB0Z7Q3M4N5P6R7S8T9V0W1X',
  body: CMS_EVENT_BODIES['account.created_900001_seq1'],
  bodyBytes: 345,
  signedStringBytes: 390,
  signature: 'cec94bc31a9cf69b93b7a4866b594ed586ff84ac7edeeecfcdf13fa864104bab',
};

/** §8.2 — door L list GET, first page of a full pull (unchanged from v1.1). Signed string 91 bytes. */
export const LIST_GET_FULL = {
  ts: '1799613300',
  method: 'GET' as const,
  path: '/api/v1/push-feed/subscribers',
  params: { limit: '3', nonce: '3f9c2a7e5b1d4c8a9e0f6b2d7a1c5e93' },
  canonicalQuery: 'limit=3&nonce=3f9c2a7e5b1d4c8a9e0f6b2d7a1c5e93',
  signedString: '1799613300.GET./api/v1/push-feed/subscribers.limit=3&nonce=3f9c2a7e5b1d4c8a9e0f6b2d7a1c5e93',
  signedStringBytes: 91,
  signature: '4f5d3c77568bee1c136d157fcca46723290dfa951cd1fbabcfdb31d4e3edbaf1',
};

/** §8.3 — door L incremental GET (percent-encoding: `:` → %3A, `+` → %2B). Signed string 142 bytes. */
export const LIST_GET_INCREMENTAL = {
  ts: '1799699700',
  method: 'GET' as const,
  path: '/api/v1/push-feed/subscribers',
  params: { updated_since: '2027-01-11T02:05:00+05:30', limit: '1000', nonce: '8b04d1e6c3a95f72e1d0b4c7a6f38e25' },
  canonicalQuery: 'limit=1000&nonce=8b04d1e6c3a95f72e1d0b4c7a6f38e25&updated_since=2027-01-11T02%3A05%3A00%2B05%3A30',
  signedString:
    '1799699700.GET./api/v1/push-feed/subscribers.limit=1000&nonce=8b04d1e6c3a95f72e1d0b4c7a6f38e25&updated_since=2027-01-11T02%3A05%3A00%2B05%3A30',
  signedStringBytes: 142,
  signature: 'debee9a3894d95e1d18d2481a99692f5677029a9871a465880a1693d1be70d38',
};

/** §8.4 — small check vectors (raw signed string → hex). */
export const CHECK_VECTORS = [
  // v1 shape, kept by the CMS only as a sanity check of the HMAC call.
  { signedString: '1792640705.{}', signature: '4c8a36e7f661932c78d1c853f9e80f2f43599d38bc1fdff0d53d8ca285034999' },
  // Empty canonical query: the string ends in `.` (not a request door L accepts — nonce is required).
  {
    signedString: '1799613300.GET./api/v1/push-feed/subscribers.',
    signature: '5994b47b5c3f29e0b1a1d170e98f53c47971649fae501f5ce3c0c1704db1ee68',
  },
] as const;

/** v1.1's POST signature (body without "erasure"): WITHDRAWN by the CMS — must no longer verify against the v1.2 body. */
export const WITHDRAWN_V11_POST_SIGNATURE = '58e4dc92c9e5dd2a603a0bbc0134c291cbef00e0dc2d41658efea0d21b939a60';
