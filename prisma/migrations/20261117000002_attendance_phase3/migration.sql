-- AlterTable
ALTER TABLE "AttendancePolicy" ADD COLUMN     "requireTvtGate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tvtGateAction" TEXT NOT NULL DEFAULT 'FLAG';

-- AlterTable
ALTER TABLE "AttendanceSession" ADD COLUMN     "clientSessionId" UUID,
ADD COLUMN     "isSyncedOffline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "syncBatchId" UUID;

-- CreateTable
CREATE TABLE "SafetyTvtSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "businessDate" VARCHAR(10) NOT NULL,
    "topic" TEXT NOT NULL,
    "conductedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conductedBy" UUID NOT NULL,
    "remarks" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "SafetyTvtSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyTvtAttendee" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "attendedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyTvtAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SafetyTvtSession_companyId_siteId_businessDate_idx" ON "SafetyTvtSession"("companyId", "siteId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyTvtSession_id_companyId_key" ON "SafetyTvtSession"("id", "companyId");

-- CreateIndex
CREATE INDEX "SafetyTvtAttendee_companyId_employeeId_idx" ON "SafetyTvtAttendee"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyTvtAttendee_id_companyId_key" ON "SafetyTvtAttendee"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyTvtAttendee_sessionId_employeeId_key" ON "SafetyTvtAttendee"("sessionId", "employeeId");

-- CreateIndex
CREATE INDEX "AttendanceSession_companyId_clientSessionId_idx" ON "AttendanceSession"("companyId", "clientSessionId");

-- AddForeignKey
ALTER TABLE "SafetyTvtSession" ADD CONSTRAINT "SafetyTvtSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyTvtSession" ADD CONSTRAINT "SafetyTvtSession_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyTvtAttendee" ADD CONSTRAINT "SafetyTvtAttendee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyTvtAttendee" ADD CONSTRAINT "SafetyTvtAttendee_sessionId_companyId_fkey" FOREIGN KEY ("sessionId", "companyId") REFERENCES "SafetyTvtSession"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyTvtAttendee" ADD CONSTRAINT "SafetyTvtAttendee_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

