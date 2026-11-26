# Leave Module — Policy Configuration Guide

Dynamic, administrator-configured leave types and effective-dated leave
policy versions, with scope-resolved request authorization. No entitlement
amounts are seeded or hardcoded — every policy value is authored by a
company administrator.

Base URL: `/api/v1` · Auth: JWT + `x-company-id` · Permissions: `LEAVE_READ`,
`LEAVE_APPLY`, `LEAVE_APPROVE`, `LEAVE_MANAGE`

## Scoped authorization

Leave has two different authorities:

| Authority                                                    | Holds                                                                       | Scope resolution                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Configuration** — types, allocations, calendar             | `LEAVE_MANAGE` @COMPANY                                                     | Company administration only — no delegation path                                                        |
| **Policy authoring** — policies + versions                   | `LEAVE_MANAGE` @COMPANY, **or** scoped `LEAVE_MANAGE` + `leavePolicyManage` | COMPANY/EMPLOYEE-scope policies stay company-only; DEPARTMENT/SITE/PROJECT policies may be delegated    |
| **Request review** — approve/reject/return                   | `LEAVE_APPROVE` at the **resolved target**                                  | Requester’s department membership **effective at `startDate`** → SITE / PROJECT / HEAD_OFFICE / COMPANY |
| **Reads of others’ data** — requests, balances               | approver authority at the resolved target                                   | Same resolution — `LEAVE_READ` alone never unlocks another employee’s record                            |
| **Self-service** — apply, read own, cancel own, resubmit own | `LEAVE_APPLY`/`LEAVE_READ` @COMPANY (EMPLOYEE baseline)                     | Personal right — no approver required                                                                   |

**Delegated policy authoring** (`CompanyDelegationPolicy.leavePolicyManage`,
default OFF): when enabled, a scoped holder (PI/PM with `LEAVE_MANAGE`
@PROJECT/SITE) may create, update, archive, and version **department
policies whose resolved target is a SITE/PROJECT inside their grant** —
e.g. a PI can set the site department's entitlement to 2 CL/month. The
flag never unlocks:

- `COMPANY`-scope policies (company baselines) or `EMPLOYEE`-scope
  policies (per-person overrides) — always company-only;
- departments resolving to `HEAD_OFFICE` or `COMPANY` — an HO-scoped
  `LEAVE_MANAGE` holder manages those via their own grant, never via the
  flag;
- leave type definitions, balance allocations, or holiday calendars —
  always `LEAVE_MANAGE`@COMPANY;
- sibling sites — the caller's grant must still cover the resolved target
  (a `PROJECT` grant covers child `SITE` targets).

Company-wide `LEAVE_MANAGE` holders (Finance/Admin) are unaffected — they
manage every scope with or without the flag. Denial surfaces as 403
`DELEGATION_DISABLED` when the flag is off and 403 permission-denied when
the scope is outside the grant.

Scope resolution rules:

- The **requester’s primary department membership effective at the request
  `startDate`** maps to the permission target: site department → `SITE`,
  project department → `PROJECT`, head-office department → `HEAD_OFFICE`,
  company department → `COMPANY`. Access derives from the department’s
  site/project binding — **never** from engagement type or department name,
  so `DIRECT_EMPLOYEE`, `CONTRACTOR_WORKER`, `DAILY_WAGE`, `APPRENTICE`,
  `CONSULTANT`, `OTHER` members are all covered identically.
- A `PROJECT`-scope grant covers child `SITE` targets (downward
  inheritance); a `COMPANY` grant covers everything.
- **PI/PD** (`LEAVE_APPROVE` @PROJECT in the role templates) review
  site/project-department requests inside their assigned sites/projects —
  sibling sites and unrelated projects deny fail-closed.
- **Unresolvable** membership (none, or ambiguous at the date) resolves to
  `COMPANY` — only company-level approvers pass, never a silent leak.
- **Scoped approver’s own request routes up**: when the requester holds
  `LEAVE_APPROVE` at the resolved target (PI/PD/PM/SE), review additionally
  requires `LEAVE_APPROVE` @COMPANY — their personal requests go to
  company-level Finance/Administration approvers, and a local approver
  (even a sibling PI) cannot decide them. Self-approval is always rejected.
- Route gates resolve targets server-side (request → employee → membership
  → department), the service re-asserts — deny means 403, unresolvable
  entities never leak existence beyond the company fallback.

## Model

```
LeaveTypeDef            company-defined leave vocabulary (code, name, enum mapping)
   │                       e.g. CL→CASUAL, SL→SICK, EL→PRIVILEGE, CO→COMP_OFF,
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
(`CASUAL | SICK | PRIVILEGE | COMP_OFF | LOSS_OF_PAY | SPECIAL`) — enum-mapped
`LeaveTypeDef` values work through them; fully custom defs do not yet.

| Method | Path                            | Permission                  | Body / notes                                                                                                                                                                                    |
| ------ | ------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/leave/requests`               | `LEAVE_APPLY`               | `{employeeId?, leaveType, startDate, endDate, isHalfDay?, halfDayPortion?, reason (≥3 chars), documentId?}` → `201`. On-behalf filing also needs `LEAVE_MANAGE` at the target employee’s scope. |
| GET    | `/leave/requests`               | `LEAVE_READ` at resolved    | `?employeeId&leaveType&status&from&to&limit≤100&siteId&projectId&departmentId` — scope filters require approver authority at that target; unscoped lists show own requests                      |
| GET    | `/leave/requests/{id}`          | `LEAVE_READ` at resolved    | Owner, or approver at the requester department’s scope (at `startDate`)                                                                                                                         |
| POST   | `/leave/requests/{id}/review`   | `LEAVE_APPROVE` at resolved | `{action: "APPROVE" \| "REJECT" \| "RETURN", remarks?, expectedVersion}` — `REJECT`/`RETURN` require remarks; optimistic lock required                                                          |
| POST   | `/leave/requests/{id}/resubmit` | `LEAVE_APPLY`               | `{startDate?, endDate?, reason?, documentId?, expectedVersion}` — owner-only, from `RETURNED` → `PENDING`; re-validates the full submission pipeline                                            |
| POST   | `/leave/requests/{id}/cancel`   | `LEAVE_APPLY`               | `{reason?, expectedVersion}` — owner, or `LEAVE_MANAGE` at resolved scope; allowed from `PENDING`/`RETURNED`/`APPROVED`                                                                         |
| GET    | `/leave/balances`               | `LEAVE_READ` at resolved    | `?employeeId&leaveType&year&siteId&projectId&departmentId` — same scoping as request lists                                                                                                      |
| GET    | `/leave/balances/{employeeId}`  | `LEAVE_READ` at resolved    | Owner, or approver at the employee’s resolved scope                                                                                                                                             |
| POST   | `/leave/allocations`            | `LEAVE_MANAGE` @COMPANY     | `{employeeId, leaveType, year (2000–2100), allocatedDays (0–365), carriedOverDays? (0–90)}` → `201`, upserts the balance — company administration only                                          |

### Request lifecycle

```
PENDING ──review──► APPROVED │ REJECTED │ RETURNED
   │                          (REJECT/RETURN release the pending reservation)
   ├──cancel──► CANCELLED
APPROVED ──cancel──► CANCELLED (refunds used days)
RETURNED ──resubmit (owner)──► PENDING (re-validates window, re-reserves balance, version++)
```

- `APPROVE` commits `pending → used`; `REJECT` and `RETURN` release
  `pending`; `resubmit` re-reserves; `cancel` releases pending or refunds
  used. `LOSS_OF_PAY` bypasses balance entirely.
- A `RETURNED` request does **not** block new submissions (its reservation
  was released); resubmission excludes itself from the date-conflict check.

### Notifications

- Submission/resubmission fanout is **scope-aware**: when the requester is
  a plain employee in a site/project department, scoped approver roles
  (`PROJECT_INCHARGE`, `PROJECT_DIRECTOR`, `PROJECT_MANAGER`,
  `SITE_ENGINEER`, `DEPT_HEAD`) are notified at the resolved `SITE` and
  `PROJECT` scopes; `HO_ADMIN`, `COMPANY_OWNER`, `FINANCE_MANAGER` always
  receive a copy for oversight. A requester who is themselves a scoped
  approver goes **only** to the company-level roles.
- Review/cancel outcomes notify the requester directly.
- Notification bodies carry the request id, type, and dates only — never
  the free-text `reason` or any medical detail.

Submission validates the request window against the resolved policy
(section above): department membership effective across `[startDate,
endDate]`, one ACTIVE version governing the whole period —
`LEAVE_PERIOD_BOUNDARY` (409) means split the request at the boundary.

## Step-by-step — Finance/Administration setup

Finance holds `LEAVE_MANAGE`@COMPANY — it can create types, policies,
versions, allocations, and holiday calendars at every scope. (A delegated
PI may also author site-department policies — see P4.) Everything below
assumes `Authorization: Bearer <jwt>` + `x-company-id` headers.

### F1 — Create the leave-type vocabulary

One `LeaveTypeDef` per leave kind. `leaveType` maps the def onto the enum
the request APIs key on.

```bash
POST /api/v1/leave/types
{ "code": "CL",  "name": "Casual Leave",   "leaveType": "CASUAL" }       → 201 { "id": "td-cl",  "code": "CL",  "leaveType": "CASUAL",      "status": "ACTIVE", "version": 0 }
{ "code": "SL",  "name": "Sick Leave",     "leaveType": "SICK" }         → 201 { "id": "td-sl",  … }
{ "code": "EL",  "name": "Earned Leave",   "leaveType": "PRIVILEGE" }    → 201 { "id": "td-el",  … }
{ "code": "CO",  "name": "Comp Off",       "leaveType": "COMP_OFF" }     → 201 { "id": "td-co",  … }
{ "code": "LOP", "name": "Loss of Pay",    "leaveType": "LOSS_OF_PAY" }  → 201 { "id": "td-lop", … }
{ "code": "ML",  "name": "Maternity Leave","leaveType": "SPECIAL" }      → 201 { "id": "td-ml",  … }
```

Defs without `leaveType` are fully custom types — usable by policy
authoring but not yet by the request APIs (which key on the enum).

### F2 — Holiday calendar (schedule module, `WORK_SCHEDULE_MANAGE`)

```bash
POST /api/v1/holiday-categories
{ "code": "NH", "name": "National Holiday" }          → 201 { "id": "hc-nh" }

POST /api/v1/holiday-calendars
{ "code": "CAL-2026", "name": "Company Calendar 2026" } → 201 { "id": "cal-1" }

POST /api/v1/holiday-calendars/cal-1/holidays/bulk
{ "holidays": [
    { "date": "2026-01-26", "name": "Republic Day",   "categoryId": "hc-nh" },
    { "date": "2026-08-15", "name": "Independence Day","categoryId": "hc-nh" },
    { "date": "2026-10-02", "name": "Gandhi Jayanti", "categoryId": "hc-nh" } ] }
→ 201 [ { "id": "h-1", "date": "2026-01-26", … }, … ]

GET  /api/v1/holiday-calendars/cal-1/holidays?from=2026-01-01&to=2026-12-31
POST /api/v1/holiday-calendars/cal-1/holidays/:holidayId/cancel   # keep row, mark ARCHIVED
```

Calendars are attached to scopes through `WorkScheduleRevision` — the
schedule is the single source of truth for "which holidays apply to whom".
Leave `sandwichRule` currently evaluates **Sundays only**; holiday/WO
absorption in leave-day counting is a deferred item (see below).

### F3 — Company-wide baseline policies

Every employee falls back to the COMPANY policy when no department/employee
override exists. Each create carries its first immutable `version`.

```bash
# CL — 12 days/yr allocated upfront, no accrual math
POST /api/v1/leave/policies
{ "scopeType": "COMPANY", "typeDefId": "td-cl",
  "name": "Casual Leave — Company Baseline",
  "version": { "effectiveFrom": "2026-01-01", "mode": "NONE",
               "note": "12-day annual allocation managed via /leave/allocations" } }
→ 201 { "policy": { "id": "pol-cl", "scopeType": "COMPANY", "version": 0, … },
        "version": { "id": "pv-cl-1", "version": 1, "mode": "NONE",
                     "effectiveFrom": "2026-01-01" } }

# EL — earned 2 days per 20 worked days
POST /api/v1/leave/policies
{ "scopeType": "COMPANY", "typeDefId": "td-el",
  "name": "Earned Leave — Company Baseline",
  "version": { "effectiveFrom": "2026-01-01", "mode": "WORKED_DAYS_RATIO",
               "ratioThresholdDays": 20, "ratioEarnedAmount": 2 } }

# SL — monthly credit 1 day/month
POST /api/v1/leave/policies
{ "scopeType": "COMPANY", "typeDefId": "td-sl",
  "name": "Sick Leave — Company Baseline",
  "version": { "effectiveFrom": "2026-01-01", "mode": "MONTHLY_CREDIT",
               "monthlyCreditAmount": 1 } }

# COMP_OFF + LOP — bookkeeping only
POST /api/v1/leave/policies   { "scopeType": "COMPANY", "typeDefId": "td-co",  "name": "Comp Off — Baseline",   "version": { "effectiveFrom": "2026-01-01", "mode": "NONE" } }
POST /api/v1/leave/policies   { "scopeType": "COMPANY", "typeDefId": "td-lop", "name": "Loss of Pay — Baseline", "version": { "effectiveFrom": "2026-01-01", "mode": "NONE" } }
```

### F4 — Tuning rules on the baseline (PATCH — identity/rule fields)

```bash
PATCH /api/v1/leave/policies/pol-sl
{ "annualAllowance": 12,          # headline entitlement (legacy bookkeeping)
  "maxConsecutiveDays": 3,        # >3 consecutive SL days → rejected at submit
  "minNoticeDays": 0,             # sick leave can be applied same-day
  "allowHalfDay": false,
  "sandwichRule": false,          # Sundays between start/end are NOT counted
  "carryoverMaxDays": 0,          # SL lapses at year end
  "requiresDocAboveDays": 2,      # >2 SL days → documentId mandatory at submit
  "expectedVersion": 0 }
→ 200 { "id": "pol-sl", "version": 1, "maxConsecutiveDays": 3, … }
```

| Rule                      | Effect at submit                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `minNoticeDays: N`        | startDate must be ≥ N days out → `LEAVE_NOTICE_INSUFFICIENT` (422)                                                                 |
| `maxConsecutiveDays: N`   | net days > N → `MAX_CONSECUTIVE_DAYS_EXCEEDED` (422)                                                                               |
| `requiresDocAboveDays: N` | net days > N requires `documentId` → `LEAVE_DOCUMENT_REQUIRED` (422)                                                               |
| `sandwichRule: true`      | every calendar day counts (Sundays/WOs sandwiched inside the window are charged)                                                   |
| `sandwichRule: false`     | Sundays inside the window are **not** charged                                                                                      |
| `allowHalfDay`            | recorded on the policy; `isHalfDay`+`halfDayPortion` on the request charges 0.5 days (flag not yet enforced as a submit-time gate) |
| `carryoverMaxDays`        | cap for year-end carry-forward (bookkeeping until the accrual job lands)                                                           |

### F5 — HO-department policy (e.g. HO gets 4 CL/month)

`scopeType: "DEPARTMENT"` targets the actual department record — works for
HO, project, and site departments alike. The dept's own siteId/projectId/
baseHeadOfficeId decides who can _review_ requests; the policy only decides
entitlements.

```bash
GET /api/v1/departments?status=ACTIVE              # HO dept id from the registry
→ 200 [ { "id": "dept-ho-ops", "code": "HO-OPS", "baseHeadOfficeId": "ho-1", … } ]

POST /api/v1/leave/policies
{ "scopeType": "DEPARTMENT", "departmentId": "dept-ho-ops",
  "typeDefId": "td-cl", "name": "Casual Leave — Head Office",
  "version": { "effectiveFrom": "2026-01-01", "mode": "MONTHLY_CREDIT",
               "monthlyCreditAmount": 4 } }        # ← HO earns 4 CL/month
→ 201 { "policy": { "id": "pol-cl-ho", "scopeType": "DEPARTMENT",
                     "departmentId": "dept-ho-ops", … } }
```

### F6 — Site-department policy (e.g. site employees get only 2 CL/month)

**Different entitlements per department are fully supported** — a
DEPARTMENT-scope policy overrides the company baseline _and_ the HO
department policy for employees whose primary membership sits in that
department at the request window. Same call, the site department's id:

```bash
GET /api/v1/departments?siteId=<siteId>            # site dept id

POST /api/v1/leave/policies
{ "scopeType": "DEPARTMENT", "departmentId": "dept-site-struct",
  "typeDefId": "td-cl", "name": "Casual Leave — Site Structure Crew",
  "version": { "effectiveFrom": "2026-01-01", "mode": "MONTHLY_CREDIT",
               "monthlyCreditAmount": 2 } }        # ← site earns 2 CL/month
→ 201 { "policy": { "id": "pol-cl-site", … } }

# and a different accrual for site labour EL:
POST /api/v1/leave/policies
{ "scopeType": "DEPARTMENT", "departmentId": "dept-site-struct",
  "typeDefId": "td-el", "name": "Earned Leave — Site Structure Crew",
  "version": { "effectiveFrom": "2026-01-01", "mode": "WORKED_DAYS_RATIO",
               "ratioThresholdDays": 25, "ratioEarnedAmount": 1 } }
```

> **Who authors this?** The _differentiation_ is configuration. Finance/
> Administration can always create both policies (`LEAVE_MANAGE`@COMPANY).
> A **delegated PI** can also author the site-department policy — but only
> when the company enables `leavePolicyManage` in
> `PATCH /org/company/delegations` (default OFF, same pattern as
> `scheduleManage`), and only for DEPARTMENT-scope policies whose
> department resolves to a SITE/PROJECT inside the PI's grant. The
> HO-department policy, the company baseline, per-person EMPLOYEE
> overrides, type definitions, and balance allocations all stay
> company-only.

Resolution order at request time: `EMPLOYEE` override → primary
`DEPARTMENT` membership at the window → `COMPANY` fallback — so a site
employee gets the site-dept policy (2 CL/month), a HO employee gets the
HO-dept policy (4 CL/month), and anyone unmatched gets the company
baseline. An `EMPLOYEE`-scope policy (`scopeType: "EMPLOYEE",
"employeeId": "…"`) is the per-person exception override.

### F7 — Evolve a policy (new version, never rewrite)

Versions are immutable; corrections are new versions with a future
`effectiveFrom` (back-dating is rejected — it would silently change
already-submitted requests).

```bash
POST /api/v1/leave/policies/pol-cl/versions
{ "effectiveFrom": "2026-07-01", "mode": "NONE",
  "note": "CL 12 → 15 days from FY H2", "expectedVersion": 1 }
→ 201 { "id": "pv-cl-2", "version": 2, "effectiveFrom": "2026-07-01" }

GET  /api/v1/leave/policies/pol-cl/versions        # full history
POST /api/v1/leave/policies/pol-cl/versions/pv-cl-2/cancel   # ARCHIVED, row kept + audited
```

One ACTIVE version must govern the _whole_ request window — a version
taking effect mid-request fails `LEAVE_PERIOD_BOUNDARY` (409); split the
request at the boundary.

### F8 — Allocate balances

```bash
POST /api/v1/leave/allocations
{ "employeeId": "emp-…", "leaveType": "CASUAL",
  "year": 2026, "allocatedDays": 12, "carriedOverDays": 2 }
→ 201 { "id": "bal-…", "employeeId": "emp-…", "leaveType": "CASUAL",
        "year": 2026, "allocatedDays": "12", "carriedOverDays": "2",
        "usedDays": "0", "pendingDays": "0", "version": 0 }
```

Upserts the `(employee, leaveType, year)` row — repeat for each type
(CL/SL/EL/CO). `LOSS_OF_PAY` needs no balance; it bypasses the check.

### F9 — Verify what an employee resolves to

```bash
GET /api/v1/leave/policies/effective?typeDefId=td-el&employeeId=emp-site…&asOf=2026-06-15
→ 200 { "policy": { "id": "pol-el-site", "scopeType": "DEPARTMENT", … },
        "version": { "id": "pv-…", "mode": "WORKED_DAYS_RATIO",
                     "ratioThresholdDays": 25, "ratioEarnedAmount": 1 },
        "typeDef": { "id": "td-el", "code": "EL" },
        "resolvedVia": "DEPARTMENT" }        # EMPLOYEE | DEPARTMENT | COMPANY
```

### F10 — Finance reviews anything (company scope)

```bash
GET  /api/v1/leave/requests?status=PENDING            # company-wide list
POST /api/v1/leave/requests/lr-…/review               # LEAVE_APPROVE@COMPANY
{ "action": "APPROVE", "expectedVersion": 1 }
```

Company scope covers every target — including PI/PD personal requests,
which _only_ company approvers can decide.

## Step-by-step — PI site-workforce leave management

PI holds `LEAVE_APPROVE`@PROJECT/SITE for assigned sites. Everything below
works for site-department employees **and** site labour — access comes from
the requester's department membership, never from engagement type.

### P1 — See what's pending at your site

```bash
GET /api/v1/leave/requests?siteId=<siteId>&status=PENDING
→ 200 [ { "id": "lr-1", "employeeId": "emp-…", "leaveType": "CASUAL",
          "startDate": "2026-02-10", "endDate": "2026-02-11",
          "totalDays": "2", "status": "PENDING", "version": 1,
          "employee": { "id": "…", "employeeCode": "E-041",
                        "displayName": "Site Worker", "designation": "Mason" } } ]
```

Also filterable by `projectId` (covers all child sites), `departmentId`,
`employeeId`, `leaveType`, `from`/`to`, `status`, `limit` (≤100).

### P2 — Check the balance before deciding

```bash
GET /api/v1/leave/balances/emp-…?leaveType=CASUAL&year=2026
→ 200 { "employeeId": "emp-…", "leaveType": "CASUAL", "year": 2026,
        "allocatedDays": "12", "carriedOverDays": "0",
        "usedDays": "4", "pendingDays": "2", "version": 3 }
# available = allocated + carriedOver − used − pending  →  6 days
```

### P3 — Approve / reject / return

```bash
POST /api/v1/leave/requests/lr-1/review
{ "action": "APPROVE", "remarks": "Crew covered", "expectedVersion": 1 }
→ 200 { "id": "lr-1", "status": "APPROVED", "reviewedBy": "u-pi",
        "reviewedAt": "…", "version": 2 }

{ "action": "REJECT", "remarks": "Pour scheduled — skeleton crew", "expectedVersion": 1 }
→ 200 { "status": "REJECTED" }          # pending reservation released

{ "action": "RETURN", "remarks": "End date crosses site shutdown — split it", "expectedVersion": 1 }
→ 200 { "status": "RETURNED" }          # released; owner fixes + resubmits
```

`expectedVersion` is required — a stale copy returns 409
`VERSION_CONFLICT`. Approved days appear automatically in the site
attendance summary (`leaveDays` / `totalApprovedLeaves`).

### P4 — Manage the site department's leave policy (delegation-gated)

When the company enables `leavePolicyManage`
(`PATCH /org/company/delegations`, default OFF), a PI holding
`LEAVE_MANAGE`@PROJECT can author the **site-department policies inside
their grant** — exactly the calls from F5/F6/F7, pointed at the site
department:

```bash
POST /api/v1/leave/policies
{ "scopeType": "DEPARTMENT", "departmentId": "dept-site-struct",
  "typeDefId": "td-cl", "name": "Casual Leave — Site Structure Crew",
  "version": { "effectiveFrom": "2026-02-01", "mode": "MONTHLY_CREDIT",
               "monthlyCreditAmount": 2 } }
→ 201                                       # site employees now accrue 2 CL/month

PATCH /api/v1/leave/policies/<policyId>
{ "name": "Casual Leave — Site (revised)", "expectedVersion": 0 }
→ 200

POST /api/v1/leave/policies/<policyId>/versions
{ "effectiveFrom": "2026-07-01", "mode": "MONTHLY_CREDIT",
  "monthlyCreditAmount": 3, "expectedVersion": 1 }
→ 201                                       # new immutable version from July
```

Same contracts, same optimistic-concurrency and audit behavior — the only
difference is _who_ may call. With the flag **off**, the same requests fail
`403 DELEGATION_DISABLED`.

### P5 — What PI cannot do (by design)

- Sibling/unrelated site requests **or policies** → 403 `ACCESS_DENIED`
- HO-department requests or policies → 403 (resolves HEAD_OFFICE; only an
  HO-scoped `LEAVE_MANAGE` holder or Finance can manage them — the flag
  never unlocks HEAD_OFFICE)
- `COMPANY`-scope policies, `EMPLOYEE`-scope per-person overrides, leave
  type definitions, balance allocations, holiday calendars →
  `LEAVE_MANAGE`@COMPANY only
- Policy writes when `leavePolicyManage` is off → 403 `DELEGATION_DISABLED`
- Their **own** request → routes to company approvers; another scoped
  approver can't decide it; self-approval always rejected

## Step-by-step — Employee self-service

### E1 — Check balances

```bash
GET /api/v1/leave/balances?leaveType=CASUAL&year=2026     # no employeeId → own rows
→ 200 [ { "leaveType": "CASUAL", "allocatedDays": "12",
          "usedDays": "4", "pendingDays": "0", "carriedOverDays": "0" } ]
```

### E2 — See which policy governs you

```bash
GET /api/v1/leave/policies/effective?typeDefId=td-el&asOf=2026-06-15   # own preview always allowed
→ 200 { "resolvedVia": "DEPARTMENT", "policy": {…}, "version": {…} }
```

### E3 — Apply

```bash
POST /api/v1/leave/requests
{ "leaveType": "CASUAL", "startDate": "2026-02-10", "endDate": "2026-02-11",
  "reason": "Family function" }
→ 201 { "id": "lr-…", "status": "PENDING", "totalDays": "2", "version": 0 }
```

Half-day: add `"isHalfDay": true, "halfDayPortion": "FIRST_HALF"` — charges
0.5 days regardless of the leave type; policy `allowHalfDay` is recorded but
not yet enforced. Doc-required thresholds: attach
`"documentId": "<uuid>"` when the policy demands it. On submit,
`totalDays` reserves against `pendingDays`.

Validation failures: `LEAVE_PERIOD_BOUNDARY` (409 — membership/policy-version
changes mid-window, split it), `LEAVE_DATE_CONFLICT` (409),
`LEAVE_NOTICE_INSUFFICIENT` (422), `MAX_CONSECUTIVE_DAYS_EXCEEDED` (422),
`LEAVE_DOCUMENT_REQUIRED` (422), `INSUFFICIENT_LEAVE_BALANCE` (422),
`NO_EFFECTIVE_LEAVE_POLICY` (404), `SELF_APPROVAL_NOT_ALLOWED` (403),
`AMBIGUOUS_LEAVE_SCOPE` (409), `INVALID_LEAVE_STATE` (400) — all carry a
machine-readable `code` in the error envelope.

### E4 — Track the request + history

```bash
GET /api/v1/leave/requests?leaveType=CASUAL&status=APPROVED&from=2026-01-01&to=2026-03-31&limit=50
→ 200 [ …requests newest-first… ]          # from/to window + limit≤100
GET /api/v1/leave/requests/lr-…            # full detail incl. reviewRemarks
```

Past leave history = the same list with `from`/`to` — `status=APPROVED`
gives days actually taken, `REJECTED`/`CANCELLED`/`RETURNED` the rest of
the trail.

### E5 — Fix a RETURNED request

```bash
POST /api/v1/leave/requests/lr-…/resubmit          # owner only
{ "startDate": "2026-02-12", "endDate": "2026-02-12",
  "reason": "Family function — shifted", "expectedVersion": 2 }
→ 200 { "id": "lr-…", "status": "PENDING", "version": 3 }
```

The whole submit pipeline re-runs (boundary, notice, conflict, balance
re-reservation); prior review fields clear.

### E6 — Cancel

```bash
POST /api/v1/leave/requests/lr-…/cancel
{ "reason": "Plans changed", "expectedVersion": 3 }
→ 200 { "status": "CANCELLED" }
```

PENDING/RETURNED release the reservation; APPROVED refunds `usedDays`.

## Step-by-step — Employee monthly attendance

The same session APIs PI/Finance use for teams work for self-service —
an employee reads only their own rows.

### A1 — List a month's sessions

`GET /attendance/sessions` filters by `employeeId`, `businessDate`,
`status`, `siteId`, `limit` (≤100) + `cursor`. The response is a bare
array ordered `punchInAt` desc — page through the month by passing the
last row's `id` as `cursor`:

```bash
GET /api/v1/attendance/sessions?employeeId=<ownEmpId>&limit=100
→ 200 [
    { "id": "sess-1", "businessDate": "2026-11-25", "status": "COMPLETED",
      "source": "MOBILE_SELF", "siteId": "site-…", "headOfficeId": null,
      "punchInAt":  "2026-11-25T03:32:00.000Z",
      "punchOutAt": "2026-11-25T12:45:00.000Z",
      "grossDurationMins": 553, "breakDurationMins": 45,
      "netDurationMins": 508, "presentUnits": "1.0",
      "overtimePUnits": "0.5", "totalPUnits": "1.5",
      "overtimeHours": "0.47",
      "scheduledStartAt": "…", "scheduledEndAt": "…",
      "autoClosedBy": null,
      "employee": { "id": "emp-…", "employeeCode": "E-041",
                    "displayName": "Worker", "tradeCategory": "MASON" },
      "site": { "id": "site-…", "code": "S-001", "name": "Tower A" },
      "headOffice": null,
      "breaks": [ { "breakType": "LUNCH",
                    "startedAt": "…T08:00:00.000Z",
                    "endedAt": "…T08:45:00.000Z", "durationMins": 45 } ] },
    { "id": "sess-2", "businessDate": "2026-11-24", … } ]
GET /api/v1/attendance/sessions?employeeId=<ownEmpId>&limit=100&cursor=sess-2   # next page
```

Key fields per session:

| Field                                             | Meaning                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `businessDate`                                    | The 8 AM → 8 AM construction business day                                   |
| `punchInAt` / `punchOutAt`                        | UTC instants                                                                |
| `breaks[]`                                        | Each break (type, start, end, `durationMins`) — lunch included              |
| `grossDurationMins`                               | punch-out − punch-in                                                        |
| `breakDurationMins`                               | total break time                                                            |
| `netDurationMins`                                 | gross − breaks = total worked                                               |
| `presentUnits` / `overtimePUnits` / `totalPUnits` | day fraction (1.0 = full day), OT units, total                              |
| `overtimeHours`                                   | OT beyond the policy baseline                                               |
| `status`                                          | `IN_PROGRESS` / `COMPLETED` / `AUTO_CLOSED` / `REJECTED`                    |
| `autoClosedBy`                                    | `SCHEDULE_END` / `EOD_SETTLEMENT` / `STALE_SWEEP` when the system closed it |
| `scheduledStartAt` / `scheduledEndAt`             | The schedule window pinned at punch-in                                      |

### A2 — One day in detail

```bash
GET /api/v1/attendance/sessions/sess-1
→ 200 { …same session object incl. full breaks[]… }
```

### A3 — A specific date directly

```bash
GET /api/v1/attendance/sessions?employeeId=<ownEmpId>&businessDate=2026-11-25
```

### A4 — Site/HO daily summary (approvers + scoped reads)

```bash
GET /api/v1/attendance/daily-summary?siteId=<siteId>&businessDate=2026-11-25&period=DAILY
→ 200 { "siteId": "site-…", "from": "2026-11-25", "to": "2026-11-25",
        "totalSessions": 42, "totalMandays": 40, "totalPresentUnits": 39.5,
        "totalOvertimeHours": 6.25,
        "workerSummaries": [ { "employeeId": "…", "leaveDays": 1,
                               "presentUnits": 1.0, "daysPresent": 1, … } ],
        "leaves": [ { "id": "lr-…", "status": "APPROVED", … } ],
        "sessions": [ … ] }
```

Approved leave shows here as `leaveDays`/`totalApprovedLeaves` — the same
approved rows from §P3, no separate integration call.

### A5 — "Was I present or on leave that day?"

The two self-service lists answer it together: a day with no session row
and an `APPROVED` leave row covering it was a leave day; a day with a
session was worked. Cross-check:

```bash
GET /api/v1/attendance/sessions?employeeId=<ownEmpId>&businessDate=2026-11-10
GET /api/v1/leave/requests?status=APPROVED&from=2026-11-10&to=2026-11-10
```

## Deferred to later milestones (not in 2A)

- Balance ledger + annual carry-forward jobs (balances remain admin-managed
  allocations for now).
- Accrual job that materializes credits from `MONTHLY_CREDIT` /
  `WORKED_DAYS_RATIO` versions.
- Comp-off credit processing (earned off-days → COMP_OFF balance).
- Sandwich-rule / weekly-off-holiday absorption evaluation in requests.
- Multi-step approval workflows, half-day/hourly handling changes,
  encashment, payroll integration.
- Requests keyed on `typeDefId` for fully custom types (no enum mapping).
  Request submission currently gates on the legacy `leaveType` enum via
  `resolveEffective` — EMPLOYEE → DEPARTMENT (primary membership) → SITE →
  PROJECT → COMPANY, fail closed. Enum-mapped DEPARTMENT policies (CL, SL,
  EL, CO, LOP...) gate requests today; custom types need the typeDef-keyed
  request path.
