-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Rule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB,
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "latestRevision" INTEGER NOT NULL DEFAULT 0,
    "currentVersionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleVersion" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByPrincipalId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rule_companyId_operationId_status_id_idx" ON "Rule"("companyId", "operationId", "status", "id");

-- CreateIndex
CREATE INDEX "Rule_companyId_status_id_idx" ON "Rule"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_companyId_operationId_key_key" ON "Rule"("companyId", "operationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_id_companyId_key" ON "Rule"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_companyId_ruleId_revision_key" ON "RuleVersion"("companyId", "ruleId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_id_ruleId_companyId_key" ON "RuleVersion"("id", "ruleId", "companyId");

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_operationId_companyId_fkey" FOREIGN KEY ("operationId", "companyId") REFERENCES "Operation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleId_companyId_fkey" FOREIGN KEY ("ruleId", "companyId") REFERENCES "Rule"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_publishedByPrincipalId_fkey" FOREIGN KEY ("publishedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Composite FK (hand-added): the pinned current version must belong to THIS
-- rule and company. currentVersionId stays nullable until first publish.
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_currentVersion_fkey"
  FOREIGN KEY ("currentVersionId", "id", "companyId")
  REFERENCES "RuleVersion"("id", "ruleId", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
