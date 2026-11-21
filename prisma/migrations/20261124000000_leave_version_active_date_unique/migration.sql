-- Hardening: one ACTIVE LeavePolicyVersion per (policy, effectiveFrom).
-- Two active versions sharing a start date are an ambiguous effective-date
-- match. Cancelled (ARCHIVED) versions do not block reusing the date.
CREATE UNIQUE INDEX "LeavePolicyVersion_policyId_effectiveFrom_active_key"
    ON "LeavePolicyVersion"("policyId", "effectiveFrom")
    WHERE "status" = 'ACTIVE';
