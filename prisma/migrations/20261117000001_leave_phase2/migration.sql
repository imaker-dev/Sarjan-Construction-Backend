-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('CASUAL', 'SICK', 'PRIVILEGE', 'COMP_OFF', 'LOSS_OF_PAY', 'SPECIAL');

-- CreateEnum
CREATE TYPE "LeaveAccrualFrequency" AS ENUM ('ANNUAL', 'MONTHLY', 'QUARTERLY', 'NONE');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HalfDayPortion" AS ENUM ('FIRST_HALF', 'SECOND_HALF');

-- CreateTable
CREATE TABLE "LeavePolicy" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "scopeType" "AttendancePolicyScope" NOT NULL DEFAULT 'COMPANY',
    "projectId" UUID,
    "siteId" UUID,
    "employeeId" UUID,
    "leaveType" "LeaveType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "annualAllowance" DECIMAL(4,1) NOT NULL DEFAULT 12,
    "accrualFrequency" "LeaveAccrualFrequency" NOT NULL DEFAULT 'ANNUAL',
    "maxConsecutiveDays" INTEGER,
    "minNoticeDays" INTEGER NOT NULL DEFAULT 0,
    "allowHalfDay" BOOLEAN NOT NULL DEFAULT true,
    "sandwichRule" BOOLEAN NOT NULL DEFAULT false,
    "carryoverMaxDays" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "encashable" BOOLEAN NOT NULL DEFAULT false,
    "requiresDocAboveDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveBalance" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "leaveType" "LeaveType" NOT NULL,
    "year" INTEGER NOT NULL,
    "allocatedDays" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "usedDays" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "pendingDays" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "carriedOverDays" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "leaveType" "LeaveType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isHalfDay" BOOLEAN NOT NULL DEFAULT false,
    "halfDayPortion" "HalfDayPortion",
    "totalDays" DECIMAL(4,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "documentId" UUID,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMPTZ,
    "reviewRemarks" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeavePolicy_companyId_scopeType_leaveType_idx" ON "LeavePolicy"("companyId", "scopeType", "leaveType");

-- CreateIndex
CREATE INDEX "LeavePolicy_companyId_projectId_idx" ON "LeavePolicy"("companyId", "projectId");

-- CreateIndex
CREATE INDEX "LeavePolicy_companyId_siteId_idx" ON "LeavePolicy"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "LeavePolicy_companyId_employeeId_idx" ON "LeavePolicy"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeavePolicy_id_companyId_key" ON "LeavePolicy"("id", "companyId");

-- CreateIndex
CREATE INDEX "LeaveBalance_companyId_employeeId_idx" ON "LeaveBalance"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_id_companyId_key" ON "LeaveBalance"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_companyId_employeeId_leaveType_year_key" ON "LeaveBalance"("companyId", "employeeId", "leaveType", "year");

-- CreateIndex
CREATE INDEX "LeaveRequest_companyId_employeeId_status_idx" ON "LeaveRequest"("companyId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_companyId_startDate_endDate_idx" ON "LeaveRequest"("companyId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequest_id_companyId_key" ON "LeaveRequest"("id", "companyId");

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

