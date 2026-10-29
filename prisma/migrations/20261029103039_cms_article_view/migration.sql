-- CreateTable
CREATE TABLE "CmsArticleView" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "articleId" TEXT NOT NULL,
    "canonicalPath" TEXT NOT NULL,
    "externalId" TEXT,
    "date" DATE NOT NULL,
    "views" INTEGER NOT NULL,
    "pushViews" INTEGER,
    "digestViews" INTEGER,
    "cmsUpdatedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmsArticleView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmsArticleView_portal_canonicalPath_date_idx" ON "CmsArticleView"("portal", "canonicalPath", "date");

-- CreateIndex
CREATE INDEX "CmsArticleView_portal_externalId_date_idx" ON "CmsArticleView"("portal", "externalId", "date");

-- CreateIndex
CREATE INDEX "CmsArticleView_portal_date_idx" ON "CmsArticleView"("portal", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CmsArticleView_portal_articleId_date_key" ON "CmsArticleView"("portal", "articleId", "date");
