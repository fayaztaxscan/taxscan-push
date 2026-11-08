-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "socialImageId" TEXT;

-- CreateTable
CREATE TABLE "SocialImage" (
    "id" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialImage_pkey" PRIMARY KEY ("id")
);
