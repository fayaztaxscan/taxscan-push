-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_clientRequestId_key" ON "Campaign"("clientRequestId");
