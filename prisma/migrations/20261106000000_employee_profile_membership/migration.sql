-- Milestone 1B: employee operational profile + DepartmentMembership.
CREATE TYPE "EmploymentEngagementType" AS ENUM ('DIRECT_EMPLOYEE','CONTRACTOR_WORKER','DAILY_WAGE','APPRENTICE','CONSULTANT','OTHER');

-- Additive + nullable: legacy Employee rows keep NULL until profile update.
ALTER TABLE "Employee" ADD COLUMN "engagementType" "EmploymentEngagementType",
  ADD COLUMN "designation" TEXT,
  ADD COLUMN "tradeCategory" TEXT,
  ADD COLUMN "joiningDate" DATE,
  ADD COLUMN "contactPhone" TEXT,
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "emergencyContactName" TEXT,
  ADD COLUMN "emergencyContactPhone" TEXT;

CREATE TABLE "DepartmentMembership" (
  "id"           UUID                     NOT NULL DEFAULT gen_random_uuid(),
  "companyId"    UUID                     NOT NULL,
  "employeeId"   UUID                     NOT NULL,
  "departmentId" UUID                     NOT NULL,
  "isPrimary"    BOOLEAN                  NOT NULL DEFAULT FALSE,
  "startedAt"    TIMESTAMPTZ              NOT NULL DEFAULT now(),
  "endedAt"      TIMESTAMPTZ,
  "version"      INTEGER                  NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMPTZ              NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ              NOT NULL,
  CONSTRAINT "DepartmentMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DepartmentMembership_employeeId_companyId_fkey"
    FOREIGN KEY ("employeeId","companyId") REFERENCES "Employee"("id","companyId") ON DELETE RESTRICT,
  CONSTRAINT "DepartmentMembership_departmentId_companyId_fkey"
    FOREIGN KEY ("departmentId","companyId") REFERENCES "Department"("id","companyId") ON DELETE RESTRICT
);

-- Single source of truth: endedAt IS NULL => ACTIVE.
-- At most one ACTIVE membership per (employee, department).
CREATE UNIQUE INDEX "DepartmentMembership_active_emp_dept_uq"
  ON "DepartmentMembership"("companyId","employeeId","departmentId")
  WHERE "endedAt" IS NULL;
-- At most one ACTIVE PRIMARY membership per (employee, company).
CREATE UNIQUE INDEX "DepartmentMembership_active_primary_uq"
  ON "DepartmentMembership"("companyId","employeeId")
  WHERE "endedAt" IS NULL AND "isPrimary";
CREATE INDEX "DepartmentMembership_emp_ended_idx" ON "DepartmentMembership"("companyId","employeeId","endedAt");
CREATE INDEX "DepartmentMembership_dept_ended_idx" ON "DepartmentMembership"("companyId","departmentId","endedAt");
