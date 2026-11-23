-- Delegate site workforce onboarding (profile + initial placement, no login)
-- to scoped project/site holders. Default OFF; a missing policy row means
-- nothing is delegated.
ALTER TABLE "CompanyDelegationPolicy" ADD COLUMN "employeeOnboard" BOOLEAN NOT NULL DEFAULT false;
