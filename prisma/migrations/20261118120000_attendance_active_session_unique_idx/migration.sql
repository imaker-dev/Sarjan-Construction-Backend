-- Create partial unique index on AttendanceSession for active IN_PROGRESS sessions
-- Guarantees at the database level that an employee can have at most one IN_PROGRESS session per company at any time.
CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceSession_company_employee_active_unique"
ON "AttendanceSession"("companyId", "employeeId")
WHERE status = 'IN_PROGRESS';
