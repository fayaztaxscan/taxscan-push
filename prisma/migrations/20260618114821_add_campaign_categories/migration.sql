-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "categories" TEXT[] DEFAULT ARRAY[]::TEXT[];
