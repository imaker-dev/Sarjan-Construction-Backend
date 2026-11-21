-- Add DEPARTMENT to the shared policy scope enum. Separate migration because
-- a new enum value cannot be used (in CHECK literals) inside the transaction
-- that adds it.
ALTER TYPE "AttendancePolicyScope" ADD VALUE IF NOT EXISTS 'DEPARTMENT';
