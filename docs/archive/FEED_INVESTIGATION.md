# Feed Investigation — taxscan.in per-section feeds

**Date / browser:** 2026-06-02 · investigated via `web_fetch` (read-only; no login, no form submission).

## Summary verdict

**Per-section feeds EXIST.** All four section-feed URLs of the form `https://www.taxscan.in/<section>/feed` returned valid RSS 2.0 with per-item `<category>` tags that name the section. This is the best-case outcome — no vendor change is needed; the poller can switch to one source per topic and auto-tag.

## Results table

| URL | Type (feed/html/404/redirect) | #items | Has category field? | Notes / first item title |
|-----|-------------------------------|--------|---------------------|--------------------------|
| `https://www.taxscan.in/corporate-laws/feed` | **feed (RSS 2.0, `Content-Type: text/xml`)** | 2 in snapshot | **yes** — `<category><![CDATA[Corporate Laws,Top Stories]]></category>` on each item | *"Limitation against Corporate Guarantor Commences from Invocation of Guarantee, Not NPA Classification: NCLT Admits Insolvency Petition [Read Order]"* — link: `https://www.taxscan.in/top-stories/limitation-against-corporate-guarantor...-1446695` |
| `https://www.taxscan.in/corporate-laws/rss` | empty body (effectively no feed) | — | — | URL pattern not used by this site; only `/feed` works |
| `https://www.taxscan.in/corporate-laws.xml` | empty body (effectively no feed) | — | — | URL pattern not used by this site |
| `https://www.taxscan.in/cst-vat-gst/feed` | **feed (RSS 2.0)** | 5 in snapshot | **yes** — `<category><![CDATA[CST & VAT / GST,Top Stories]]></category>` on each item | *"'Filing GST Appeal using ITC for Pre-Deposit Cannot Make Advocate a Conspirator': Advocate Opens up after Allahabad HC Quashes FIR"* — link: `https://www.taxscan.in/top-stories/filing-gst-appeal-using-itc-for-pre-deposit...-1446743` |
| `https://www.taxscan.in/income-tax/feed` | **feed (RSS 2.0)** | ≥ several (response truncated due to size) | **yes** — `<category><![CDATA[Income Tax,Top Stories]]></category>` on each item | *"Income Tax Assessment Order Signed Within Time but Communicated After Statutory Deadline Held Time-Barred: ITAT [Read Order]"* — link: `https://www.taxscan.in/top-stories/income-tax-assessment-order-signed-within-time...-1446746` |
| `https://www.taxscan.in/excise-customs/feed` | **feed (RSS 2.0)** | ≥ several (response truncated due to size) | **yes** — `<category><![CDATA[Excise & Customs,Top Stories]]></category>` on each item | *"Third-Party Exports Valid for EPCG Obligation Discharge Under Earlier FTP Regime: CESTAT [Read Order]"* — link: `https://www.taxscan.in/top-stories/third-party-exports-valid-for-epcg-obligation...-1446744` |
| `https://www.taxscan.in/feed` | **could not retrieve body** (web_fetch returned an empty body on two attempts; the site’s own footer on `/corporate-laws` advertises this URL, so it is intended to exist) | unknown | unknown | See main-feed section below — could not directly inspect items |
| `https://www.taxscan.in/feeds` | empty body / does not appear to be served | — | — | No directory-style feed index |
| `https://www.taxscan.in/sitemap.xml` | empty body / no response | — | — | Standard sitemap at the root path could not be retrieved; not investigated further per the brief |

All four section feeds share the same XML structure: standard RSS 2.0 with `xmlns:atom`, `xmlns:content`, `xmlns:dc` namespaces; `<channel>` metadata block; an `<atom:link rel="self">` pointing at `https://www.taxscan.in/category/<section>/google_feeds.xml`; each `<item>` carrying `<link>`, `<title>` (CDATA), `<description>`, `<enclosure>` (webp image), `<content:encoded>` (HTML body), `<guid isPermaLink="true">`, **`<category>` (the per-item section + "Top Stories" combined as a single CDATA string)**, `<dc:creator>`, `<pubDate>`.

## Main feed (`/feed`) item inspection

**I was unable to retrieve the body of `https://www.taxscan.in/feed`.** Both `web_fetch` attempts returned an empty body (no error code, no Content-Type, no redirect — just an empty response), and the sandbox's raw `curl` is blocked by an outbound allowlist (`X-Proxy-Error: blocked-by-allowlist`), so I could not verify the main feed's contents directly. Two observations that still bear on the question:

- The site **does** advertise this URL — the `/corporate-laws` HTML page's footer links to `https://www.taxscan.in/feed`. So it's the documented main feed URL, and the project's own `src/lib/env.ts` defaults `RSS_FEED_URL` to it, implying the existing poller has been hitting it successfully.
- Each per-section feed's `<atom:link rel="self">` points at a *different* internal URL (e.g. `https://www.taxscan.in/category/corporate-laws/google_feeds.xml`), and per-section item `<link>` URLs predominantly use the `/top-stories/` prefix. So the section identity is encoded in the feed source itself (the URL you fetch), not reliably in the article URL path.

Practically: even though I couldn't directly verify `<category>` presence on the main `/feed`, the per-section pattern (which **does** carry `<category>`) is the better tagging surface either way. **Recommend ignoring `/feed` for per-topic tagging and using the per-section feeds.**

## `<head>` rel=alternate feed link found on `/corporate-laws`?

**Unable to confirm.** The HTML response for `https://www.taxscan.in/corporate-laws` was returned by `web_fetch` in a normalised/Markdown form that stripped non-standard `<link>` tags, so I could not see whether a `<link rel="alternate" type="application/rss+xml" href="…">` exists in `<head>`. What I could observe: the page's **footer** does include a plain anchor to `https://www.taxscan.in/feed` (so the main feed URL is at least discoverable on-page), but no per-section feed URL appeared in the rendered text.

This doesn't change the verdict — `/corporate-laws/feed` works regardless of whether it's announced via rel=alternate.

## Recommended path

Switch each topic in your poller to its own per-section feed and tag every item from that source with the corresponding topic. Concretely:

| Topic | Feed source |
|---|---|
| Corporate | `https://www.taxscan.in/corporate-laws/feed` |
| GST | `https://www.taxscan.in/cst-vat-gst/feed` |
| Income Tax | `https://www.taxscan.in/income-tax/feed` |
| Customs / Excise | `https://www.taxscan.in/excise-customs/feed` |

You'd presumably also want to test `/service-tax/feed`, `/other-taxations/feed`, `/top-stories/feed`, `/news-updates/feed`, and `/columns/feed` on the same pattern before flipping all topics over (they're all section paths visible in the site navigation), but the four sampled here strongly suggest the pattern holds across every category page.

Each item already carries a `<category>` containing the section name (e.g. `Corporate Laws,Top Stories`), so if you'd rather **keep a single poller** and tag from the field, your existing `CATEGORY_TO_TOPIC` map just needs to handle these exact strings:

| `<category>` value | Topic to tag |
|---|---|
| `Corporate Laws,Top Stories` (and/or `Corporate Laws`) | Corporate |
| `CST & VAT / GST,Top Stories` | GST |
| `Income Tax,Top Stories` | Income Tax |
| `Excise & Customs,Top Stories` | Customs / Excise |

But **per-section polling is the cleaner option** — it removes the need to parse a combined category string, the source URL itself encodes the topic, and you can poll different sections at different cadences if traffic warrants. No vendor request is needed.
