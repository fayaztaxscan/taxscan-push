# Brief: digest — let dark mode recolour the button and header together

- **Date / name:** 2026-11-02-digest-dark-mode-colours  →  branch `build/digest-dark-mode-colours`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
In a dark-mode mail app, the built-in digest's **Read More** buttons (and ad CTA buttons) and the **"Daily Digest · date"**
line under the logo stay readable. To get there we remove the trick that pins the button and header *backgrounds*, so
the app recolours background and text together, the way it already treats the old hand-made Mailercloud newsletter.
Light-mode looks stay exactly as they are now.

## Why (owner's words)
> Anagha, 2 Nov: "1. Read more button text color change to some dark colors  2. Case digest text with date at the top
> below logo color change". Owner said **yes to 1 and 2** on 2 Nov.

Diagnosis (planning, 2 Nov): our button text is already `#000` on `#FEE620`, and the date line is `#fff` on `#3b3543`.
`solid()` (`renderer.ts`) adds `background-image:linear-gradient(c,c)` so dark-mode apps can't recolour the
**background**, but they still recolour the **text**. The result is white text on yellow (her "pale Read More") and dark
text on purple (her "date not visible"). The owner's iPhone dark-mode screenshot of the old newsletter shows the app
recolouring both together (dark olive button, light text): readable. Removing the pin is removing a hack, which fits
the 30 Oct "no dark-mode hacks" decision.

## Scope
**In:**
- `button()` (Read More + ad CTAs): drop `${solid(C.button)}` from the link's inline style. Keep `bgcolor`,
  `background-color:#FEE620`, `color:#000000`, sizes, phone rules.
- Header cell (`ts-hdr`, the `<td>` with the logo + "Daily Digest · {{date}}"): drop `${solid(C.brand)}`. Keep
  `bgcolor` + `background-color:#3b3543` and the white text.
- `<style>`: remove the Outlook forced-colour line
  (`[data-ogsb] .ts-hdr…`, `[data-ogsb] .ts-btn…`, `[data-ogsc] .ts-btn…`, `[data-ogsc] .ts-hdr-text…`) and update the
  comment above it. Outlook should recolour like every other app.
- If `solid()` then has no callers except the brand block (below), leave it in place for that use.
- Update the tests that pin the old behaviour (`digestPolish.test.ts` ~70–77, `digestOldFormat.test.ts` ~160,
  `digestTemplates.test.ts` ~668–682) so they assert the new behaviour. Don't just delete them.
- `docs/EMAIL_DIGEST_DESIGN.md` ~1093: the header bar is no longer "kept in dark mode". One line saying apps recolour
  the bar and buttons in dark mode (owner, 2 Nov).

**Out (do not build):**
- No colour, size, layout, wording or position changes. The date line stays on the bar and the button stays yellow
  in light mode.
- Do not touch the brand block (`ts-brand`, the picture placeholder with the logo, ~line 821). It keeps its `solid()`.
- Do not change `<meta name="color-scheme" content="light">` / `supported-color-schemes`.
- Phone layout / stacking (Anagha's point 3): the owner hasn't decided, so it is not part of this brief.
- Custom (ACTIVE) templates on the Templates screen: no change; the buttons there come from the same `button()`.

## Acceptance tests
Each one must PASS in the REPORT.
1. A rendered built-in digest (FREE and PREMIUM, with ads) contains **no** `linear-gradient(#FEE620` and **no**
   `linear-gradient(#3b3543` on the header cell. The brand block may still carry its own.
2. No `[data-ogsb]` or `[data-ogsc]` rule appears in the output.
3. Light-mode colours unchanged: every Read More/ad-CTA link still has `background-color:#FEE620` + `color:#000000`,
   and its cell still has `bgcolor="#FEE620"`. The header cell still has `bgcolor="#3b3543"` + `background-color:#3b3543`,
   and `.ts-hdr-text` is still `color:#ffffff`.
4. HTML size does not grow: the worst-case sample (`digestPolish`/size tests) is ≤ its current value.
5. The updated tests above plus the rest of the `digest*` test files pass. Also `tsc` and lint are clean.
6. Visual check (ui-developer, real browser): the Templates → "Preview built-in" in light mode looks identical to
   before (screenshot before/after, desktop + 375 px).

## Files
- `src/services/digest/renderer.ts`: `button()` (~236), header row in the built-in shell (~915), `<style>` block (~888–893).
- Tests: `src/__tests__/digestPolish.test.ts`, `src/__tests__/digestOldFormat.test.ts`, `src/__tests__/digestTemplates.test.ts`.
- `docs/EMAIL_DIGEST_DESIGN.md`: one line.

## Constraints
- Flag: none. It's a look change to the built-in template, and stage 2 only sends to the 3-person staff list.
- Migrations: none.
- Docs that ship with it: the design-doc line above. No admin-guide change.
- Today's frozen run HTML is not re-rendered. The change applies from the next 06:30 build.

## Context the builder needs
- `solid()` and its comment: `renderer.ts` ~226. The comment explains why it was added. That reasoning is what this brief reverses.
- Memory trap: we can't verify real dark-mode clients from here (Zoho, iOS Mail, Gmail apps). The real check is
  the next staff send on Anagha's and the owner's phones. Say so in the REPORT. Don't claim it's verified.
