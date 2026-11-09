-- CreateEnum
CREATE TYPE "TelegramPostStatus" AS ENUM ('PENDING', 'POSTED', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'TELEGRAM_POSTING_RESUMED';

-- CreateTable
CREATE TABLE "TelegramPost" (
    "id" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "pushKey" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "TelegramPostStatus" NOT NULL DEFAULT 'PENDING',
    "messageId" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramPost_status_nextAttemptAt_idx" ON "TelegramPost"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TelegramPost_campaignId_idx" ON "TelegramPost"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramPost_page_pushKey_key" ON "TelegramPost"("page", "pushKey");
