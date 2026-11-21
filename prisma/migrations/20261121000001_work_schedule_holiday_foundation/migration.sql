CREATE TYPE "HolidayKind" AS ENUM ('NATIONAL', 'FESTIVAL', 'COMPANY', 'RESTRICTED', 'CUSTOM');

-- CreateTable
CREATE TABLE "HolidayCalendar" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "HolidayCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "HolidayKind" NOT NULL DEFAULT 'COMPANY',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSchedule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "scopeType" "AttendancePolicyScope" NOT NULL DEFAULT 'COMPANY',
    "departmentId" UUID,
    "projectId" UUID,
    "siteId" UUID,
    "employeeId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT NOT NULL,
    "workingWeekdays" INTEGER[] NOT NULL,
    "offSaturdayPattern" TEXT,
    "offSaturdayAnchor" DATE,
    "holidayCalendarId" UUID,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "status" "OrgNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WorkSchedule_pkey" PRIMARY KEY ("id")
);

-- Scope shape: exactly the scope's own reference column is populated.
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "work_schedule_scope_shape" CHECK (
    ("scopeType" = 'COMPANY' AND "departmentId" IS NULL AND "projectId" IS NULL AND "siteId" IS NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'DEPARTMENT' AND "departmentId" IS NOT NULL AND "projectId" IS NULL AND "siteId" IS NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'PROJECT' AND "projectId" IS NOT NULL AND "departmentId" IS NULL AND "siteId" IS NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'SITE' AND "siteId" IS NOT NULL AND "departmentId" IS NULL AND "projectId" IS NULL AND "employeeId" IS NULL)
    OR ("scopeType" = 'EMPLOYEE' AND "employeeId" IS NOT NULL AND "departmentId" IS NULL AND "projectId" IS NULL AND "siteId" IS NULL)
);

-- Weekday values: 1-7 entries, all within 0..6 (Sun..Sat). Duplicate entries
-- are rejected by the service layer (CHECK constraints cannot use subqueries).
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "work_schedule_weekdays" CHECK (
    cardinality("workingWeekdays") BETWEEN 1 AND 7
    AND "workingWeekdays" <@ '{0,1,2,3,4,5,6}'::integer[]
);

-- Saturday carve-out consistency: pattern requires Saturday (6) to be a
-- working weekday; ALTERNATE additionally requires a Saturday anchor date.
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "work_schedule_saturday_pattern" CHECK (
    ("offSaturdayPattern" IS NULL AND "offSaturdayAnchor" IS NULL)
    OR (
        "offSaturdayPattern" IN ('ALL', 'SECOND_AND_FOURTH', 'FIRST_AND_THIRD')
        AND 6 = ANY("workingWeekdays")
        AND "offSaturdayAnchor" IS NULL
    )
    OR (
        "offSaturdayPattern" = 'ALTERNATE'
        AND 6 = ANY("workingWeekdays")
        AND "offSaturdayAnchor" IS NOT NULL
        AND EXTRACT(ISODOW FROM "offSaturdayAnchor") = 6
    )
);

-- Effective range ordering; effectiveTo NULL = open-ended.
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "work_schedule_effective_range" CHECK (
    "effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"
);

-- No overlapping ACTIVE schedules at the same scope target. The COALESCE
-- sentinel ('0000...') makes COMPANY-scope rows comparable (NULL never equals
-- NULL in exclusion constraints). Requires btree_gist (enabled earlier).
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "work_schedule_no_overlap" EXCLUDE USING gist (
    "companyId" WITH =,
    "scopeType" WITH =,
    COALESCE("departmentId", "projectId", "siteId", "employeeId", '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo", '9999-12-31'::date), '[]') WITH &&
) WHERE (status = 'ACTIVE');

-- CreateIndex
CREATE UNIQUE INDEX "HolidayCalendar_companyId_code_key" ON "HolidayCalendar"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "HolidayCalendar_id_companyId_key" ON "HolidayCalendar"("id", "companyId");

-- CreateIndex
CREATE INDEX "HolidayCalendar_companyId_status_id_idx" ON "HolidayCalendar"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_calendarId_date_key" ON "Holiday"("calendarId", "date");

-- CreateIndex
CREATE INDEX "Holiday_companyId_calendarId_date_idx" ON "Holiday"("companyId", "calendarId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSchedule_id_companyId_key" ON "WorkSchedule"("id", "companyId");

-- CreateIndex
CREATE INDEX "WorkSchedule_companyId_scopeType_idx" ON "WorkSchedule"("companyId", "scopeType");

-- CreateIndex
CREATE INDEX "WorkSchedule_companyId_departmentId_idx" ON "WorkSchedule"("companyId", "departmentId");

-- CreateIndex
CREATE INDEX "WorkSchedule_companyId_projectId_idx" ON "WorkSchedule"("companyId", "projectId");

-- CreateIndex
CREATE INDEX "WorkSchedule_companyId_siteId_idx" ON "WorkSchedule"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "WorkSchedule_companyId_employeeId_idx" ON "WorkSchedule"("companyId", "employeeId");

-- AddForeignKey
ALTER TABLE "HolidayCalendar" ADD CONSTRAINT "HolidayCalendar_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_calendarId_companyId_fkey" FOREIGN KEY ("calendarId", "companyId") REFERENCES "HolidayCalendar"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_projectId_companyId_fkey" FOREIGN KEY ("projectId", "companyId") REFERENCES "Project"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_holidayCalendarId_companyId_fkey" FOREIGN KEY ("holidayCalendarId", "companyId") REFERENCES "HolidayCalendar"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
