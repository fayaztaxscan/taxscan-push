# Brief: soft prompt — the scroll trigger counts only a real reader's scroll

- **Date / name:** 2026-11-03-soft-prompt-real-scroll  →  branch `build/soft-prompt-real-scroll`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). Reader soft prompt (`public/taxscan-push.js`) →
  ui-developer; the env/config line → backend-developer (one at a time).

## Goal
The v2 soft prompt's **scroll** trigger fires only after a real person has scrolled a visible tab, so robots, background
tabs and tiny "scrolls" on short or still-loading pages no longer count as prompts shown. Behind a flag, default off.

## Why (owner's words)
> 3 Nov 2026: "Our opt in rates have dropped heavily in last days. what can we do? Should we roll back to earlier format?"
> Planning: don't roll back; fix the trigger. Owner: "Yes".

**Evidence (prod, read-only, v2 since 22 Oct 10:43 UTC; 24 Oct–3 Nov):**

| device / page / trigger | shown | said no | tapped Allow | granted |
|---|---|---|---|---|
| desktop · first page · **scroll** | **78,787** | 930 | 13 | **5** |
| desktop · first page · dwell (45 s) | 4,360 | 1,226 | 59 | 24 |
| mobile · first page · dwell | 3,189 | 912 | 52 | 18 |
| mobile · first page · scroll | 1,866 | 608 | 16 | 8 |
| second pages (both) | ~1,000 | ~220 | 7 | 2 |

Desktop first-page **scroll** shows arrive **flat at ~300 / hour around the clock, incl. 01:00–05:00 IST**, and ~99 % get no
reaction at all — robots / headless renders / background tabs, or the handler firing on a non-human scroll. Everything
else converts ~0.5 % of prompts → granted (v1 baseline ~0.6 %). Real grants are UP with v2 (~5/day vs ~0.4/day in v1's
last week), so the "rate drop" is a polluted denominator.

The current handler (`armSoftPrompt`, ~line 440): ANY `scroll` event where `scrollTop / (scrollHeight − clientHeight) ≥ 0.6`
shows the card — a programmatic scroll, a scroll-restore, or a page barely taller than the window (max of a few px) passes.

## Scope
**In** (only when the new flag is on; flag off = today's behaviour byte for byte):
1. **Real-input gate:** the scroll trigger may fire only after the page has seen at least one genuine user input on it:
   `wheel`, `touchmove`, `keydown` (scroll keys: arrows / PgUp / PgDn / Space / Home / End), or `pointerdown`
   (scrollbar drag) — `isTrusted` events only.
2. **Real distance:** the reader must have scrolled at least **one full window height** (`scrollTop ≥ clientHeight`) in
   addition to the ratio, and the page must be at least **2 window heights** tall (`scrollHeight ≥ 2 × clientHeight`) at
   that moment; otherwise keep listening (the page may still be loading).
3. **Visible tab:** no trigger (scroll or dwell) shows the card while `document.visibilityState !== 'visible'`; a dwell
   timer that fires in a hidden tab waits and shows when the tab becomes visible (if still allowed) — or simply re-arms;
   your choice, say which.
4. Applies to both first-page and later-page scroll triggers. Dwell (45 s / 30 s) and second-page timings unchanged
   apart from 3.
5. **Flag:** env `SOFT_PROMPT_REAL_SCROLL` (default off) → `/api/config` field (e.g. `promptRealScroll: true|false`) →
   the SDK reads it like `promptVariant`. Keep the `trigger` meta values unchanged (`scroll`, `dwell`, `second-page`) —
   `/api/track` has a strict enum allow-list; don't add values.
6. Update `scripts/sql/soft-prompt-funnel.sql` header comment with the switch date placeholder, and `CLAUDE.md`'s note
   stays for planning (don't edit it).

**Out (do not build):**
- Copy, design, timings, v1/v2 switch, topic chips, recapture, the service worker.
- Bot detection by user-agent, any server-side filtering of stored events.

## Acceptance tests
1. Unit (pure helpers, like `promptTriggers` today): a scroll with no prior trusted input → no show; after a trusted
   `wheel` → show at ≥ 60 % AND ≥ one window AND page ≥ 2 windows; a page 1.2 windows tall never shows by scroll; flag off
   → today's rule exactly.
2. Unit: hidden tab → neither trigger shows; becomes visible → behaves as documented in item 3.
3. Unit: `/api/config` carries the flag; default off; `/api/track` enum unchanged.
4. Real browser (desktop 1280 and phone 375), with the flag on, on a local page using the SDK:
   - a real mouse-wheel scroll past 60 % + one window → card shows, `PROMPT_SHOWN` with `trigger=scroll`;
   - `window.scrollTo(0, 99999)` from the console with no input → no card;
   - a short page → no card by scroll; dwell still shows after 45 s on a first page (v2).
   Do **not** create events in production; never prompt a real reader during testing.
5. tsc, lint, the soft-prompt test file(s) pass.

## Files
- `public/taxscan-push.js` (`armSoftPrompt`, `maybeShow`, cfg), `src/lib/env.ts`, `src/routes/api.ts` (`/api/config`),
  `.env.example`, `scripts/sql/soft-prompt-funnel.sql` (comment only)
- Tests: `src/__tests__/softPrompt.test.ts` (+ new cases)

## Constraints
- Flag: `SOFT_PROMPT_REAL_SCROLL` default off.
- Migrations: none.
- Full suite: no — area tests: `nice -n 10 npx jest src/__tests__/softPrompt` (+ any `/api/config` test file it touches).
- Hard rule stays: never trigger the native permission prompt directly; the soft card first.
- The SDK is served to every taxscan.in reader — keep it ES5-safe like the rest of the file, no new dependencies.

## Context the builder needs
- taxscan.in is a Nuxt SPA; the SDK is injected ~6 s after navigation. Verify the SDK in a browser, not `curl`.
- After deploy, planning measures: grants/day and shown/day by device/trigger with `scripts/sql/soft-prompt-funnel.sql`
  over 7 days vs 24 Oct–3 Nov. **Stop rule:** if real grants fall below ~4/day for a week, switch the flag off.
