-- Track per-delivery failure outcomes so the dashboard can compute delivery rate.
-- Postgres requires ADD VALUE outside a transaction; Prisma's migrate deploy
-- handles this when the file contains only ALTER TYPE statements.

ALTER TYPE "EventType" ADD VALUE 'FAILED';
