-- Digest: a write-ahead "create sent" stamp, set just before the createDraft() call.
-- Add-column only, nullable; nothing existing changes.
ALTER TABLE "DigestSend" ADD COLUMN "createSentAt" TIMESTAMP(3);
