# Brief: LinkedIn posts carry the article's picture (and a description) in the link card

- **Date / name:** 2026-11-02-linkedin-article-thumbnail  →  branch `build/linkedin-article-thumbnail`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first).

## Goal
Every LinkedIn post's link card shows the article's **cover picture** and a one-line **description**, like a link a person
pastes. If the picture can't be fetched or uploaded, the post still goes out, without the picture, as today.

## Why (owner's words)
> 2 Nov 17:30, with a screenshot of a live post (Nokia DTAA SLP article): "why is the article image not appearing?"

Cause: the Posts API does **not** scrape the URL for `content.article`. A thumbnail appears only when the post supplies
`content.article.thumbnail` = an **image URN uploaded via the Images API**. `src/services/linkedin/client.ts` `postBody()`
sends only `source` + `title`. (The old automation script had the same gap.)

## Scope
**In:**
1. **The picture source:** the CMS article we already fetch for hashtags (`fetchCmsArticle()` in
   `src/services/linkedin/post.ts`). Read `cover_image_url` and `excerpt` (extend `CmsArticle`). If the CMS fetch failed,
   there's no picture: don't scrape the page.
2. **Fetch the picture:** https only, host on an allowlist (`documents.taxscan.in`, `www.taxscan.in`, `taxscan.in`), 10 s
   timeout, ≤ 5 MB (abort past it), `content-type` image/jpeg | image/png | image/gif only.
3. **Upload to LinkedIn (Images API):** check LinkedIn's current docs for the exact shapes and note them in the REPORT.
   - `POST https://api.linkedin.com/rest/images?action=initializeUpload` (same `LinkedIn-Version` / `X-Restli-Protocol-Version`
     / Bearer headers) with `{ "initializeUploadRequest": { "owner": "<org URN>" } }` → `value.uploadUrl` + `value.image`
     (`urn:li:image:…`).
   - `PUT` the bytes to `uploadUrl` with the Bearer header (per the docs).
   - Then post with `content.article = { source, title, description, thumbnail: <image URN> }`.
4. **Description:** CMS `excerpt`, else `Campaign.body`. Whitespace-collapsed, ≤ 200 characters at a word boundary with "…".
   Plain JSON string (it's not little-text commentary, so no escaping).
5. **Fail-open:** any failure in steps 2–3 (timeout, 4xx/5xx, wrong type, too big) → post WITHOUT `thumbnail` (keep
   `description`), and log `image=none:<reason>` on the outcome line (`image=ok` when attached). A picture failure is never
   a post failure, never a retry, never an auth-stop, EXCEPT that a 401/403 from initializeUpload is treated like the post's
   own 401/403 (the token is bad for everything).
6. **No double uploads on retry:** if an attempt uploaded an image but the post call then failed with a retryable error,
   it's fine to upload again on the retry (images are cheap). Just don't loop within one attempt.
7. **Time budget:** the CMS fetch, image fetch, upload and post together must stay well inside the 10-minute stale window.
   Keep each step's timeout as above (CMS 5 s, image 10 s, upload 15 s, post 15 s).

**Out (do not build):**
- Scraping the article page for og:image (the CMS gives the cover directly).
- Image resizing or re-encoding.
- Re-posting or editing posts already published without a picture.

## Acceptance tests
Each one must PASS in the REPORT. All HTTP is mocked.
1. Happy path: the CMS returns `cover_image_url` + `excerpt` → image GET → initializeUpload → PUT → the post body has
   `content.article.thumbnail = urn:li:image:…` and `description` = the excerpt (cut to ≤ 200). The log has `image=ok`.
2. Picture fetch 404 / timeout / `text/html` / 6 MB → the post goes out without `thumbnail`, with `image=none:<reason>`,
   status POSTED.
3. initializeUpload 500 or the PUT failing → posted without a thumbnail. initializeUpload 401 → handled as auth-stop, no post call.
4. A disallowed host (`http://`, another domain) → no fetch at all, `image=none:host`.
5. The CMS fetch failed → no image attempt, the description falls back to `Campaign.body`.
6. The token never appears in logs or rows (extend the existing grep test to the new calls).
7. `tsc`, lint, the `linkedin*` tests pass.

## Files
- `src/services/linkedin/post.ts` (CmsArticle fields, description), `src/services/linkedin/client.ts` (image upload +
  `postBody` thumbnail/description), `src/services/linkedin/worker.ts` (wire it in, log field), `docs/LINKEDIN_POSTING.md`.
- Tests: `src/__tests__/linkedinPost.test.ts`, `linkedinWorker.test.ts` (+ fixtures with `cover_image_url`).

## Constraints
- Flag: none. It improves the live poster's output and fails open to today's behaviour.
- Migrations: none.
- Full suite: no — area tests `linkedin*`. The release check covers the rest.
- No new npm dependency.

## Context the builder needs
- Live example to model the fixture on: `GET https://api.taxscan.in/api/v1/articles/<slug>` returns `cover_image_url`
  like `https://documents.taxscan.in/cms/media/<name>.jpg` (~125 KB JPEG) and an `excerpt`.
- The worker's `attempt()` and the outcome log line: `src/services/linkedin/worker.ts`.
