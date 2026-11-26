-- Dynamic Head Office & site attendance schedules -- Slice 1.
-- Additive only: every new column is NULLable so day-pattern-only revisions
-- and pre-existing sessions behave exactly as before. No historical
-- attendance rows are rewritten or backfilled.

-- Intraday break + clock-out configuration on work-schedule revisions.
CREATE TYPE "BreakWindowMode" AS ENUM ('FIXED_WINDOW', 'DYNAMIC');
CREATE TYPE "AutoClockOutMode" AS ENUM ('DISABLED', 'AT_SCHEDULED_END', 'AFTER_GRACE');

ALTER TABLE "WorkScheduleRevision"
  ADD COLUMN "scheduledStartMins"    INTEGER,
  ADD COLUMN "scheduledEndMins"      INTEGER,
  ADD COLUMN "graceInMins"           INTEGER,
  ADD COLUMN "graceOutMins"          INTEGER,
  ADD COLUMN "breakWindowMode"       "BreakWindowMode",
  ADD COLUMN "breakWindowStartMins"  INTEGER,
  ADD COLUMN "breakWindowEndMins"    INTEGER,
  ADD COLUMN "breakDurationMins"     INTEGER,
  ADD COLUMN "autoClockOutMode"      "AutoClockOutMode",
  ADD COLUMN "autoClockOutGraceMins" INTEGER;

-- Intraday columns are all-or-nothing for the shift window, bounded to a day.
ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "WorkScheduleRevision_intraday_minutes_range"
  CHECK (
    ("scheduledStartMins"   IS NULL OR ("scheduledStartMins"   BETWEEN 0 AND 1439)) AND
    ("scheduledEndMins"     IS NULL OR ("scheduledEndMins"     BETWEEN 0 AND 1439)) AND
    ("breakWindowStartMins" IS NULL OR ("breakWindowStartMins" BETWEEN 0 AND 1439)) AND
    ("breakWindowEndMins"   IS NULL OR ("breakWindowEndMins"   BETWEEN 0 AND 1439)) AND
    ("graceInMins"          IS NULL OR ("graceInMins"          BETWEEN 0 AND 240)) AND
    ("graceOutMins"         IS NULL OR ("graceOutMins"         BETWEEN 0 AND 240)) AND
    ("breakDurationMins"    IS NULL OR ("breakDurationMins"    BETWEEN 1 AND 480)) AND
    ("autoClockOutGraceMins" IS NULL OR ("autoClockOutGraceMins" BETWEEN 0 AND 720))
  );

ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "WorkScheduleRevision_intraday_shape"
  CHECK (
    -- scheduled start and end are set together and never equal
    (("scheduledStartMins" IS NULL) = ("scheduledEndMins" IS NULL)) AND
    ("scheduledStartMins" IS NULL OR "scheduledStartMins" <> "scheduledEndMins") AND
    -- FIXED_WINDOW requires a real window and a duration that fits it
    ("breakWindowMode" IS DISTINCT FROM 'FIXED_WINDOW' OR (
      "breakWindowStartMins" IS NOT NULL AND
      "breakWindowEndMins"   IS NOT NULL AND
      "breakWindowEndMins" <> "breakWindowStartMins" AND
      "breakDurationMins"    IS NOT NULL AND
      "breakDurationMins" <=
        MOD("breakWindowEndMins" - "breakWindowStartMins" + 1440, 1440)
    )) AND
    -- DYNAMIC requires the per-day cap; a bounding window is optional
    ("breakWindowMode" IS DISTINCT FROM 'DYNAMIC' OR "breakDurationMins" IS NOT NULL) AND
    -- no break mode => no break window/duration fields
    ("breakWindowMode" IS NOT NULL OR (
      "breakWindowStartMins" IS NULL AND "breakWindowEndMins" IS NULL AND
      "breakDurationMins" IS NULL
    )) AND
    -- AFTER_GRACE requires a positive grace; AT_SCHEDULED_END forbids it
    ("autoClockOutMode" IS DISTINCT FROM 'AFTER_GRACE' OR
      ("autoClockOutGraceMins" IS NOT NULL AND "autoClockOutGraceMins" > 0)) AND
    ("autoClockOutMode" IS DISTINCT FROM 'AT_SCHEDULED_END' OR
      "autoClockOutGraceMins" IS NULL)
  );

-- Punch-time snapshot on sessions: pins the resolved schedule revision, the
-- calc-relevant policy values, and the local scheduled instants as UTC so
-- later policy/schedule edits never reclassify this session.
ALTER TABLE "AttendanceSession"
  ADD COLUMN "scheduleRevisionId"    UUID,
  ADD COLUMN "policySnapshot"        JSONB,
  ADD COLUMN "scheduledStartAt"      TIMESTAMPTZ,
  ADD COLUMN "scheduledEndAt"        TIMESTAMPTZ,
  ADD COLUMN "autoClockOutMode"      "AutoClockOutMode",
  ADD COLUMN "autoClockOutGraceMins" INTEGER,
  ADD COLUMN "autoClosedBy"          VARCHAR(24);

-- Composite FK keeps the snapshot tenant-safe (schedule revision is immutable
-- anyway, so the pin can never drift).
ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "WorkScheduleRevision_id_companyId_key"
  UNIQUE ("id", "companyId");
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_scheduleRevision_fkey"
  FOREIGN KEY ("scheduleRevisionId", "companyId")
  REFERENCES "WorkScheduleRevision" ("id", "companyId") ON DELETE RESTRICT;

ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_autoClockOut_shape"
  CHECK (
    ("autoClockOutMode" IS DISTINCT FROM 'AFTER_GRACE' OR
      ("autoClockOutGraceMins" IS NOT NULL AND "autoClockOutGraceMins" > 0)) AND
    ("autoClockOutMode" IS DISTINCT FROM 'AT_SCHEDULED_END' OR
      "autoClockOutGraceMins" IS NULL) AND
    ("autoClosedBy" IS NULL OR "autoClosedBy" IN ('SCHEDULED_END', 'EOD_SETTLEMENT', 'STALE_SWEEP'))
  );

CREATE INDEX "AttendanceSession_auto_close_idx"
  ON "AttendanceSession" ("companyId", "status", "autoClockOutMode", "scheduledEndAt")
  WHERE "status" = 'IN_PROGRESS' AND "scheduledEndAt" IS NOT NULL;

-- Delegation switch: scoped holders may edit project/site work schedules.
-- Defaults OFF -- Finance/Admin remain the only schedule editors until enabled.
ALTER TABLE "CompanyDelegationPolicy" ADD COLUMN "scheduleManage" BOOLEAN NOT NULL DEFAULT false;
