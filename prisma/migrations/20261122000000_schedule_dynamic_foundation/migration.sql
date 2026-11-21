-- Milestone 1 (revised): dynamic work-schedule foundation.
-- Replaces the finite offSaturdayPattern / HolidayKind allowlists with
-- administrator-configured, data-driven structures:
--   * WorkScheduleRevision  — immutable, effective-dated pattern versions
--     (weekday set + monthly nth-weekday offs + anchored rotation cycle).
--   * WorkScheduleOverride  — date-specific WORKING/OFF overrides.
--   * HolidayCategory       — company-defined holiday categories.
--   * Holiday               — status-based cancel instead of hard delete.
-- Also guards AttendancePolicy/LeavePolicy against DEPARTMENT scope rows they
-- cannot shape (they have no departmentId column).

CREATE TYPE "ScheduleOverrideKind" AS ENUM ('WORKING', 'OFF');

-- ---------------------------------------------------------------------------
-- Holiday categories (administrator-defined vocabulary)
-- ---------------------------------------------------------------------------
CREATE TABLE "HolidayCategory" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "HolidayCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HolidayCategory_companyId_code_key" ON "HolidayCategory"("companyId", "code");
CREATE UNIQUE INDEX "HolidayCategory_id_companyId_key" ON "HolidayCategory"("id", "companyId");
CREATE INDEX "HolidayCategory_companyId_status_id_idx" ON "HolidayCategory"("companyId", "status", "id");

ALTER TABLE "HolidayCategory" ADD CONSTRAINT "HolidayCategory_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill one category per distinct legacy kind actually in use per company.
-- Companies with no holidays get a clean slate — nothing is seeded.
INSERT INTO "HolidayCategory" ("id", "companyId", "code", "name", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       h."companyId",
       h."kind",
       INITCAP(LOWER(h."kind"::text)),
       'ACTIVE',
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "companyId", "kind" FROM "Holiday") h;

-- Holiday: kind enum -> categoryId; add cancellable status.
ALTER TABLE "Holiday" ADD COLUMN "categoryId" UUID;
ALTER TABLE "Holiday" ADD COLUMN "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Holiday" ADD COLUMN "cancelledAt" TIMESTAMPTZ;

UPDATE "Holiday" h
SET "categoryId" = c."id"
FROM "HolidayCategory" c
WHERE c."companyId" = h."companyId" AND c."code" = h."kind"::text;

ALTER TABLE "Holiday" ALTER COLUMN "categoryId" SET NOT NULL;
DROP INDEX "Holiday_calendarId_date_key";
ALTER TABLE "Holiday" DROP COLUMN "kind";

-- One ACTIVE holiday per (calendar, date); cancelled rows are retained.
CREATE UNIQUE INDEX "Holiday_calendarId_date_active_key"
    ON "Holiday"("calendarId", "date") WHERE status = 'ACTIVE';
CREATE INDEX "Holiday_companyId_categoryId_idx" ON "Holiday"("companyId", "categoryId");

ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_categoryId_companyId_fkey"
    FOREIGN KEY ("categoryId", "companyId")
    REFERENCES "HolidayCategory"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TYPE "HolidayKind";

-- ---------------------------------------------------------------------------
-- Work schedule revisions (immutable pattern history)
-- ---------------------------------------------------------------------------
CREATE TABLE "WorkScheduleRevision" (
    "id" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "workingWeekdays" INTEGER[] NOT NULL,
    "offNthWeekdays" JSONB,
    "rotationAnchor" DATE,
    "rotationLengthDays" INTEGER,
    "rotationWorkingOffsets" INTEGER[] NOT NULL DEFAULT '{}',
    "rotationOffOffsets" INTEGER[] NOT NULL DEFAULT '{}',
    "holidayCalendarId" UUID,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdByPrincipalId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkScheduleRevision_pkey" PRIMARY KEY ("id")
);

-- Rotation consistency: rotation config is all-or-nothing (offset bounds and
-- uniqueness within/between the offset arrays are service-validated — CHECK
-- constraints cannot inspect array elements or use subqueries).
ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "wsr_rotation" CHECK (
    (
        "rotationLengthDays" IS NULL
        AND "rotationAnchor" IS NULL
        AND cardinality("rotationWorkingOffsets") = 0
        AND cardinality("rotationOffOffsets") = 0
    )
    OR (("rotationLengthDays" BETWEEN 2 AND 366) IS TRUE AND "rotationAnchor" IS NOT NULL)
);

-- At least one source of working days: a weekday set or working cycle offsets.
ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "wsr_working_source" CHECK (
    cardinality("workingWeekdays") > 0 OR cardinality("rotationWorkingOffsets") > 0
);

-- Weekday values within 0..6; duplicates rejected by the service layer.
ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "wsr_weekdays" CHECK (
    "workingWeekdays" <@ '{0,1,2,3,4,5,6}'::integer[]
);

-- Migrate each existing schedule's pattern into revision 1. Legacy pattern
-- mapping: ALL -> every nth occurrence of Saturday off; SECOND_AND_FOURTH /
-- FIRST_AND_THIRD -> positional nth-offs; ALTERNATE -> 14-day anchored cycle.
INSERT INTO "WorkScheduleRevision"
    ("id", "scheduleId", "companyId", "revision", "effectiveFrom", "timezone",
     "workingWeekdays", "offNthWeekdays", "rotationAnchor", "rotationLengthDays",
     "rotationWorkingOffsets", "rotationOffOffsets", "holidayCalendarId", "status",
     "createdAt")
SELECT gen_random_uuid(),
       ws."id",
       ws."companyId",
       1,
       ws."effectiveFrom",
       ws."timezone",
       ws."workingWeekdays",
       CASE ws."offSaturdayPattern"
           WHEN 'ALL' THEN '[{"weekday":6,"nths":[1,2,3,4,5,-1]}]'::jsonb
           WHEN 'SECOND_AND_FOURTH' THEN '[{"weekday":6,"nths":[2,4]}]'::jsonb
           WHEN 'FIRST_AND_THIRD' THEN '[{"weekday":6,"nths":[1,3]}]'::jsonb
           ELSE NULL
       END,
       CASE WHEN ws."offSaturdayPattern" = 'ALTERNATE' THEN ws."offSaturdayAnchor" END,
       CASE WHEN ws."offSaturdayPattern" = 'ALTERNATE' THEN 14 END,
       '{}'::integer[],
       CASE WHEN ws."offSaturdayPattern" = 'ALTERNATE' THEN '{0}'::integer[] ELSE '{}'::integer[] END,
       ws."holidayCalendarId",
       'ACTIVE',
       CURRENT_TIMESTAMP
FROM "WorkSchedule" ws;

CREATE UNIQUE INDEX "WorkScheduleRevision_scheduleId_revision_key"
    ON "WorkScheduleRevision"("scheduleId", "revision");
CREATE INDEX "WorkScheduleRevision_scheduleId_effectiveFrom_revision_idx"
    ON "WorkScheduleRevision"("scheduleId", "effectiveFrom", "revision");
CREATE INDEX "WorkScheduleRevision_companyId_holidayCalendarId_idx"
    ON "WorkScheduleRevision"("companyId", "holidayCalendarId");

ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "WorkScheduleRevision_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "WorkScheduleRevision_scheduleId_companyId_fkey"
    FOREIGN KEY ("scheduleId", "companyId")
    REFERENCES "WorkSchedule"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkScheduleRevision" ADD CONSTRAINT "WorkScheduleRevision_holidayCalendarId_companyId_fkey"
    FOREIGN KEY ("holidayCalendarId", "companyId")
    REFERENCES "HolidayCalendar"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Date-specific overrides
-- ---------------------------------------------------------------------------
CREATE TABLE "WorkScheduleOverride" (
    "id" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "disposition" "ScheduleOverrideKind" NOT NULL,
    "name" TEXT,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelledAt" TIMESTAMPTZ,
    "createdByPrincipalId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WorkScheduleOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkScheduleOverride_scheduleId_date_active_key"
    ON "WorkScheduleOverride"("scheduleId", "date") WHERE status = 'ACTIVE';
CREATE INDEX "WorkScheduleOverride_companyId_scheduleId_date_idx"
    ON "WorkScheduleOverride"("companyId", "scheduleId", "date");

ALTER TABLE "WorkScheduleOverride" ADD CONSTRAINT "WorkScheduleOverride_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkScheduleOverride" ADD CONSTRAINT "WorkScheduleOverride_scheduleId_companyId_fkey"
    FOREIGN KEY ("scheduleId", "companyId")
    REFERENCES "WorkSchedule"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WorkSchedule: drop per-row pattern columns (now immutable revisions).
-- The scope-shape, effective-range and no-overlap constraints stay — they
-- apply to the schedule identity window, which is unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE "WorkSchedule" DROP CONSTRAINT "work_schedule_weekdays";
ALTER TABLE "WorkSchedule" DROP CONSTRAINT "work_schedule_saturday_pattern";
ALTER TABLE "WorkSchedule" DROP COLUMN "timezone";
ALTER TABLE "WorkSchedule" DROP COLUMN "workingWeekdays";
ALTER TABLE "WorkSchedule" DROP COLUMN "offSaturdayPattern";
ALTER TABLE "WorkSchedule" DROP COLUMN "offSaturdayAnchor";
ALTER TABLE "WorkSchedule" DROP COLUMN "holidayCalendarId";

-- ---------------------------------------------------------------------------
-- Scope-enum guard: DEPARTMENT was added to the shared AttendancePolicyScope
-- enum for WorkSchedule, but AttendancePolicy and LeavePolicy have no
-- departmentId column — a DEPARTMENT-scoped row there could never name its
-- target. Fail closed at the database layer.
-- ---------------------------------------------------------------------------
ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "attendance_policy_no_department_scope"
    CHECK ("scope" <> 'DEPARTMENT');
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "leave_policy_no_department_scope"
    CHECK ("scopeType" <> 'DEPARTMENT');
