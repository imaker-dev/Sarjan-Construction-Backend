-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADING', 'QUARANTINED', 'AVAILABLE', 'REJECTED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "declaredContentType" TEXT,
    "contentType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADING',
    "rejectReason" TEXT,
    "uploadedByPrincipalId" UUID,
    "uploadedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByPrincipalId" UUID,
    "reviewedAt" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLink" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "formSubmissionId" UUID,
    "workflowInstanceId" UUID,
    "fieldKey" TEXT,
    "linkedByPrincipalId" UUID,
    "linkedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" TIMESTAMPTZ,
    "unlinkedByPrincipalId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_companyId_uploadedByPrincipalId_uploadedAt_id_idx" ON "Document"("companyId", "uploadedByPrincipalId", "uploadedAt", "id");

-- CreateIndex
CREATE INDEX "Document_companyId_status_uploadedAt_id_idx" ON "Document"("companyId", "status", "uploadedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Document_id_companyId_key" ON "Document"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_companyId_storageKey_key" ON "Document"("companyId", "storageKey");

-- CreateIndex
CREATE INDEX "DocumentLink_companyId_documentId_unlinkedAt_idx" ON "DocumentLink"("companyId", "documentId", "unlinkedAt");

-- CreateIndex
CREATE INDEX "DocumentLink_companyId_formSubmissionId_unlinkedAt_idx" ON "DocumentLink"("companyId", "formSubmissionId", "unlinkedAt");

-- CreateIndex
CREATE INDEX "DocumentLink_companyId_workflowInstanceId_unlinkedAt_idx" ON "DocumentLink"("companyId", "workflowInstanceId", "unlinkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_id_companyId_key" ON "DocumentLink"("id", "companyId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedByPrincipalId_fkey" FOREIGN KEY ("uploadedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_reviewedByPrincipalId_fkey" FOREIGN KEY ("reviewedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_formSubmissionId_companyId_fkey" FOREIGN KEY ("formSubmissionId", "companyId") REFERENCES "FormSubmission"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_workflowInstanceId_companyId_fkey" FOREIGN KEY ("workflowInstanceId", "companyId") REFERENCES "WorkflowInstance"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_linkedByPrincipalId_fkey" FOREIGN KEY ("linkedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_unlinkedByPrincipalId_fkey" FOREIGN KEY ("unlinkedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Exactly one concrete link target per row (constrained polymorphism).
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_one_target"
  CHECK (num_nonnulls("formSubmissionId", "workflowInstanceId") = 1);

-- One active link per (document, submission, field) — fieldKey may be null,
-- so COALESCE keeps NULL-valued fields unique too.
CREATE UNIQUE INDEX "DocumentLink_one_active_form_link"
  ON "DocumentLink"("companyId", "documentId", "formSubmissionId", COALESCE("fieldKey", ''))
  WHERE "formSubmissionId" IS NOT NULL AND "unlinkedAt" IS NULL;

-- One active link per (document, instance).
CREATE UNIQUE INDEX "DocumentLink_one_active_instance_link"
  ON "DocumentLink"("companyId", "documentId", "workflowInstanceId")
  WHERE "workflowInstanceId" IS NOT NULL AND "unlinkedAt" IS NULL;
