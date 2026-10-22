-- AlterTable
ALTER TABLE "DigestRun" ADD COLUMN     "readsNote" TEXT,
ADD COLUMN     "readsSource" TEXT,
ADD COLUMN     "readsUsed" BOOLEAN;

-- CreateTable
CREATE TABLE "DigestItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "audience" "DigestAudience",
    "articleKey" TEXT NOT NULL,
    "campaignId" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authority" TEXT,
    "category" TEXT NOT NULL,
    "excerpt" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "readRate" DOUBLE PRECISION,

    CONSTRAINT "DigestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DigestItem_articleKey_idx" ON "DigestItem"("articleKey");

-- CreateIndex
CREATE INDEX "DigestItem_campaignId_idx" ON "DigestItem"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "DigestItem_runId_articleKey_audience_key" ON "DigestItem"("runId", "articleKey", "audience");

-- AddForeignKey
ALTER TABLE "DigestItem" ADD CONSTRAINT "DigestItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DigestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestItem" ADD CONSTRAINT "DigestItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
