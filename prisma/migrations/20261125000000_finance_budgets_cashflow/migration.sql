-- Finance slice: project budgets, immutable revisions, review decisions,
-- and cash-flow forecasts. Additive only — no existing tables touched.
--
-- * Money is DECIMAL(18,2) — never float.
-- * BudgetRevision/BudgetRevisionLine are append-only in application code:
--   revision rows move DRAFT → SUBMITTED → APPROVED/REJECTED/RETURNED only
--   through submit/decide commands; lines are inserted once with the revision.
-- * Idempotency: partial unique indexes on idempotencyKey let retried
--   creates/decisions replay safely instead of duplicating records.
-- * latestApprovedRevisionId composite FK is added by hand below (no Prisma
--   relation — same pattern as Operation.currentVersionId).

CREATE TYPE "BudgetRevisionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED');
CREATE TYPE "BudgetCategory" AS ENUM ('MATERIAL', 'LABOUR', 'EQUIPMENT', 'SUBCONTRACT', 'OVERHEAD', 'CONTINGENCY', 'OTHER');
CREATE TYPE "BudgetReviewAction" AS ENUM ('APPROVE', 'REJECT', 'RETURN');
CREATE TYPE "CashFlowDirection" AS ENUM ('INFLOW', 'OUTFLOW');
CREATE TYPE "CashFlowCategory" AS ENUM ('CLIENT_RECEIPT', 'ADVANCE_RECEIPT', 'RETENTION_RELEASE', 'MATERIAL', 'LABOUR', 'EQUIPMENT', 'SUBCONTRACT', 'OVERHEAD', 'TAX', 'OTHER');

CREATE TABLE "ProjectBudget" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "latestApprovedRevisionId" UUID,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ProjectBudget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BudgetRevision" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "budgetId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "BudgetRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "submittedByPrincipalId" UUID,
    "submittedAt" TIMESTAMPTZ,
    "decidedByPrincipalId" UUID,
    "decidedAt" TIMESTAMPTZ,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "BudgetRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BudgetRevisionLine" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "category" "BudgetCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetRevisionLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BudgetReviewDecision" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "action" "BudgetReviewAction" NOT NULL,
    "actorPrincipalId" UUID,
    "actorType" TEXT NOT NULL,
    "reason" TEXT,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "eventKey" UUID NOT NULL,
    "decidedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetReviewDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CashFlowForecast" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "CashFlowForecast_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CashFlowForecastLine" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "forecastId" UUID NOT NULL,
    "direction" "CashFlowDirection" NOT NULL,
    "category" "CashFlowCategory" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "expectedDate" DATE,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashFlowForecastLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectBudget_companyId_projectId_status_id_idx" ON "ProjectBudget"("companyId", "projectId", "status", "id");
CREATE UNIQUE INDEX "ProjectBudget_companyId_projectId_code_key" ON "ProjectBudget"("companyId", "projectId", "code");
CREATE UNIQUE INDEX "ProjectBudget_id_companyId_key" ON "ProjectBudget"("id", "companyId");

CREATE INDEX "BudgetRevision_companyId_budgetId_status_id_idx" ON "BudgetRevision"("companyId", "budgetId", "status", "id");
CREATE UNIQUE INDEX "BudgetRevision_companyId_budgetId_revision_key" ON "BudgetRevision"("companyId", "budgetId", "revision");
CREATE UNIQUE INDEX "BudgetRevision_id_companyId_key" ON "BudgetRevision"("id", "companyId");
CREATE UNIQUE INDEX "BudgetRevision_id_budgetId_companyId_key" ON "BudgetRevision"("id", "budgetId", "companyId");

CREATE INDEX "BudgetRevisionLine_companyId_revisionId_sortOrder_id_idx" ON "BudgetRevisionLine"("companyId", "revisionId", "sortOrder", "id");

CREATE UNIQUE INDEX "BudgetReviewDecision_eventKey_key" ON "BudgetReviewDecision"("eventKey");
CREATE INDEX "BudgetReviewDecision_companyId_revisionId_decidedAt_id_idx" ON "BudgetReviewDecision"("companyId", "revisionId", "decidedAt", "id");

CREATE INDEX "CashFlowForecast_companyId_projectId_status_id_idx" ON "CashFlowForecast"("companyId", "projectId", "status", "id");
CREATE INDEX "CashFlowForecast_companyId_projectId_periodStart_periodEnd_idx" ON "CashFlowForecast"("companyId", "projectId", "periodStart", "periodEnd");
CREATE UNIQUE INDEX "CashFlowForecast_id_companyId_key" ON "CashFlowForecast"("id", "companyId");

CREATE INDEX "CashFlowForecastLine_companyId_forecastId_sortOrder_id_idx" ON "CashFlowForecastLine"("companyId", "forecastId", "sortOrder", "id");

ALTER TABLE "ProjectBudget" ADD CONSTRAINT "ProjectBudget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectBudget" ADD CONSTRAINT "ProjectBudget_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Hand-added composite FK (no Prisma relation): the latest-approved pointer
-- can only reference a revision belonging to this budget in this company.
ALTER TABLE "ProjectBudget" ADD CONSTRAINT "ProjectBudget_latestApprovedRevisionId_fkey"
    FOREIGN KEY ("latestApprovedRevisionId", "id", "companyId")
    REFERENCES "BudgetRevision"("id", "budgetId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BudgetRevision" ADD CONSTRAINT "BudgetRevision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetRevision" ADD CONSTRAINT "BudgetRevision_budgetId_companyId_fkey" FOREIGN KEY ("budgetId", "companyId") REFERENCES "ProjectBudget"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetRevision" ADD CONSTRAINT "BudgetRevision_submittedByPrincipalId_fkey" FOREIGN KEY ("submittedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetRevision" ADD CONSTRAINT "BudgetRevision_decidedByPrincipalId_fkey" FOREIGN KEY ("decidedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BudgetRevisionLine" ADD CONSTRAINT "BudgetRevisionLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetRevisionLine" ADD CONSTRAINT "BudgetRevisionLine_revisionId_companyId_fkey" FOREIGN KEY ("revisionId", "companyId") REFERENCES "BudgetRevision"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BudgetReviewDecision" ADD CONSTRAINT "BudgetReviewDecision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetReviewDecision" ADD CONSTRAINT "BudgetReviewDecision_revisionId_companyId_fkey" FOREIGN KEY ("revisionId", "companyId") REFERENCES "BudgetRevision"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetReviewDecision" ADD CONSTRAINT "BudgetReviewDecision_actorPrincipalId_fkey" FOREIGN KEY ("actorPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashFlowForecast" ADD CONSTRAINT "CashFlowForecast_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashFlowForecast" ADD CONSTRAINT "CashFlowForecast_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CashFlowForecastLine" ADD CONSTRAINT "CashFlowForecastLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashFlowForecastLine" ADD CONSTRAINT "CashFlowForecastLine_forecastId_companyId_fkey" FOREIGN KEY ("forecastId", "companyId") REFERENCES "CashFlowForecast"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Idempotent retry safety (partial uniques — Prisma cannot express these):
-- one create/decision per idempotency key per scope; rows without a key are
-- unaffected.
CREATE UNIQUE INDEX "ProjectBudget_companyId_projectId_idempotencyKey_key"
    ON "ProjectBudget"("companyId", "projectId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE UNIQUE INDEX "BudgetRevision_companyId_budgetId_idempotencyKey_key"
    ON "BudgetRevision"("companyId", "budgetId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE UNIQUE INDEX "BudgetReviewDecision_revisionId_idempotencyKey_key"
    ON "BudgetReviewDecision"("revisionId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE UNIQUE INDEX "CashFlowForecast_companyId_projectId_idempotencyKey_key"
    ON "CashFlowForecast"("companyId", "projectId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
