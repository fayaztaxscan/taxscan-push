-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "objectKey" TEXT,
    "rows" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "tables" JSONB NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupRun_ranAt_idx" ON "BackupRun"("ranAt");
