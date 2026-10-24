-- CMS audience sync, QA L3 on 381fb25 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4, §6.2).
-- The EmailSuppression trigger (20261024120000) hashed `email` VERBATIM, while the app hashes the
-- NORMALISED address (src/services/digest/webhook.ts normaliseEmail → emailHash). A row written by
-- hand, or restored from an old file, with " Foo@Example.COM" got a hash no reader lookup matches.
--
-- 1. CREATE OR REPLACE the trigger function so it normalises exactly like the app before hashing,
--    and stores the normalised address:
--      - trim = JavaScript String.prototype.trim(): every Unicode WhiteSpace + LineTerminator
--        (TAB LF VT FF CR SPACE U+00A0 U+1680 U+2000–U+200A U+2028 U+2029 U+202F U+205F U+3000
--        U+FEFF) from both ends — Postgres's btrim() with a character set;
--      - lower-case = JavaScript toLowerCase(). Postgres lower() agrees for ASCII under every locale
--        and leaves an already lower-cased string unchanged, but NOT for every non-ASCII capital
--        (e.g. U+0130 → JS "i̇", Postgres "i"; U+1E9E → JS "ß", Postgres unchanged). So a NON-ASCII
--        address that is not already in normal form is REFUSED (exception) rather than hashed
--        differently from the app. The app always stores the JS-normalised form, which passes
--        through unchanged.
--      - control characters (U+0000–U+001F, U+007F after trimming) are refused, as normaliseEmail
--        refuses them. The app applies no IDN/punycode conversion, so neither does this.
--    The trigger itself (email_suppression_hash_before) is unchanged and keeps pointing at the
--    function.
-- 2. Re-backfill the rows whose email or hash is not what the app would compute. A row whose
--    normalised form collides with another row's address or hash, or that the function would refuse,
--    is left as is (RAISE NOTICE with a count, never an address); none exist in production (every row
--    there came from the app).
--
-- Additive: no column or index changes. Prisma does not model triggers — never accept a generated
-- migration that drops this one.

CREATE OR REPLACE FUNCTION email_suppression_js_trim(v text) RETURNS text AS $$
  SELECT btrim(v, chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199)
    || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288)
    || chr(65279));
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION email_suppression_normalise(v text) RETURNS text AS $$
DECLARE
  t text := email_suppression_js_trim(v);
  n text;
BEGIN
  IF t ~ '[\x01-\x1f\x7f]' THEN
    RAISE EXCEPTION 'EmailSuppression.email: control characters are not allowed' USING ERRCODE = '22023';
  END IF;
  n := lower(t);
  IF n <> t AND t ~ '[^\x01-\x7f]' THEN
    RAISE EXCEPTION 'EmailSuppression.email: store the normalised (lower-case) form of a non-ASCII address' USING ERRCODE = '22023';
  END IF;
  RETURN n;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION email_suppression_hash_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    NEW.email := email_suppression_normalise(NEW.email);
    NEW."emailHash" := encode(sha256(convert_to(NEW.email, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  r record;
  n text;
  h text;
  fixed int := 0;
  skipped int := 0;
BEGIN
  FOR r IN SELECT id, email, "emailHash" FROM "EmailSuppression" WHERE email IS NOT NULL LOOP
    BEGIN
      n := email_suppression_normalise(r.email);
    EXCEPTION WHEN invalid_parameter_value THEN
      skipped := skipped + 1;
      CONTINUE;
    END;
    h := encode(sha256(convert_to(n, 'UTF8')), 'hex');
    IF r.email = n AND r."emailHash" IS NOT DISTINCT FROM h THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM "EmailSuppression" o WHERE o.id <> r.id AND (o.email = n OR o."emailHash" = h)) THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;
    UPDATE "EmailSuppression" SET email = n WHERE id = r.id;
    fixed := fixed + 1;
  END LOOP;
  RAISE NOTICE 'EmailSuppression normalise backfill: % fixed, % left (collision or refused)', fixed, skipped;
END;
$$;
