-- Head-office punch anchors: HO-department employees (no Site) punch against
-- their department's base Head Office instead of a construction site.

-- HeadOffice geo + timezone fields mirror Site's geofence contract.
ALTER TABLE "HeadOffice"
  ADD COLUMN "geoLatitude" DECIMAL(9,6),
  ADD COLUMN "geoLongitude" DECIMAL(9,6),
  ADD COLUMN "geoFenceRadiusM" INTEGER,
  ADD COLUMN "timezone" TEXT;

-- AttendanceSession gains a head-office anchor; siteId becomes nullable and a
-- CHECK constraint guarantees exactly one location anchor per session.
ALTER TABLE "AttendanceSession" ALTER COLUMN "siteId" DROP NOT NULL;
ALTER TABLE "AttendanceSession" ADD COLUMN "headOfficeId" UUID;

ALTER TABLE "AttendanceSession"
  ADD CONSTRAINT "AttendanceSession_headOfficeId_companyId_fkey"
  FOREIGN KEY ("headOfficeId", "companyId")
  REFERENCES "HeadOffice"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceSession"
  ADD CONSTRAINT "AttendanceSession_location_check"
  CHECK (
    ("siteId" IS NOT NULL AND "headOfficeId" IS NULL)
    OR ("siteId" IS NULL AND "headOfficeId" IS NOT NULL)
  );

CREATE INDEX "AttendanceSession_companyId_headOfficeId_businessDate_idx"
  ON "AttendanceSession"("companyId", "headOfficeId", "businessDate");
