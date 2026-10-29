# Brief: Digest footer says "Write to info@taxscan.in"

- **Date / name:** 2026-10-29-digest-footer-contact → branch `build/digest-footer-contact`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
The digest footer's line "Questions or feedback? Just reply to this email." becomes
**"Questions or feedback? Write to info@taxscan.in"**, with the address as a `mailto:` link, in both the HTML and
the plain-text part, for Free and Premium.

## Why (owner's words)
> 2026-10-29: Mailercloud is restricted to @hello.taxscan.in, so the reply-to is now `info@hello.taxscan.in`, and
> mail to @hello.taxscan.in lands at Mailercloud, not a real inbox. Owner: "change that line to 'Questions or
> feedback? Write to info@taxscan.in'".

## Scope
**In:**
- `src/services/digest/renderer.ts` ~line 850 (HTML footer) and ~line 1071 (plain text): the new sentence.
  - In HTML, `info@taxscan.in` is a `mailto:info@taxscan.in` link in the footer's existing link style.
  - In text: `Questions or feedback? Write to info@taxscan.in`.
  - Keep the reason sentence before it (`FREE_REASON` / `PREMIUM_REASON`) unchanged.
- The `mailto:` link must pass the renderer's own link checks. If the template link rules (e.g.
  `templates.ts` / the checklist) refuse `mailto:`, allow **exactly** `mailto:info@taxscan.in` and nothing broader,
  the same way the social links were allowed. No UTM on it.
- Saved templates: if the footer comes from a placeholder, they get the new text automatically. If a saved
  template hard-codes the old sentence, say so in the REPORT (there are none in production yet).
- Tests: update `digestLookalike.test.ts:315`; add an assertion for the text part and the link.

**Out:** the reply-to address and any env (stays `MAILERCLOUD_REPLY_EMAIL=info@hello.taxscan.in`); the reason
sentences; the guide.

## Acceptance tests
1. Free and Premium HTML contain the new sentence with a `mailto:info@taxscan.in` link; the text part contains the
   plain sentence; neither contains "Just reply".
2. The link checks accept `mailto:info@taxscan.in` and still refuse any other `mailto:` in a template.
3. The worst-case size stays under 75 KB (paste the numbers).
4. tsc, lint (0 errors), the full suite: green.

## Constraints
No flag, no migration, no env. Small: one commit.
