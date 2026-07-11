-- CreateTable
CREATE TABLE "GaReadsReport" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GaReadsReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GaReadsReport_portal_key" ON "GaReadsReport"("portal");
