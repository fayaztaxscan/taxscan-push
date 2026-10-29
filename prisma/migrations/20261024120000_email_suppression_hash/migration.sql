-- CMS audience sync, prep for task 3 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4, §6.2, §6.3).
-- EmailSuppression.emailHash becomes the row's identity for every writer: the CMS feed can write
-- hash-only rows (an erased or withheld address), so an address must never end up as two rows.
--
-- 1. A BEFORE INSERT/UPDATE trigger derives "emailHash" = sha256(email) (lower-case hex of the UTF-8
--    bytes, exactly what emailHash() in src/services/digest/webhook.ts computes) whenever email is
--    set. Setting email to NULL (an erasure) keeps the hash. Every writer — the Mailercloud webhook,
--    the restore script, a hand-written INSERT — gets the same hash without having to remember it.
-- 2. Backfill the existing rows (a few dozen in production; one UPDATE).
--
-- Additive: no column or index changes; the table is tiny. Prisma does not model triggers — never
-- accept a generated migration that drops this one (same rule as the AuditLog guard).

CREATE OR REPLACE FUNCTION email_suppression_hash_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    NEW."emailHash" := encode(sha256(convert_to(NEW.email, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_suppression_hash_before
  BEFORE INSERT OR UPDATE OF email, "emailHash" ON "EmailSuppression"
  FOR EACH ROW EXECUTE FUNCTION email_suppression_hash_guard();

UPDATE "EmailSuppression"
   SET "emailHash" = encode(sha256(convert_to(email, 'UTF8')), 'hex')
 WHERE email IS NOT NULL
   AND ("emailHash" IS NULL OR "emailHash" <> encode(sha256(convert_to(email, 'UTF8')), 'hex'));
