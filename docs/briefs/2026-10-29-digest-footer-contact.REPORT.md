# REPORT: 2026-10-29-digest-footer-contact

- **Branch:** `build/digest-footer-contact` (base `origin/develop` at `34a4c6e`)
- **Code commit:** `b7c5dd5a4e2c0a4b0260dc65a7d3cdc3bfcd1388`
- **Result:** all 4 acceptance items PASS.

## Files changed

- `src/services/digest/renderer.ts`:
  - new exports `CONTACT_EMAIL`, `CONTACT_MAILTO`, `CONTACT_LINE` and `isContactMailto()` (string-equal `mailto:info@taxscan.in`; nothing broader);
  - HTML footer: `<reason> Questions or feedback? Write to <a href="mailto:info@taxscan.in" class="ts-link" style="color:#1376c8;text-decoration:underline;padding:9px 0;">info@taxscan.in</a>` (the sentence ends at the link, as in the owner's wording);
  - plain text: `<reason> Questions or feedback? Write to info@taxscan.in`;
  - a template's own links (`templateLinks`): the exact mailto is left as written, no UTM.
- `src/services/digest/templates.ts`: the checklist's "links" check lets exactly that mailto through (same way as the five social URLs).
- `src/__tests__/digestLookalike.test.ts`: line 315's "Just reply" assertion is now "not Just reply"; new tests (below).
- `src/__tests__/digestRenderer.test.ts`: the "every href carries the digest UTM" test now sets aside exactly the unsubscribe tag and the one contact mailto (asserting there is exactly one).

## Migrations / flags / env

None. `MAILERCLOUD_REPLY_EMAIL` is untouched (stays `info@hello.taxscan.in`).

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0. `npm run lint`: exit 0 (0 errors).
- `digestRenderer` + `digestLookalike` + `digestTemplates`: `Tests: 129 passed, 129 total`.
- **Full suite (`--maxWorkers=1`):** `Test Suites: 75 passed, 75 total` · `Tests: 1516 passed, 1516 total` (1,512 on `develop` + 4 new).

## Acceptance tests

1. **PASS.** For Free and Premium: the footer HTML is the unchanged reason line + "Questions or feedback? Write to" + a `mailto:info@taxscan.in` link (one mailto in the whole email, no UTM on it); the text part has `<reason> Questions or feedback? Write to info@taxscan.in`; neither contains "Just reply". The unsubscribe link and the postal address are asserted unchanged, and there is still no "noreply".
2. **PASS.** `isContactMailto` is true only for the exact string. The template checklist passes the built-in and a template carrying exactly that mailto, and **fails** `mailto:other@taxscan.in`, `mailto:info@taxscan.in?subject=x` and `mailto:someone@example.com`; an actual send with a template containing `mailto:other@taxscan.in` is refused with `RenderError`, while the exact one is left as written (no UTM). Variants (`MAILTO:` upper-case, `info@hello.taxscan.in`, trailing space, no scheme) are all refused by `isContactMailto`.
3. **PASS.** Worst case (12 stories with pictures, 3 image ads, social row, the new line), with the tracking allowance:
   - Free: html 64,943 B, **budget 71,993 B**; Premium: html 65,381 B, **budget 72,431 B**.
   - Warning at 75 KB = 76,800 B; maximum 90 KB = 92,160 B. The new line adds ~0.3 KB (and one more tracked link, 150 B).
4. **PASS.** tsc, lint 0 errors, full suite green.

## Agents run

None.

## Deviations from the brief

1. **The mailto link has `padding:9px 0`.** An existing renderer test requires every link to have a ≥ 44 px tap target (`min-height:44px` or the headlines' `padding:9px 0`). The unsubscribe link's `display:inline-block;min-height:44px` style would put a 44 px-tall box in the middle of a one-sentence line, so the contact link keeps the sentence's line height and gets the headlines' vertical padding, which widens its tap area in browsers. (Outlook ignores vertical padding on inline links; it is still a text link.)
2. `digestRenderer.test.ts` was changed (the UTM test) — the brief only named `digestLookalike.test.ts:315`. That test renders without an asset host, so it never saw the social links; it does see the mailto.

## Saved templates

The footer is the renderer's own markup and reaches a saved template through the required `{{footer}}` placeholder, so **saved templates get the new text automatically**. None hard-codes the old sentence in this repository; nothing in `docs/` does either (the only other occurrence of "Just reply" was the test assertion). No saved templates exist in production yet (per the brief).

## Worth remembering

- The two earlier renderer tests passed without a mailto only because they render with no asset host; the footer is always present, so its link is always in every email now.
- `mailto:` links get click-tracking rewritten by some providers; Mailercloud's behaviour for a mailto is unverified. If it rewrites it, the link would open through their redirect (the owner can see this in the first test send).
- The plain-text part still ends with the unsubscribe and postal lines unchanged.

## Clean-up

```sh
git worktree remove ../taxscan-push-worktrees/digest-footer-contact
dropdb taxscan_push_build_digest-footer-contact; dropdb taxscan_push_build_digest-footer-contact_shadow
git branch -D build/digest-footer-contact; git push origin --delete build/digest-footer-contact
```
