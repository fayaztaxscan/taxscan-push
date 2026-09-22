-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "rolledClicked" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rolledFailed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rolledFirstSentAt" TIMESTAMP(3),
ADD COLUMN     "rolledSent" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "EventRollup" (
    "id" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventRollup_type_key" ON "EventRollup"("type");
