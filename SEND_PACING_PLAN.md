# Send-pacing + editorial-classifier plan (#5)

**Status:** Stages 1–3 BUILT & tested on `develop` — classifier filter
(`RSS_EDITORIAL_FILTER`), pacer (`PACER_ENABLED`, both default off), and the
review-queue admin screen (`/review`: Approve → QUALIFIED / Push-now / Reject).
The full editorial pipeline is complete; remaining work is rollout + config on
Railway. **Filed:** 2026-06-16. **Owner:** internal.

Goal: replace the current "every new RSS article → push immediately, throttled by a
per-subscriber cooldown that silently DROPS people" model with an **automated version of
the iZooto editorial workflow** the team ran by hand for years — same discipline, same
proven cadence, but automatic, with a human review step only for the genuinely ambiguous
articles.

This supersedes the summary in `KNOWN_ISSUES.md` #5.

---

## 1. The proven model we're automating (from editorial — Abhirami, 2026-06-16)

- iZooto was **100% manual** — no auto-push. An editor picked each article.
- They sent **up to 17 pushes/day**.
- They kept a **strict 45-minute minimum gap between sends** (a *global, channel-level*
  spacing rule — not a per-recipient rule).
- They pushed **only** for major authorities (allow-list below) + selected analytical
  articles, and **never** for ITAT/CESTAT/NCLAT/NCLT tribunal orders.

Real-data validation (33-article feed sample, 2026-06-16): **~64% of current auto-sends
are ITAT/CESTAT/NCLT** — exactly the content editors suppressed. The classifier removes
that dilution; pacing is handled by global spacing, not per-subscriber drops.

---

## 2. Editorial classification (title-based; CMS tags are not reliable)

Classify each new article by **title** (court/authority names are unambiguous in taxscan
titles, e.g. `…: CESTAT [Read Order]`). Lists live in **config** so editors can tweak
without a code change. Priority-ordered so the higher court wins mixed-authority titles
(e.g. "CESTAT … Jharkhand HC Directs …" → High Court).

**ALLOW (qualified — auto-eligible):**
Supreme Court, High Court, ICAI, DGFT, IBBI, GSTAT, PMLA, CBDT, CBIC.

**SKIP (fallback only — see §5):** ITAT, CESTAT, NCLAT, NCLT.

**JOB / RECRUITMENT posts** (taxscan job-scan content — "… Vacancy in …", "…
Hiring …", "… Recruitment …", walk-in/internship): → **review queue** (§6),
matched *before* the authority rules so a recruitment post that also names an
authority (e.g. "ICAI Recruitment") never auto-sends — an editor decides. Bare
"job"/"job work" is NOT treated as a job post (it's a GST concept).

**UNCLASSIFIED (no authority match):** mostly analytical/explanatory articles
("Understanding GST on …", "What S.58(3) Means …"). → **review queue** (§6).
Note: the `[Read Order]` marker does **not** reliably separate judgment from analysis
(explainers cite orders too), so we do not use it to auto-decide; that judgment stays human.

---

## 3. Article lifecycle (states)

```
new RSS item ──classify──▶ ALLOW        → QUALIFIED queue   (DRAFT, awaiting a slot)
                           SKIP         → FALLBACK pool     (DRAFT, filler only)
                           UNCLASSIFIED → REVIEW queue      (DRAFT, awaiting editor)

REVIEW queue ──editor──▶ Approve   → QUALIFIED queue (auto-sends next free slot)
                         Push now  → FORCE send immediately (§7)
                         Reject    → discarded, never sent

slot opens (§4) ──▶ pick top QUALIFIED; if none, pick top FALLBACK; send to full
                    targeted audience; increment daily count.
```

Nothing is ever silently dropped — articles are **deferred** to a later slot, not skipped.

---

## 4. Pacing rules

- **Global send spacing: 45 min** (`SEND_SPACING_MINUTES=45`) between *any* two channel
  pushes — **global across all topics** (decision D4), so an "All news" subscriber is never
  hit twice inside 45 min. Measured as time since the last SENT push of any kind (auto OR manual).
- **Daily ceiling: 20** (`DAILY_SEND_CEILING=20`), channel-level (campaigns dispatched
  since IST midnight). It **hard-stops the AUTOMATED pacer** at 20. **Manual force pushes
  are NOT blocked by it** — an editor can always push beyond 20 (editorial override) — but
  manual pushes still **count** toward the running total, so they bring the automated pacer
  to its 20 limit sooner. (Counted-in, but override-capable — decision D1.)
- **Quiet hours**: existing window still applies — no sends overnight. 45-min spacing
  across the active day naturally yields ≈17–20 slots, matching the proven cadence.
- **Per-subscriber cooldown: retired** (`MIN_GAP_MINUTES=0`). Global spacing + topic
  targeting replace it. A single-topic subscriber receives far fewer than 20/day; only an
  "All news" subscriber approaches the ceiling.

A node-cron tick (every minute) releases a slot when **all** are true: ≥45 min since last
push, outside quiet hours, daily count < 20, and something is pending. No Redis — "last
push" is `max(SENT)`; the queues are DRAFT campaigns; the daily count is a `count()` of
today's SENT campaigns.

---

## 5a. Morning backfill — fill empty morning slots from yesterday (2026-06-18)

Flag: `MORNING_BACKFILL_ENABLED` (default off), window end `MORNING_BACKFILL_UNTIL`
(default `12:00` IST). When ON, a slot that would otherwise sit empty in the morning
(after quiet hours, before the window end, and **only while today has produced no
qualified article yet**) is filled from **yesterday's** articles:

1. **Court rulings** — SC → Bombay HC → other HC. **Re-send allowed even if sent
   yesterday** (ties break by most clicks, then recency).
2. else **unsent other-category** items (regulatory/approved before tribunal filler).
3. else **other-category by most clicks** (re-send the best performers).

Each yesterday URL is re-used **at most once per day** (deduped against today's sends,
so the pacer rotates down the list). A re-send is a fresh clone (the original's stats
stay intact; the clone keeps the original's yesterday `createdAt` so it is not mistaken
for today's fresh content). Re-sends still respect the 45-min spacing and the 20/day
ceiling. As soon as the first fresh qualified article of the day publishes, backfill
switches off and normal selection (§5) resumes. Decided 2026-06-18: mornings-only;
once-each-then-rotate; yesterday's SC/HC re-send beats a fresh tribunal.

## 5. Slot selection — priority ranking

When a slot opens, pick the single best pending article by this sort:

1. **Pool** — QUALIFIED (allow-list + approved-unclassified) before FALLBACK
   (ITAT/CESTAT/NCLAT/NCLT). Fallback is used **only when no qualified item is pending**.
2. **Freshness, within qualified — today before older (decision D3).** If any qualified
   article published *today* is pending, never pick an older one. Older qualified items are
   **not discarded** — they wait and fill slots only when nothing from today is pending,
   draining **newest-day-first** until the queue empties. (So a day-old SC judgment is sent
   only on a slot where today produced nothing qualified.)
3. **Authority tier, within the same day** — Supreme Court → **priority High Court
   (Bombay)** → any other High Court → regulatory/announcement
   (ICAI/CBDT/CBIC/DGFT/IBBI/GSTAT/PMLA) + approved analytical. Priority benches are a
   config list (`PRIORITY_HIGH_COURTS` in `classify.ts`, default Bombay); add a court
   there to elevate it. A priority bench still ranks below today's Supreme Court and
   never jumps the cross-day freshness rule.
4. **Publish time — oldest first** (final tiebreak; revised 2026-06-18). A cluster
   of same-day, same-tier articles goes out **in the order it was published**, so the
   first-published ruling is sent first rather than last. (Was newest-first originally.)

An editor doesn't have to wait for the slot: the **Queue** screen (`/queue`) lists every
pending QUALIFIED/FALLBACK article in this exact send order, each with a **Push now**
button (full-reach force send — §7 semantics) to jump it ahead of its slot.

**FALLBACK** items rank by recency, **most-recent first** (decision D2); old tribunal
stories age out naturally and are not carried indefinitely.

On a busy day (≥20 qualified items) the fallback pool never sends. On a slow day it fills
otherwise-empty slots so the channel never sits idle.

---

## 6. Review queue (preserves human judgment, like iZooto)

Unclassified articles surface in an admin **Review queue**. Per item the editor can:
- **Approve** → moves to the QUALIFIED queue; auto-sends on the next free slot (ranked
  per §5), unless pushed manually first.
- **Push now** → immediate FORCE send (§7).
- **Reject** → discarded (captured in DB for the site, never pushed).

This is the only routine human touch-point — the SC/HC/tribunal bulk is fully automatic.

---

## 7. Manual / force push semantics

`force` (already built — commit `043b30c`) is the editorial override:
- **Bypasses the 45-min spacing** — sends immediately (the urgent-item escape hatch).
- **NOT blocked by the 20/day ceiling** — can always fire, even past 20 (decision D1), but
  **increments** the daily count (so manual sends bring the automated pacer to its limit sooner).
- **Resets the spacing clock** — the next auto slot waits 45 min from the manual push, so
  auto + manual can't cluster on a subscriber.
- Still bypasses the per-subscriber cap/cooldown (irrelevant once those are retired).

---

## 8. Config parameters (new / changed)

| Param | Value | Meaning |
|---|---|---|
| `SEND_SPACING_MINUTES` | 45 | global gap between channel pushes |
| `DAILY_SEND_CEILING` | 20 | channel-level daily ceiling, counts ALL sends incl. manual |
| `MIN_GAP_MINUTES` | 0 | retire the per-subscriber cooldown |
| `FREQ_CAP_PER_DAY` | (retire / superseded) | replaced by the channel-level ceiling |
| allow-list / skip-list | config | title-classifier authority lists |

---

## 9. Implementation sketch (Node/Express + node-cron + web-push; no Redis)

1. **Classifier** (`src/services/classify.ts`): pure function `classify(title) → {decision, authority, tier}`. Unit-tested against a fixture of real titles.
2. **Poller** stops dispatching inline; instead it *captures + classifies* into the
   QUALIFIED / FALLBACK / REVIEW states (DRAFT campaigns with a `queue`/`priority` tag).
3. **Pacer** (new cron tick): the slot-release logic in §4–§5. One query for last-send,
   one for today's count, one for the top pending item; then dispatch via the existing
   `executeCampaign`.
4. **Review API + SPA screen**: list unclassified DRAFTs; Approve / Push-now / Reject.
5. **Schema**: add a small enum/flag to `Campaign` (or `FeedItem`) for queue + priority +
   approval state. (A migration — additive, safe.)
6. **Tests**: classifier table, pacer spacing/ceiling/quiet-hours, review transitions,
   force-counts-toward-ceiling.

---

## 10. Decisions (resolved 2026-06-16)

- **D1 — ceiling vs. manual:** the 20/day ceiling **hard-blocks the automated pacer only**.
  **Manual force pushes can always fire, even past 20**, but they **count** toward the total
  (so they bring the automated pacer to its limit sooner). See §4, §7.
- **D2 — fallback order:** within ITAT/CESTAT/NCLAT/NCLT filler, **most-recent first**; old
  ones age out, not carried indefinitely. See §5.
- **D3 — freshness / carryover:** **today before yesterday.** Never pick an older qualified
  article while a today's qualified one is pending. Older qualified items are not discarded —
  they drain as filler (newest-day-first) only on slots where today has nothing qualified.
  See §5. **Revised 2026-06-18:** *within* a day+tier the order is now **oldest-published-first**
  (was newest-first), so a same-day cluster sends in publish order. The cross-day rule
  (today before older days) is unchanged.
- **D4 — spacing scope:** the 45-min gap is **global across all topics** (protects "All
  news" subscribers), matching iZooto. See §4.
- **D5 — approved-analytical ranking:** rank approved items in the normal regulatory/article
  tier with recency tiebreak (default). See §5.
- **D6 — priority high courts (2026-06-18):** designated benches (default **Bombay High
  Court**) automatically rank just below the Supreme Court and above all other High Courts,
  so their rulings jump the publish-order queue. Handled in the classifier, not by hand;
  the list (`PRIORITY_HIGH_COURTS`) is config so editors can add e.g. Delhi later. Tiers are
  now: 1 SC · 2 priority HC · 3 other HC · 4 regulatory/approved. See §5.

---

## 11. Rollout

Build + test on `develop`; deploy behind the existing send path. Because it changes live
behaviour materially, stage it: ship the **classifier filter first** (immediately stops the
ITAT/CESTAT dilution — the biggest win), then the **pacer**, then the **review queue**.
Watch CTR / unsub against the current 0.66% / 0.04% baseline after each stage.
