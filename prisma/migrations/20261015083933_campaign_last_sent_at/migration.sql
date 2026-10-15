-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "lastSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Campaign_lastSentAt_idx" ON "Campaign"("lastSentAt");

-- Backfill: the latest live SENT event per campaign (Event keeps 30 days of
-- SENT rows; older ones are rolled up), falling back to the rolled first-sent
-- time for campaigns whose delivery rows have all been rolled up. Only the last
-- 7-14 days matter to the screens that read this, so the fallback just keeps
-- old SENT campaigns from reading as never-sent.
UPDATE "Campaign" c
SET "lastSentAt" = s.last_sent
FROM (
  SELECT "campaignId", MAX("createdAt") AS last_sent
  FROM "Event"
  WHERE "type" = 'SENT' AND "campaignId" IS NOT NULL
  GROUP BY "campaignId"
) s
WHERE c."id" = s."campaignId";

UPDATE "Campaign"
SET "lastSentAt" = "rolledFirstSentAt"
WHERE "lastSentAt" IS NULL AND "rolledFirstSentAt" IS NOT NULL;
