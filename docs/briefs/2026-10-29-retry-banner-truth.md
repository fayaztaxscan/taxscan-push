# Brief: The Digests "Retry now" message tells the truth

- **Date / name:** 2026-10-29-retry-banner-truth → branch `build/retry-banner-truth`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
After **Retry now** (and **Send now**), the green or red message on Digests says what actually happened to each
version (Free / Premium), not a fixed success sentence.

## Why (owner's words, 29 Oct)
Anagha pressed Retry now in preview mode. Mailercloud refused both drafts again (HTTP 400 reply_email), yet the
**green** banner said: "Retried in preview mode: the Mailercloud draft is made, nothing is sent. Today's digest
is now: failed." The owner and Anagha both read it as success. A message that contradicts the outcome is a bug.

## The bug
`admin/src/views/Digests.vue` `confirmDoor()` (~line 224): in preview mode, after a retry, it always shows "the
Mailercloud draft is made", whatever the result.

## Scope
**In:**
- Build the message from the actual outcome. The retry response already returns `result.state` + `steps`. If the
  per-audience outcome isn't in the response, add it **server-side** to the retry/send-now reply (e.g.
  `audiences: { FREE: 'CREATED'|'FAILED'|…, PREMIUM: … }` plus the short error kind). The client must not infer it
  from strings.
  - All requested versions made → green: "Retried in preview mode: both drafts are made in Mailercloud, nothing
    is sent." (or the one version's name).
  - Any version failed → **red/amber** (the screen's error style): "Retry didn't work: Free — <short reason>;
    Premium — <short reason>. Nothing was sent." The reason is the same short text the per-version line shows.
  - Partly made → say which version was made and which failed.
- Same rule for **Send now**: never "Handed to Mailercloud" unless the state says so (it already checks the
  state; keep it, and add the failure wording).
- **Don't let "Retry now" be pressed again while a retry is running.** It's already `busy`-guarded; verify it.
  Today's 6 attempts were repeated presses, not a loop.

**Out:** retry policy, the error classification, any Mailercloud behaviour.

## Acceptance tests
1. Unit/component (or a route test plus a pure message function): preview retry with both versions failing →
   error-styled message naming both reasons, and the word "made" doesn't appear; both made → green "both drafts are
   made"; one of each → the partial message.
2. Send now in live mode: scheduled → "Handed to Mailercloud…"; failed → error-styled with the reason.
3. Browser (one at a time): reproduce today's case with a fake sender that 400s → the red message. Screenshot.
4. tsc, lint (0 errors), `npm run build:admin`, the full suite: green.

## Constraints
No flag, no migration, no env. The digest's state machine is untouched; this is reporting only.
