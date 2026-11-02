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

---

## Follow-up 1 (owner, 2 Nov): phone pictures fill the column + the header becomes one banner image

**Why.** The owner sent iPhone Mail dark-mode screenshots of the 31 Oct Premium digest. Readability is good with
stacking, and the owner said "readability is also important", so **keep the stacked phone layout** (Anagha's point 3
is answered by this, not by a redesign). Two flaws showed up: (a) on the phone each story picture is narrower than the
text below it, leaving a gap on the right; (b) iPhone Mail turned the purple header bar light grey, so the logo PNG,
which has its own purple background, sits as a dark patch on a light bar. Owner: "go with recommendation".

**In:**
1. **Pictures fill the column on phones.** At ≤600 px, every story picture (og:image, the default story picture and
   the brand block `ts-brand`) is exactly as wide as the text column below it, at its own aspect ratio (no crop
   change on desktop). Find out why it isn't today (the inline `width:280px`, a fixed-width parent cell, or the
   `ts-stcol` wrapper) and fix that cause. ICYMI stays text-only.
2. **Header = one full-width banner image** (built-in template only), like the old newsletter's banner:
   - New file `public/email/taxscan-header-1800x220.png`: 1800×220 (2× of 900×110). Solid `#3b3543` edge to edge,
     the existing white Taxscan logo centred at the same visual size as today (220 px at 1×). Make it from
     `public/email/taxscan-logo-white-440.png`. **No new npm dependency.** A one-off script under `scripts/` or any
     local tool is fine, but commit only the PNG (target ≤ 25 KB) and note in the REPORT how it was made.
   - The header row draws `<img>` of that banner, `width="900"`, `width:100%;max-width:900px;height:auto;display:block`,
     alt "Taxscan", linked to `{{home_url}}`. The banner's row has **no** `bgcolor`/`background-color` of its own; the
     picture carries the colour.
   - **The date line moves just below the banner**, on the white card: "Daily Digest · {{date}}", centred, Arial
     15/22, `#111111`, about 14 px padding top and bottom. The Premium badge stays beside it, with its border and
     text in `#111111` (no longer white).
   - This supersedes the main brief's header items: the `ts-hdr` cell and `.ts-hdr-text` no longer exist in the
     built-in shell, so main-brief acceptance test 3's header half is replaced by the tests below. Keep the old
     files `taxscan-logo-on-dark-440.png` / `taxscan-logo-white-440.png` in place, because sent mail references them.
   - Phone CSS: drop the `.ts-hdr` / `.ts-logo` rules that no longer match anything. The banner scales by itself.

**Out:** custom (ACTIVE) templates. `{{logo}}` and every other placeholder keep their current output, so a custom
template renders byte-for-byte as before. No change to story/ICYMI/ad/footer markup beyond item 1. No colour change
anywhere else.

**Acceptance tests (add to the REPORT):**
F1. A rendered built-in digest's header is a single `<img>` whose src ends `/email/taxscan-header-1800x220.png`, with
    `width="900"`, alt "Taxscan", inside a link to the digest home URL. The header row has no background colour.
F2. The PNG is exactly 1800×220, ≤ 25 KB, and its corner pixels are `#3b3543`.
F3. "Daily Digest · <date>" appears after the banner, in `#111111` on the white card. In PREMIUM the badge is
    present with a `#111111` border/text, and in FREE it's absent.
F4. At 375 px (ui-developer, real browser, Templates → Preview built-in): every story picture's width equals the
    text column's width (±1 px), and the banner spans the full email width. Desktop at 900 px looks as before apart
    from the header (before/after screenshots of both widths).
F5. A custom template using `{{logo}}` renders exactly as on `origin/develop` (snapshot or string-equal test).
F6. Worst-case size stays ≤ its current value (the banner is one image tag, so it should shrink slightly).
