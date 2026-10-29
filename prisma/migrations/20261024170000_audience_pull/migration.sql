-- CMS audience sync, task 5: the pull (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.2–§5.4, §8.2, §10.2).
-- Additive only: nullable columns / columns with constant defaults on two small tables (no rewrite).
--  - CmsAccount."outOfScopeAt": the absence rule's marker (an account missing from a COMPLETE full
--    load). memberRole ignores such an account; any later snapshot clears it.
--  - AudienceSyncState."lastFullRowCount": the 90% acceptance rule + the scope-change (allowlist → all) check.
--  - AudienceSyncState.counters: daily seq_conflict / unknown_status counts + Premium removals (24 h breaker).
--  - AudienceSyncState.alerts: audience alert markers (once per kind per IST day), emailed through the digest alert copy.

ALTER TABLE "CmsAccount" ADD COLUMN "outOfScopeAt" TIMESTAMP(3);

ALTER TABLE "AudienceSyncState" ADD COLUMN "lastFullRowCount" INTEGER;
ALTER TABLE "AudienceSyncState" ADD COLUMN "counters" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "AudienceSyncState" ADD COLUMN "alerts" JSONB NOT NULL DEFAULT '{}';
