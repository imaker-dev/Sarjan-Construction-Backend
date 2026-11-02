-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'DEAD');

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ,
    "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMPTZ,
    "eventKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "recipientPrincipalId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ,
    "publishedAt" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_id_idx" ON "OutboxEvent"("status", "nextAttemptAt", "id");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_leaseUntil_idx" ON "OutboxEvent"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_companyId_eventKey_key" ON "OutboxEvent"("companyId", "eventKey");

-- CreateIndex
CREATE INDEX "Notification_recipientPrincipalId_companyId_createdAt_id_idx" ON "Notification"("recipientPrincipalId", "companyId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Notification_companyId_publishedAt_idx" ON "Notification"("companyId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_companyId_recipientPrincipalId_eventKey_key" ON "Notification"("companyId", "recipientPrincipalId", "eventKey");

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientPrincipalId_fkey" FOREIGN KEY ("recipientPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Republish sweep: durable rows not yet pushed to Redis.
CREATE INDEX "Notification_unpublished_idx" ON "Notification"("companyId", "publishedAt")
  WHERE "publishedAt" IS NULL;
