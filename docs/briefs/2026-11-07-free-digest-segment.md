# Brief: Free digest can target a Mailercloud segment

- **Date / name:** 2026-11-07-free-digest-segment  →  branch `build/free-digest-segment`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
With a new setting `DIGEST_FREE_SEGMENT_IDS`, the Free digest's draft targets that segment and nothing else. With the setting unset, nothing changes.

## Why (owner's words)
> "don't send free digest to all unless send button is clicked" (owner, 2026-11-05)

Owner decided on 5 Nov that Free targets a segment: `TaxscanNewsletterSubscribers` (`SwZafy`), not tagged `TS Premium (auto)`, not tagged `TS No marketing (auto)`. Owner gave the go for this brief on 7 Nov.

Two real test sends on 5 Nov showed that excluding by tag name does not exclude anyone, and `exclude_segments` is unproven. Targeting by segment is proven: Premium has gone out that way since 6 Nov. Today `audienceTarget` refuses Free without a list id, so Free cannot use a segment.

## Scope
**In:**
- `DIGEST_FREE_SEGMENT_IDS` (comma-separated, default empty), read in `src/lib/env.ts` next to `DIGEST_FREE_LIST_IDS`, using `listEnv`. Add `segmentIds` to `cfg.audiences.free`.
- `audienceTarget(cfg, 'FREE', aud)` when the setting is set:
  - Target is exactly `{ listIds: [], segmentIds, tagIds: [], excludeListIds: [], excludeTagIds: [] }`. The segment's own rules carry the exclusions, so no premium exclude is needed.
  - This also applies when `DIGEST_AUDIENCE_FROM_CMS` is on: no derived tags and no `formerToFree` tag are added. The send guard (`guardRefusal`) still runs on the press, unchanged.
- `audienceTarget` returns `{ ok: false, reason }`, naming the settings in plain words, in each of these cases:
  1. `DIGEST_FREE_SEGMENT_IDS` and `DIGEST_FREE_LIST_IDS` are both set. Mailercloud may treat the two as a union, which would mail the whole list.
  2. `DIGEST_FREE_SEGMENT_IDS` is set and `DIGEST_FREE_MANUAL` is not on. A segment means real readers, and they are only ever mailed on a press.
  3. A Free segment id is also in `DIGEST_PREMIUM_SEGMENT_IDS`.
- Send Free confirm dialog on the Digests screen: add one line, shown only when a segment is the target, telling the person to refresh the segment in Mailercloud and read its count before pressing. The screen needs one safe boolean for this (for example `freeTargetsSegment`), never the id.
- Docs: `docs/EMAIL_DIGEST_DESIGN.md` §5 (new setting and the three refusals); `docs/DIGEST_PILOT_RUNBOOK.md` (the rollout order below); admin guide: one short line in the Send Free section, version bumped.

**Out (do not build):**
- Any change to Premium's target, or to the send guard's tag-id target (a separate brief).
- Reading or showing the segment's live count on the screen.
- Removing or changing `DIGEST_FREE_EXCLUDE_*`, `DIGEST_FREE_MANUAL`, or Send Free's press logic.
- Any change to Railway settings or to Mailercloud.

## Acceptance tests
Each one must PASS in the REPORT.
1. Setting unset: `audienceTarget` for Free returns exactly what it returns today, in both the derived and the non-derived branch, including today's refusals.
2. Segment set, list empty, manual on: the target has that segment, and empty lists, tags and excludes. This holds with `DIGEST_AUDIENCE_FROM_CMS` on and off.
3. Segment and list both set: refused, and the reason names both settings.
4. Segment set, manual off: refused, and the reason names `DIGEST_FREE_MANUAL`.
5. A Free segment id equal to a Premium segment id: refused.
6. `createDraft`'s body for a Free segment target has `segments` with the id, empty `list_ids`, and no `tag_ids` or `exclude_*` values.
7. Premium's target is unchanged in every case above.
8. A pressed Send Free on a segment-target draft schedules once. Refusals and gates behave as `digestFreeManual.test.ts` already expects.
9. The dialog line shows only when a segment is the target. Check it in a browser against a stubbed API, and put a screenshot in `docs/briefs/2026-11-07-free-digest-segment.shots/`.
10. The screen payload contains no segment id.

## Files
- `src/lib/env.ts` — the setting; `cfg.audiences.free.segmentIds`
- `src/services/digest/runner.ts` — `audienceTarget`, Free branch
- `src/services/digest/screen.ts` — the safe boolean
- `admin/src/views/Digests.vue`, `admin/src/composables/digestView.ts` — the dialog line
- `docs/EMAIL_DIGEST_DESIGN.md`, `docs/DIGEST_PILOT_RUNBOOK.md`, the admin guide
- Tests: `src/__tests__/digestFreeManual.test.ts`, `src/__tests__/audienceGuard.test.ts`, or a new `src/__tests__/digestFreeSegment.test.ts`

## Constraints
- Flag: no separate flag. The setting unset is the off state, and it is not set by this build.
- Migrations: none.
- Full suite: yes — touches config/env.
- Docs that ship with it: the three listed under Scope.
- `audienceTarget` runs for BOTH versions in `buildConfigProblems`, so any Free refusal above stops the whole morning build, Premium included. Keep that behaviour (fail closed, with the existing alert), and state it in the runbook so that the settings change only outside 06:15–17:00 IST.
- Never log or display a reader address.

## Context the builder needs
- Premium's target with `DIGEST_PREMIUM_SEGMENT_IDS` is the working pattern; follow it.
- A segment answers to several ids, so don't compare ids for anything beyond refusal 3.
- A draft's `segments_contact_count` is not a live count; don't use it.
- Facts and traps: `docs/EMAIL_DIGEST_DESIGN.md` §5, §7.1.

## Rollout, after it ships (planning + owner, not this build)
Add this order to the runbook:
1. Anagha creates a small test segment and the real Free segment in Mailercloud. Planning reads both rule sets with `GET /v1/segments/{id}`.
2. Outside 06:15–17:00 IST, set `DIGEST_FREE_SEGMENT_IDS` to the test segment and clear `DIGEST_FREE_LIST_IDS` in the same change. Confirm `DIGEST_FREE_MANUAL` is on first.
3. Next morning, press Send Free. The test contact tagged Premium must receive nothing, and the untagged one must receive the digest.
4. Glance at one real digest's unsubscribe headers.
5. Only on the owner's yes, change to the real segment. Refresh and read the count before every Send Free.
