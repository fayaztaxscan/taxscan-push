# REPORT: picture-clears-note

- **Code commit:** `94234f1` on `build/picture-clears-note` (base `origin/develop` def6800)
- **UI by:** `ui-developer` agent

## Files changed
- `admin/src/views/Compose.vue`: one line in the picture field (`pic-side`), directly under "Used only on the LinkedIn and Facebook posts, not in the notification itself.":
  `<p class="muted pic-note">Clears after a successful send, so attach it again for the next push if needed.</p>`
  It is inside the existing `pictureOn` block with no condition of its own, so it shows whenever the field shows, with or without a picture.

## Migrations / flags
None.

## Test results (verbatim)
- tsc: `npx tsc -p tsconfig.json --noEmit`: no output (pass)
- lint: `npm run lint`: no output (pass)
- admin build: `✓ built in 2.63s`
- No new tests: copy only, and there are no SPA unit tests. No full suite, as the brief says (`Full suite: no`; no shared foundation touched).

## Acceptance tests
1. `SOCIAL_PICTURE_ENABLED` on: the line sits directly under "Used only on…", same 12 px muted style, with no picture and with a 1080×1080 picture attached. Off: the field and both notes are absent. Desktop 1366 px and 375 px, headless Chromium against the worktree API: **PASS**
2. Admin build passes. At 375 px the line wraps onto two lines inside the column. There is no page or box overflow at either width, and the file input, Download/Remove and Send now stay on screen: **PASS**

Screenshots: `/private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/0df1aaa6-282d-49af-b84f-4c9207e3d57b/scratchpad/clears-note/`. The build session checked `on-375-with-picture-field.png` itself.

## Agents run
- `ui-developer`: the line and the browser check.

## Deviations
- **Admin guide: no version bump** (stays v2.29). `BUILD-SESSION.md` §3 makes docs part of a build only when the brief lists them, and the brief asks for no wording change (the guide already says the picture clears after a send). There is no standing rule requiring a bump for every UI change.

## Worth remembering
- The build DB holds an inactive throwaway admin `ui-check-clears@localhost.test`; it goes when the DB is dropped. The SocialImage row it uploaded was deleted.

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/picture-clears-note
dropdb taxscan_push_build_picture-clears-note; dropdb taxscan_push_build_picture-clears-note_shadow
git branch -D build/picture-clears-note; git push origin --delete build/picture-clears-note
```
