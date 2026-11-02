-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_permissionId_fkey";

-- DropForeignKey
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_roleId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "occurredAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "Principal" ALTER COLUMN "loginId" DROP NOT NULL,
ALTER COLUMN "loginIdType" DROP NOT NULL,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "Employee" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "Role" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "Permission" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "RolePermission" ALTER COLUMN "assignedAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "RoleAssignment" ALTER COLUMN "effectiveFrom" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "effectiveTo" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "revokedAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "AuthSession" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "lastUsedAt" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "RefreshToken" ALTER COLUMN "issuedAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "consumedAt" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "revokedAt" SET DATA TYPE TIMESTAMPTZ;

-- CreateIndex
CREATE UNIQUE INDEX "Role_id_companyId_key" ON "Role"("id", "companyId");

-- CreateIndex
CREATE INDEX "RoleAssignment_headOfficeId_idx" ON "RoleAssignment"("headOfficeId");

-- CreateIndex
CREATE INDEX "RoleAssignment_projectId_idx" ON "RoleAssignment"("projectId");

-- CreateIndex
CREATE INDEX "RoleAssignment_siteId_idx" ON "RoleAssignment"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_id_sessionId_key" ON "RefreshToken"("id", "sessionId");

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_companyId_fkey" FOREIGN KEY ("roleId", "companyId") REFERENCES "Role"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_replacedById_sessionId_fkey" FOREIGN KEY ("replacedById", "sessionId") REFERENCES "RefreshToken"("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Consistency constraints (hand-added; not expressible in the Prisma schema):

-- USER principals must have normalized login credentials; SERVICE/SYSTEM must
-- not carry any login fields at all — they can never authenticate through the
-- human login flow.
ALTER TABLE "Principal" ADD CONSTRAINT "Principal_credentials_check" CHECK (
  ("type" = 'USER' AND "loginId" IS NOT NULL AND "loginIdType" IS NOT NULL AND "passwordHash" IS NOT NULL)
  OR ("type" <> 'USER' AND "loginId" IS NULL AND "loginIdType" IS NULL AND "passwordHash" IS NULL)
);

-- Login identifiers are stored normalized (trim + lowercase). lower()/btrim()
-- are IMMUTABLE so they are allowed in CHECK constraints.
ALTER TABLE "Principal" ADD CONSTRAINT "Principal_loginId_normalized" CHECK (
  "loginId" IS NULL OR "loginId" = lower(btrim("loginId"))
);

-- Effective windows must be well-formed when both bounds are set.
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_effective_range_check" CHECK (
  "effectiveFrom" IS NULL OR "effectiveTo" IS NULL OR "effectiveFrom" < "effectiveTo"
);

-- A refresh token cannot expire at or before its issue time.
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_expiry_check" CHECK (
  "expiresAt" > "issuedAt"
);
