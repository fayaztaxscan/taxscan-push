-- CMS audience sync, task 3 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4, §6.3; CMS push-feed contract v1.2 §11).
-- Additive: three nullable columns on the (still empty) audience tables.
--  - CmsAccount.erasedAt: `account.deleted` with `erasure: true` — the account is never reactivated.
--  - CmsAccount.unknownStatus: an unrecognised status is kept verbatim here; `status` keeps the last
--    KNOWN one, so an unknown status never changes the account's role (design §4).
--  - AudienceMember.eraseRequestedAt: the Mailercloud erase (or No-marketing tag) is queued for the
--    writer (task 6), which nulls the address once Mailercloud has acknowledged it.

-- AlterTable
ALTER TABLE "AudienceMember" ADD COLUMN     "eraseRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CmsAccount" ADD COLUMN     "erasedAt" TIMESTAMP(3),
ADD COLUMN     "unknownStatus" TEXT;
