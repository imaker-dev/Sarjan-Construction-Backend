-- CreateEnum
CREATE TYPE "ApprovalTaskStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalOutcome" AS ENUM ('APPROVED', 'REJECTED', 'RETURNED');

-- CreateTable
CREATE TABLE "ApprovalTask" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "workflowInstanceId" UUID NOT NULL,
    "stageKey" TEXT NOT NULL,
    "fromState" "WorkflowState" NOT NULL,
    "assigneeType" TEXT NOT NULL,
    "assigneeValue" TEXT,
    "selfApprove" BOOLEAN NOT NULL DEFAULT false,
    "status" "ApprovalTaskStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByPrincipalId" UUID,
    "decidedAt" TIMESTAMPTZ,
    "decisionAction" TEXT,
    "decisionReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ApprovalTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "approvalTaskId" UUID NOT NULL,
    "outcome" "ApprovalOutcome" NOT NULL,
    "action" TEXT NOT NULL,
    "actorPrincipalId" UUID,
    "actorType" TEXT NOT NULL,
    "reason" TEXT,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "eventKey" UUID NOT NULL,
    "decidedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalTask_companyId_workflowInstanceId_status_id_idx" ON "ApprovalTask"("companyId", "workflowInstanceId", "status", "id");

-- CreateIndex
CREATE INDEX "ApprovalTask_companyId_status_id_idx" ON "ApprovalTask"("companyId", "status", "id");

-- CreateIndex
CREATE INDEX "ApprovalTask_companyId_assigneeType_assigneeValue_status_idx" ON "ApprovalTask"("companyId", "assigneeType", "assigneeValue", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalTask_id_companyId_key" ON "ApprovalTask"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_eventKey_key" ON "ApprovalDecision"("eventKey");

-- CreateIndex
CREATE INDEX "ApprovalDecision_companyId_approvalTaskId_decidedAt_id_idx" ON "ApprovalDecision"("companyId", "approvalTaskId", "decidedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_approvalTaskId_idempotencyKey_key" ON "ApprovalDecision"("approvalTaskId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_workflowInstanceId_companyId_fkey" FOREIGN KEY ("workflowInstanceId", "companyId") REFERENCES "WorkflowInstance"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_decidedByPrincipalId_fkey" FOREIGN KEY ("decidedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_approvalTaskId_companyId_fkey" FOREIGN KEY ("approvalTaskId", "companyId") REFERENCES "ApprovalTask"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_actorPrincipalId_fkey" FOREIGN KEY ("actorPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One pending approval task per instance. A partial unique index — Prisma
-- cannot express conditional uniqueness. Covers concurrent task opens at the
-- database level (second insert raises 23505).
CREATE UNIQUE INDEX "ApprovalTask_one_pending"
  ON "ApprovalTask"("workflowInstanceId")
  WHERE "status" = 'PENDING';
