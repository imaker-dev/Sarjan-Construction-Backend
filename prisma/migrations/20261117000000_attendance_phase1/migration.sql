-- CreateEnum
CREATE TYPE "AttendanceSessionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'AUTO_CLOSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('MOBILE_SELF', 'SUPERVISOR_KIOSK', 'BIOMETRIC_DEVICE', 'MANUAL_CORRECTION');

-- CreateEnum
CREATE TYPE "BreakMode" AS ENUM ('FIXED', 'DYNAMIC');

-- CreateEnum
CREATE TYPE "OvertimeMode" AS ENUM ('HOURLY', 'P_MULTIPLIER');

-- CreateEnum
CREATE TYPE "AttendancePolicyScope" AS ENUM ('COMPANY', 'PROJECT', 'SITE', 'EMPLOYEE');

-- DropForeignKey
ALTER TABLE "ComplianceRecord" DROP CONSTRAINT "ComplianceRecord_companyId_fkey";

-- DropForeignKey
ALTER TABLE "ComplianceRecord" DROP CONSTRAINT "ComplianceRecord_documentId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "DepartmentMembership" DROP CONSTRAINT "DepartmentMembership_departmentId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "DepartmentMembership" DROP CONSTRAINT "DepartmentMembership_employeeId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "DepartmentOperation" DROP CONSTRAINT "DepartmentOperation_companyId_fkey";

-- DropForeignKey
ALTER TABLE "DepartmentOperation" DROP CONSTRAINT "DepartmentOperation_departmentId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "DepartmentOperation" DROP CONSTRAINT "DepartmentOperation_operationKey_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeOperation" DROP CONSTRAINT "EmployeeOperation_companyId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeOperation" DROP CONSTRAINT "EmployeeOperation_employeeId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeOperation" DROP CONSTRAINT "EmployeeOperation_operationKey_fkey";

-- DropForeignKey
ALTER TABLE "Form" DROP CONSTRAINT "Form_currentVersion_fkey";

-- DropForeignKey
ALTER TABLE "FormSubmission" DROP CONSTRAINT "FormSubmission_currentRevisionId_fkey";

-- DropForeignKey
ALTER TABLE "Operation" DROP CONSTRAINT "Operation_currentVersion_fkey";

-- DropForeignKey
ALTER TABLE "Rule" DROP CONSTRAINT "Rule_currentVersion_fkey";

-- DropForeignKey
ALTER TABLE "Workflow" DROP CONSTRAINT "Workflow_currentVersion_fkey";

-- AlterTable
ALTER TABLE "ClaimToken" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ComplianceRecord" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DepartmentMembership" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DepartmentOperation" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "EmployeeOperation" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "AttendancePolicy" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "scope" "AttendancePolicyScope" NOT NULL DEFAULT 'COMPANY',
    "projectId" UUID,
    "siteId" UUID,
    "employeeId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dayStartHour" INTEGER NOT NULL DEFAULT 8,
    "dayStartMinute" INTEGER NOT NULL DEFAULT 0,
    "shiftDurationMins" INTEGER NOT NULL DEFAULT 480,
    "halfDayThresholdMins" INTEGER NOT NULL DEFAULT 240,
    "fullDayThresholdMins" INTEGER NOT NULL DEFAULT 480,
    "breakMode" "BreakMode" NOT NULL DEFAULT 'FIXED',
    "fixedBreakMins" INTEGER NOT NULL DEFAULT 60,
    "minWorkForBreakMins" INTEGER NOT NULL DEFAULT 240,
    "maxDynamicBreakMins" INTEGER NOT NULL DEFAULT 90,
    "overtimeMode" "OvertimeMode" NOT NULL DEFAULT 'HOURLY',
    "minOvertimeMins" INTEGER NOT NULL DEFAULT 30,
    "otSlabMins" INTEGER NOT NULL DEFAULT 30,
    "pMultiplierSlabs" JSONB,
    "geofenceStrict" BOOLEAN NOT NULL DEFAULT true,
    "allowMobilePunch" BOOLEAN NOT NULL DEFAULT true,
    "allowKioskPunch" BOOLEAN NOT NULL DEFAULT true,
    "allowBiometric" BOOLEAN NOT NULL DEFAULT true,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AttendancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "businessDate" VARCHAR(10) NOT NULL,
    "status" "AttendanceSessionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "source" "AttendanceSource" NOT NULL DEFAULT 'MOBILE_SELF',
    "punchInAt" TIMESTAMPTZ NOT NULL,
    "punchInLat" DECIMAL(10,7),
    "punchInLng" DECIMAL(10,7),
    "punchInDistanceM" INTEGER,
    "punchInWithinGeofence" BOOLEAN NOT NULL DEFAULT true,
    "punchInRemarks" TEXT,
    "punchInSupervisorId" UUID,
    "punchOutAt" TIMESTAMPTZ,
    "punchOutLat" DECIMAL(10,7),
    "punchOutLng" DECIMAL(10,7),
    "punchOutDistanceM" INTEGER,
    "punchOutWithinGeofence" BOOLEAN,
    "punchOutRemarks" TEXT,
    "punchOutSupervisorId" UUID,
    "grossDurationMins" INTEGER NOT NULL DEFAULT 0,
    "breakDurationMins" INTEGER NOT NULL DEFAULT 0,
    "netDurationMins" INTEGER NOT NULL DEFAULT 0,
    "presentUnits" DECIMAL(3,1) NOT NULL DEFAULT 0,
    "overtimePUnits" DECIMAL(3,1) NOT NULL DEFAULT 0,
    "totalPUnits" DECIMAL(3,1) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AttendanceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceBreak" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "breakType" TEXT NOT NULL DEFAULT 'LUNCH',
    "startedAt" TIMESTAMPTZ NOT NULL,
    "endedAt" TIMESTAMPTZ,
    "durationMins" INTEGER NOT NULL DEFAULT 0,
    "isApproved" BOOLEAN NOT NULL DEFAULT true,
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AttendanceBreak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendancePolicy_companyId_scope_idx" ON "AttendancePolicy"("companyId", "scope");

-- CreateIndex
CREATE INDEX "AttendancePolicy_companyId_siteId_idx" ON "AttendancePolicy"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "AttendancePolicy_companyId_projectId_idx" ON "AttendancePolicy"("companyId", "projectId");

-- CreateIndex
CREATE INDEX "AttendancePolicy_companyId_employeeId_idx" ON "AttendancePolicy"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendancePolicy_id_companyId_key" ON "AttendancePolicy"("id", "companyId");

-- CreateIndex
CREATE INDEX "AttendanceSession_companyId_businessDate_idx" ON "AttendanceSession"("companyId", "businessDate");

-- CreateIndex
CREATE INDEX "AttendanceSession_companyId_employeeId_businessDate_idx" ON "AttendanceSession"("companyId", "employeeId", "businessDate");

-- CreateIndex
CREATE INDEX "AttendanceSession_companyId_siteId_businessDate_idx" ON "AttendanceSession"("companyId", "siteId", "businessDate");

-- CreateIndex
CREATE INDEX "AttendanceSession_companyId_status_idx" ON "AttendanceSession"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSession_id_companyId_key" ON "AttendanceSession"("id", "companyId");

-- CreateIndex
CREATE INDEX "AttendanceBreak_companyId_sessionId_idx" ON "AttendanceBreak"("companyId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceBreak_id_companyId_key" ON "AttendanceBreak"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentMembership_id_companyId_key" ON "DepartmentMembership"("id", "companyId");

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentOperation" ADD CONSTRAINT "DepartmentOperation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentOperation" ADD CONSTRAINT "DepartmentOperation_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentOperation" ADD CONSTRAINT "DepartmentOperation_operationKey_fkey" FOREIGN KEY ("operationKey") REFERENCES "OperationCatalogueEntry"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOperation" ADD CONSTRAINT "EmployeeOperation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOperation" ADD CONSTRAINT "EmployeeOperation_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOperation" ADD CONSTRAINT "EmployeeOperation_operationKey_fkey" FOREIGN KEY ("operationKey") REFERENCES "OperationCatalogueEntry"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "AttendancePolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "AttendancePolicy_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "AttendancePolicy_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "AttendancePolicy_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_policyId_companyId_fkey" FOREIGN KEY ("policyId", "companyId") REFERENCES "AttendancePolicy"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceBreak" ADD CONSTRAINT "AttendanceBreak_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceBreak" ADD CONSTRAINT "AttendanceBreak_sessionId_companyId_fkey" FOREIGN KEY ("sessionId", "companyId") REFERENCES "AttendanceSession"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "DepartmentMembership_dept_ended_idx" RENAME TO "DepartmentMembership_companyId_departmentId_endedAt_idx";

-- RenameIndex
ALTER INDEX "DepartmentMembership_emp_ended_idx" RENAME TO "DepartmentMembership_companyId_employeeId_endedAt_idx";

