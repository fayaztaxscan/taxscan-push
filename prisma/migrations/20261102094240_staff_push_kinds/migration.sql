-- AlterTable
ALTER TABLE "StaffPushSubscription" ADD COLUMN     "kinds" TEXT[] DEFAULT ARRAY['digest']::TEXT[];
