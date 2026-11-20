-- Enable btree_gist extension for combining scalar equality with GiST range operators
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Prevent overlapping leave requests for the same employee while status is PENDING or APPROVED
-- Uses daterange with inclusive bounds '[]'
ALTER TABLE "LeaveRequest"
ADD CONSTRAINT "leave_request_no_overlap"
EXCLUDE USING gist (
  "companyId" WITH =,
  "employeeId" WITH =,
  daterange("startDate", "endDate", '[]') WITH &&
)
WHERE (status IN ('PENDING', 'APPROVED'));
