-- AlterTable
ALTER TABLE "AudienceMember" ADD COLUMN     "admittedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AudienceMember_admittedAt_idx" ON "AudienceMember"("admittedAt");
