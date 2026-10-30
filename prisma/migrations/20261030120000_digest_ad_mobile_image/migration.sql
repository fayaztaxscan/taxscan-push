-- Digest ads get a second creative: the mobile square (additive, nullable). Existing ads keep their single
-- image as the desktop banner; an ad without a mobile square shows its banner on phones too.
ALTER TABLE "DigestAd" ADD COLUMN "mobileImageId" TEXT;
ALTER TABLE "DigestAd" ADD CONSTRAINT "DigestAd_mobileImageId_fkey" FOREIGN KEY ("mobileImageId") REFERENCES "DigestAdImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
