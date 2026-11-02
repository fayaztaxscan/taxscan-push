-- CreateTable
CREATE TABLE "LinkedInToken" (
    "id" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "envFingerprint" TEXT NOT NULL,
    "accessExpiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "renewedAt" TIMESTAMP(3),
    "lastCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInToken_page_key" ON "LinkedInToken"("page");
