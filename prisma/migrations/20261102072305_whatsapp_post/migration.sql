-- CreateEnum
CREATE TYPE "WhatsAppPostStatus" AS ENUM ('POSTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "WhatsAppPost" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "articleKey" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "WhatsAppPostStatus" NOT NULL,
    "actedByUserId" TEXT,
    "actedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppPost_portal_articleKey_key" ON "WhatsAppPost"("portal", "articleKey");

-- AddForeignKey
ALTER TABLE "WhatsAppPost" ADD CONSTRAINT "WhatsAppPost_actedByUserId_fkey" FOREIGN KEY ("actedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
