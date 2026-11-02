# REPORT: linkedin-article-thumbnail

- **Branch:** `build/linkedin-article-thumbnail` (base `origin/develop` 5f54f32). **Code commit:** `5558ba1`.

## Files changed
- `src/services/linkedin/image.ts` (new) — `fetchCoverImage()`: https only, exact-host allowlist (`documents.taxscan.in`, `www.taxscan.in`, `taxscan.in`; no userinfo / port), **no redirects** (`redirect: 'error'`, so a redirect cannot leave the allowlist), 10 s for the whole fetch including the body, ≤ 5 MB (the stream read is aborted at the cap; also checks `content-length`), `content-type` image/jpeg | image/png | image/gif only. Failures are a fixed word (`host`, `redirect`, `timeout`, `network`, `type`, `size`, `http_<n>`), never a URL or body.
- `src/services/linkedin/client.ts` — `uploadImage()` (Images API: `POST /rest/images?action=initializeUpload` with the org URN, then `PUT` to `uploadUrl` with the Bearer token) and `postBody()` now takes `description` / `thumbnail` and puts them in `content.article` (only when present). The upload URL must be https on `linkedin.com` / `licdn.com`, and the image URN must look like `urn:li:image:…`, or the Bearer token is not sent and the picture is skipped (`init_bad_answer`).
- `src/services/linkedin/post.ts` — `CmsArticle` gains optional `coverImageUrl` / `excerpt` (`cover_image_url`, `excerpt`); `cardDescription()` (excerpt, else `Campaign.body`; whitespace-collapsed, ≤ 200 characters at a word boundary with "…"; a plain string, no little-text escaping); `PostPayload` gains `description` and `coverImageUrl` (null when the CMS fetch failed).
- `src/services/linkedin/worker.ts` — `attempt()` fetches + uploads the picture before the post, fail-open, and the outcome lines end with `image=ok` or `image=none:<reason>` (posted / retry / failed / auth_stop all carry it). A 401 / 403 from the registration is turned into the same auth verdict as the post's own and **no post call is made**. New injectable deps `fetchImage` / `uploadImage` for tests.
- `docs/LINKEDIN_POSTING.md` — "The link card's picture and description".
- Tests: `linkedinThumbnail.test.ts` (new, 14, no database), `linkedinWorker.test.ts` (+10 scenarios "I."), `linkedinPost.test.ts` (one expectation for the new fields); fixtures `src/__tests__/fixtures/linkedin/cms-*.json` now carry the real `cover_image_url` and `excerpt` of the three 2 Nov articles.

## Migrations / flags
None / none (the poster's output improves and fails open to today's card).

## LinkedIn's Images API as documented (checked 2 Nov 2026, learn.microsoft.com Images API + Assets API pages)
- Register: `POST https://api.linkedin.com/rest/images?action=initializeUpload`, headers `Authorization: Bearer`, `Linkedin-Version`, `X-Restli-Protocol-Version: 2.0.0`, body `{"initializeUploadRequest":{"owner":"urn:li:organization:…"}}` → `{"value":{"uploadUrlExpiresAt":…,"uploadUrl":"https://www.linkedin.com/dms-uploads/…","image":"urn:li:image:…"}}`.
- Upload: `PUT` the bytes to `uploadUrl`; **the image upload call requires the OAuth token in `Authorization`** (unlike video); a 201 answer. JPG, PNG, GIF; under 36,152,320 pixels. `SYNCHRONOUS_UPLOAD` is not supported in the Images API (the upload is asynchronous: the image goes WAITING_UPLOAD → PROCESSING → AVAILABLE).
- Permissions: `w_organization_social` (the page token already has it) with ADMIN permission on the page.
- Not in the brief and not built: LinkedIn's Assets-API note that a post made before the image is confirmed can be invisible if the image then fails to process suggests a `GET /rest/images/<urn>` status check (`AVAILABLE`) before posting. I did not add polling (the brief fixes the steps and the time budget); see "Worth remembering".

## Results (verbatim)
- `npx tsc -p tsconfig.json --noEmit`: clean. `npm run lint`: exit 0.
- Area tests `src/__tests__/linkedin*`: `Test Suites: 4 passed, 4 total` / `Tests: 87 passed, 87 total`.
- **No full suite** (brief: area tests only; no schema, auth, send-path, config or env change). The release check covers the rest. Each test file ran in one jest process.

## Acceptance
1. Happy path (CMS cover + excerpt → fetch → register → upload → post carries `thumbnail = urn:li:image:…` and the excerpt cut to ≤ 200; log `image=ok`; POSTED): PASS (worker test I.1; unit tests for each step).
2. Picture fetch 404 / timeout / `text/html` / 6 MB (by `content-length`, by a streamed body past the cap with the read stopping early, and by a non-stream body) → posted without `thumbnail`, `image=none:<reason>`, status POSTED, attempts 1: PASS.
3. initializeUpload 500 or the PUT failing → posted without a thumbnail; initializeUpload 401 (and 403) → auth-stop, **no post call**, the usual once-a-day admin email: PASS.
4. A disallowed host (`http://`, another domain, a lookalike subdomain, userinfo, a port) → no fetch at all (asserted with a spy on the global `fetch`), `image=none:host`: PASS.
5. The CMS fetch failed → no image attempt (neither mock called), the description falls back to `Campaign.body`, `image=none:no_cover`: PASS.
6. The token never appears in the logs, rows, mails or captured requests across the new calls (the real `uploadImage` against a server that echoes the token): PASS. (`uploadImage` returns only fixed reason words; an auth error text is scrubbed by `safeError`.)
7. tsc, lint, `linkedin*` tests: PASS.

## Agents run
None (no UI).

## Worth remembering
- **Not seen against real LinkedIn.** All HTTP is mocked. The first live post with a picture is the check: the log line says `image=ok` or why not, and the post on the page shows (or lacks) the card picture.
- **Possible asynchronous-processing gap.** The registration/upload is asynchronous. If LinkedIn were to reject posts whose image is still PROCESSING, the post would fail with a 4xx and (as before) be marked FAILED; the fix would be one status GET (`/rest/images/<urn>` → `AVAILABLE`) with a short wait before posting. Not built; say the word if the first live post shows it.
- The CMS must serve `cover_image_url` from `documents.taxscan.in` (as today). A cover on any other host is skipped (`image=none:host`) by design; add the host to `IMAGE_HOSTS` in `image.ts` if the CMS ever moves it.
- Both the CMS fetch (5 s, one attempt) and the picture fetch (10 s) are per attempt; a retried post repeats them. At ~20 posts a day that is negligible.
- No change to what gets posted, when, or how it retries.

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/linkedin-article-thumbnail
dropdb taxscan_push_build_linkedin_article_thumbnail; dropdb taxscan_push_build_linkedin_article_thumbnail_shadow
git branch -D build/linkedin-article-thumbnail; git push origin --delete build/linkedin-article-thumbnail
```

---

# Follow-up 1 (planning review): wait for the image, and a post rejected because of the thumbnail still goes out

- **Same branch** `build/linkedin-article-thumbnail`, one more code commit (hash in `git log`).

## Files changed
- `src/services/linkedin/client.ts` — `waitForImage()`: after the PUT, `GET https://api.linkedin.com/rest/images/<urn>` (same headers; the raw URN in the path, as the Images API page shows) up to **4 looks, 1.5 s apart** (about 4.5 s of waiting; the clock is injectable). `status` AVAILABLE → ok; WAITING_UPLOAD / PROCESSING / anything else → look again; after the 4th look still not ready → `processing`; PROCESSING_FAILED → `processing_failed`; a non-OK answer → `status_<code>`; a network error / timeout → `status_network`; a malformed URN → `status_network` (no call). The reasons are fixed words, never a body.
- `src/services/linkedin/worker.ts` — after a successful upload the thumbnail is attached only if the image is ready, else the post goes out without it with `image=none:<reason>`. If the post WITH a thumbnail comes back `failed` (a client error that is not 401 / 403 / 429), the same attempt repeats the post once without `thumbnail` and logs `image=dropped:<status>`; the repeat's verdict is the attempt's (T3b: if it fails too, the row is FAILED with the repeat's error). New injectable dep `waitImage`.
- `docs/LINKEDIN_POSTING.md` — steps 4, 6, 7 and the log line.
- Tests: `linkedinWorker.test.ts` — "follow-up 1" block (T1–T5 plus the cases below); every other worker scenario that uploads a picture now gets an injected "ready" (`deps()` default), so no test can reach LinkedIn's status endpoint.

## Results (verbatim)
- tsc clean; lint clean. Area tests `src/__tests__/linkedin*`: `Test Suites: 4 passed, 4 total` / `Tests: 97 passed, 97 total`. No full suite (area tests only, as asked); each file in one jest process.

## Acceptance
- T1 PASS (the status stays PROCESSING for all 4 looks: exactly 4 GETs, posted without a thumbnail, `image=none:processing`, status POSTED). T2 PASS (PROCESSING then AVAILABLE: 2 looks, thumbnail attached, `image=ok`). T3 PASS (422 with the thumbnail, then success without: exactly 2 post calls, the second without `thumbnail` but with the same description and commentary, `image=dropped:422`, POSTED, attempts 1, no error). T4 PASS (a 500 with the thumbnail: the normal retry, exactly 1 post call, the row PENDING; also a 429 and a network error are not repeated). T5 PASS (a 401: auth-stop, 1 post call, no repeat).
- Also covered: an error from the status call (`status_404`) and a failed processing → no thumbnail; the repeat failing too → FAILED with the repeat's error (2 calls only); a client error on a post that had NO thumbnail is not repeated; `waitForImage` itself (never more than 4 looks, the 1.5 s gaps, the headers, fixed reasons, the token never echoed).

## Worth remembering
- A post that dropped its picture because of a client error is the one case where the same attempt makes two post calls. If the FIRST call had in fact created the post (it should not on a 4xx) a duplicate could appear; LinkedIn documents 4xx as "not created", and the unique `LinkedInPost` row still prevents any second automatic post.
- `PROCESSING_FAILED` is reported as `image=none:processing_failed` (the brief names only `processing` and `status_<code>`).
- Still unverified against real LinkedIn: the first live post will show `image=ok` / `none:…` / `dropped:…` in the log line.
