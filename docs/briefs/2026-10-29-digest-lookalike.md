# Brief: Built-in digest template looks like the old Mailercloud newsletter

- **Date / name:** 2026-10-29-digest-lookalike → branch `build/digest-lookalike`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
The built-in digest template looks as close as practical to taxscan's current hand-made Mailercloud newsletter,
while keeping every rule the new digest adds (one-click unsubscribe, postal address, alt text, size cap, no
"noreply", correct date).

## Why (owner's words)
> 2026-10-23: the new digest stays close to the current template, plus the new logo.
> 2026-10-29: "I want the template as similar as to one shared by me." Then, to the five recommendations below: "Yes to recommendations".

Reference pictures (from planning, in the owner's Downloads):
- `~/Downloads/Digest-old-newsletter.png`: the old newsletter, rendered from the owner's `.eml`.
- `~/Downloads/Digest-builtin-now.png`: our built-in template today, rendered with the same stories and ads, but
  without the logo, which the real build does add.

## Scope (the five decisions)
1. **Article picture beside each story.** The old one has a picture on the left and the text on the right.
   - taxscan's RSS carries **no** images, but every article page has `og:image` (verified 29 Oct on
     `https://www.taxscan.in/gst/central-govt-releases-…`: `https://documents.taxscan.in/cms/media/<slug>-<id>.jpg`).
   - At **build time** (the 06:30 build, when items are frozen), fetch each frozen item's article page and read
     `og:image`, plain `fetch`: https only, `redirect: 'error'`, ≤ 4 at a time, 5 s each, and the whole step capped at
     30 s.
   - Store the URL on the frozen item, e.g. `imageUrl?: string | null`. If frozen items live in a JSON column, add
     the optional field without a migration. If a column is needed, add an additive migration.
   - **Fail-open:** no image, a timeout, a non-2xx, or a host not allowed → that story renders text-only, exactly
     as today. The build never fails or waits longer because of a picture.
   - **Use the original `og:image` JPEG/PNG URL** (`documents.taxscan.in`, ~100 KB at 1200 px). **Do not** use
     taxscan's `/_img` resizer: planning checked on 29 Oct and it **always returns WebP** (whatever the `Accept`
     header or format parameter), which Outlook for Windows and some other clients can't show. Picture weight
     doesn't count toward Gmail's ~102 KB clip, which is HTML only. Set `width` explicitly so the picture displays
     at ≈ 240 px. Accept only a `documents.taxscan.in` https URL ending `.jpg`, `.jpeg` or `.png`; anything else →
     text-only. Extend the image allowlist (`isAllowedTemplateImage`) to exactly that host; never add a general
     allowance.
   - **Layout:** desktop is a two-column row, picture ≈ 40% on the left and title, summary and "Read more" on the
     right, like the old one. Phones (≤ 480 px) stack the picture above the text. It must work without media
     queries (fluid/hybrid technique) and in Outlook (MSO conditional fallback). Alt text = the headline.
   - The build-time fetch is the only place a reader-visible URL comes from the article page. Don't follow the
     image URL at build time; just store it.
2. **Header:** keep the designer's white logo image (`/email/taxscan-logo-white-440.png`, already used when
   `assetBaseUrl` is set) on the dark header. Keep the date line. No code change is expected; confirm it in the
   rendered preview.
3. **Remove the small labels above each headline** (the "ITAT" / "KARNATAKA HIGH COURT" line).
4. **Ads look like the old ones:**
   - An ad **with an image** = the banner only, full width, the whole image linked, alt text = the ad's alt text.
     No "FROM TAXSCAN" label, no headline, no button.
   - An ad **without an image** keeps today's headline + button.
5. **Social icons row** above the footer, like the old one, centred, small (24–32 px), each with alt text:
   Facebook `https://www.facebook.com/taxscan/`, X `https://twitter.com/tax_scan`,
   Instagram `https://www.instagram.com/taxscan/`, LinkedIn
   `https://www.linkedin.com/company/tax-scan-9aa530129/`, website `https://www.taxscan.in/`.
   - Icons are small PNGs served from `public/email/`, the same origin as the logo. Monochrome, legible on white;
     produce simple ones (≤ 2 KB each).
   - These five links are **fixed footer links, not ad or story links**. Make sure the link checks
     (`ALLOWED_PUSH_HOSTS` / template link rules) permit exactly these five and nothing broader.
   - No UTM on social links.

**Out:**
- "View this email in your browser" (needs an unverified Mailercloud merge tag).
- Any change to the footer's required parts: unsubscribe, postal address, reply line.
- Saved (non-built-in) templates: they keep working. New placeholders, if any, are optional for them.
- Ranking, item count, subject and preheader.

## Acceptance tests
1. Unit: an item with `imageUrl` renders the two-column row with the picture (original URL, explicit width) and alt = headline; an
   item without one renders text-only; a disallowed image host renders text-only.
2. Unit: the og:image fetch is fail-open. Use fakes, no real network: a timeout, a 404, a page with no og:image, a
   redirect, an http URL and a slow page past the 30 s cap all give `imageUrl` null, and the build completes.
3. Unit: no authority label is rendered. An ad with an image renders the image link only; an ad without an image
   renders headline + button.
4. Unit: the social row has exactly the five links, each with alt text and no UTM. The allowlist still refuses any
   other social URL in a template.
5. Size: the worst-case fixture (max items, all pictures, three ads) stays under `DIGEST_HTML_WARN_KB` (75 KB).
   Paste the byte counts for the recent and worst cases.
6. **Visual, in a real browser:** render the built-in template with the same 12 stories and 3 ads used for
   `Digest-builtin-now.png`, plus pictures, at 600 px desktop and 375 px phone, light and dark. Save the screenshots
   in the worktree (untracked) and list their paths in the REPORT next to `~/Downloads/Digest-old-newsletter.png`.
   One browser at a time.
7. tsc, lint (no new errors), the full suite: green.

## Files
`src/services/digest/renderer.ts` (built-in template + item and ad markup), `src/services/digest/builder.ts` /
`content.ts` (freeze `imageUrl`; the fetch belongs in a small new module, e.g. `src/services/digest/articleImage.ts`),
the image/link allowlist helpers, `public/email/` (5 icons), tests. If you change the guide's §9/§10 wording about
how the digest looks, keep it to one sentence and bump the guide's version line.

## Constraints
- No flag: the digest is off in production and this is its look. No new dependency.
- Never log a reader-visible URL at error level with query values; use `safeErrorLog` (`src/lib/httpErrors.ts`).
- Don't touch `NEXT_STEP.md` / `CLAUDE.md`.
- If `2026-10-29-guide-pdf-builtin-preview` is merged first, use its Templates "Preview built-in" for the visual
  check. Otherwise render with a scratch script, as planning did.
