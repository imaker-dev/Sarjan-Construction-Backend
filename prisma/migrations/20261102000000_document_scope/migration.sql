-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "headOfficeId" UUID,
ADD COLUMN     "projectId" UUID,
ADD COLUMN     "scopeType" "ScopeType" NOT NULL DEFAULT 'COMPANY',
ADD COLUMN     "siteId" UUID;

-- CreateIndex
CREATE INDEX "Document_companyId_scopeType_idx" ON "Document"("companyId", "scopeType");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_headOfficeId_companyId_fkey" FOREIGN KEY ("headOfficeId", "companyId") REFERENCES "HeadOffice"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The matching scope column must be set for the scope type (mirrors
-- RoleAssignment_scope_check); composite FKs above keep the target in-company.
ALTER TABLE "Document" ADD CONSTRAINT "Document_scope_check" CHECK (
  ("scopeType" = 'COMPANY'      AND "headOfficeId" IS NULL     AND "projectId" IS NULL     AND "siteId" IS NULL)
  OR ("scopeType" = 'HEAD_OFFICE' AND "headOfficeId" IS NOT NULL AND "projectId" IS NULL     AND "siteId" IS NULL)
  OR ("scopeType" = 'PROJECT'     AND "projectId"    IS NOT NULL AND "headOfficeId" IS NULL  AND "siteId" IS NULL)
  OR ("scopeType" = 'SITE'        AND "siteId"       IS NOT NULL AND "headOfficeId" IS NULL  AND "projectId" IS NULL)
);
