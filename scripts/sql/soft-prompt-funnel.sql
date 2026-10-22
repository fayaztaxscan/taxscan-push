-- Soft-prompt funnel: v1 vs v2, split by device and first-page-or-not.
--
-- READ-ONLY. Aggregates only — no endpoint, subscriber id or URL is selected.
--
-- Usage (dates are IST calendar days, both inclusive):
--   PGOPTIONS='-c default_transaction_read_only=on' \
--   psql "$DATABASE_URL" -v from=2026-10-15 -v to=2026-10-21 -f scripts/sql/soft-prompt-funnel.sql
--
-- For production, take DATABASE_PUBLIC_URL from the Railway *Postgres* service
-- (`railway variables --service Postgres --json`) — never print it.
--
-- The funnel, as public/taxscan-push.js records it (since PR #70, 2026-10-15):
--   PROMPT_SHOWN → PROMPT_ALLOW_CLICKED → PROMPT_ACCEPTED   (browser said yes)
--                                       → PROMPT_BLOCKED    (browser said no)
--                                       → PROMPT_IGNORED    (closed / ignored / Chrome's quiet bell)
--                → PROMPT_DECLINED, meta.how = no | close | escape (our card)
-- Every step carries meta {device, landing, variant, trigger}. Events without
-- meta come from SDK copies cached before the change and show as "(no meta)".
--
-- Comparing versions: v1 never asks on a reader's first page; v2 may (after 60%
-- scroll or 45 s). So compare BOTH the per-prompt rates AND the absolute grants
-- per day — v2 can convert a smaller share of a much larger number of prompts.
-- At ~17 grants a week, read differences of a few grants as noise.
--
-- Event."createdAt" is stored as UTC without a time zone; bounds below convert
-- the IST days to UTC.

\set ON_ERROR_STOP on
\pset footer off

\echo
\echo '== 1. Funnel by version / device / first page (rates are % of prompts shown) =='
WITH ev AS (
  SELECT type,
         COALESCE(meta->>'variant', '(no meta)') AS variant,
         COALESCE(meta->>'device', '—')          AS device,
         CASE meta->>'landing' WHEN 'true' THEN 'first page'
                               WHEN 'false' THEN 'later page'
                               ELSE '—' END      AS page,
         meta->>'how'                             AS how
  FROM "Event"
  WHERE type IN ('PROMPT_SHOWN', 'PROMPT_ALLOW_CLICKED', 'PROMPT_DECLINED',
                 'PROMPT_ACCEPTED', 'PROMPT_BLOCKED', 'PROMPT_IGNORED')
    AND "createdAt" >= (:'from'::date)::timestamp - interval '5 hours 30 minutes'
    AND "createdAt" <  (:'to'::date + 1)::timestamp - interval '5 hours 30 minutes'
)
SELECT variant,
       CASE WHEN GROUPING(device) = 1 THEN 'ALL' ELSE device END AS device,
       CASE WHEN GROUPING(page) = 1 THEN 'ALL' ELSE page END     AS page,
       COUNT(*) FILTER (WHERE type = 'PROMPT_SHOWN')         AS shown,
       COUNT(*) FILTER (WHERE type = 'PROMPT_ALLOW_CLICKED') AS tapped_allow,
       COUNT(*) FILTER (WHERE type = 'PROMPT_DECLINED')      AS said_no,
       COUNT(*) FILTER (WHERE type = 'PROMPT_ACCEPTED')      AS granted,
       COUNT(*) FILTER (WHERE type = 'PROMPT_BLOCKED')       AS browser_blocked,
       COUNT(*) FILTER (WHERE type = 'PROMPT_IGNORED')       AS browser_ignored,
       ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'PROMPT_ALLOW_CLICKED')
             / NULLIF(COUNT(*) FILTER (WHERE type = 'PROMPT_SHOWN'), 0), 2) AS pct_tapped_allow,
       ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'PROMPT_DECLINED')
             / NULLIF(COUNT(*) FILTER (WHERE type = 'PROMPT_SHOWN'), 0), 2) AS pct_said_no,
       ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'PROMPT_ACCEPTED')
             / NULLIF(COUNT(*) FILTER (WHERE type = 'PROMPT_SHOWN'), 0), 2) AS pct_granted,
       -- Of those who tapped our Allow, how many the browser's own prompt let through.
       ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'PROMPT_ACCEPTED')
             / NULLIF(COUNT(*) FILTER (WHERE type = 'PROMPT_ALLOW_CLICKED'), 0), 1) AS pct_allow_to_granted
FROM ev
GROUP BY GROUPING SETS ((variant), (variant, device), (variant, device, page))
ORDER BY variant, GROUPING(device) DESC, device, GROUPING(page) DESC, page;

\echo
\echo '== 2. How readers said no on our card (% of declines) =='
SELECT COALESCE(meta->>'variant', '(no meta)') AS variant,
       COALESCE(meta->>'how', '—')             AS how,
       COUNT(*)                                AS declines,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY COALESCE(meta->>'variant', '(no meta)')), 1) AS pct
FROM "Event"
WHERE type = 'PROMPT_DECLINED'
  AND "createdAt" >= (:'from'::date)::timestamp - interval '5 hours 30 minutes'
  AND "createdAt" <  (:'to'::date + 1)::timestamp - interval '5 hours 30 minutes'
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

\echo
\echo '== 3. What triggered the prompt, and how each trigger converted =='
SELECT COALESCE(meta->>'variant', '(no meta)') AS variant,
       COALESCE(meta->>'trigger', '—')         AS trigger,
       COUNT(*) FILTER (WHERE type = 'PROMPT_SHOWN')    AS shown,
       COUNT(*) FILTER (WHERE type = 'PROMPT_ACCEPTED') AS granted,
       ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'PROMPT_ACCEPTED')
             / NULLIF(COUNT(*) FILTER (WHERE type = 'PROMPT_SHOWN'), 0), 2) AS pct_granted
FROM "Event"
WHERE type IN ('PROMPT_SHOWN', 'PROMPT_ACCEPTED')
  AND "createdAt" >= (:'from'::date)::timestamp - interval '5 hours 30 minutes'
  AND "createdAt" <  (:'to'::date + 1)::timestamp - interval '5 hours 30 minutes'
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

\echo
\echo '== 4. Per IST day: prompts, grants, and real soft-prompt subscriptions =='
\echo '   (subscribed = SUBSCRIBED events with source soft-prompt; they carry no version,'
\echo '    so read them against the day the flag was switched.)'
WITH days AS (
  SELECT generate_series(:'from'::date, :'to'::date, interval '1 day')::date AS ist_day
), ev AS (
  SELECT ("createdAt" + interval '5 hours 30 minutes')::date AS ist_day, type, meta
  FROM "Event"
  WHERE type IN ('PROMPT_SHOWN', 'PROMPT_ACCEPTED', 'SUBSCRIBED')
    AND "createdAt" >= (:'from'::date)::timestamp - interval '5 hours 30 minutes'
    AND "createdAt" <  (:'to'::date + 1)::timestamp - interval '5 hours 30 minutes'
)
SELECT d.ist_day,
       COUNT(*) FILTER (WHERE e.type = 'PROMPT_SHOWN'    AND e.meta->>'variant' = 'v1') AS v1_shown,
       COUNT(*) FILTER (WHERE e.type = 'PROMPT_ACCEPTED' AND e.meta->>'variant' = 'v1') AS v1_granted,
       COUNT(*) FILTER (WHERE e.type = 'PROMPT_SHOWN'    AND e.meta->>'variant' = 'v2') AS v2_shown,
       COUNT(*) FILTER (WHERE e.type = 'PROMPT_ACCEPTED' AND e.meta->>'variant' = 'v2') AS v2_granted,
       COUNT(*) FILTER (WHERE e.type = 'PROMPT_SHOWN'    AND e.meta IS NULL)            AS no_meta_shown,
       COUNT(*) FILTER (WHERE e.type = 'SUBSCRIBED' AND e.meta->>'source' = 'soft-prompt') AS subscribed
FROM days d
LEFT JOIN ev e ON e.ist_day = d.ist_day
GROUP BY d.ist_day
ORDER BY d.ist_day;
