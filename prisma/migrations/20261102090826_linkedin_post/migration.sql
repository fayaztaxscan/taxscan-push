-- CreateEnum
CREATE TYPE "LinkedInPostStatus" AS ENUM ('PENDING', 'POSTED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "LinkedInPost" (
    "id" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "articleKey" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "LinkedInPostStatus" NOT NULL DEFAULT 'PENDING',
    "linkedinPostId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkedInPost_status_nextAttemptAt_idx" ON "LinkedInPost"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInPost_page_articleKey_key" ON "LinkedInPost"("page", "articleKey");
