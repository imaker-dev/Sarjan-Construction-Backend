-- CreateEnum
CREATE TYPE "DepartmentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "projectId" UUID,
    "siteId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capabilityKey" TEXT,
    "headEmployeeId" UUID,
    "status" "DepartmentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_companyId_status_id_idx" ON "Department"("companyId", "status", "id");

-- CreateIndex
CREATE INDEX "Department_companyId_projectId_status_id_idx" ON "Department"("companyId", "projectId", "status", "id");

-- CreateIndex
CREATE INDEX "Department_companyId_siteId_status_id_idx" ON "Department"("companyId", "siteId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Department_companyId_code_key" ON "Department"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_id_companyId_key" ON "Employee"("id", "companyId");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_headEmployeeId_companyId_fkey" FOREIGN KEY ("headEmployeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Scope-column consistency (hand-added; not expressible in the Prisma schema):
-- exactly the column matching scopeType may be set; HEAD_OFFICE scope is
-- rejected outright. A site-scoped department stores siteId only — its project
-- is resolved through the Site row.
ALTER TABLE "Department" ADD CONSTRAINT "Department_scope_check" CHECK (
  ("scopeType" = 'COMPANY' AND "projectId" IS NULL     AND "siteId" IS NULL)
  OR ("scopeType" = 'PROJECT' AND "projectId" IS NOT NULL AND "siteId" IS NULL)
  OR ("scopeType" = 'SITE'    AND "siteId"    IS NOT NULL AND "projectId" IS NULL)
);
