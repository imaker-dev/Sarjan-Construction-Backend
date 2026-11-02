-- Company profile + compliance records (additive)
CREATE TYPE "CompanyEntityType" AS ENUM ('PRIVATE_LIMITED','PUBLIC_LIMITED','LLP','PARTNERSHIP','PROPRIETORSHIP','OTHER');
CREATE TYPE "ComplianceCategory" AS ENUM ('GST','TAN','UDYAM_MSME','EPFO','ESIC','BOCW','LABOUR_LICENCE','CONTRACTOR_ENLISTMENT','ISO_CERT','TECHNICAL_LICENCE','INSURANCE','OTHER');
CREATE TYPE "ComplianceRecordStatus" AS ENUM ('DRAFT','ACTIVE','SUSPENDED','EXPIRED','ARCHIVED');

ALTER TABLE "Company" ADD COLUMN "entityType" "CompanyEntityType",
  ADD COLUMN "tradeName" TEXT, ADD COLUMN "formedOn" DATE,
  ADD COLUMN "pan" TEXT, ADD COLUMN "cin" TEXT, ADD COLUMN "llpin" TEXT,
  ADD COLUMN "regNumber" TEXT, ADD COLUMN "website" TEXT, ADD COLUMN "description" TEXT,
  ADD COLUMN "regAddressLine1" TEXT, ADD COLUMN "regAddressLine2" TEXT,
  ADD COLUMN "regLocality" TEXT, ADD COLUMN "regCity" TEXT, ADD COLUMN "regDistrict" TEXT,
  ADD COLUMN "regStateUt" TEXT, ADD COLUMN "regPin" TEXT, ADD COLUMN "regCountry" TEXT DEFAULT 'IN',
  ADD COLUMN "corrAddressLine1" TEXT, ADD COLUMN "corrAddressLine2" TEXT,
  ADD COLUMN "corrLocality" TEXT, ADD COLUMN "corrCity" TEXT, ADD COLUMN "corrDistrict" TEXT,
  ADD COLUMN "corrStateUt" TEXT, ADD COLUMN "corrPin" TEXT, ADD COLUMN "corrCountry" TEXT,
  ADD COLUMN "contactName" TEXT, ADD COLUMN "contactDesignation" TEXT,
  ADD COLUMN "contactEmail" TEXT, ADD COLUMN "contactPhone" TEXT;

CREATE TABLE "ComplianceRecord" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "category" "ComplianceCategory" NOT NULL,
  "customLabel" TEXT,
  "identifier" TEXT NOT NULL,
  "jurisdiction" TEXT,
  "issuingAuthority" TEXT,
  "scopeType" "ScopeType" NOT NULL DEFAULT 'COMPANY',
  "issueDate" DATE,
  "expiryDate" DATE,
  "status" "ComplianceRecordStatus" NOT NULL DEFAULT 'DRAFT',
  "verifiedAt" TIMESTAMPTZ,
  "verifiedBy" UUID,
  "documentId" UUID,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "ComplianceRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComplianceRecord_companyId_category_identifier_key" ON "ComplianceRecord"("companyId","category","identifier");
CREATE UNIQUE INDEX "ComplianceRecord_id_companyId_key" ON "ComplianceRecord"("id","companyId");
CREATE INDEX "ComplianceRecord_companyId_status_category_idx" ON "ComplianceRecord"("companyId","status","category");
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT;
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_documentId_companyId_fkey" FOREIGN KEY ("documentId","companyId") REFERENCES "Document"("id","companyId") ON DELETE RESTRICT;
