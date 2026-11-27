-- Surfaces keeps only clicked rows (brief 2026-11-27-surfaces-clicked-only). Data only, safe to run again.
-- Space is reclaimed separately (VACUUM FULL cannot run inside a migration).
DELETE FROM "ArticleSurfaceStat" WHERE clicks = 0;
