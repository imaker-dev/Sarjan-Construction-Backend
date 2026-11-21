-- Prevent silent retroactive reclassification: record when a schedule was
-- archived so resolution can still treat it as applicable for dates before
-- the archive timestamp. Backfill existing archived rows with updatedAt as
-- the best available timestamp.
ALTER TABLE "WorkSchedule" ADD COLUMN "archivedAt" TIMESTAMPTZ;

UPDATE "WorkSchedule" SET "archivedAt" = "updatedAt" WHERE status = 'ARCHIVED' AND "archivedAt" IS NULL;
