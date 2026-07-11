-- CreateTable
CREATE TABLE "ArticleReadStat" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "pagePath" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "totalViews" INTEGER NOT NULL DEFAULT 0,
    "pushViews" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleReadStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArticleReadStat_date_idx" ON "ArticleReadStat"("date");

-- CreateIndex
CREATE INDEX "ArticleReadStat_pagePath_idx" ON "ArticleReadStat"("pagePath");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleReadStat_portal_pagePath_date_key" ON "ArticleReadStat"("portal", "pagePath", "date");
