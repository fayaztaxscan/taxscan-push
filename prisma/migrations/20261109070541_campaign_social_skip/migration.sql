-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "socialSkip" TEXT[] DEFAULT ARRAY[]::TEXT[];
