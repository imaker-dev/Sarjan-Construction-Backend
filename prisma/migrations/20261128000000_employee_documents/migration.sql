-- CreateEnum
CREATE TYPE "EmployeeDocumentType" AS ENUM (
  'AADHAAR',
  'PAN',
  'VOTER_ID',
  'PASSPORT',
  'DRIVING_LICENSE',
  'OPERATOR_LICENSE',
  'TRADE_CERTIFICATE',
  'ACADEMIC_CERTIFICATE',
  'FITNESS_CERTIFICATE',
  'POLICE_VERIFICATION',
  'EMPLOYMENT_CONTRACT',
  'BANK_DETAILS',
  'PHOTO',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "DocumentVerificationStatus" AS ENUM (
  'PENDING',
  'VERIFIED',
  'REJECTED'
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "documentType" "EmployeeDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "documentNumber" TEXT,
    "issuingAuthority" TEXT,
    "issueDate" DATE,
    "expiryDate" DATE,
    "verificationStatus" "DocumentVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedByPrincipalId" UUID,
    "verifiedAt" TIMESTAMPTZ,
    "rejectionReason" TEXT,
    "metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDocument_id_companyId_key" ON "EmployeeDocument"("id", "companyId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_companyId_employeeId_documentType_idx" ON "EmployeeDocument"("companyId", "employeeId", "documentType");

-- CreateIndex
CREATE INDEX "EmployeeDocument_companyId_expiryDate_idx" ON "EmployeeDocument"("companyId", "expiryDate");

-- CreateIndex
CREATE INDEX "EmployeeDocument_companyId_verificationStatus_idx" ON "EmployeeDocument"("companyId", "verificationStatus");

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_verifiedByPrincipalId_fkey" FOREIGN KEY ("verifiedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
