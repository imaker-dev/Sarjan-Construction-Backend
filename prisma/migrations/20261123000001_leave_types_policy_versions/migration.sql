-- Milestone 2A: dynamic leave types + versioned leave policy configuration.
--
-- * LeaveTypeDef — company-configured leave type vocabulary (Casual, Sick,
--   Earned/Privilege, Comp Off, Loss of Pay, custom). No amounts seeded.
-- * LeavePolicyVersion — immutable, effective-dated accrual configuration
--   (MONTHLY_CREDIT / WORKED_DAYS_RATIO / NONE), mirroring WorkSchedule's
--   identity+revision split. Version rows are appended, never updated.
-- * LeavePolicy gains departmentId (DEPARTMENT scope via the real Department
--   record — valid for leave regardless of department location) and typeDefId;
--   leaveType becomes nullable (custom types have no enum value).
--
-- Preservation: every existing policy keeps its row, enum value, and config
-- columns verbatim. Backfilled version-1 rows carry mode NONE plus a
-- legacyConfig JSON snapshot — legacy accrual semantics (annualAllowance +
-- accrualFrequency) are preserved losslessly, NOT silently converted into the
-- new modes (annual amounts cannot be mapped to monthly credits without
-- changing meaning). Requests and balances are untouched.

CREATE TYPE "LeaveAccrualMode" AS ENUM ('MONTHLY_CREDIT', 'WORKED_DAYS_RATIO', 'NONE');

-- ---------------------------------------------------------------------------
-- Leave type definitions
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveTypeDef" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "leaveType" "LeaveType",
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "LeaveTypeDef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaveTypeDef_companyId_code_key" ON "LeaveTypeDef"("companyId", "code");
CREATE UNIQUE INDEX "LeaveTypeDef_companyId_leaveType_key" ON "LeaveTypeDef"("companyId", "leaveType");
CREATE UNIQUE INDEX "LeaveTypeDef_id_companyId_key" ON "LeaveTypeDef"("id", "companyId");
CREATE INDEX "LeaveTypeDef_companyId_status_id_idx" ON "LeaveTypeDef"("companyId", "status", "id");

ALTER TABLE "LeaveTypeDef" ADD CONSTRAINT "LeaveTypeDef_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill one definition per distinct leaveType enum value actually used by
-- the company (policies, balances, or requests). Companies with no leave data
-- get a clean slate — nothing is seeded, no amounts are invented.
INSERT INTO "LeaveTypeDef" ("id", "companyId", "code", "name", "leaveType", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u."companyId", LOWER(u."leaveType"), INITCAP(LOWER(REPLACE(u."leaveType", '_', ' '))), u."leaveType"::"LeaveType", 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "companyId", "leaveType"::text AS "leaveType" FROM "LeavePolicy"
    UNION
    SELECT DISTINCT "companyId", "leaveType"::text FROM "LeaveBalance"
    UNION
    SELECT DISTINCT "companyId", "leaveType"::text FROM "LeaveRequest"
) u;

-- ---------------------------------------------------------------------------
-- LeavePolicy: department scope + type def link
-- ---------------------------------------------------------------------------
ALTER TABLE "LeavePolicy" DROP CONSTRAINT "leave_policy_no_department_scope";

ALTER TABLE "LeavePolicy" ADD COLUMN "departmentId" UUID;
ALTER TABLE "LeavePolicy" ADD COLUMN "typeDefId" UUID;
ALTER TABLE "LeavePolicy" ALTER COLUMN "leaveType" DROP NOT NULL;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_departmentId_companyId_fkey"
    FOREIGN KEY ("departmentId", "companyId")
    REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_typeDefId_companyId_fkey"
    FOREIGN KEY ("typeDefId", "companyId")
    REFERENCES "LeaveTypeDef"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "LeavePolicy_companyId_departmentId_idx" ON "LeavePolicy"("companyId", "departmentId");
CREATE INDEX "LeavePolicy_companyId_typeDefId_idx" ON "LeavePolicy"("companyId", "typeDefId");

-- Link existing policies to their backfilled type definition.
UPDATE "LeavePolicy" p
SET "typeDefId" = d."id"
FROM "LeaveTypeDef" d
WHERE d."companyId" = p."companyId" AND d."leaveType" = p."leaveType"::text::"LeaveType";

-- Scope shape: exactly the scope's own reference column is populated.
-- DEPARTMENT is valid for leave policies (unlike AttendancePolicy, which
-- keeps its own no-DEPARTMENT guard).
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "leave_policy_scope_shape" CHECK (
    ("scopeType" = 'COMPANY' AND "departmentId" IS NULL AND "projectId" IS NULL AND "siteId" IS NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'DEPARTMENT' AND "departmentId" IS NOT NULL AND "projectId" IS NULL AND "siteId" IS NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'PROJECT' AND "departmentId" IS NULL AND "projectId" IS NOT NULL AND "siteId" IS NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'SITE' AND "departmentId" IS NULL AND "projectId" IS NULL AND "siteId" IS NOT NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'EMPLOYEE' AND "departmentId" IS NULL AND "projectId" IS NULL AND "siteId" IS NULL AND "employeeId" IS NOT NULL)
);

-- One ACTIVE typed policy per (type, scope target). NULL target sentinel
-- distinguishes COMPANY rows. Legacy rows without typeDefId are excluded.
CREATE UNIQUE INDEX "LeavePolicy_active_type_target_key"
    ON "LeavePolicy"(
        "companyId", "typeDefId", "scopeType",
        COALESCE("departmentId", "projectId", "siteId", "employeeId",
                 '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE "isActive" AND "typeDefId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Immutable policy versions
-- ---------------------------------------------------------------------------
CREATE TABLE "LeavePolicyVersion" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "mode" "LeaveAccrualMode" NOT NULL,
    "monthlyCreditAmount" DECIMAL(4,1),
    "ratioThresholdDays" INTEGER,
    "ratioEarnedAmount" DECIMAL(4,1),
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "legacyConfig" JSONB,
    "createdByPrincipalId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeavePolicyVersion_pkey" PRIMARY KEY ("id")
);

-- Mode-field consistency: each mode owns exactly its parameter columns.
ALTER TABLE "LeavePolicyVersion" ADD CONSTRAINT "lpv_mode_fields" CHECK (
    (
        "mode" = 'MONTHLY_CREDIT'
        AND "monthlyCreditAmount" IS NOT NULL AND "monthlyCreditAmount" > 0
        AND "ratioThresholdDays" IS NULL AND "ratioEarnedAmount" IS NULL
    )
    OR (
        "mode" = 'WORKED_DAYS_RATIO'
        AND "ratioThresholdDays" IS NOT NULL AND "ratioThresholdDays" > 0
        AND "ratioEarnedAmount" IS NOT NULL AND "ratioEarnedAmount" > 0
        AND "monthlyCreditAmount" IS NULL
    )
    OR (
        "mode" = 'NONE'
        AND "monthlyCreditAmount" IS NULL
        AND "ratioThresholdDays" IS NULL AND "ratioEarnedAmount" IS NULL
    )
);

CREATE UNIQUE INDEX "LeavePolicyVersion_policyId_version_key"
    ON "LeavePolicyVersion"("policyId", "version");
CREATE INDEX "LeavePolicyVersion_policyId_effectiveFrom_version_idx"
    ON "LeavePolicyVersion"("policyId", "effectiveFrom", "version");
CREATE INDEX "LeavePolicyVersion_companyId_idx" ON "LeavePolicyVersion"("companyId");

ALTER TABLE "LeavePolicyVersion" ADD CONSTRAINT "LeavePolicyVersion_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeavePolicyVersion" ADD CONSTRAINT "LeavePolicyVersion_policyId_companyId_fkey"
    FOREIGN KEY ("policyId", "companyId")
    REFERENCES "LeavePolicy"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill version 1 for every existing policy. mode NONE + legacyConfig
-- snapshot: the original accrual fields are preserved verbatim, and admins
-- re-author explicit accrual versions going forward.
INSERT INTO "LeavePolicyVersion"
    ("id", "policyId", "companyId", "version", "effectiveFrom", "mode",
     "status", "note", "legacyConfig", "createdAt")
SELECT gen_random_uuid(),
       p."id",
       p."companyId",
       1,
       p."createdAt"::date,
       'NONE',
       'ACTIVE',
       'legacy-import',
       jsonb_build_object(
           'leaveType', p."leaveType"::text,
           'annualAllowance', p."annualAllowance",
           'accrualFrequency', p."accrualFrequency"::text,
           'maxConsecutiveDays', p."maxConsecutiveDays",
           'minNoticeDays', p."minNoticeDays",
           'allowHalfDay', p."allowHalfDay",
           'sandwichRule', p."sandwichRule",
           'carryoverMaxDays', p."carryoverMaxDays",
           'encashable', p."encashable",
           'requiresDocAboveDays', p."requiresDocAboveDays"
       ),
       CURRENT_TIMESTAMP
FROM "LeavePolicy" p;
