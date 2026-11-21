# Rollback — 20261126000000_attendance_head_office_punch

Prefer a forward-fix migration. If a true rollback is required (dev/staging
only, after verifying no `AttendanceSession` rows carry `headOfficeId`):

1. `DELETE FROM "AttendanceSession" WHERE "headOfficeId" IS NOT NULL;`
   (or migrate those rows to a Site anchor first)
2. `ALTER TABLE "AttendanceSession" DROP CONSTRAINT "AttendanceSession_location_check";`
3. `ALTER TABLE "AttendanceSession" DROP CONSTRAINT "AttendanceSession_headOfficeId_companyId_fkey";`
4. `DROP INDEX "AttendanceSession_companyId_headOfficeId_businessDate_idx";`
5. `ALTER TABLE "AttendanceSession" DROP COLUMN "headOfficeId", ALTER COLUMN "siteId" SET NOT NULL;`
6. `ALTER TABLE "HeadOffice" DROP COLUMN "geoLatitude", DROP COLUMN "geoLongitude", DROP COLUMN "geoFenceRadiusM", DROP COLUMN "timezone";`

Verify constraint names with `\d+ "AttendanceSession"` before dropping —
Postgres may have renamed an earlier variant.
