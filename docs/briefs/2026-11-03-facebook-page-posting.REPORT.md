# REPORT: facebook-page-posting

- Code commit: `557b202` on branch `build/facebook-page-posting` (rebased onto origin/develop 51911c2, which already holds digest-story-row-fit).
- Agents run (one at a time): backend-developer (service, worker, route, migration, tests, docs), ui-developer (Facebook screen, nav, Campaigns mark, Activity label, guide section, real-browser check).

## Files changed
- `prisma/schema.prisma`, `prisma/migrations/20261103094319_facebook_post/` — `FacebookPostStatus` enum, `FacebookPost` (same columns + unique (page, articleKey) as `LinkedInPost`), `AuditAction.FACEBOOK_POSTING_RESUMED`. Additive.
- `src/lib/env.ts` — `env.facebook` (flag, postFrom, graphVersion v25.0, minGapMinutes 10, dailyCap 30, pages.taxscan {pageId, accessToken}).
- `src/services/facebook/{pages,client,post,worker}.ts` — Graph client (token in POST body / Authorization header only, never the URL), error classification (auth / policy / rate / transient / duplicate / failed), message builder (headline + blank line + ≤4 plain hashtags, `#taxscan` last), 1-minute worker (1 post per tick, ≥ min gap from last POSTED, IST daily cap, stale row → FAILED unknown), auth stop + policy stop, `resumePolicy`.
- `src/routes/facebook.ts`, `src/app.ts`, `src/index.ts`, `src/routes/auth.ts` — list / retry / skip / check (ADMIN) / resume (ADMIN, audited); flag off → 404; `features.facebookPosting`; worker started.
- `src/services/metrics.ts` — Campaigns `channels.facebook` + `channelDetails.facebook`; keys absent when the flag is off.
- `.env.example`, `docs/FACEBOOK_POSTING.md` — flags, what posts, pacing, error classes, switch-on steps.
- `admin/src/views/Facebook.vue` (new), `router.ts`, `composables/useAuth.ts`, `components/NavBar.vue`, `views/Campaigns.vue`, `views/Activity.vue`, `styles/app.css` — SOCIAL → Facebook screen, banners, Resume, Check connection, Campaigns mark, audit label.
- `docs/Taxscan-Push-Admin-Guide.html` — new Facebook section; version 2.19 (cover + footer).
- `src/__tests__/facebookWorker.test.ts` (new, 27 tests); `src/__tests__/whatsappQueue.test.ts` — one line: exact `features` equality now includes `facebookPosting`.
- `docs/briefs/2026-11-03-facebook-page-posting.shots/` — desktop and phone screenshots.

## Migrations / flags
- Migration `20261103094319_facebook_post` (additive).
- Env: `FACEBOOK_POSTING_ENABLED` (off), `FACEBOOK_POST_FROM` (required when on), `FACEBOOK_TAXSCAN_PAGE_ID`, `FACEBOOK_TAXSCAN_PAGE_TOKEN`, `FACEBOOK_GRAPH_VERSION` (v25.0), `FACEBOOK_MIN_GAP_MINUTES` (10), `FACEBOOK_DAILY_CAP` (30).

## Results
- tsc: clean (exit 0). lint: clean (`eslint "src/**/*.ts"`). `npm run build:admin`: `✓ built in 2.35s`.
- New tests: `Tests: 27 passed, 27 total` (facebookWorker).
- Area (linkedin*, campaignChannels, whatsapp*, campaign*, metricsRecentCampaigns, adminLoginFeatures): all pass; LinkedIn tests unchanged.
- **Full suite (required: schema + config touched):** `Test Suites: 97 passed, 97 total` / `Tests: 1916 passed, 1916 total`.
  An earlier full run had 1 failure (`whatsappNudge` "real queue feeds the nudge") — cause: leftover rows from the UI agent's browser seeding in the build DB (7 seeded SENT campaigns counted by the real queue). Deleted the seed rows and re-ran: all green. Not a code issue.

## Acceptance
1. PASS — both URL shapes post once; test-segment-only, home/section/academy/shop, before POST_FROM, >24 h, drafts never; re-push/clone adds no row.
2. PASS — form body has message/link/access_token; no token in URL; version from env; ≤4 plain hashtags ending #taxscan; link carries the 4 Facebook UTMs and passes the allowlist.
3. PASS — 5 at once post at minutes 0/10/20/30/40, one per tick; the 31st of an IST day waits, posts next day within 24 h.
4. PASS — 190 auth stop + one email/IST day + banner; 368 policy stop survives restart, emails at once, blocks Retry (409 policy_stop), cleared only by ADMIN Resume (publisher 403, AuditLog row, second Resume 409); 4/17/32/613/429 → +15/+60 then FAILED; 5xx/network → +1/+5/+15; 506 FAILED no retry; retries skip quiet hours; stale row → FAILED unknown, not re-posted.
5. PASS — runtime leak checks (logs, rows, settings, emails, API) + token source scan.
6. PASS — flag off: no cron, endpoints 404, `features.facebookPosting=false`, refusing-to-start cases logged.
7. PASS — Check connection: "Connected to page: X" via Authorization header, no /feed call; 190 → auth class; ADMIN only.
8. PASS — LinkedIn tests unchanged and green.
9. PASS — real browser (Playwright chromium, true 375 px viewport + 1280/1440; Graph host blocked, no Facebook call): Facebook screen rows in every state, amber + red banners, Resume, Check connection error state, Retry refused while stopped, Campaigns fb marks, hamburger SOCIAL → Facebook. No page-level overflow at 375 or 1280. Screenshots in the `.shots/` folder.

## Deviations / decisions (planning please review)
1. **Policy stop is persisted in the existing `DigestSetting` table** (key `facebook:policy:<page>`; auth banner `facebook:auth:<page>`, as LinkedIn does) — no extra table. `DigestSetting` is in the R2 backup, so a restore brings a policy stop back (fails safe).
2. **Nav breakpoint moved 1350 → 1430 px** (`app.css`: hamburger + compact-row blocks). A third SOCIAL link made the nav wrap to two rows at 1350–1429 px (72 px tall); at 1430 it is 52.5 px. Shared CSS change — please confirm acceptable.
3. Helpers (`fetchCmsArticle`, `hashtagsFor`, `slugOf`, `FIXED_TAG`, `pushOutOfQuietHours`) are **imported from `services/linkedin/`**, not moved to `social/` — LinkedIn code untouched.
4. Min gap is measured from the last POSTED row, so quick transient retries aren't delayed by it. Manual Retry ignores gap and daily cap (one explicit post) but is refused during a policy stop.
5. Page id must be 5–25 digits and token ≥20 printable chars (the id goes into a URL path).
6. The admin guide in the worktree base was 2.17 vs 2.18 on develop; resolved to 2.19 in the rebase.

## Worth remembering
- **LinkedIn.vue bug (not fixed, out of scope):** after a 409 it sets the error and then calls `load()`, which clears it, so the message never shows. Facebook.vue fixes it with `load(keepError)`; one-line fix for LinkedIn if wanted.
- Facebook test file uses a random page name per run (`fbtest<random>`); earlier failures came from overlapping jest runs sharing one build DB (my own doing, not code).
- `articleKey()` returns `article:<id>`.
- Not tested against real Graph (by design); first real check is the owner's switch-on steps in `docs/FACEBOOK_POSTING.md`.

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/facebook-page-posting
dropdb taxscan_push_build_facebook-page-posting; dropdb taxscan_push_build_facebook-page-posting_shadow
git branch -D build/facebook-page-posting; git push origin --delete build/facebook-page-posting
```
