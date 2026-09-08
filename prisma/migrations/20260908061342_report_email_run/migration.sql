-- CreateTable
CREATE TABLE "ReportEmailRun" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipients" INTEGER NOT NULL,
    "sent" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "error" TEXT,

    CONSTRAINT "ReportEmailRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportEmailRun_portal_ranAt_idx" ON "ReportEmailRun"("portal", "ranAt");
