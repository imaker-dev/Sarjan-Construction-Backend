-- CreateEnum
CREATE TYPE "WorkflowState" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'PARTIALLY_FULFILLED', 'COMPLETED', 'CANCELLED', 'CLOSED');

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "workflowVersionId" UUID NOT NULL,
    "operationVersionId" UUID NOT NULL,
    "state" "WorkflowState" NOT NULL,
    "businessEntityType" TEXT,
    "businessEntityId" UUID,
    "context" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "startedByPrincipalId" UUID,
    "startedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTransition" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "workflowInstanceId" UUID NOT NULL,
    "fromState" "WorkflowState" NOT NULL,
    "toState" "WorkflowState" NOT NULL,
    "action" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "actorPrincipalId" UUID,
    "actorType" TEXT NOT NULL,
    "reason" TEXT,
    "ruleVersionId" UUID,
    "ruleOutcome" TEXT,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "eventKey" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowInstance_companyId_workflowId_state_id_idx" ON "WorkflowInstance"("companyId", "workflowId", "state", "id");

-- CreateIndex
CREATE INDEX "WorkflowInstance_companyId_operationId_state_id_idx" ON "WorkflowInstance"("companyId", "operationId", "state", "id");

-- CreateIndex
CREATE INDEX "WorkflowInstance_companyId_state_id_idx" ON "WorkflowInstance"("companyId", "state", "id");

-- CreateIndex
CREATE INDEX "WorkflowInstance_companyId_businessEntityType_businessEntit_idx" ON "WorkflowInstance"("companyId", "businessEntityType", "businessEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_id_companyId_key" ON "WorkflowInstance"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTransition_eventKey_key" ON "WorkflowTransition"("eventKey");

-- CreateIndex
CREATE INDEX "WorkflowTransition_companyId_workflowInstanceId_occurredAt__idx" ON "WorkflowTransition"("companyId", "workflowInstanceId", "occurredAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTransition_workflowInstanceId_idempotencyKey_key" ON "WorkflowTransition"("workflowInstanceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_id_companyId_key" ON "RuleVersion"("id", "companyId");

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_workflowId_companyId_fkey" FOREIGN KEY ("workflowId", "companyId") REFERENCES "Workflow"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_workflowVersionId_workflowId_companyId_fkey" FOREIGN KEY ("workflowVersionId", "workflowId", "companyId") REFERENCES "WorkflowVersion"("id", "workflowId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_operationVersionId_operationId_companyId_fkey" FOREIGN KEY ("operationVersionId", "operationId", "companyId") REFERENCES "OperationVersion"("id", "operationId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_startedByPrincipalId_fkey" FOREIGN KEY ("startedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_workflowInstanceId_companyId_fkey" FOREIGN KEY ("workflowInstanceId", "companyId") REFERENCES "WorkflowInstance"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_actorPrincipalId_fkey" FOREIGN KEY ("actorPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_ruleVersionId_companyId_fkey" FOREIGN KEY ("ruleVersionId", "companyId") REFERENCES "RuleVersion"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Business-record back-reference: both columns set together or neither.
-- (Prisma cannot express this cross-column invariant.)
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_business_pair_check"
  CHECK (("businessEntityType" IS NULL) = ("businessEntityId" IS NULL));
