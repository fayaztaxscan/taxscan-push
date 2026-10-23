-- AlterTable
ALTER TABLE "DigestSend" ADD COLUMN     "createAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "scheduleAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "stepAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stepFirstFailureAt" TIMESTAMP(3);
