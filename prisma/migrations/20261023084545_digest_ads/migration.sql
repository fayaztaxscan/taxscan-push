-- CreateTable
CREATE TABLE "DigestAd" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "altText" TEXT NOT NULL,
    "body" TEXT,
    "ctaText" TEXT NOT NULL,
    "linkUrl" TEXT NOT NULL,
    "imageId" TEXT,
    "audience" TEXT NOT NULL,
    "topic" TEXT,
    "slots" INTEGER[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isSlotDefault" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigestAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestAdImage" (
    "id" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestAdImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestAdPlacement" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "utmContent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestAdPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DigestAd_portal_status_idx" ON "DigestAd"("portal", "status");

-- CreateIndex
CREATE INDEX "DigestAdPlacement_adId_createdAt_idx" ON "DigestAdPlacement"("adId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DigestAdPlacement_sendId_slot_key" ON "DigestAdPlacement"("sendId", "slot");

-- AddForeignKey
ALTER TABLE "DigestAd" ADD CONSTRAINT "DigestAd_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "DigestAdImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestAdPlacement" ADD CONSTRAINT "DigestAdPlacement_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "DigestSend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestAdPlacement" ADD CONSTRAINT "DigestAdPlacement_adId_fkey" FOREIGN KEY ("adId") REFERENCES "DigestAd"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
