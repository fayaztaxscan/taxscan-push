-- CreateEnum
CREATE TYPE "SearchSurface" AS ENUM ('DISCOVER', 'GOOGLE_NEWS');

-- CreateTable
CREATE TABLE "ArticleSurfaceStat" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "pagePath" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "surface" "SearchSurface" NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleSurfaceStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArticleSurfaceStat_date_idx" ON "ArticleSurfaceStat"("date");

-- CreateIndex
CREATE INDEX "ArticleSurfaceStat_pagePath_idx" ON "ArticleSurfaceStat"("pagePath");

-- CreateIndex
CREATE INDEX "ArticleSurfaceStat_surface_idx" ON "ArticleSurfaceStat"("surface");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleSurfaceStat_portal_pagePath_date_surface_key" ON "ArticleSurfaceStat"("portal", "pagePath", "date", "surface");
