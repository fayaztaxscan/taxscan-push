# REPORT: 2026-10-29-retry-banner-truth

- **Branch:** `build/retry-banner-truth` (base `origin/develop` at `9114495`)
- **Code commit:** `e5d3380d67a36e0fafd1e2fec12f28b0c5350dbb`
- **Result:** all 4 acceptance items PASS. The bug had a **second cause** the brief did not name (below).

## The bug, both halves

1. The fixed success sentence in `confirmDoor()` (as briefed).
2. **`load()` clears the error banner, and `confirmDoor` called `await load()` in its `finally`.** So even a correct red message set in `try`/`catch` would have been wiped a moment later. This already affected the existing error paths (e.g. the "No reply from the server in time" message). The message is now applied **after** the reload.

## Files changed

- `src/routes/digest.ts` (the shared retry / send-now `door()`): after `advanceRun`, reads each version back and replies `result: { …result, audiences: { FREE: { state, error, errorKind }, PREMIUM: { … } } }`. `error` is the version's `lastError` (the same short text the per-version line shows), `errorKind` is RETRYABLE / FATAL / AMBIGUOUS. Also on the cut-off 409. The state machine and the runner are untouched.
- `admin/src/composables/digestView.ts`: new pure `doorMessage(kind, sendLive, result)` → `{ tone: 'ok' | 'err', text }`, plus `shortReason()` and the types. It never parses strings; it reads the per-version states.
- `admin/src/views/Digests.vue`: `confirmDoor()` uses it, shows the red (`.banner.err`) or green (`.banner.ok`) banner after the reload, and returns early if a press is already running.
- `src/__tests__/digestScreen.test.ts`: 8 new tests (below).

## Migrations / flags / env

None.

## The message, by case

| Case | Tone | Text |
|---|---|---|
| Retry, preview, both drafts made | green | "Retried in preview mode: both drafts are made in Mailercloud, nothing is sent." (one version: "the Free draft is made …") |
| Retry, a version failed (or is waiting with an error) | **red** | "Retry didn't work: Free — <reason>; Premium — <reason>. Nothing was sent." |
| Retry, one made, one failed | **red** | "Retry only partly worked: the Premium draft is made in Mailercloud; Free — <reason>. Nothing was sent." |
| Send now / live retry, all handed over | green | "Handed to Mailercloud. It is sending now." |
| Send now, a version failed | **red** | "Send now didn't work: <reason>. Nothing was sent." — or, if the other was handed over: "Only the Free digest was handed to Mailercloud. Premium — <reason>." |
| Anything neither made nor failed | green | "Not sent yet. Today's digest is now: <state>." |

`<reason>` is the version's last error, one clause (trailing punctuation trimmed, 140 characters max; "it did not work" if empty).

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0. `npm run lint`: exit 0. `npm run build:admin`: `✓ built in 2.56s`.
- `digestScreen`: `Tests: 46 passed, 46 total`.
- **Full suite (`--maxWorkers=1`):** `Test Suites: 75 passed, 75 total` · `Tests: 1524 passed, 1524 total` (1,516 on `develop` + 8 new).

## Acceptance tests

1. **PASS** (route tests that call the real endpoint with a scripted `FakeSender`, then the message function on the reply): preview retry with both drafts refused (HTTP 400) → both versions `FAILED` with a reason, message red, text matches `Retry didn't work: Free — …; Premium — …. Nothing was sent.`, and **"made" does not appear**; both made → green "both drafts are made", nothing scheduled; Free refused + Premium made → "Retry only partly worked: the Premium draft is made in Mailercloud; Free — …". Plus pure-function tests for each wording, a long reason and an empty one.
2. **PASS.** Send now live: both `SCHEDULED` → "Handed to Mailercloud. It is sending now."; Mailercloud refusing the schedule (HTTP 400) → red "Send now didn't work: …", never "Handed to Mailercloud".
3. **PASS**, real Chrome (one browser) against the real app on port 3917 with a scripted sender that answers HTTP 400 `reply_email` to every draft (preview mode, clock at 07:40 IST, build DB; the sender is the test `FakeSender`, booted from an untracked scratch script, so no production code was changed for it). Digests showed "Failed" for both versions; **Retry now → confirm** produced the **red** banner:
   > Retry didn't work: Free — fake createDraft fatal for [email] (http=400 code=reply_email); Premium — fake createDraft fatal for [email] (http=400 code=reply_email). Nothing was sent.

   (The reason text is the fake's; the real one is Mailercloud's short message, the same text each version's own line shows.) The banner stays after the screen reloads. Screenshot (untracked): `/Users/bestdoc/Documents/taxscan-push-worktrees/retry-banner-truth/visual-check/retry-red-banner.jpg`.
4. **PASS.** tsc, lint, `build:admin`, full suite.

## "Don't let Retry now be pressed again while a retry is running"

Verified, and tightened. The Retry now / Send now / Approve / Hold buttons are already `:disabled="!!busy"`, and the confirm dialog's button is `:disabled="busy"`; the 6 attempts on 29 Oct were separate presses, not a loop. I added an early return in `confirmDoor()` (`if (busy.value) return`) as a backstop for any second confirm event. The server side has the runner's step claims, which I did not touch.

## Agents run

None.

## Deviations from the brief

1. The server reply gained `audiences` on **every** door response (the 200, the cut-off 409), not only on retry. One extra query per press.
2. **Mixed outcomes under a failed message:** when a version's draft is made but the other failed in a Send now, the red text names which was handed over (the brief only specified the retry wording).

## Worth remembering

- A message that says "made" should only ever be built from the version's state. If a new state is added later, `doorMessage` lists the made/handed/failed sets at the top of the function; anything not in them falls to the neutral "Not sent yet" line, which is green.
- The existing banner for Digests status ("Mailercloud rejected today's digest …", amber) is separate and was already truthful; it stays above the new red line.
- The brief says "red/amber (the screen's error style)": I used `.banner.err` (red), the same style as every other failure on the screen.
- Scratch files (`scratch/browser-fail.ts`, `visual-check/`) are untracked in the worktree and go with it.

## Clean-up

```sh
git worktree remove --force ../taxscan-push-worktrees/retry-banner-truth   # --force: untracked scratch/ and visual-check/
dropdb taxscan_push_build_retry-banner-truth; dropdb taxscan_push_build_retry-banner-truth_shadow
git branch -D build/retry-banner-truth; git push origin --delete build/retry-banner-truth
```
