-- Milestone 1A: organization setup fields + per-scope department uniqueness.
CREATE TYPE "DepartmentCategory" AS ENUM ('FINANCE','ADMINISTRATION','OPERATIONS','PROCUREMENT','SAFETY','HR','QUALITY','CUSTOM');
CREATE TYPE "ProjectType" AS ENUM ('RESIDENTIAL','COMMERCIAL','INDUSTRIAL','INFRASTRUCTURE','OTHER');

ALTER TABLE "HeadOffice" ADD COLUMN "legalName" TEXT,
  ADD COLUMN "addressLine1" TEXT, ADD COLUMN "addressLine2" TEXT, ADD COLUMN "locality" TEXT,
  ADD COLUMN "city" TEXT, ADD COLUMN "district" TEXT, ADD COLUMN "state" TEXT,
  ADD COLUMN "pinCode" TEXT, ADD COLUMN "country" TEXT,
  ADD COLUMN "contactName" TEXT, ADD COLUMN "contactPhone" TEXT, ADD COLUMN "contactEmail" TEXT;

ALTER TABLE "Department" ADD COLUMN "category" "DepartmentCategory" NOT NULL DEFAULT 'CUSTOM',
  ADD COLUMN "categoryLabel" TEXT;

ALTER TABLE "Project" ADD COLUMN "projectType" "ProjectType" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "clientName" TEXT, ADD COLUMN "contractRef" TEXT,
  ADD COLUMN "locationCity" TEXT, ADD COLUMN "locationDistrict" TEXT,
  ADD COLUMN "locationState" TEXT, ADD COLUMN "locationPin" TEXT;

ALTER TABLE "Site" ADD COLUMN "addressLine1" TEXT, ADD COLUMN "addressLine2" TEXT,
  ADD COLUMN "locality" TEXT, ADD COLUMN "city" TEXT, ADD COLUMN "district" TEXT,
  ADD COLUMN "state" TEXT, ADD COLUMN "pinCode" TEXT, ADD COLUMN "country" TEXT;

-- Scoped department-code uniqueness: company-wide rows unambiguous, the same
-- code may repeat inside distinct project/site scopes.
DROP INDEX "Department_companyId_code_key";
CREATE UNIQUE INDEX "Department_company_code_uq" ON "Department"("companyId","code")
  WHERE "projectId" IS NULL AND "siteId" IS NULL;
CREATE UNIQUE INDEX "Department_company_project_code_uq" ON "Department"("companyId","projectId","code")
  WHERE "projectId" IS NOT NULL;
CREATE UNIQUE INDEX "Department_company_site_code_uq" ON "Department"("companyId","siteId","code")
  WHERE "siteId" IS NOT NULL;

-- Full construction-department category list (ALTER TYPE ADD VALUE is
-- additive; existing CUSTOM rows are untouched).
ALTER TYPE "DepartmentCategory" ADD VALUE IF NOT EXISTS 'STORE';
ALTER TYPE "DepartmentCategory" ADD VALUE IF NOT EXISTS 'MACHINERY';
ALTER TYPE "DepartmentCategory" ADD VALUE IF NOT EXISTS 'SITE_ENGINEERING';
ALTER TYPE "DepartmentCategory" ADD VALUE IF NOT EXISTS 'KITCHEN';
