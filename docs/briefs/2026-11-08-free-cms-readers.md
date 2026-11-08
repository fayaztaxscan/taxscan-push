# Brief: Free digest reaches CMS free readers, admitted in daily batches

- **Date / name:** 2026-11-08-free-cms-readers  →  branch `build/free-cms-readers`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Every CMS reader account with status `free` can reach the Free digest. The audience sync gives these readers a new role, `FREE`, and writes them to Mailercloud with a new tag. It admits at most a set number of readers per IST day. With the new settings off, nothing changes.

## Why (owner's words)
> Free = (a) every contact on `TaxscanNewsletterSubscribers` (`SwZafy`) + (b) every Feed 1 account with status free or ended, one copy per address. Exclude consent false, our unsubscribes, deleted, Premium. (Owner via the CMS session, 8 Nov; confirmed here 8 Nov: "Yes" to the rule and to a stepped rollout of about 10k a day.)
> "Let us build this. Mails for free users are sent manually only… and they send it only when there is credit." (owner, 8 Nov)

This replaces the 24 Oct ruling "Free = `SwZafy` only". Today, `ended` readers already have the role `FORMER` and carry the Former tag. A plain `free` account has the role `NONE`, so we never store its address and it is not in Mailercloud unless it is also on `SwZafy`. Count on 8 Nov: 74,512 free accounts, of which about 66k are not on `SwZafy`.

How Free will reach readers once this ships (setup only, nothing to build here): `DIGEST_FREE_SEGMENT_IDS` gets two Mailercloud segments that Anagha builds. One is `SwZafy` minus the Premium and No-marketing tags. The other matches contacts tagged Former OR the new Free-reader tag.

## Scope
**In:**
1. **Settings** (in `src/lib/env.ts`, in the `audience` block; plus `AUDIENCE_PULL_PAGE_PAUSE_MS`, Scope 8):
   - `AUDIENCE_FREE_READERS`: default off.
   - `AUDIENCE_FREE_ADMIT_PER_DAY`: integer, default `0`.
   - `AUDIENCE_MC_TAG_FREE`: the Mailercloud tag id for `TS Free reader (auto)`.
   - With the flag on and the tag unset, report a config problem, the way the other three tags already do (`writer.ts` ~L159).
2. **Rule** (`src/services/audience/rules.ts`, the single definition): add `FREE` to `MemberRole`.
   - With the flag on, an address that is not PREMIUM or FORMER becomes FREE when any live, in-scope account holding it is `free` and its consent is not an explicit `false`.
   - `null` consent counts as consent (owner, 22 Oct).
   - Precedence stays PREMIUM > FORMER > FREE > NONE, and `noMarketing` is unchanged.
   - With the flag off the rule is unchanged: a `free` account stays NONE. Update the header comment.
3. **Addresses.** With the flag on, a FREE address gets an `AudienceMember` row that stores the address, exactly like FORMER today.
   - The first full load after the switch must reach the ~74k free accounts we never stored.
   - The pull's "equal seq and same content → skip" path (`pull.ts`, header comment) must not skip a row that would make a new FREE member. That is the same idea as today's exception for a member row that lost its address.
   - The hourly pull and the webhook keep working as they do.
4. **Admission, at most N new FREE members per IST day** (`AUDIENCE_FREE_ADMIT_PER_DAY`; `0` = none admitted).
   - A FREE member the writer has not touched yet waits, not admitted, until there is room under that day's cap.
   - Admit first those already in Mailercloud: on `SwZafy` or another list, found by the writer's existing lookup. Then the rest, in a stable order of your choosing. Say which in the REPORT.
   - Record the admission time on the member: an additive column, for example `admittedAt`. The count per IST day comes from that column.
   - PREMIUM and FORMER work always goes first in the writer's queue and is never held by FREE admissions.
   - Removals are never capped: a FREE member that turns PREMIUM, NONE, unsubscribed or deleted is handled as today.
5. **Writer:** a FREE member gets only the Free-reader tag. Moving between roles swaps tags the way PREMIUM ⇄ FORMER does today. Creates go to `AUDIENCE_MC_LIST_ID` as today. Pacing, the 07:10–08:00 IST pause, create-only-after-404, the refusal log and **Retry refused** stay as they are and include FREE.
6. **Breaker and send guard:**
   - FREE role changes do not count toward `change_too_large` or `scope_change`, and they never trip `premium_removals`. Otherwise turning the flag on would trip the breaker at once.
   - The send guard's `pending_writes` stays about Premium only, so FREE members waiting for admission never hold a digest.
   - The `truncated_load` pause still stops FREE writes like any other write.
7. **Audience card** (Digests, ADMIN): one FREE line when the flag is on. Counts only: eligible, admitted, tagged, refused, waiting for admission, and admitted today against the cap. The admin guide gets one line, and its version is bumped.
8. **Pause between pages** (owner yes, 8 Nov, at the CMS's request: our 04:30 full pull, 17 pages back to back, set off a 7-hour CMS outage that the CMS team says was its own bug). Both pulls wait `AUDIENCE_PULL_PAGE_PAUSE_MS` (default `2000`, `0` = no pause) after applying a page and before requesting the next. No pause after the last page. The wait is injectable, so tests don't sleep. The full and hourly pulls, `updated_since`, single-flight and the 04:30 time stay as they are.
9. **Docs:** `docs/CMS_AUDIENCE_SYNC_DESIGN.md` (top ruling + §4 rule + the new settings); `docs/DIGEST_PILOT_RUNBOOK.md` (the rollout order below); `docs/EMAIL_DIGEST_DESIGN.md` §5 (setting list).

**Out (do not build):**
- Any change to Premium's target, the Free target code, or Send Free. `DIGEST_FREE_SEGMENT_IDS` already takes several ids; check this in test 10, don't change it.
- Creating or editing Mailercloud segments or tags, or any Railway setting.
- The credit stop-and-alert brief (separate).
- Ordering admissions by activity or reads.

## Acceptance tests
Each one must PASS in the REPORT.
1. Flag off: `memberRole` returns today's result for every existing rules test, and a `free` account is NONE.
2. Flag on: free + consent `null` → FREE; free + consent `true` → FREE; free + consent `false` → NONE with `noMarketing`; free + ended on one address → FORMER; free + active → PREMIUM; free but deleted or out of scope → NONE.
3. Flag on: a full load over stored free accounts at equal seq creates FREE member rows with the address, and makes no Mailercloud call by itself.
4. Admission: with a cap of 3 and 5 FREE members waiting, one IST day admits exactly 3. The next IST day admits the other 2. Members already in Mailercloud are admitted before the rest.
5. Cap `0`: no FREE member is admitted and no Mailercloud call is made for any. PREMIUM and FORMER writes still run.
6. A waiting FREE member that turns PREMIUM is written at once without using the cap, and it never gets the Free tag.
7. Moving FREE → NONE, FREE → unsubscribed or FREE → deleted removes the Free tag at once, without the cap.
8. Breaker: turning the flag on with 1,000 new FREE members in one run opens no breaker. A run with Premium changes above the limit still opens `change_too_large`.
9. Send guard: 1,000 FREE members waiting for admission leave `pending_writes` false.
10. `audienceTarget` for Free with two segment ids targets both (and still refuses an id shared with Premium).
11. With the flag on and `AUDIENCE_MC_TAG_FREE` unset, the boot reports a config problem and FREE writes are skipped.
12. Audience card: the FREE line shows the counts with the flag on, and is absent with it off. It never shows an address.
13. Page pause: a 3-page full pull calls the wait exactly twice with 2000 ms. A 1-page pull calls it 0 times. Setting `0` → no wait.

## Files
- `src/lib/env.ts`: three settings + the config problem.
- `src/services/audience/rules.ts`: FREE role.
- `src/services/audience/ingest.ts`, `pull.ts`: addresses for FREE, the equal-seq exception, the page pause.
- `src/services/audience/writer.ts`: admission, queue order, Free tag.
- `src/services/audience/breaker.ts`, `guard.ts`: FREE kept out of the change counts and pending writes.
- `src/services/audience/adminView.ts` + the Digests Audience card (ui-developer): FREE line.
- `prisma/schema.prisma` + one additive migration (admission column).
- Docs as listed; admin guide.
- Tests: the audience test files (`src/__tests__/audience*`, rules, writer, breaker, guard, pull) + new ones.

## Constraints
- Flags: `AUDIENCE_FREE_READERS` default off; `AUDIENCE_FREE_ADMIT_PER_DAY` default 0.
- Migrations: additive only.
- Full suite: **yes**, because this touches schema/migration and config/env.
- Never log or show an address. Never call a Mailercloud delete. Never send `contact_type`. Never use the batch or upsert contact endpoints (`docs/CMS_AUDIENCE_SYNC_DESIGN.md`).
- `AudienceMember.email` stays out of backups, as today. After a restore the full load refills addresses for FREE too.

## Context the builder needs
- Design: `docs/CMS_AUDIENCE_SYNC_DESIGN.md` §4 (rule), §5 (pulls), §8 (writer, breaker), §10 (guard).
- `memberRole()` in `rules.ts` is the single definition of the rule. `recomputeMembers()` in `ingest.ts` is the only writer of member rows.
- Writer pace in production is about 92 members a minute. A cap of 10,000 is therefore about 2 hours of writes a day, so it fits comfortably outside the 07:10–08:00 pause.
- Refusals: Mailercloud refused about 4% of Former creates with "Invalid email". Expect the same here; it is not a bug.
- The page pause (Scope 8) is the only change to how we call the CMS. The CMS's changed-since request is already covered by the hourly pull.

## Rollout after ship (planning session, not the build)
1. Owner creates the tag `TS Free reader (auto)`. The tag id goes into `AUDIENCE_MC_TAG_FREE`, then `AUDIENCE_FREE_READERS`=true with the cap still 0. Next full load: check the FREE count on the card (~74k eligible) and that no breaker opened.
2. Cap = 10,000. Each day, read refusals, then check bounces and complaints on the last Free send before the next batch.
3. Anagha builds the two Free segments; their ids go into `DIGEST_FREE_SEGMENT_IDS`, changed only outside 06:15–17:00 IST. Free is sent on Send Free, only when there is credit.
