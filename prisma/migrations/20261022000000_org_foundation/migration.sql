-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrgNodeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "status" "CompanyStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeadOffice" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeadOffice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "headOfficeId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNED',
    "startDate" DATE,
    "endDate" DATE,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "geoLatitude" DECIMAL(9,6),
    "geoLongitude" DECIMAL(9,6),
    "geoFenceRadiusM" INTEGER,
    "timezone" TEXT,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "companyId" UUID,
    "actorId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "correlationId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusBefore" TEXT,
    "statusAfter" TEXT,
    "changedFields" JSONB,
    "metadata" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- CreateIndex
CREATE INDEX "HeadOffice_companyId_status_id_idx" ON "HeadOffice"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HeadOffice_companyId_code_key" ON "HeadOffice"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "HeadOffice_id_companyId_key" ON "HeadOffice"("id", "companyId");

-- CreateIndex
CREATE INDEX "Project_companyId_status_id_idx" ON "Project"("companyId", "status", "id");

-- CreateIndex
CREATE INDEX "Project_headOfficeId_companyId_status_id_idx" ON "Project"("headOfficeId", "companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Project_companyId_code_key" ON "Project"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Project_id_companyId_key" ON "Project"("id", "companyId");

-- CreateIndex
CREATE INDEX "Site_projectId_companyId_status_id_idx" ON "Site"("projectId", "companyId", "status", "id");

-- CreateIndex
CREATE INDEX "Site_companyId_status_id_idx" ON "Site"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Site_projectId_code_key" ON "Site"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_eventKey_key" ON "AuditLog"("eventKey");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_occurredAt_idx" ON "AuditLog"("entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_occurredAt_idx" ON "AuditLog"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");

-- AddForeignKey
ALTER TABLE "HeadOffice" ADD CONSTRAINT "HeadOffice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_headOfficeId_companyId_fkey" FOREIGN KEY ("headOfficeId", "companyId") REFERENCES "HeadOffice"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

