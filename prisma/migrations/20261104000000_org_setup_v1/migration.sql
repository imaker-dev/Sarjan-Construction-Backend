-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "baseHeadOfficeId" UUID;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_baseHeadOfficeId_companyId_fkey" FOREIGN KEY ("baseHeadOfficeId", "companyId") REFERENCES "HeadOffice"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one primary Head Office per company (concurrency-safe).
CREATE UNIQUE INDEX "HeadOffice_one_primary_per_company"
  ON "HeadOffice"("companyId") WHERE "isPrimary" = true;
