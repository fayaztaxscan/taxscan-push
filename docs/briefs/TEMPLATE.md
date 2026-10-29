# Brief: <title>

- **Date / name:** <yyyy-mm-dd>-<name>  →  branch `build/<name>`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
<One or two sentences: what exists when this is done.>

## Why (owner's words)
> <quote / paraphrase with date>

## Scope
**In:**
- …

**Out (do not build):**
- …

## Acceptance tests
Each one must PASS in the REPORT.
1. …

## Files
- `<path>` — <what changes>
- Tests: `<path>`

## Constraints
- Flag: `<NAME>` default off (or "no flag — reason").
- Migrations: <none | additive only, name prefix …>
- Docs that ship with it: <none | admin guide page …>
- <Anything the code must not do.>

## Context the builder needs
<Pointers to design-doc sections, existing functions to reuse, traps from memory.>
