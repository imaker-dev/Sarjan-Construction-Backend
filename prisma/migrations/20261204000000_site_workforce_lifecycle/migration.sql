-- W4: site/project workforce suspension, exit, and reinstatement.
--
-- * DepartmentMembershipEndReason enum + end metadata on DepartmentMembership
--   (all nullable -- legacy ended rows stay valid as "unspecified ending")
-- * supersededBy composite self-FK: a replacement membership must belong to
--   the same employee and company as the ended row
-- * SiteWorkforceExit append-only marker: permanent per-employee/scope exit
--   record that blocks reinstatement of suspended rows (it does NOT block
--   fresh placement -- it records the decision, not a hiring ban)
-- * memberSuspend / memberExit delegation flags (default OFF -- a missing
--   policy row means nothing is delegated)

CREATE TYPE "DepartmentMembershipEndReason" AS ENUM
  ('PLACEMENT_END', 'TRANSFERRED', 'SUSPENDED', 'EXITED', 'DEACTIVATED');

ALTER TABLE "DepartmentMembership"
  ADD COLUMN "endReason"    "DepartmentMembershipEndReason",
  ADD COLUMN "endNote"      TEXT,
  ADD COLUMN "suspendUntil" DATE,
  ADD COLUMN "supersededBy" UUID;

-- suspendUntil is meaningful only on SUSPENDED rows. COALESCE makes the
-- predicate evaluate FALSE (not NULL) for legacy null-reason rows -- a bare
-- `endReason = 'SUSPENDED'` would evaluate NULL and pass the CHECK.
ALTER TABLE "DepartmentMembership"
  ADD CONSTRAINT "DepartmentMembership_suspendUntil_suspended_ck"
  CHECK ("suspendUntil" IS NULL OR COALESCE("endReason"::text, '') = 'SUSPENDED');

-- Composite FK target for supersession (same company + same employee).
CREATE UNIQUE INDEX "DepartmentMembership_companyId_employeeId_id_key"
  ON "DepartmentMembership"("companyId", "employeeId", "id");

ALTER TABLE "DepartmentMembership"
  ADD CONSTRAINT "DepartmentMembership_supersededBy_fkey"
  FOREIGN KEY ("companyId", "employeeId", "supersededBy")
  REFERENCES "DepartmentMembership"("companyId", "employeeId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SiteWorkforceExit" (
  "id"                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  "companyId"           UUID        NOT NULL,
  "employeeId"          UUID        NOT NULL,
  "siteId"              UUID,
  "projectId"           UUID,
  "exitedAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "exitedByPrincipalId" UUID,
  "note"                TEXT,
  CONSTRAINT "SiteWorkforceExit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SiteWorkforceExit_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT,
  CONSTRAINT "SiteWorkforceExit_employeeId_companyId_fkey"
    FOREIGN KEY ("employeeId","companyId") REFERENCES "Employee"("id","companyId") ON DELETE RESTRICT,
  CONSTRAINT "SiteWorkforceExit_siteId_companyId_fkey"
    FOREIGN KEY ("siteId","companyId") REFERENCES "Site"("id","companyId") ON DELETE RESTRICT,
  CONSTRAINT "SiteWorkforceExit_projectId_companyId_fkey"
    FOREIGN KEY ("projectId","companyId") REFERENCES "Project"("id","companyId") ON DELETE RESTRICT,
  CONSTRAINT "SiteWorkforceExit_exitedByPrincipalId_fkey"
    FOREIGN KEY ("exitedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT,
  -- Exactly one target scope: site OR project.
  CONSTRAINT "SiteWorkforceExit_one_scope_ck"
    CHECK (num_nonnulls("siteId","projectId") = 1)
);

-- One exit decision per employee per scope -- repeat exits are conflicts.
CREATE UNIQUE INDEX "SiteWorkforceExit_site_uq"
  ON "SiteWorkforceExit"("companyId","employeeId","siteId")
  WHERE "siteId" IS NOT NULL;
CREATE UNIQUE INDEX "SiteWorkforceExit_project_uq"
  ON "SiteWorkforceExit"("companyId","employeeId","projectId")
  WHERE "projectId" IS NOT NULL;
CREATE UNIQUE INDEX "SiteWorkforceExit_id_companyId_key"
  ON "SiteWorkforceExit"("id","companyId");
CREATE INDEX "SiteWorkforceExit_companyId_employeeId_idx"
  ON "SiteWorkforceExit"("companyId","employeeId");

ALTER TABLE "CompanyDelegationPolicy"
  ADD COLUMN "memberSuspend" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "memberExit"    BOOLEAN NOT NULL DEFAULT false;
