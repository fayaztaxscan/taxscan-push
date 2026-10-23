-- AlterTable
ALTER TABLE "DigestSend" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "ownApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "templateFallbackFromId" TEXT,
ADD COLUMN     "templateFallbackReason" TEXT;
