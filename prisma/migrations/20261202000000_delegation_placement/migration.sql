-- Delegate site-department membership administration to scoped project/site
-- holders. Default OFF; a missing policy row means nothing is delegated.
ALTER TABLE "CompanyDelegationPolicy" ADD COLUMN "placement" BOOLEAN NOT NULL DEFAULT false;
