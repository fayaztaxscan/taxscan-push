-- CreateEnum
CREATE TYPE "SubscriberStatus" AS ENUM ('ACTIVE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('SENT', 'DELIVERED', 'CLICKED', 'DISMISSED', 'SUBSCRIBED', 'UNSUBSCRIBED', 'PROMPT_SHOWN', 'PROMPT_ACCEPTED');

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "topics" TEXT[],
    "userAgent" TEXT,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "icon" TEXT,
    "target" JSONB NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "subscriberId" TEXT,
    "type" "EventType" NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_endpoint_key" ON "Subscriber"("endpoint");

-- CreateIndex
CREATE INDEX "Subscriber_portal_idx" ON "Subscriber"("portal");

-- CreateIndex
CREATE INDEX "Subscriber_status_idx" ON "Subscriber"("status");

-- CreateIndex
CREATE INDEX "Campaign_portal_idx" ON "Campaign"("portal");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "Campaign_scheduledAt_idx" ON "Campaign"("scheduledAt");

-- CreateIndex
CREATE INDEX "Event_campaignId_idx" ON "Event"("campaignId");

-- CreateIndex
CREATE INDEX "Event_subscriberId_idx" ON "Event"("subscriberId");

-- CreateIndex
CREATE INDEX "Event_type_idx" ON "Event"("type");

-- CreateIndex
CREATE INDEX "Event_createdAt_idx" ON "Event"("createdAt");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
