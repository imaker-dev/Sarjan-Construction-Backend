-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Operation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capabilityKey" TEXT,
    "description" TEXT,
    "definition" JSONB,
    "status" "OperationStatus" NOT NULL DEFAULT 'DRAFT',
    "latestRevision" INTEGER NOT NULL DEFAULT 0,
    "currentVersionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationVersion" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByPrincipalId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Operation_companyId_departmentId_status_id_idx" ON "Operation"("companyId", "departmentId", "status", "id");

-- CreateIndex
CREATE INDEX "Operation_companyId_status_id_idx" ON "Operation"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_companyId_departmentId_key_key" ON "Operation"("companyId", "departmentId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_id_companyId_key" ON "Operation"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationVersion_companyId_operationId_revision_key" ON "OperationVersion"("companyId", "operationId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "OperationVersion_id_operationId_companyId_key" ON "OperationVersion"("id", "operationId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_id_companyId_key" ON "Department"("id", "companyId");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationVersion" ADD CONSTRAINT "OperationVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationVersion" ADD CONSTRAINT "OperationVersion_operationId_companyId_fkey" FOREIGN KEY ("operationId", "companyId") REFERENCES "Operation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationVersion" ADD CONSTRAINT "OperationVersion_publishedByPrincipalId_fkey" FOREIGN KEY ("publishedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Composite FK (hand-added; Prisma can't express a self-consistent triple
-- reference): the pinned current version must belong to THIS operation and
-- company. currentVersionId stays nullable until the first publish.
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_currentVersion_fkey"
  FOREIGN KEY ("currentVersionId", "id", "companyId")
  REFERENCES "OperationVersion"("id", "operationId", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
