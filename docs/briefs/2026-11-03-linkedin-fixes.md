# Brief: LinkedIn fixes — cover picture actually attaches; screen keeps its error after a refused Retry / Skip

- **Date / name:** 2026-11-03-linkedin-fixes  →  branch `build/linkedin-fixes`, base `origin/develop` (as it is now; independent of the Facebook build)
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). Part 1 → backend-developer; Part 2 → ui-developer.

## Goal
1. LinkedIn page posts carry the article's cover picture on the link card (today: none do).
2. On the LinkedIn screen, a refused Retry / Skip shows its reason instead of wiping it.

## Why (owner's words)
> 3 Nov 2026: "I also noticed linked posts are not showing the article images still … Both need to fixed".
> 3 Nov 2026: "yes" — to fixing the screen bug the Facebook build found.

**Evidence (planning, prod logs 3 Nov):** every post today logs
`[linkedin] page=taxscan … outcome=posted hashtags=cms image=none:status_400`. So the CMS cover is found, fetched and
uploaded (initializeUpload + PUT succeed), and then the **status poll** `GET https://api.linkedin.com/rest/images/<urn>`
answers **400** — the worker gives up on the picture and posts without it. Cause, almost certainly:
`src/services/linkedin/client.ts` `waitForImage` puts the URN **raw** in the path (`/rest/images/urn:li:image:…`); with
`X-Restli-Protocol-Version: 2.0.0` the key must be **URL-encoded** (`/rest/images/urn%3Ali%3Aimage%3A…`, i.e.
`encodeURIComponent(urn)`). Facebook is NOT affected (it reads og:image itself; planning checked `facebookexternalhit` gets
the og:image and the picture 200 image/jpeg, with our UTMs on the URL too).

## Scope
**In:**
- **Part 1 (backend):**
  a. `waitForImage`: `encodeURIComponent(r.urn)` in the path. Check every other place a URN goes into a URL path (images,
     posts) the same way.
  b. **Belt and braces:** if the status poll itself errors (`status_4xx` other than 401/403, or `status_network`) — as
     opposed to a real `PROCESSING_FAILED` — still attach the uploaded image and rely on the existing drop-and-repeat (#98:
     a post rejected because of the picture is repeated once without it). Log `image=ok:unverified` in that case.
     `processing_failed` and still-`processing` after the polls keep today's behaviour (post without the picture) — unless
     you find in LinkedIn's docs that attaching a PROCESSING image is accepted; then say so in the REPORT, don't change it.
  c. Update `docs/LINKEDIN_POSTING.md` (step 4 and the log-line list).
- **Part 2 (UI):** `admin/src/views/LinkedIn.vue` sets the error after a 409 and then calls `load()`, which clears it.
  Keep the error across that reload, the same way the Facebook screen does (`load(keepError)` in `admin/src/views/Facebook.vue` — read it with `git show origin/build/facebook-page-posting:admin/src/views/Facebook.vue`; it is not on develop yet); check every
  `await load()` on an error path (~lines 130–210).

**Out (do not build):**
- Re-posting today's picture-less posts (they stay as they are).
- Any Facebook change, any change to what posts / hashtags / UTMs.

## Acceptance tests
1. Unit: the status poll URL is `https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3A<id>` (encoded), headers unchanged.
2. Unit: poll answers 400 → the post goes out WITH the thumbnail, log `image=ok:unverified`; the post then rejected with a
   400 → repeated once without it, `image=dropped:400` (existing path). `PROCESSING_FAILED` → no thumbnail as today.
   401/403 from the poll → unchanged auth handling.
3. Existing LinkedIn tests pass (update the URL expectations, don't delete checks).
4. UI, real browser (desktop + 375 px): a refused Retry (409) shows its message and it stays after the list reloads; a
   successful Retry / Skip still clears an old message.
5. tsc, lint, `npm run build:admin` clean.

## Files
- `src/services/linkedin/client.ts`, `src/services/linkedin/worker.ts` (~line 199), `docs/LINKEDIN_POSTING.md`
- `admin/src/views/LinkedIn.vue`
- Tests: `src/__tests__/linkedin*.test.ts`

## Constraints
- Flag: none (bug fixes on a live feature).
- Migrations: none.
- Full suite: no — area tests: `nice -n 10 npx jest src/__tests__/linkedin` (+ build:admin).
- Never log the token, the upload URL or a response body (existing rules).

## Context the builder needs
- #98 brief + REPORT: `docs/briefs/2026-11-02-linkedin-article-thumbnail.md` (the Images API flow and drop-and-repeat).
- No real LinkedIn call in tests. The first real check is the next post after deploy: planning reads the
  `[linkedin] … image=` line and the owner looks at the page.
