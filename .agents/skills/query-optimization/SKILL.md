---
name: query-optimization
description: >-
  Actionable procedures, Prisma patterns, and indexing strategies for PostgreSQL
  query optimization. Use when authoring repository methods, designing schema indexes,
  diagnosing slow queries, refactoring loops, or implementing pagination and bulk operations.
---

# PostgreSQL & Prisma Query Optimization Guide

This skill provides concrete recipes and invariants to ensure fast, scalable, and memory-efficient database queries across the application.

---

## 1. Eliminate N+1 Queries

### Anti-Pattern
Executing queries inside loops or mapping functions:
```typescript
// BAD: 1 + N database round-trips
for (const employee of employees) {
  const activeSession = await prisma.attendanceSession.findFirst({
    where: { employeeId: employee.id, status: 'IN_PROGRESS' }
  });
}
```

### Optimized Pattern
Pre-fetch relations in a single query using `include` or batch lookups with `in`:
```typescript
// GOOD: 1 round-trip using batch lookup
const activeSessions = await prisma.attendanceSession.findMany({
  where: {
    employeeId: { in: employees.map((e) => e.id) },
    status: 'IN_PROGRESS',
  },
  select: { id: true, employeeId: true, siteId: true, punchInAt: true },
});

// Map in-memory via Map for O(1) correlation
const sessionByEmp = new Map(activeSessions.map((s) => [s.employeeId, s]));
```

---

## 2. Projection & Column Selection

- Never fetch whole entities with full includes when only specific columns are needed.
- In Prisma, prefer explicit `select` over full object fetching to minimize network payload, serialization overhead, and buffer memory.

```typescript
// GOOD: Minimal payload projection
const siteSummaries = await prisma.site.findMany({
  where: { companyId, status: 'ACTIVE' },
  select: { id: true, code: true, name: true },
});
```

---

## 3. Indexing & Composite Index Architecture

### Multi-Column Composite Index Rule (ESR Rule: Equality -> Sort -> Range)
When indexing queries with multiple conditions:
1. **Equality columns first**: Columns filtered with `=` (e.g., `companyId`, `status`).
2. **Sort columns second**: Columns used in `ORDER BY` (e.g., `createdAt`, `id`).
3. **Range columns last**: Columns filtered with `<`, `>`, `BETWEEN`, `IN` (e.g., `punchInAt`, `businessDate`).

### Example Schema Index:
```prisma
// For: WHERE companyId = ? AND status = ? ORDER BY createdAt DESC
@@index([companyId, status, createdAt(sort: Desc)])
```

### Partial Unique Indexes for State Invariants
For one-active-per-entity rules, use PostgreSQL partial unique indexes instead of table-wide locks:
```sql
CREATE UNIQUE INDEX "AttendanceSession_one_active_idx" 
ON "AttendanceSession" ("companyId", "employeeId") 
WHERE "status" = 'IN_PROGRESS';
```

---

## 4. Deterministic Cursor Pagination

- Never fetch unbounded collections without pagination.
- For high-volume transaction tables, avoid deep `offset` (`skip: 10000` scans and discards 10,000 rows). Use deterministic cursor pagination:

```typescript
const items = await prisma.auditLog.findMany({
  where: { companyId },
  take: limit + 1,
  ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  orderBy: { id: 'asc' },
  select: { id: true, action: true, createdAt: true },
});

const hasNextPage = items.length > limit;
const page = hasNextPage ? items.slice(0, limit) : items;
const nextCursor = hasNextPage ? page[page.length - 1]?.id : null;
```

---

## 5. Bulk Operations & Transactions

- Prefer bulk operations (`createMany`, `updateMany`) over individual queries inside loops.
- Keep `$transaction` blocks concise: perform external API calls, password hashing, and token signing **outside** transactions to avoid holding open connections and starving the connection pool.

---

## 6. Execution Plan Inspection (EXPLAIN ANALYZE)

When investigating performance on complex reports or joins:
```typescript
const plan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
  EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  SELECT "id", "presentUnits" FROM "AttendanceSession"
  WHERE "companyId" = ${companyId}::uuid AND "businessDate" = ${date}
`;
```
Look for:
- **Seq Scan (Sequential Scan):** Indicates a missing or unusable index.
- **Index Scan vs Index Only Scan:** Aim for *Index Only Scan* where index covers the projected columns.
- **High Buffer Reads:** Indicates excessive disk I/O.
