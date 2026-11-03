-- CreateEnum
CREATE TYPE "FacebookPostStatus" AS ENUM ('PENDING', 'POSTED', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'FACEBOOK_POSTING_RESUMED';

-- CreateTable
CREATE TABLE "FacebookPost" (
    "id" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "articleKey" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "FacebookPostStatus" NOT NULL DEFAULT 'PENDING',
    "facebookPostId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacebookPost_status_nextAttemptAt_idx" ON "FacebookPost"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookPost_page_articleKey_key" ON "FacebookPost"("page", "articleKey");
