-- CreateEnum
CREATE TYPE "SendQueue" AS ENUM ('QUALIFIED', 'FALLBACK', 'REVIEW');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "authority" TEXT,
ADD COLUMN     "sendQueue" "SendQueue";

-- CreateIndex
CREATE INDEX "Campaign_sendQueue_idx" ON "Campaign"("sendQueue");
