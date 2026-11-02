-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Workflow" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "operationVersionId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "latestRevision" INTEGER NOT NULL DEFAULT 0,
    "currentVersionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByPrincipalId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workflow_companyId_operationId_status_id_idx" ON "Workflow"("companyId", "operationId", "status", "id");

-- CreateIndex
CREATE INDEX "Workflow_companyId_status_id_idx" ON "Workflow"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_companyId_operationId_key_key" ON "Workflow"("companyId", "operationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_id_companyId_key" ON "Workflow"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_companyId_workflowId_revision_key" ON "WorkflowVersion"("companyId", "workflowId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_id_workflowId_companyId_key" ON "WorkflowVersion"("id", "workflowId", "companyId");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_operationVersionId_operationId_companyId_fkey" FOREIGN KEY ("operationVersionId", "operationId", "companyId") REFERENCES "OperationVersion"("id", "operationId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_companyId_fkey" FOREIGN KEY ("workflowId", "companyId") REFERENCES "Workflow"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_publishedByPrincipalId_fkey" FOREIGN KEY ("publishedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Composite FK (hand-added): the pinned current version must belong to THIS
-- workflow and company. currentVersionId stays nullable until first publish.
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_currentVersion_fkey"
  FOREIGN KEY ("currentVersionId", "id", "companyId")
  REFERENCES "WorkflowVersion"("id", "workflowId", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
