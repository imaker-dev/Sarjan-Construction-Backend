-- Company-controlled delegation switches for scoped project/site
-- administration (PI/PD). All flags default OFF; no row means no delegation.
CREATE TABLE "CompanyDelegationPolicy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "siteCreate" BOOLEAN NOT NULL DEFAULT false,
    "siteUpdate" BOOLEAN NOT NULL DEFAULT false,
    "deptManage" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyDelegationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyDelegationPolicy_companyId_key" ON "CompanyDelegationPolicy"("companyId");

ALTER TABLE "CompanyDelegationPolicy"
    ADD CONSTRAINT "CompanyDelegationPolicy_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
