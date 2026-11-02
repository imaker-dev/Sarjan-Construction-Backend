-- CreateEnum
CREATE TYPE "PrincipalType" AS ENUM ('USER', 'SERVICE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "LoginIdType" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "PrincipalStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('COMPANY', 'HEAD_OFFICE', 'PROJECT', 'SITE');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Principal" (
    "id" UUID NOT NULL,
    "loginId" TEXT NOT NULL,
    "loginIdType" "LoginIdType" NOT NULL,
    "passwordHash" TEXT,
    "type" "PrincipalType" NOT NULL DEFAULT 'USER',
    "status" "PrincipalStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Principal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "principalId" UUID,
    "employeeCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "principalId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "headOfficeId" UUID,
    "projectId" UUID,
    "siteId" UUID,
    "grantedByPrincipalId" UUID,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "principalId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "replacedById" UUID,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Principal_loginId_key" ON "Principal"("loginId");

-- CreateIndex
CREATE INDEX "Employee_principalId_idx" ON "Employee"("principalId");

-- CreateIndex
CREATE INDEX "Employee_companyId_status_id_idx" ON "Employee"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_companyId_employeeCode_key" ON "Employee"("companyId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_companyId_principalId_key" ON "Employee"("companyId", "principalId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_companyId_key_key" ON "Role"("companyId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- CreateIndex
CREATE INDEX "RoleAssignment_principalId_revokedAt_idx" ON "RoleAssignment"("principalId", "revokedAt");

-- CreateIndex
CREATE INDEX "RoleAssignment_companyId_scopeType_idx" ON "RoleAssignment"("companyId", "scopeType");

-- CreateIndex
CREATE INDEX "AuthSession_principalId_status_idx" ON "AuthSession"("principalId", "status");

-- CreateIndex
CREATE INDEX "AuthSession_familyId_idx" ON "AuthSession"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_id_companyId_key" ON "Site"("id", "companyId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_occurredAt_idx" ON "AuditLog"("actorId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_grantedByPrincipalId_fkey" FOREIGN KEY ("grantedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_headOfficeId_companyId_fkey" FOREIGN KEY ("headOfficeId", "companyId") REFERENCES "HeadOffice"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Scope-integrity invariant (hand-added; not expressible in the Prisma schema):
-- exactly the scope column matching scopeType may be set. Together with the
-- composite FKs above this guarantees an assignment's scope target exists and
-- belongs to the assignment's company.
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_scope_check" CHECK (
  ("scopeType" = 'COMPANY'     AND "headOfficeId" IS NULL     AND "projectId" IS NULL     AND "siteId" IS NULL)
  OR ("scopeType" = 'HEAD_OFFICE' AND "headOfficeId" IS NOT NULL AND "projectId" IS NULL     AND "siteId" IS NULL)
  OR ("scopeType" = 'PROJECT'     AND "projectId"    IS NOT NULL AND "headOfficeId" IS NULL  AND "siteId" IS NULL)
  OR ("scopeType" = 'SITE'        AND "siteId"       IS NOT NULL AND "headOfficeId" IS NULL  AND "projectId" IS NULL)
);
