-- CreateTable
CREATE TABLE "DigestTemplate" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL DEFAULT 'taxscan',
    "name" TEXT NOT NULL,
    "audience" "DigestAudience" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "format" TEXT NOT NULL DEFAULT 'HTML',
    "source" TEXT NOT NULL,
    "compiledHtml" TEXT,
    "compileError" TEXT,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "validatedAt" TIMESTAMP(3),
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "replacesId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigestTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DigestTemplate_portal_audience_status_idx" ON "DigestTemplate"("portal", "audience", "status");

-- Raw SQL (Prisma cannot model these; docs/EMAIL_DIGEST_DESIGN.md §3, task 10).
-- New table only: no existing table is touched, so no lock_timeout is needed.

-- The DATABASE enforces "one ACTIVE template per audience" (per portal).
CREATE UNIQUE INDEX "one_active_template_per_audience"
  ON "DigestTemplate" ("portal", "audience")
  WHERE "status" = 'ACTIVE';

-- Only the known lifecycle states and formats.
ALTER TABLE "DigestTemplate"
  ADD CONSTRAINT "DigestTemplate_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'SCHEDULED', 'ARCHIVED')),
  ADD CONSTRAINT "DigestTemplate_format_check" CHECK ("format" IN ('HTML', 'MJML'));

-- A SCHEDULED override always has a window, and the window is not empty.
ALTER TABLE "DigestTemplate"
  ADD CONSTRAINT "DigestTemplate_window_check" CHECK (
    "status" <> 'SCHEDULED' OR ("startsAt" IS NOT NULL AND "endsAt" IS NOT NULL AND "endsAt" > "startsAt")
  );

-- ACTIVE and SCHEDULED templates always carry compiled html.
ALTER TABLE "DigestTemplate"
  ADD CONSTRAINT "DigestTemplate_compiled_check" CHECK (
    "status" NOT IN ('ACTIVE', 'SCHEDULED') OR "compiledHtml" IS NOT NULL
  );
