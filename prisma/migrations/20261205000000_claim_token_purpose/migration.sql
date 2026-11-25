-- ======================================================================
-- ClaimToken purpose + company/employee binding (Slice A)
--
-- Every live claim code is bound to the ONE operation it may perform:
--   COMPANY_ONBOARD  -> activate admin + complete company/HO onboarding
--   EMPLOYEE_INVITE  -> activate the bound employee's login only
-- purpose NULL is allowed only on already-closed legacy rows.
-- ======================================================================

CREATE TYPE "ClaimTokenPurpose" AS ENUM ('COMPANY_ONBOARD', 'EMPLOYEE_INVITE');

ALTER TABLE "ClaimToken"
  ADD COLUMN "purpose" "ClaimTokenPurpose",
  ADD COLUMN "companyId" UUID,
  ADD COLUMN "employeeId" UUID;

-- Backing unique for the triple FK (principalId is nullable -- NULL rows are
-- simply never referenced, which is exactly what invite binding needs).
CREATE UNIQUE INDEX "Employee_id_companyId_principalId_key"
  ON "Employee"("id", "companyId", "principalId");

-- Bound-token lookups: WHERE companyId = ? AND employeeId = ? [AND consumed].
CREATE INDEX "ClaimToken_companyId_employeeId_consumedAt_idx"
  ON "ClaimToken"("companyId", "employeeId", "consumedAt");

-- >>> claim-token-classification >>>
-- Classify ONLY provable live tokens via the audit trail. A token must have
-- exactly ONE employee link on its principal (multi-company principals are
-- ambiguous by definition) in a NON-platform company AND exactly one
-- evidence kind. Invite evidence (EMPLOYEE_INVITED / EMPLOYEE_INVITE_RESENT
-- audits on THAT employee in THAT company) and onboard evidence
-- (CLAIM_TOKEN_REISSUED on THAT principal, or PLATFORM_COMPANY_CREATED
-- naming THAT employee) are tied to the principal/employee/company triple --
-- unrelated audit rows can never classify a token.
WITH ev AS (
  SELECT
    ct.id AS token_id,
    e.id  AS employee_id,
    e."companyId",
    EXISTS (
      SELECT 1 FROM "AuditLog" a
      WHERE a."entityType" = 'EMPLOYEE'
        AND a."entityId" = e.id
        AND a."companyId" = e."companyId"
        AND a.action IN ('EMPLOYEE_INVITED', 'EMPLOYEE_INVITE_RESENT')
    ) AS invite_evidence,
    (
      EXISTS (
        SELECT 1 FROM "AuditLog" a
        WHERE a."entityType" = 'PRINCIPAL'
          AND a."entityId" = ct."principalId"
          AND a."companyId" = e."companyId"
          AND a.action = 'CLAIM_TOKEN_REISSUED')
      OR EXISTS (
        SELECT 1 FROM "AuditLog" a
        WHERE a."entityType" = 'COMPANY'
          AND a."entityId" = e."companyId"
          AND a.action = 'PLATFORM_COMPANY_CREATED'
          AND a."changedFields" -> 'adminEmployee' ->> 'after' = e.id::text)
    ) AS onboard_evidence
  FROM "ClaimToken" ct
  JOIN "Employee" e ON e."principalId" = ct."principalId"
  JOIN "Company" c ON c.id = e."companyId" AND c."isPlatform" = false
  WHERE ct."consumedAt" IS NULL
    AND (SELECT count(*) FROM "Employee" e2
         WHERE e2."principalId" = ct."principalId") = 1
)
UPDATE "ClaimToken" ct
SET "purpose" = CASE WHEN ev.invite_evidence
                     THEN 'EMPLOYEE_INVITE'
                     ELSE 'COMPANY_ONBOARD' END::"ClaimTokenPurpose",
    "companyId" = ev."companyId",
    "employeeId" = CASE WHEN ev.invite_evidence THEN ev.employee_id END
FROM ev
WHERE ct.id = ev.token_id
  -- XOR: exactly one evidence kind. Both or neither -> unclassified.
  AND ev.invite_evidence <> ev.onboard_evidence;

-- Fail closed: every unclassifiable unconsumed token is permanently CLOSED.
-- Both flows have safe reissue paths (platform claim-token route, employee
-- invite/resend), so closure is recoverable -- never a silent guess.
UPDATE "ClaimToken" SET "consumedAt" = now()
WHERE "consumedAt" IS NULL AND "purpose" IS NULL;
-- <<< claim-token-classification <<<

-- Purpose/binding invariants:
--   EMPLOYEE_INVITE -> companyId AND employeeId required
--   COMPANY_ONBOARD -> companyId required, employeeId forbidden
--   purpose NULL    -> only on already-closed rows (legacy/consumed)
ALTER TABLE "ClaimToken" ADD CONSTRAINT "ClaimToken_purpose_binding_ck" CHECK (
  ("purpose" IS NULL AND "consumedAt" IS NOT NULL)
  OR ("purpose" = 'EMPLOYEE_INVITE'
      AND "companyId" IS NOT NULL AND "employeeId" IS NOT NULL)
  OR ("purpose" = 'COMPANY_ONBOARD'
      AND "companyId" IS NOT NULL AND "employeeId" IS NULL)
);

ALTER TABLE "ClaimToken" ADD CONSTRAINT "ClaimToken_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Triple composite FK: the bound employee must exist, belong to the bound
-- company, AND have this token's principalId as its linked principal.
ALTER TABLE "ClaimToken" ADD CONSTRAINT "ClaimToken_employeeId_companyId_principalId_fkey"
  FOREIGN KEY ("employeeId", "companyId", "principalId")
  REFERENCES "Employee"("id", "companyId", "principalId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
