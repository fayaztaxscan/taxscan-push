# REPORT: 2026-10-29-digest-lookalike

- **Branch:** `build/digest-lookalike` (base `origin/develop` at `6111d3b`)
- **Code commit:** `0259480840e2723d49f9e55306dce2470b9178b1`
- **Result:** all 7 acceptance items PASS. Three things for planning: a placeholder was used for the image ads in the visual check; the old newsletter's exact 12 stories were not available, so real current taxscan stories were used; the guide was not touched (below).

## Files changed

- `prisma/schema.prisma` + `prisma/migrations/20261029075627_digest_item_image_url/`: `DigestItem.imageUrl TEXT` (nullable, **additive**). Needed because frozen items are table rows, not JSON.
- `src/services/digest/articleImage.ts` (**new**): `isAllowedArticleImage` (exactly `https://documents.taxscan.in/…​.jpg|.jpeg|.png`, no port/userinfo), `parseOgImage`, `fetchArticleImage` / `fetchArticleImages` (https article pages on the push allowlist only, `redirect: 'error'`, ≤ 4 at a time, 5 s per page, 30 s for the whole step; never throws, never logs a URL).
- `src/services/digest/builder.ts`: `FrozenItem.imageUrl?`; `selectDigest` runs the picture step once per distinct page (new `SelectDeps.articleImages`, default = the real fetch, **but a no-op under `NODE_ENV=test`** so no test touches the network); `attachImages` (exported for tests) is fail-open; rolled-forward ICYMI items keep their picture; `writeDigestItems` writes `imageUrl`.
- `src/services/digest/runner.ts`, `src/routes/digestTemplates.ts`: carry `imageUrl` when frozen rows are read back (the pending-render path, and the Templates preview's "recent stories").
- `src/services/digest/renderer.ts`: no label above a headline; two-column story row when there is a picture; image ad = banner only; the optional `{{social}}` row; `SOCIAL_LINKS` / `isSocialUrl`; `isAllowedTemplateImage` now also accepts exactly a story picture; a template's own links may include the five social URLs (left as written, no UTM).
- `src/services/digest/templates.ts`: the checklist's links check lets exactly the five social URLs through; the worst-case fixture now has a picture on every item.
- `public/email/social-{facebook,x,instagram,linkedin,website}.png`: 56×56 (shown at 28), 457–608 bytes each, white glyph on the brand-colour circle (legible on white **and** on the dark-mode card).
- Tests: `digestLookalike.test.ts` (**new**, 30 tests); `digestRenderer`, `digestAds`, `digestTemplates` tests updated for the new look (see Deviations).

## Migrations / flags / env

One additive migration (above). **No flag** (the brief says none), no env, no new dependency.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npm run lint`: the three known errors only (`audienceConfig.test.ts 226:34`; `digestRenderer.test.ts 514:19`, `514:23` — line moved by one because I added a line above it; it is the same existing irregular-whitespace test data).
- `src/__tests__/digestLookalike`: `Tests: 30 passed, 30 total`.
- **Full suite (`--maxWorkers=1`):** `Test Suites: 72 passed, 72 total` · `Tests: 1433 passed, 1433 total` (1,402 on this base + 31 net; the machine is still loaded, so single worker as in the last REPORT).

## Acceptance tests

1. **PASS.** A story with `imageUrl` renders the two-column row: `<img class="ts-pic" src=<original documents.taxscan.in url> width="240">`, alt = the (escaped) headline, the picture linked to the same href as the headline, an Outlook ghost table (`width=240` / `312`), and an inline-block fluid layout that stacks without a media query. A story without one is the plain single column. Nine bad URLs (other host, http, `.webp`, the `/_img` resizer host, a port, userinfo, a look-alike host, `.gif`, `javascript:`) all render text-only. The template image allowlist gained exactly that host/extension rule and nothing broader.
2. **PASS** (fakes only). A 404, a 500, a page with no og:image, a redirect (fetch rejects under `redirect:'error'`), a network error, an http article URL, a host not allowed, an og:image on another host, the WebP resizer, a non-https og:image, a body that throws, a page slower than its timeout and the whole step slower than the cap all give `null`; the step returns at the cap (tested with an 80 ms cap), a page that answers after the cap does not count, never more than 4 pages at once, and `attachImages` swallows a throwing fetcher. The freeze writes and reads `imageUrl`.
3. **PASS.** No category or authority label above a headline (with or without a picture). An ad with an image is one linked image with its alt text (no "From Taxscan", headline, body or button); an ad without one keeps the label, headline, body and button. The plain-text part still names the offer.
4. **PASS.** The social row has exactly the five links (Facebook, X, Instagram, LinkedIn, website), each an icon with alt text, 28 px, centred, above the footer, no UTM. The footer's unsubscribe, postal address and reply line are unchanged, and there is no "noreply". Any other social URL in a template is still refused by the checklist; the built-in still passes it. Without an asset host there is no icon row (no broken pictures).
5. **PASS.** Worst case (12 stories, every one with a long picture URL, three image ads, social row), with the 90 KB-limit tracking allowance:
   - Free: html 64,796 B, **budget 71,696 B**; Premium: html 65,234 B, **budget 72,134 B** — both under the 75 KB (76,800 B) warning and the 90 KB (92,160 B) limit.
   - A typical day (12 short stories with pictures, 3 image ads): html 48,550 B, budget 55,450 B.
   - Before this change the same worst case without pictures was ~50.3 KB budget. (Pictures add only their URLs, not their weight.)
6. **PASS**, with the caveats below. In real Chrome, one browser: the built-in template rendered with **12 real stories from taxscan's public feed with their real og:image pictures** (the live fetch found 12 of 12), three ads, at 600 px and 375 px, light and dark. Files (untracked, in the worktree):
   - `/Users/bestdoc/Documents/taxscan-push-worktrees/digest-lookalike/visual-check/free-light-600-top.jpg`
   - `…/visual-check/free-light-600-bottom-social-footer.jpg`
   - `…/visual-check/free-light-375-top.jpg` (picture full width above the text)
   - `…/visual-check/free-light-375-bottom-ads-social-footer.jpg`
   - `…/visual-check/free-dark-600-top.jpg`
   - `…/visual-check/free-dark-375-bottom-ads-social-footer.jpg`
   - the four rendered pages: `…/visual-check/{free,premium}-{light,dark}.html`
   - Reference: `~/Downloads/Digest-old-newsletter.png`; before: `~/Downloads/Digest-builtin-now.png`.
   Caveats: (a) the **image ads use a placeholder banner** I generated (the owner's real ones are not in the repo), served from a local scratch server; (b) the stories are **today's real ones, not the 12 used for `Digest-builtin-now.png`** (I did not have that data); (c) light and dark were made by forcing the template's dark-mode CSS off or on in a copy, because this Chrome follows the system (dark) setting; (d) Outlook's ghost table is **not** visually tested (no Outlook here).
7. **PASS** (tsc; lint with no new errors; full suite).

## Agents run

None.

## Deviations from the brief

1. **Existing tests changed because the look changed on purpose:** the label assertions in `digestRenderer.test.ts` (two tests), the ad-markup test in `digestAds.test.ts` (split into "with picture" and "without picture"), and the size test in `digestTemplates.test.ts` ("near the limit" padding re-sized from 30 KB to 12 KB: the built-in worst case is now ~72 KB, so the old padding went over 90 KB).
2. **The social icons row is a new optional placeholder `{{social}}`**, not part of `{{footer}}`, so saved templates are unchanged (they do not get the row unless an editor adds it). The built-in has it. It is listed under Templates → placeholders automatically.
3. **The guide was not edited.** The brief allows one sentence in §9/§10 "if you change the wording" and says to bump the version; the guide is being changed on `build/guide-pdf-builtin-preview` (v2.5), so touching it here would conflict. Planning can add the sentence after that merges.
4. I added a second CSS rule for phones (`.ts-pic{max-width:100%}`): after a first visual pass the picture stayed 240 px wide when stacked on a phone. It is an enhancement only (stacking itself needs no media query).

## Worth remembering

- `defaultArticleImages` returns "no pictures" when `NODE_ENV === 'test'`, so existing builder tests never hit the network; any new test of the real fetch must pass `fetchFn`.
- A saved (non-built-in) template renders stories with the **same** `itemRow` (it is the renderer's own markup), so saved templates also lose the label and gain pictures. Only the social row is opt-in.
- The picture is the article's **original** `og:image`, ~100 KB at 1200 px; it is drawn at 240 px wide, so a phone downloads the full file. If weight matters later, a pre-sized thumbnail would need a source other than the WebP-only `/_img`.
- A story whose page had no usable image on the build day stays text-only for that digest; a rolled-forward ICYMI item with no picture is tried again at the next build.
- `Digest-builtin-now.png` shows **no logo** because it was rendered without an asset host; the real build always has one.
- Plain-text part still prints a story's authority/category line (the owner's request was about the HTML labels). Easy to drop if wanted.
- Build DB users from earlier briefs are not relevant here; no login was needed.

## Clean-up

```sh
git worktree remove --force ../taxscan-push-worktrees/digest-lookalike   # --force: untracked scratch/ and visual-check/ live there
dropdb taxscan_push_build_digest-lookalike; dropdb taxscan_push_build_digest-lookalike_shadow
git branch -D build/digest-lookalike; git push origin --delete build/digest-lookalike
```
