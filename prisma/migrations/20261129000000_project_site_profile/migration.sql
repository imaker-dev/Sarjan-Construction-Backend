-- CreateEnum
CREATE TYPE "ContractType" AS ENUM (
  'LUMPSUM',
  'ITEM_RATE',
  'EPC',
  'DESIGN_BUILD',
  'COST_PLUS',
  'LABOUR_ONLY',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "SiteType" AS ENUM (
  'MAIN_CONSTRUCTION',
  'BATCHING_PLANT',
  'LAYDOWN_YARD',
  'LABOUR_CAMP',
  'OFFICE',
  'STORE',
  'WORKSHOP',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "AreaUnit" AS ENUM (
  'SQM',
  'SQFT',
  'ACRE',
  'HECTARE',
  'BIGHA',
  'KATHA'
);

-- CreateEnum
CREATE TYPE "OrgDocumentType" AS ENUM (
  'MASTER_PLAN',
  'LAYOUT_PLAN',
  'DRAWING',
  'BOQ',
  'CONTRACT',
  'WORK_ORDER',
  'LAND_RECORD',
  'SURVEY',
  'GEOTECH_REPORT',
  'APPROVAL_LETTER',
  'HANDOVER_RECORD',
  'SITE_PHOTO',
  'SAFETY_PLAN',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "DrawingDiscipline" AS ENUM (
  'ARCHITECTURAL',
  'STRUCTURAL',
  'CIVIL',
  'MEP',
  'ELECTRICAL',
  'PLUMBING',
  'HVAC',
  'FIRE_SAFETY',
  'SURVEY',
  'GEOTECHNICAL',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "OrgDocumentLinkStatus" AS ENUM (
  'DRAFT',
  'ISSUED',
  'FOR_CONSTRUCTION',
  'SUPERSEDED',
  'VOID'
);

-- CreateEnum
CREATE TYPE "ProjectApprovalType" AS ENUM (
  'RERA',
  'ENVIRONMENT_CLEARANCE',
  'FIRE_NOC',
  'LAND_CONVERSION',
  'HEIGHT_CLEARANCE',
  'HERITAGE',
  'LOCAL_BODY',
  'RAILWAY_NOC',
  'HIGHWAY_NOC',
  'FOREST_CLEARANCE',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "ProjectApprovalStatus" AS ENUM (
  'APPLIED',
  'UNDER_REVIEW',
  'GRANTED',
  'REJECTED',
  'EXPIRED',
  'REVOKED'
);

-- AlterTable: Project extended profile. All additive / nullable.
ALTER TABLE "Project" ADD COLUMN "projectSubtype" TEXT,
ADD COLUMN "contractType" "ContractType",
ADD COLUMN "clientContactName" TEXT,
ADD COLUMN "clientContactPhone" TEXT,
ADD COLUMN "clientContactEmail" TEXT,
ADD COLUMN "workOrderRef" TEXT,
ADD COLUMN "tenderRef" TEXT,
ADD COLUMN "contractValue" DECIMAL(18,2),
ADD COLUMN "contractCurrency" VARCHAR(3),
ADD COLUMN "contractDate" DATE,
ADD COLUMN "workOrderDate" DATE,
ADD COLUMN "locationAddressLine" TEXT,
ADD COLUMN "locationLocality" TEXT,
ADD COLUMN "locationCountry" TEXT,
ADD COLUMN "geoLatitude" DECIMAL(9,6),
ADD COLUMN "geoLongitude" DECIMAL(9,6),
ADD COLUMN "scopeSummary" TEXT,
ADD COLUMN "landArea" DECIMAL(14,2),
ADD COLUMN "landAreaUnit" "AreaUnit",
ADD COLUMN "builtUpArea" DECIMAL(14,2),
ADD COLUMN "numBuildings" INTEGER,
ADD COLUMN "numFloorsMax" INTEGER,
ADD COLUMN "numUnits" INTEGER,
ADD COLUMN "linearLengthKm" DECIMAL(10,3),
ADD COLUMN "carriagewayWidthM" DECIMAL(8,2),
ADD COLUMN "ntpDate" DATE,
ADD COLUMN "revisedEndDate" DATE,
ADD COLUMN "actualStartDate" DATE,
ADD COLUMN "actualEndDate" DATE;

-- AlterTable: Site extended profile. All additive / nullable.
ALTER TABLE "Site" ADD COLUMN "description" TEXT,
ADD COLUMN "siteType" "SiteType",
ADD COLUMN "landParcelId" UUID,
ADD COLUMN "plotArea" DECIMAL(14,2),
ADD COLUMN "areaUnit" "AreaUnit",
ADD COLUMN "surveyNo" TEXT,
ADD COLUMN "possessionDate" DATE,
ADD COLUMN "handoverDate" DATE,
ADD COLUMN "scopeSummary" TEXT,
ADD COLUMN "mobilizationDate" DATE,
ADD COLUMN "accessArrangements" TEXT,
ADD COLUMN "facilities" JSONB,
ADD COLUMN "siteContactName" TEXT,
ADD COLUMN "siteContactPhone" TEXT,
ADD COLUMN "siteContactEmail" TEXT,
ADD COLUMN "accessInstructions" TEXT,
ADD COLUMN "emergencyDetails" TEXT;

-- CreateTable
CREATE TABLE "ProjectLandParcel" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "surveyNo" TEXT,
    "plotNo" TEXT,
    "area" DECIMAL(14,2) NOT NULL,
    "areaUnit" "AreaUnit" NOT NULL,
    "boundaryDescription" TEXT,
    "possessionDate" DATE,
    "documentId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectLandParcel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectDocument" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "documentType" "OrgDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "documentNumber" TEXT,
    "discipline" "DrawingDiscipline",
    "revision" TEXT,
    "issueDate" DATE,
    "linkStatus" "OrgDocumentLinkStatus" NOT NULL DEFAULT 'ISSUED',
    "attachedByPrincipalId" UUID,
    "metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ProjectDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteDocument" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "documentType" "OrgDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "documentNumber" TEXT,
    "discipline" "DrawingDiscipline",
    "revision" TEXT,
    "issueDate" DATE,
    "linkStatus" "OrgDocumentLinkStatus" NOT NULL DEFAULT 'ISSUED',
    "attachedByPrincipalId" UUID,
    "metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "SiteDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectApproval" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "approvalType" "ProjectApprovalType" NOT NULL,
    "customType" TEXT,
    "issuingAuthority" TEXT,
    "jurisdiction" TEXT,
    "referenceNo" TEXT,
    "status" "ProjectApprovalStatus" NOT NULL DEFAULT 'APPLIED',
    "appliedDate" DATE,
    "grantedDate" DATE,
    "validUntil" DATE,
    "documentId" UUID,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ProjectApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectLandParcel_id_companyId_key" ON "ProjectLandParcel"("id", "companyId");

-- CreateIndex
CREATE INDEX "ProjectLandParcel_companyId_projectId_id_idx" ON "ProjectLandParcel"("companyId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocument_companyId_projectId_documentId_key" ON "ProjectDocument"("companyId", "projectId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocument_id_companyId_key" ON "ProjectDocument"("id", "companyId");

-- CreateIndex
CREATE INDEX "ProjectDocument_companyId_projectId_documentType_idx" ON "ProjectDocument"("companyId", "projectId", "documentType");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDocument_companyId_siteId_documentId_key" ON "SiteDocument"("companyId", "siteId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDocument_id_companyId_key" ON "SiteDocument"("id", "companyId");

-- CreateIndex
CREATE INDEX "SiteDocument_companyId_siteId_documentType_idx" ON "SiteDocument"("companyId", "siteId", "documentType");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectApproval_id_companyId_key" ON "ProjectApproval"("id", "companyId");

-- CreateIndex
CREATE INDEX "ProjectApproval_companyId_projectId_status_idx" ON "ProjectApproval"("companyId", "projectId", "status");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_landParcelId_companyId_fkey" FOREIGN KEY ("landParcelId", "companyId") REFERENCES "ProjectLandParcel"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectLandParcel" ADD CONSTRAINT "ProjectLandParcel_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectLandParcel" ADD CONSTRAINT "ProjectLandParcel_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectLandParcel" ADD CONSTRAINT "ProjectLandParcel_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_attachedByPrincipalId_fkey" FOREIGN KEY ("attachedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDocument" ADD CONSTRAINT "SiteDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDocument" ADD CONSTRAINT "SiteDocument_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDocument" ADD CONSTRAINT "SiteDocument_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDocument" ADD CONSTRAINT "SiteDocument_attachedByPrincipalId_fkey" FOREIGN KEY ("attachedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectApproval" ADD CONSTRAINT "ProjectApproval_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectApproval" ADD CONSTRAINT "ProjectApproval_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectApproval" ADD CONSTRAINT "ProjectApproval_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
