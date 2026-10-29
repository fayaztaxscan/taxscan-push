-- AlterTable
ALTER TABLE "AudienceMember" ADD COLUMN     "resubscribePending" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AudienceSyncState" ADD COLUMN     "drift" JSONB;
