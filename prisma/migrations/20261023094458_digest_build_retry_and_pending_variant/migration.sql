-- AlterTable
ALTER TABLE "DigestRun" ADD COLUMN     "buildAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "buildError" TEXT,
ADD COLUMN     "buildFailure" TEXT,
ADD COLUMN     "buildFirstFailureAt" TIMESTAMP(3),
ADD COLUMN     "buildNextAttemptAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DigestSend" ADD COLUMN     "contentPendingAt" TIMESTAMP(3);
