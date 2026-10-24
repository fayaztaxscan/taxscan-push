-- CMS audience sync, task 1 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4; CMS push-feed contract v1.1).
-- Additive only: four new tables, four new AuditAction values, and on EmailSuppression (a few
-- dozen rows) two nullable columns + email made nullable (a catalogue-only change). No existing
-- large table is touched; nothing reads or writes the new tables until audience task 3.
-- ALTER TYPE … ADD VALUE inside the migration transaction is fine on PostgreSQL ≥ 12 (prod 18.6):
-- the new values are not used in this transaction.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'AUDIENCE_SYNC_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIENCE_FULL_LOAD';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIENCE_ERASURE';
ALTER TYPE "AuditAction" ADD VALUE 'AUDIENCE_RESUBSCRIBED';

-- AlterTable
ALTER TABLE "EmailSuppression" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "emailHash" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CmsAccount" (
    "accountId" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "seq" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "plan" TEXT,
    "periodEnd" DATE,
    "consentValue" BOOLEAN,
    "consentAt" TIMESTAMP(3),
    "emailHash" TEXT,
    "deletedAt" TIMESTAMP(3),
    "lastSource" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmsAccount_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "AudienceMember" (
    "emailHash" TEXT NOT NULL,
    "email" TEXT,
    "desiredRole" TEXT NOT NULL,
    "noMarketing" BOOLEAN NOT NULL DEFAULT false,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "appliedTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mcState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastErrorKind" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceMember_pkey" PRIMARY KEY ("emailHash")
);

-- CreateTable
CREATE TABLE "CmsEventReceipt" (
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "signedTs" BIGINT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmsEventReceipt_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "AudienceSyncState" (
    "portal" TEXT NOT NULL,
    "lastFullAsOf" TIMESTAMP(3),
    "lastFullOkAt" TIMESTAMP(3),
    "lastIncrAsOf" TIMESTAMP(3),
    "lastIncrOkAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "cmsCounts" JSONB NOT NULL DEFAULT '{}',
    "breakerOpenAt" TIMESTAMP(3),
    "breakerReason" TEXT,
    "pendingReview" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceSyncState_pkey" PRIMARY KEY ("portal")
);

-- CreateIndex
CREATE INDEX "CmsAccount_emailHash_idx" ON "CmsAccount"("emailHash");

-- CreateIndex
CREATE INDEX "CmsAccount_status_idx" ON "CmsAccount"("status");

-- CreateIndex
CREATE INDEX "AudienceMember_nextAttemptAt_idx" ON "AudienceMember"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "AudienceMember_desiredRole_idx" ON "AudienceMember"("desiredRole");

-- CreateIndex
CREATE INDEX "CmsEventReceipt_receivedAt_idx" ON "CmsEventReceipt"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_emailHash_key" ON "EmailSuppression"("emailHash");

-- CreateIndex
CREATE INDEX "EmailSuppression_accountId_idx" ON "EmailSuppression"("accountId");

