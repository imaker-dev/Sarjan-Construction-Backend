-- Platform marker + single-use claim codes
ALTER TABLE "Company" ADD COLUMN "isPlatform" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Company_one_platform" ON "Company"("isPlatform") WHERE "isPlatform" = true;

CREATE TABLE "ClaimToken" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "principalId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "consumedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ClaimToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClaimToken_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "ClaimToken_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ClaimToken_principalId_consumedAt_idx" ON "ClaimToken"("principalId", "consumedAt");
-- At most one active (unconsumed) claim code per principal — concurrent
-- reissues can never leave two usable codes.
CREATE UNIQUE INDEX "ClaimToken_one_active_per_principal" ON "ClaimToken"("principalId") WHERE "consumedAt" IS NULL;
