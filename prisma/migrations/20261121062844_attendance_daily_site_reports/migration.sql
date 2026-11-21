-- CreateEnum
CREATE TYPE "DailyReportStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED');

-- CreateEnum
CREATE TYPE "WeatherCondition" AS ENUM ('CLEAR', 'OVERCAST', 'LIGHT_RAIN', 'HEAVY_RAIN', 'STORMY', 'EXTREME_HEAT');

-- CreateEnum
CREATE TYPE "LabourCategory" AS ENUM ('CAT_A_STAFF', 'CAT_B_DIRECT_LABOUR', 'CAT_C_SUBCONTRACTOR');

-- DropForeignKey
ALTER TABLE "ProjectBudget" DROP CONSTRAINT "ProjectBudget_latestApprovedRevisionId_fkey";

-- AlterTable
ALTER TABLE "WorkScheduleRevision" ALTER COLUMN "rotationWorkingOffsets" DROP DEFAULT,
ALTER COLUMN "rotationOffOffsets" DROP DEFAULT;

-- CreateTable
CREATE TABLE "DailySiteReport" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "businessDate" VARCHAR(10) NOT NULL,
    "status" "DailyReportStatus" NOT NULL DEFAULT 'DRAFT',
    "weather" "WeatherCondition" NOT NULL DEFAULT 'CLEAR',
    "weatherStoppageHours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "workProgressNotes" TEXT,
    "siteObstaclesRemarks" TEXT,
    "safetyIncidentReported" BOOLEAN NOT NULL DEFAULT false,
    "safetyNotes" TEXT,
    "totalWorkersHeadcount" INTEGER NOT NULL DEFAULT 0,
    "totalPresentUnits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "totalOvertimeHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "totalOvertimePUnits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "totalFlaggedSessions" INTEGER NOT NULL DEFAULT 0,
    "catAStaffCount" INTEGER NOT NULL DEFAULT 0,
    "catAStaffUnits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "catBDirectCount" INTEGER NOT NULL DEFAULT 0,
    "catBDirectUnits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "catCSubconCount" INTEGER NOT NULL DEFAULT 0,
    "catCSubconUnits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "submittedById" UUID,
    "submittedAt" TIMESTAMPTZ,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ,
    "rejectionReason" TEXT,
    "lockedById" UUID,
    "lockedAt" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "DailySiteReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySiteReportLabour" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "category" "LabourCategory" NOT NULL,
    "subcontractorId" UUID,
    "subcontractorName" VARCHAR(150),
    "tradeCategory" VARCHAR(100) NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "presentUnits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "remarks" VARCHAR(255),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "DailySiteReportLabour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyReportAuditLog" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "fieldName" VARCHAR(100),
    "oldValue" TEXT,
    "newValue" TEXT,
    "reason" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyReportAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailySiteReport_companyId_siteId_businessDate_idx" ON "DailySiteReport"("companyId", "siteId", "businessDate");

-- CreateIndex
CREATE INDEX "DailySiteReport_companyId_status_idx" ON "DailySiteReport"("companyId", "status");

-- CreateIndex
CREATE INDEX "DailySiteReport_companyId_businessDate_idx" ON "DailySiteReport"("companyId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailySiteReport_id_companyId_key" ON "DailySiteReport"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "DailySiteReport_companyId_siteId_businessDate_key" ON "DailySiteReport"("companyId", "siteId", "businessDate");

-- CreateIndex
CREATE INDEX "DailySiteReportLabour_companyId_reportId_idx" ON "DailySiteReportLabour"("companyId", "reportId");

-- CreateIndex
CREATE INDEX "DailySiteReportLabour_companyId_category_idx" ON "DailySiteReportLabour"("companyId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "DailySiteReportLabour_id_companyId_key" ON "DailySiteReportLabour"("id", "companyId");

-- CreateIndex
CREATE INDEX "DailyReportAuditLog_companyId_reportId_createdAt_idx" ON "DailyReportAuditLog"("companyId", "reportId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyReportAuditLog_id_companyId_key" ON "DailyReportAuditLog"("id", "companyId");

-- AddForeignKey
ALTER TABLE "DailySiteReport" ADD CONSTRAINT "DailySiteReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteReport" ADD CONSTRAINT "DailySiteReport_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteReport" ADD CONSTRAINT "DailySiteReport_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteReport" ADD CONSTRAINT "DailySiteReport_submittedById_companyId_fkey" FOREIGN KEY ("submittedById", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteReport" ADD CONSTRAINT "DailySiteReport_approvedById_companyId_fkey" FOREIGN KEY ("approvedById", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteReport" ADD CONSTRAINT "DailySiteReport_lockedById_companyId_fkey" FOREIGN KEY ("lockedById", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteReportLabour" ADD CONSTRAINT "DailySiteReportLabour_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteReportLabour" ADD CONSTRAINT "DailySiteReportLabour_reportId_companyId_fkey" FOREIGN KEY ("reportId", "companyId") REFERENCES "DailySiteReport"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReportAuditLog" ADD CONSTRAINT "DailyReportAuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReportAuditLog" ADD CONSTRAINT "DailyReportAuditLog_reportId_companyId_fkey" FOREIGN KEY ("reportId", "companyId") REFERENCES "DailySiteReport"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
