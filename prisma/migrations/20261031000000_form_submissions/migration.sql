-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED');

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "workflowInstanceId" UUID NOT NULL,
    "formId" UUID NOT NULL,
    "formVersionId" UUID NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "draftValues" JSONB,
    "latestRevision" INTEGER NOT NULL DEFAULT 0,
    "currentRevisionId" UUID,
    "submittedByPrincipalId" UUID,
    "submittedAt" TIMESTAMPTZ,
    "returnedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionRevision" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedByPrincipalId" UUID,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "eventKey" UUID NOT NULL,

    CONSTRAINT "SubmissionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FormSubmission_companyId_operationId_status_id_idx" ON "FormSubmission"("companyId", "operationId", "status", "id");

-- CreateIndex
CREATE INDEX "FormSubmission_companyId_workflowInstanceId_status_idx" ON "FormSubmission"("companyId", "workflowInstanceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FormSubmission_companyId_workflowInstanceId_formVersionId_key" ON "FormSubmission"("companyId", "workflowInstanceId", "formVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "FormSubmission_id_companyId_key" ON "FormSubmission"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionRevision_eventKey_key" ON "SubmissionRevision"("eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionRevision_companyId_submissionId_revision_key" ON "SubmissionRevision"("companyId", "submissionId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionRevision_id_submissionId_companyId_key" ON "SubmissionRevision"("id", "submissionId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionRevision_submissionId_idempotencyKey_key" ON "SubmissionRevision"("submissionId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_operationId_companyId_fkey" FOREIGN KEY ("operationId", "companyId") REFERENCES "Operation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_workflowInstanceId_companyId_fkey" FOREIGN KEY ("workflowInstanceId", "companyId") REFERENCES "WorkflowInstance"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_companyId_fkey" FOREIGN KEY ("formId", "companyId") REFERENCES "Form"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formVersionId_formId_companyId_fkey" FOREIGN KEY ("formVersionId", "formId", "companyId") REFERENCES "FormVersion"("id", "formId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_submittedByPrincipalId_fkey" FOREIGN KEY ("submittedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionRevision" ADD CONSTRAINT "SubmissionRevision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionRevision" ADD CONSTRAINT "SubmissionRevision_submissionId_companyId_fkey" FOREIGN KEY ("submissionId", "companyId") REFERENCES "FormSubmission"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionRevision" ADD CONSTRAINT "SubmissionRevision_submittedByPrincipalId_fkey" FOREIGN KEY ("submittedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Constrained current-revision pointer: the pinned revision must belong to
-- THIS submission and company. Prisma cannot express triple-column FKs
-- through a non-relation scalar, so this is hand-added (same pattern as
-- Form.currentVersionId).
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_currentRevisionId_fkey"
  FOREIGN KEY ("currentRevisionId", "id", "companyId")
  REFERENCES "SubmissionRevision"("id", "submissionId", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
