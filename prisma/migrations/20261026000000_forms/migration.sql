-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Form" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "schema" JSONB,
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
    "latestRevision" INTEGER NOT NULL DEFAULT 0,
    "currentVersionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormVersion" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "formId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "schema" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByPrincipalId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Form_companyId_operationId_status_id_idx" ON "Form"("companyId", "operationId", "status", "id");

-- CreateIndex
CREATE INDEX "Form_companyId_status_id_idx" ON "Form"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Form_companyId_operationId_key_key" ON "Form"("companyId", "operationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Form_id_companyId_key" ON "Form"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "FormVersion_companyId_formId_revision_key" ON "FormVersion"("companyId", "formId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "FormVersion_id_formId_companyId_key" ON "FormVersion"("id", "formId", "companyId");

-- AddForeignKey
ALTER TABLE "Form" ADD CONSTRAINT "Form_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Form" ADD CONSTRAINT "Form_operationId_companyId_fkey" FOREIGN KEY ("operationId", "companyId") REFERENCES "Operation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_formId_companyId_fkey" FOREIGN KEY ("formId", "companyId") REFERENCES "Form"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_publishedByPrincipalId_fkey" FOREIGN KEY ("publishedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Composite FK (hand-added): the pinned current version must belong to THIS
-- form and company. currentVersionId stays nullable until the first publish.
ALTER TABLE "Form" ADD CONSTRAINT "Form_currentVersion_fkey"
  FOREIGN KEY ("currentVersionId", "id", "companyId")
  REFERENCES "FormVersion"("id", "formId", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
