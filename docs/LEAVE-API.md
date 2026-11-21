# Leave Module — Policy Configuration Guide (Milestone 2A)

Dynamic, administrator-configured leave types and effective-dated leave
policy versions. No entitlement amounts are seeded or hardcoded — every
policy value is authored by a company administrator.

Base URL: `/api/v1` · Auth: JWT + `x-company-id` · Permissions: `LEAVE_READ`, `LEAVE_MANAGE`

## Model

```
LeaveTypeDef            company-defined leave vocabulary (code, name, enum mapping)
   │                       e.g. CL→CASUAL, SL→SICK, EL→EARNED, CO→COMP_OFF,
   │                       LOP→LOSS_OF_PAY, or fully custom types (leaveType NULL)
   │
LeavePolicy             identity row: scope (COMPANY | DEPARTMENT | EMPLOYEE) + name
   │
   └─ LeavePolicyVersion  immutable, effective-dated accrual configuration
                           mode: MONTHLY_CREDIT | WORKED_DAYS_RATIO | NONE
```

- Version rows are appended, never updated. `effectiveFrom` selects which
  version applies to a given date; corrections are new versions or a
  `cancel` (row retained `ARCHIVED`, audited).
- `addVersion` rejects a past `effectiveFrom` — a back-dated version would
  silently change already-submitted records.
- Legacy policies (pre-2A) keep every original field. Their version 1 rows
  carry `mode: NONE` plus a `legacyConfig` JSON snapshot — the old
  `annualAllowance`/`accrualFrequency` semantics are preserved verbatim,
  not silently converted.
- Resolution fails closed: missing policy or missing effective version →
  `NO_EFFECTIVE_LEAVE_POLICY` (404). No defaults are invented.

## Endpoints

**Leave type definitions**

| Method | Path                        | Notes                                      |
| ------ | --------------------------- | ------------------------------------------ |
| POST   | `/leave/types`              | `{code, name, description?, leaveType?}`   |
| GET    | `/leave/types`              | `?status=ACTIVE                            | ARCHIVED` |
| PATCH  | `/leave/types/{id}`         | `{name?, description?, expectedVersion}`   |
| POST   | `/leave/types/{id}/archive` | blocked while ACTIVE policies reference it |

**Policies + versions**

| Method | Path                                         | Notes                                                                                                                      |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/leave/policies`                            | `{scopeType, departmentId?\|employeeId?, typeDefId, name, version:{…}}` → `{policy, version}`                              |
| GET    | `/leave/policies`                            | filters: `scopeType`, `typeDefId`, `isActive`                                                                              |
| GET    | `/leave/policies/{id}`                       |                                                                                                                            |
| PATCH  | `/leave/policies/{id}`                       | identity fields + legacy fields, `expectedVersion`                                                                         |
| POST   | `/leave/policies/{id}/archive`               | `{expectedVersion}`                                                                                                        |
| GET    | `/leave/policies/{id}/versions`              | full version history                                                                                                       |
| POST   | `/leave/policies/{id}/versions`              | `{effectiveFrom (>= today), mode, …, expectedVersion}`                                                                     |
| POST   | `/leave/policies/{id}/versions/{vid}/cancel` | last ACTIVE version cannot be cancelled                                                                                    |
| GET    | `/leave/policies/effective`                  | preview: `?typeDefId=…` or `?leaveType=…`, `&employeeId=…`, `&asOf=YYYY-MM-DD` → `{policy, version, typeDef, resolvedVia}` |

## Accrual modes

| Mode                | Required fields                           | Forbidden fields      |
| ------------------- | ----------------------------------------- | --------------------- |
| `MONTHLY_CREDIT`    | `monthlyCreditAmount` (> 0)               | ratio fields          |
| `WORKED_DAYS_RATIO` | `ratioThresholdDays`, `ratioEarnedAmount` | `monthlyCreditAmount` |
| `NONE`              | —                                         | all accrual fields    |

`WORKED_DAYS_RATIO` is a single non-duplicating rule:
`credits = floor((eligibleDays + residualDays) / ratioThresholdDays) × ratioEarnedAmount`;
only the remainder carries forward. Fractional credits are never awarded
while the same worked days also carry. The policy stores the rule
parameters — it does not compute balances (accrual jobs are a later
milestone).

## Resolution order (fail closed)

`EMPLOYEE` policy → primary `DEPARTMENT` membership → `COMPANY` fallback.
(Request-time gating additionally honors legacy SITE/PROJECT tiers between
department and company for policies authored before this model.)

- Membership resolution is **effective-dated**: the department used is the
  one whose membership covers the relevant date (`startedAt`/`endedAt`),
  not merely the employee's current membership. Preview uses `asOf`;
  request submission uses the request window.
- **Window boundaries fail closed** (`LEAVE_PERIOD_BOUNDARY` 409):
  the resolved department at `startDate` must equal the one at `endDate`,
  a single membership must cover the whole window, and one ACTIVE policy
  version must govern the entire period (no version effective at start,
  or a next version taking effect mid-request, is a boundary). Split the
  request at the boundary.
- **Version uniqueness**: two ACTIVE versions cannot share
  `effectiveFrom` (service check + partial unique index) — cancelled
  versions do not block the date.

- Primary membership wins; a single non-primary membership resolves
  deterministically; multiple active memberships with no primary →
  `LEAVE_AMBIGUOUS_SCOPE` (409).
- Department scope references the real `Department` record (HO, project,
  or site departments all valid). Location is not an authorization scope.
- Each tier requires an ACTIVE policy **and** an ACTIVE version with
  `effectiveFrom <= asOf`.

## Requests & balances (legacy enum-keyed APIs)

These pre-2A endpoints are live. They key on the `leaveType` enum
(`CASUAL | SICK | EARNED | COMP_OFF | LOSS_OF_PAY`) — enum-mapped
`LeaveTypeDef` values work through them; fully custom defs do not yet.

| Method | Path                           | Permission      | Body / notes                                                                                                             |
| ------ | ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/leave/requests`              | `LEAVE_APPLY`   | `{employeeId?, leaveType, startDate, endDate, isHalfDay?, halfDayPortion?, reason (≥3 chars), documentId?}` → `201`      |
| GET    | `/leave/requests`              | `LEAVE_READ`    | `?employeeId&leaveType&status&from&to&limit≤100&cursor` — keyset pagination                                              |
| GET    | `/leave/requests/{id}`         | `LEAVE_READ`    |                                                                                                                          |
| POST   | `/leave/requests/{id}/review`  | `LEAVE_APPROVE` | `{action: "APPROVE" \| "REJECT", remarks?, expectedVersion}` — optimistic lock required                                  |
| POST   | `/leave/requests/{id}/cancel`  | `LEAVE_APPLY`   | `{reason?, expectedVersion}`                                                                                             |
| GET    | `/leave/balances`              | `LEAVE_READ`    | `?employeeId&leaveType&year`                                                                                             |
| GET    | `/leave/balances/{employeeId}` | `LEAVE_READ`    | one employee's balance rows                                                                                              |
| POST   | `/leave/allocations`           | `LEAVE_MANAGE`  | `{employeeId, leaveType, year (2000–2100), allocatedDays (0–365), carriedOverDays? (0–90)}` → `201`, upserts the balance |

Submission validates the request window against the resolved policy
(section above): department membership effective across `[startDate,
endDate]`, one ACTIVE version governing the whole period —
`LEAVE_PERIOD_BOUNDARY` (409) means split the request at the boundary.

## Deferred to later milestones (not in 2A)

- Balance ledger + annual carry-forward jobs (balances remain admin-managed
  allocations for now).
- Accrual job that materializes credits from `MONTHLY_CREDIT` /
  `WORKED_DAYS_RATIO` versions.
- Comp-off credit processing (earned off-days → COMP_OFF balance).
- Sandwich-rule / weekly-off-holiday absorption evaluation in requests.
- Approval routing workflows, half-day/hourly handling changes, encashment,
  payroll integration.
- Requests keyed on `typeDefId` for fully custom types (no enum mapping).
  Request submission currently gates on the legacy `leaveType` enum via
  `resolveEffective` — EMPLOYEE → DEPARTMENT (primary membership) → SITE →
  PROJECT → COMPANY, fail closed. Enum-mapped DEPARTMENT policies (CL, SL,
  EL, CO, LOP...) gate requests today; custom types need the typeDef-keyed
  request path.
