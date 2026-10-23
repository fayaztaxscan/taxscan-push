-- Task 13 (digest scheduler tick, health checks, complaint-rate hold, adopted-draft approval).
-- New nullable columns on the digest tables only; no table outside the digest is touched
-- and nothing is backfilled.
ALTER TABLE "DigestRun" ADD COLUMN "complaintCheck" JSONB;
ALTER TABLE "DigestRun" ADD COLUMN "webhookCheckedAt" TIMESTAMP(3);
ALTER TABLE "DigestRun" ADD COLUMN "webhookActive" BOOLEAN;
ALTER TABLE "DigestSend" ADD COLUMN "adoptedDraftAt" TIMESTAMP(3);
