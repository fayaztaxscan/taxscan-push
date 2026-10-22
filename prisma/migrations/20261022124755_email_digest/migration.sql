-- CreateEnum
CREATE TYPE "DigestAudience" AS ENUM ('FREE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "DigestBuild" AS ENUM ('BUILDING', 'BUILT', 'BUILD_FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DigestApproval" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'HELD');

-- CreateEnum
CREATE TYPE "DigestSendState" AS ENUM ('PENDING', 'CREATED', 'SCHEDULED', 'SENT', 'PARTIALLY_SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SenderErrorKind" AS ENUM ('RETRYABLE', 'FATAL', 'AMBIGUOUS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_HELD';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_SEND_NOW';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_RETRY';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_TEST_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_SCHEDULED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_SKIPPED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_TEMPLATE_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_TEMPLATE_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_TEMPLATE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_TEMPLATE_REVERTED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_AD_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_AD_ARCHIVED';

-- CreateTable
CREATE TABLE "DigestRun" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "runDate" DATE NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "builtAt" TIMESTAMP(3),
    "build" "DigestBuild" NOT NULL DEFAULT 'BUILDING',
    "skipReason" TEXT,
    "approval" "DigestApproval" NOT NULL DEFAULT 'NOT_REQUIRED',
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "healthOk" BOOLEAN,
    "healthCheckedAt" TIMESTAMP(3),
    "healthError" TEXT,
    "alerts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestSend" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "audience" "DigestAudience" NOT NULL,
    "state" "DigestSendState" NOT NULL DEFAULT 'PENDING',
    "templateId" TEXT,
    "subject" TEXT NOT NULL,
    "preheader" TEXT NOT NULL,
    "html" TEXT,
    "text" TEXT,
    "htmlBytes" INTEGER NOT NULL,
    "mcCampaignName" TEXT NOT NULL,
    "mcCampaignId" TEXT,
    "sendAfter" TIMESTAMP(3) NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "sentConfirmedAt" TIMESTAMP(3),
    "sentVia" TEXT,
    "stepClaimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "firstFailureAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorKind" "SenderErrorKind",
    "targeted" INTEGER,
    "reached" INTEGER,
    "opens" INTEGER,
    "clicks" INTEGER,
    "rolledUnsub" INTEGER NOT NULL DEFAULT 0,
    "rolledBounce" INTEGER NOT NULL DEFAULT 0,
    "rolledSpam" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DigestSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DigestRun_portal_runDate_key" ON "DigestRun"("portal", "runDate");

-- CreateIndex
CREATE UNIQUE INDEX "DigestSend_mcCampaignName_key" ON "DigestSend"("mcCampaignName");

-- CreateIndex
CREATE UNIQUE INDEX "DigestSend_mcCampaignId_key" ON "DigestSend"("mcCampaignId");

-- CreateIndex
CREATE INDEX "DigestSend_state_nextAttemptAt_idx" ON "DigestSend"("state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "DigestSend_runId_audience_key" ON "DigestSend"("runId", "audience");

-- AddForeignKey
ALTER TABLE "DigestSend" ADD CONSTRAINT "DigestSend_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DigestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
