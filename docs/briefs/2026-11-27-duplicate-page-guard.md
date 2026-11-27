# Brief: one page, one id — duplicate page guard + campaignChannels test fix

- **Date / name:** 2026-11-27-duplicate-page-guard  →  branch `build/duplicate-page-guard`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
A shared social page (Facebook Shopscan/Academy, LinkedIn Academy/Shopscan) that is given the SAME page id / org URN as
another page of the same channel stays OFF, with a boot line saying so, instead of posting every push twice. And the
`campaignChannels.test.ts` random failure is gone.

## Why (owner's words)
> 27 Nov 2026: "A one-line fix for the random test failure, plus the guard against two pages sharing one page id. - Yes"

Facts: the facebook-academy-page build noted nothing stops two Facebook pages sharing one page id (that page would get
every push twice — a policy risk with Facebook). The same gap was noted for LinkedIn on 4 Nov ("Academy URN guard").
Release check 1 on 27 Nov failed on `campaignChannels.test.ts`: `RUN` ends in 6 random hex; when all 6 are digits
(~6 %/run) `articleKey()` (`/-(\d{4,})$/`) reads them as the article id, every seeded URL gets the same key, and
`whatsAppPost.create` hits the unique `(portal, articleKey)`.

## Scope
**In:**
1. **Facebook:** when building `env.facebook.sharedPages`, a shared page whose page id equals the Taxscan page's
   (`FACEBOOK_TAXSCAN_PAGE_ID`) or an EARLIER shared page's (order = `SHARED_PAGES`: Shopscan, then Academy) is left OUT.
   Its boot line reads `[facebook] <page> page off: FACEBOOK_<PAGE>_PAGE_ID is the same page as <other> (it would post
   every push twice)` — names only, never the id.
2. **LinkedIn:** the same for `env.linkedin.sharedPages` on the org URN (vs `LINKEDIN_TAXSCAN_ORG_URN`, then the earlier
   shared page in its own order), with the matching boot line (`[linkedin] <page> page off: …`).
3. One pure helper per channel (or one generic) so the env builder and the boot line read the SAME result; no second copy
   of the rule. Compare after trim; URNs compare exactly.
4. **Test fix:** `src/__tests__/campaignChannels.test.ts` — make `RUN` never end in digits only (e.g. prefix the random
   part with a letter: `` `${Date.now()}-r${…hex}` ``). Test-only.

**Out (do not build):**
- No screen change (an off page simply isn't listed, as today).
- Telegram / WhatsApp (one destination each).
- No change to any page's live behaviour while ids differ (today's prod: all different — verified 27 Nov).

## Acceptance tests
Each one must PASS in the REPORT.
1. Facebook Academy id = Taxscan's → Academy not in `sharedPages`, `portalPages()` = Taxscan + Shopscan, boot line names the clash, no id printed.
2. Facebook Academy id = Shopscan's (both otherwise valid) → Shopscan on, Academy off with the clash line.
3. Facebook all three different → all on (today's prod shape); Shopscan's id = Taxscan's → Shopscan off, Academy still on.
4. LinkedIn: Academy URN = Taxscan's → Academy off; Shopscan URN = Academy's → Shopscan off, Academy on; all different → all on.
5. Ids with surrounding spaces count as the same.
6. The worker still starts in every case (a shared page never blocks start); a tick with a clashed page makes no row and no call for it.
7. `campaignChannels.test.ts`: with `RUN`'s random part forced to digits-only hex (temporary test, not committed — or a
   committed unit check on the `RUN` shape), the file passes; without the fix it fails (say so in the REPORT).
8. Facebook, LinkedIn, social pages/pageStatus, Compose skip and campaignChannels tests pass.

## Files
- `src/lib/env.ts` (shared-page builders + helper), `src/services/facebook/worker.ts` and the LinkedIn worker (boot lines)
- `src/__tests__/campaignChannels.test.ts` (RUN)
- Tests: Facebook/LinkedIn env + worker tests (new cases)
- `docs/FACEBOOK_POSTING.md`, `docs/LINKEDIN_POSTING.md`: one line each on the guard.

## Constraints
- Flag: none — it only refuses a configuration that would double-post; every valid prod config is unchanged.
- Migrations: none.
- Full suite: yes — touches config/env.
- Never print a page id, URN or token in a log line or the REPORT.

## Context the builder needs
- Facebook: `parseSharedFacebookPage`, `env.facebook.sharedPages`, `SHARED_PAGES`, boot loop with `SHARED_PAGE_ENV` in
  `src/services/facebook/worker.ts` (from brief 2026-11-27-facebook-academy-page).
- LinkedIn: `parseSharedLinkedInPage`, `env.linkedin.sharedPages` (Academy then Shopscan), its boot lines.
- `articleKey()` and the `-<id>` pattern: CLAUDE.md "2 Nov, PR #94".
