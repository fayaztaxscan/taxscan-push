-- AlterTable
ALTER TABLE "DigestSend" ADD COLUMN     "htmlPurgedAt" TIMESTAMP(3),
ADD COLUMN     "webhookProofAt" TIMESTAMP(3);
