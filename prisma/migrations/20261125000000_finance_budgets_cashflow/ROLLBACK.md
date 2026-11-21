# Rollback — `20261125000000_finance_budgets_cashflow`

This migration is **purely additive**: it creates six new tables, four enums, and
partial-unique idempotency indexes. It changes no existing table, column, or
index, so it is backward-compatible with the previously deployed application —
the preferred recovery is **forward-fix** (per `rule.md` §Migration & rollback).

If a true revert is required (e.g. the release is pulled before any Finance
writes landed), drop the new objects in dependency order:

```sql
-- 1. Child tables first (they hold composite FKs into parents).
DROP TABLE IF EXISTS "BudgetReviewDecision";
DROP TABLE IF EXISTS "BudgetRevisionLine";
DROP TABLE IF EXISTS "CashFlowForecastLine";

-- 2. Mid-level tables. ProjectBudget must be dropped before BudgetRevision
--    only if the latestApprovedRevisionId FK still points back; dropping
--    BudgetRevision first is safe because the FK restricts deletion of
--    *revisions*, not the budget. Order below handles either case by dropping
--    the pointer constraint explicitly.
ALTER TABLE "ProjectBudget"
  DROP CONSTRAINT IF EXISTS "ProjectBudget_latestApprovedRevisionId_fkey";

DROP TABLE IF EXISTS "BudgetRevision";
DROP TABLE IF EXISTS "CashFlowForecast";
DROP TABLE IF EXISTS "ProjectBudget";

-- 3. Enums created by this migration.
DROP TYPE IF EXISTS "BudgetStatus";
DROP TYPE IF EXISTS "BudgetRevisionStatus";
DROP TYPE IF EXISTS "BudgetCategory";
DROP TYPE IF EXISTS "BudgetReviewAction";
DROP TYPE IF EXISTS "CashFlowDirection";
DROP TYPE IF EXISTS "CashFlowCategory";
```

Verify the constraint name in step 2 against the live database first:

```sql
SELECT conname FROM pg_constraint
WHERE conrelid = '"ProjectBudget"'::regclass
  AND conname LIKE '%latestApprovedRevision%';
```

## Notes

- The hand-managed composite FK on `ProjectBudget.latestApprovedRevisionId`
  (revision must belong to the same budget + company) intentionally differs
  from the Prisma-generated name pattern; re-adding the column later must
  re-add that composite FK, not a plain one.
- `DELETE`-style rollback of seeded data is unnecessary — this migration
  inserts no rows.
- Outbox/audit rows written at runtime reference these tables by id only and
  do not block the drops; they become historical pointers like any deleted
  entity reference.
