# Finance Department — API Guide

Step-by-step reference for the complete Finance-persona lifecycle: company
onboarding → org skeleton → Finance department → employees → memberships →
invite/claim/login → role + operation grants → daily punch flow → attendance &
leave policy setup (CL / SL / EL / COFF, sandwich rule, carry-over) → Finance
read APIs → dashboards → budgets & cash-flow forecasts.

Base URL: `/api/v1`

Personas used below:

| Actor              | Role               | Scope                       |
| ------------------ | ------------------ | --------------------------- |
| `platform-admin`   | Platform principal | Platform company only       |
| `owner@acme.com`   | `COMPANY_OWNER`    | Acme Construction (tenant)  |
| `finhead@acme.com` | `FINANCE_MANAGER`  | Finance dept, company scope |
| `finexec@acme.com` | `FINANCE_STAFF`    | Finance dept, company scope |

```http
Authorization: Bearer <access-token>
x-company-id: <company-uuid>          # every tenant route — platform & /auth routes exempt
Content-Type: application/json
```

> **Two gate layers, always separate:**
>
> - **API permissions** (`FINANCE_*`, `ATTENDANCE_*`, `LEAVE_*`, …) come from
>   role assignments.
> - **Business operations** (`PROJECT_BUDGET_VIEW`, `PAYROLL_INPUT_REVIEW`, …)
>   are enabled on departments then granted to employees. `COMPANY_OWNER` is
>   exempt from the operation layer only — never from API permissions.

---

## Step 0 — Platform creates the tenant company

**Platform-side** (platform principal, no `x-company-id`):

```http
POST /api/v1/platform/companies
Authorization: Bearer <platform-token>
```

```json
{
  "companyCode": "ACME",
  "companyName": "Acme Construction Pvt Ltd",
  "adminLoginId": "owner@acme.com",
  "adminDisplayName": "Rajesh Owner"
}
```

```json
201
{
  "company": { "id": "c0mpany-uuid", "code": "ACME", "name": "Acme Construction Pvt Ltd" },
  "adminPrincipalId": "principal-uuid",
  "claimToken": "one-time-claim-code"          // delivered once — never stored raw
}
```

Provisioning note: the new company's `COMPANY_OWNER` role receives the full
`FINANCE_*` permission set (plus other reconcile-managed keys) **at creation** —
no `db:reconcile` needed. `FINANCE_MANAGER` / `FINANCE_STAFF` role templates are
created too, but with zero assignments.

## Step 1 — Company Owner claims the account & logs in

```http
POST /api/v1/auth/claim
{ "token": "one-time-claim-code", "password": "Str0ng!Pass" }
```

```json
200 { "ok": true }
```

```http
POST /api/v1/auth/login
{ "loginId": "owner@acme.com", "password": "Str0ng!Pass" }
```

```json
200
{
  "accessToken": "eyJhbGciOi…",
  "refreshToken": "eyJhbGciOi…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "role": "COMPANY_OWNER",
  "roles": ["COMPANY_OWNER"],
  "user": {
    "id": "principal-uuid",
    "loginId": "owner@acme.com",
    "displayName": "Rajesh Owner",
    "companyId": "c0mpany-uuid",
    "companyCode": "ACME",
    "operations": []
  }
}
```

All following tenant calls use this token + `x-company-id: c0mpany-uuid`.

## Step 2 — Org skeleton (head office → project → site)

Finance sits at a head office; attendance punching needs at least one geofenced
site.

```http
POST /api/v1/org/head-offices        # ORG_HEAD_OFFICE_CREATE
{ "code": "HQ", "name": "Head Office — Patna", "isPrimary": true,
  "city": "Patna", "state": "Bihar", "country": "India" }
```

```json
201 { "id": "ho-uuid", "code": "HQ", "isPrimary": true, "status": "ACTIVE", "version": 0 }
```

> Head offices are created `ACTIVE` (unlike departments, which start `DRAFT`).

```http
POST /api/v1/org/projects            # ORG_PROJECT_CREATE — headOfficeId derived server-side
{ "code": "ACME-TWR", "name": "Acme Tower", "timezone": "Asia/Kolkata",
  "projectType": "COMMERCIAL", "locationCity": "Patna" }
```

```http
POST /api/v1/org/sites               # ORG_SITE_CREATE — geofence fields drive punch validation
{ "projectId": "project-uuid", "code": "SITE-01", "name": "Acme Tower Site",
  "city": "Patna", "geoLatitude": 25.5941, "geoLongitude": 85.1376,
  "geoFenceRadiusM": 150, "timezone": "Asia/Kolkata" }
```

> `geoLatitude`/`geoLongitude`/`geoFenceRadiusM` are what `punch-in` validates
> against (Haversine). Without them, punch policy falls back per the attendance
> policy's `geofenceStrict` flag. See `docs/ATTENDANCE-API.md`.

## Step 3 — Create the Finance department

Finance is a **company-wide** department anchored physically to a head office —
`baseHeadOfficeId` is a location, never a permission scope.

```http
POST /api/v1/departments             # DEPARTMENT_CREATE
{
  "scopeType": "COMPANY",
  "code": "FIN",
  "name": "Finance & Accounts",
  "category": "FINANCE",             // controlled category — this is what makes it "Finance"
  "baseHeadOfficeId": "ho-uuid"
}
```

```json
201
{
  "id": "dept-fin-uuid", "scopeType": "COMPANY", "category": "FINANCE",
  "code": "FIN", "name": "Finance & Accounts", "status": "DRAFT",
  "baseHeadOfficeId": "ho-uuid", "version": 0
}
```

```http
POST /api/v1/departments/dept-fin-uuid/status
{ "to": "ACTIVE", "expectedVersion": 0 }
```

```json
200 { "id": "dept-fin-uuid", "status": "ACTIVE", "version": 1 }
```

> The `FINANCE` category — not the name — is what the role-assignment guard and
> every Finance authorization check keys on. A department _named_ "Finance"
> with `category: CUSTOM` does not qualify.

## Step 4 — Create the Finance employees

Profiles exist first; logins are invited later (profile ≠ login principal).

```http
POST /api/v1/employees               # EMPLOYEE_CREATE
{
  "employeeCode": "FIN-001",
  "displayName": "Anil Finance",
  "engagementType": "DIRECT_EMPLOYEE",
  "designation": "Finance Manager",
  "joiningDate": "2026-11-01",
  "contactPhone": "9810000001",
  "contactEmail": "finhead@acme.com"
}
```

```json
201 { "id": "emp-mgr-uuid", "employeeCode": "FIN-001", "status": "ACTIVE", "version": 0 }
```

Repeat for staff:

```http
POST /api/v1/employees
{ "employeeCode": "FIN-002", "displayName": "Bina Accounts",
  "engagementType": "DIRECT_EMPLOYEE", "designation": "Accounts Executive" }
→ emp-staff-uuid
```

## Step 5 — Add memberships (Finance dept, primary)

```http
POST /api/v1/employees/emp-mgr-uuid/memberships      # EMPLOYEE_MANAGE
{ "departmentId": "dept-fin-uuid", "isPrimary": true }
```

```json
201
{
  "id": "memb-uuid", "employeeId": "emp-mgr-uuid",
  "departmentId": "dept-fin-uuid", "isPrimary": true,
  "startedAt": "2026-11-21T00:00:00.000Z", "endedAt": null
}
```

Repeat for `emp-staff-uuid`. This step is **mandatory** before role grants —
membership is the eligibility gate for `FINANCE_*` roles (but membership alone
grants no permissions).

## Step 6 — Invite → claim → login (how the Finance Manager gets in)

Owner sends an invite; the employee self-activates:

```http
POST /api/v1/employees/emp-mgr-uuid/invite           # EMPLOYEE_INVITE
{ "loginId": "finhead@acme.com", "loginIdType": "EMAIL" }
```

```json
201
{
  "claimCode": "<one-time-code>",
  "claimUrl": "https://app.acme.com/verify-employee?token=<one-time-code>",
  "expiresAt": "2026-11-22T00:00:00.000Z"
}
// Code is emailed when mail is configured; returned to the inviter once —
// never stored raw, never logged.
```

Employee activates (unauthenticated, rate-limited):

```http
POST /api/v1/auth/claim
{ "token": "<claim-code>", "password": "Fin#Pass2026" }
```

Then logs in exactly like the owner did:

```http
POST /api/v1/auth/login
{ "loginId": "finhead@acme.com", "password": "Fin#Pass2026" }
```

```json
200
{
  "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer", "expiresIn": 900,
  "role": null, "roles": [],
  "user": { "id": "fin-principal-uuid", "loginId": "finhead@acme.com",
            "displayName": "Anil Finance", "employeeCode": "FIN-001",
            "companyId": "c0mpany-uuid", "operations": [] }
}
```

`GET /api/v1/auth/me` returns the full profile (roles, permissions, departments,
assignments) — cached, invalidated on any profile/role/membership change.

## Step 7 — Grant Finance roles (membership-guarded)

```http
POST /api/v1/employees/emp-mgr-uuid/assignments      # ACCESS_ROLE_ASSIGN (owner)
{ "roleKey": "FINANCE_MANAGER", "scopeType": "COMPANY" }
```

```json
201 { "id": "assign-uuid", "roleKey": "FINANCE_MANAGER", "scopeType": "COMPANY" }
```

```http
POST /api/v1/employees/emp-staff-uuid/assignments
{ "roleKey": "FINANCE_STAFF", "scopeType": "COMPANY" }
```

**The hard guard (fail-closed):** a `FINANCE_*` role is granted only to an
active, login-linked employee with an **active membership in an active
`category: FINANCE` department** of the same company → otherwise
`409 FINANCE_MEMBERSHIP_REQUIRED`. When the employee's last active Finance
membership ends, all `FINANCE_*` assignments are revoked **in the same
transaction** (each audited `ACCESS_ROLE_REVOKED`), and the authorization-time
check stops their permissions even if any path bypasses revocation.
`COMPANY_OWNER` never needs Finance membership.

| Role              | Key Finance API permissions                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPANY_OWNER`   | All 16 `FINANCE_*` (provisioned at company creation)                                                                                                              |
| `FINANCE_MANAGER` | `FINANCE_PORTFOLIO_READ`, `FINANCE_EMPLOYEE_READ`, `FINANCE_EMPLOYEE_SENSITIVE_READ`, `FINANCE_BUDGET_READ`, `FINANCE_BUDGET_MANAGE`, `FINANCE_DASHBOARD_READ`, … |
| `FINANCE_STAFF`   | Least-privilege subset — **no** `FINANCE_EMPLOYEE_SENSITIVE_READ`, no budget `MANAGE`, no export                                                                  |

Confirm templates any time:

```http
GET /api/v1/roles                    # ROLE_ASSIGNMENT_READ
```

## Step 8 — Enable & assign business operations

Operations are a second, independent gate: enable on the department, then grant
to the employee.

```http
GET /api/v1/operations               # OPERATION_READ — full global catalogue
```

```http
POST /api/v1/departments/dept-fin-uuid/operations    # OPERATION_CONFIGURE
{ "operationKey": "PROJECT_BUDGET_VIEW" }
```

Repeat for each key the dept should perform, e.g.:

```
PROJECT_BUDGET_VIEW · PROJECT_BUDGET_CREATE · PROJECT_BUDGET_REVISE
PROJECT_BUDGET_APPROVE · PROJECT_DASHBOARD_VIEW
PROJECT_CASH_FLOW_FORECAST_SUBMIT · PROJECT_CASH_FLOW_FORECAST_REVISE
PROJECT_CASH_FLOW_REVIEW
FINANCE_EMPLOYEE_DIRECTORY_VIEW · FINANCE_EMPLOYMENT_DETAILS_VIEW
PAYROLL_INPUT_REVIEW
```

Grant to the employee (effective-dated; only enabled ops may be granted):

```http
POST /api/v1/employees/emp-mgr-uuid/operations       # OPERATION_EMPLOYEE_ASSIGN
{ "operationKey": "PROJECT_BUDGET_APPROVE" }
```

```http
GET /api/v1/employees/emp-mgr-uuid/operations        # EMPLOYEE_READ — effective ops list
```

> Membership alone never grants operations; operations alone never grant API
> permissions. Both must hold (or the caller is `COMPANY_OWNER`).

---

## Step 9 — Finance manager's daily punch flow

Punching is identical for every employee — Finance roles change nothing.
Requires `ATTENDANCE_RECORD` (self) at the site; a geofenced site + active
policy resolve the business date.

```http
GET /api/v1/auth/me                                   # shows attendance.hasActiveSession
```

```http
POST /api/v1/attendance/punch-in                      # ATTENDANCE_RECORD at site
{ "siteId": "site-uuid", "latitude": 25.5942, "longitude": 85.1377 }
```

```json
201
{
  "id": "session-uuid", "employeeId": "emp-mgr-uuid", "siteId": "site-uuid",
  "businessDate": "2026-11-21", "status": "IN_PROGRESS",
  "source": "MOBILE_SELF", "punchInAt": "2026-11-21T08:02:11.000Z",
  "punchInWithinGeofence": true, "isFlagged": false
}
```

```http
POST /api/v1/attendance/breaks/start   { "remarks": "lunch" }
POST /api/v1/attendance/breaks/end     {}
POST /api/v1/attendance/punch-out      { "siteId": "site-uuid", "latitude": 25.5940, "longitude": 85.1375 }
```

```json
200
{
  "id": "session-uuid", "status": "COMPLETED",
  "punchOutAt": "2026-11-21T17:15:42.000Z",
  "grossDurationMins": 553, "breakDurationMins": 45, "netDurationMins": 508,
  "presentUnits": "1.0", "totalPUnits": "1.0", "overtimeHours": "0.47"
}
```

> Passing another `employeeId`, or a `source` of `SUPERVISOR_KIOSK` /
> `BIOMETRIC_DEVICE` / `MANUAL_CORRECTION`, requires `ATTENDANCE_MANAGE`.
> Outside the geofence → punch is flagged (`isFlagged`, `flagReason`), not
> rejected — regularization is `ATTENDANCE_MANAGE` via
> `POST /attendance/sessions/:id/regularize`. Full flow: `docs/ATTENDANCE-API.md`.

## Step 10 — Attendance policy (the "settings" layer)

One company-wide policy is typical; project/site/employee-scoped policies
override it (`scope: COMPANY|PROJECT|SITE|EMPLOYEE`).

```http
POST /api/v1/attendance/policies                      # ATTENDANCE_MANAGE
{
  "name": "Default Attendance Policy",
  "scope": "COMPANY",
  "dayStartHour": 8, "dayStartMinute": 0,            // 8 AM – 8 AM business cycle
  "shiftDurationMins": 480,
  "halfDayThresholdMins": 240,
  "fullDayThresholdMins": 480,
  "breakMode": "FIXED", "fixedBreakMins": 60, "minWorkForBreakMins": 240,
  "overtimeMode": "HOURLY", "minOvertimeMins": 30, "otSlabMins": 30,
  "pMultiplierSlabs": [
    { "minExtraMins": 120, "pUnit": 0.5 },
    { "minExtraMins": 240, "pUnit": 1.0 }
  ],
  "geofenceStrict": true,
  "allowMobilePunch": true, "allowKioskPunch": true, "allowBiometric": true,
  "requireTvtGate": false, "tvtGateAction": "FLAG"
}
```

```json
201 { "id": "policy-uuid", "scope": "COMPANY", "status": "ACTIVE", "version": 0 }
```

```http
GET   /api/v1/attendance/policies/effective?employeeId=emp-mgr-uuid   # resolved policy
PATCH /api/v1/attendance/policies/policy-uuid                         # same fields, partial
GET   /api/v1/attendance/sessions?siteId=…&businessDate=2026-11-21    # ATTENDANCE_READ
GET   /api/v1/attendance/daily-summary?siteId=…&businessDate=2026-11-21
GET   /api/v1/attendance/muster-roll?siteId=…&from=2026-11-01&to=2026-11-30
```

## Step 11 — Leave setup: type defs → policies → allocations → requests

### 11a. Leave _type definitions_ — the company vocabulary (CL / SL / EL / COFF…)

Codes are admin-defined and optionally map onto the built-in `LeaveType` enum
(`CASUAL`, `SICK`, `PRIVILEGE`, `COMP_OFF`, `LOSS_OF_PAY`, `SPECIAL`).

```http
POST /api/v1/leave/types             # LEAVE_MANAGE
{ "code": "CL", "name": "Casual Leave", "leaveType": "CASUAL" }
{ "code": "SL", "name": "Sick Leave", "leaveType": "SICK" }
{ "code": "EL", "name": "Earned Leave", "leaveType": "PRIVILEGE" }
{ "code": "COFF", "name": "Comp Off", "leaveType": "COMP_OFF" }
```

```json
201 { "id": "typedef-cl-uuid", "code": "CL", "leaveType": "CASUAL", "status": "ACTIVE" }
```

### 11b. Policies + immutable accrual _versions_

Each policy binds a type def to a scope (`COMPANY`, `DEPARTMENT`, `EMPLOYEE`)
and starts with an immutable accrual version — `MONTHLY_CREDIT` (x days/month)
or `WORKED_DAYS_RATIO` (y days per N worked days).

```http
POST /api/v1/leave/policies          # LEAVE_MANAGE
{
  "scopeType": "COMPANY",
  "typeDefId": "typedef-cl-uuid",
  "name": "CL — company standard",
  "version": { "effectiveFrom": "2026-01-01", "mode": "MONTHLY_CREDIT",
               "monthlyCreditAmount": 1, "note": "12 CL / year" }
}
```

```json
201 { "id": "policy-cl-uuid", "typeDefId": "typedef-cl-uuid", "version": 0 }
```

### 11c. The "settings" — PATCH carries the behavioural knobs

```http
PATCH /api/v1/leave/policies/policy-cl-uuid
{
  "annualAllowance": 12,
  "accrualFrequency": "MONTHLY",
  "allowHalfDay": true,
  "sandwichRule": true,                    // holidays/weekends inside a range count
  "maxConsecutiveDays": 3,
  "minNoticeDays": 1,
  "carryoverMaxDays": 5,
  "encashable": false,
  "requiresDocAboveDays": null,
  "isActive": true,
  "expectedVersion": 0
}
```

| Setting                | Effect                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| `sandwichRule`         | Weekly-offs/holidays falling _between_ leave days count as leave |
| `allowHalfDay`         | Enables `isHalfDay` + `halfDayPortion` on requests               |
| `maxConsecutiveDays`   | Hard cap per request                                             |
| `minNoticeDays`        | `startDate` must be ≥ today + N                                  |
| `carryoverMaxDays`     | Cap on year-end carry-over                                       |
| `encashable`           | Type may be encashed                                             |
| `requiresDocAboveDays` | Requests above N days need `documentId`                          |

Version changes are effective-dated, never edited in place:

```http
POST /api/v1/leave/policies/policy-cl-uuid/versions
{ "effectiveFrom": "2027-01-01", "mode": "MONTHLY_CREDIT",
  "monthlyCreditAmount": 1.5, "expectedVersion": 1 }
GET  /api/v1/leave/policies/effective?typeDefId=typedef-cl-uuid&asOf=2026-11-21
```

### 11d. Yearly allocation → balances

```http
POST /api/v1/leave/allocations       # LEAVE_MANAGE
{ "employeeId": "emp-mgr-uuid", "leaveType": "CASUAL",
  "year": 2026, "allocatedDays": 12, "carriedOverDays": 2 }
```

```http
GET /api/v1/leave/balances/emp-mgr-uuid?leaveType=CASUAL&year=2026   # LEAVE_READ
```

```json
200
{
  "id": "bal-uuid", "employeeId": "emp-mgr-uuid", "leaveType": "CASUAL",
  "year": 2026, "allocatedDays": "12.0", "usedDays": "0.0",
  "pendingDays": "0.0", "carriedOverDays": "2.0", "version": 0
}
// available = allocated + carriedOver − used − pending
// Own balance: LEAVE_READ. Another employee's: LEAVE_READ + supervisor/manager.
// List all: GET /api/v1/leave/balances?employeeId=…&leaveType=…&year=…
```

### 11e. Employee applies → approver reviews

```http
POST /api/v1/leave/requests          # LEAVE_APPLY (own) / LEAVE_MANAGE (for others)
{ "leaveType": "CASUAL", "startDate": "2026-12-24", "endDate": "2026-12-26",
  "reason": "Family function", "isHalfDay": false }
```

```json
201 { "id": "req-uuid", "status": "PENDING", "totalDays": "3.0" }
```

```http
POST /api/v1/leave/requests/req-uuid/review          # LEAVE_APPROVE — never self-approve
{ "action": "APPROVE", "remarks": "ok", "expectedVersion": 0 }
```

```http
GET  /api/v1/leave/requests?employeeId=emp-mgr-uuid&status=PENDING   # LEAVE_READ
POST /api/v1/leave/requests/req-uuid/cancel                          # LEAVE_APPLY
{ "expectedVersion": 1 }
```

---

## Step 12 — Finance read APIs (portfolio & workforce)

Every route below is tenant-scoped and dual-gated (API permission **and** the
listed business operation, unless caller is `COMPANY_OWNER`).

### `GET /api/v1/finance/projects` — `FINANCE_PORTFOLIO_READ` + `PROJECT_DASHBOARD_VIEW`

Query: `status=ACTIVE|ARCHIVED`, `search`, `limit` (1-100, default 50), `cursor`
(uuid keyset).

```json
200
{
  "items": [{
    "id": "project-uuid", "code": "ACME-TWR", "name": "Acme Tower",
    "status": "ACTIVE", "projectType": "COMMERCIAL", "locationCity": "Patna",
    "headOffice": { "id": "ho-uuid", "code": "HQ", "name": "Head Office — Patna" }
  }],
  "nextCursor": "project-uuid"
}
```

### `GET /api/v1/finance/projects/{projectId}/sites` — same gates

```json
200
{
  "items": [{
    "id": "site-uuid", "code": "SITE-01", "name": "Acme Tower Site",
    "status": "ACTIVE", "city": "Patna", "geoFenceRadiusM": 150
    // geoLatitude / geoLongitude are NEVER returned here
  }]
}
```

404 `NOT_FOUND` for missing or cross-company `projectId`.

### `GET /api/v1/finance/employees` — `FINANCE_EMPLOYEE_READ` + `FINANCE_EMPLOYEE_DIRECTORY_VIEW`

Query: `projectId`, `siteId`, `departmentId` (matched via **active** memberships
only — site-scoped depts reach the project through `site.projectId`),
`status`, `search` (name/code, case-insensitive), `limit`, `cursor`.

```json
200
{
  "items": [{
    "id": "emp-mgr-uuid", "employeeCode": "FIN-001", "displayName": "Anil Finance",
    "status": "ACTIVE",
    "primaryMembership": {
      "id": "memb-uuid", "departmentId": "dept-fin-uuid", "isPrimary": true,
      "startedAt": "2026-11-21T00:00:00.000Z", "endedAt": null,
      "department": {
        "id": "dept-fin-uuid", "code": "FIN", "name": "Finance & Accounts",
        "scopeType": "COMPANY", "projectId": null, "siteId": null,
        "baseHeadOfficeId": "ho-uuid"
      }
    }
  }]
}
```

### `GET /api/v1/finance/employees/{employeeId}` — directory gates

```json
200
{
  "id": "emp-mgr-uuid", "employeeCode": "FIN-001", "displayName": "Anil Finance",
  "status": "ACTIVE",
  "memberships": [{
    "id": "memb-uuid", "departmentId": "dept-fin-uuid",
    "departmentCode": "FIN", "departmentName": "Finance & Accounts",
    "scopeType": "COMPANY", "isPrimary": true, "startedAt": "2026-11-21T00:00:00.000Z"
  }],
  "employmentDetails": {
    "engagementType": "DIRECT_EMPLOYEE", "designation": "Finance Manager",
    "tradeCategory": null, "joiningDate": "2026-11-01",
    "contactPhone": "9810000001", "contactEmail": "finhead@acme.com",
    "emergencyContactName": null, "emergencyContactPhone": null
  }
}
```

`employmentDetails` is **`null` unless BOTH** `FINANCE_EMPLOYEE_SENSITIVE_READ`
(permission) **and** `FINANCE_EMPLOYMENT_DETAILS_VIEW` (operation) hold —
`FINANCE_STAFF` never sees it. Salary/bank/gov-ID fields don't exist and are
never fabricated.

### `GET /api/v1/finance/employees/{employeeId}/attendance-summary?from&to` — `PAYROLL_INPUT_REVIEW`

```json
200
{
  "employeeId": "emp-mgr-uuid", "from": "2026-11-01", "to": "2026-11-30",
  "sessions": 19, "presentUnits": "18.5", "overtimeUnits": "1.0",
  "totalUnits": "19.5", "overtimeHours": "4.00",
  "grossMinutes": 10560, "netMinutes": 9420,
  "flaggedSessions": 1, "sitesWorked": 1
}
```

Aggregates only — never GPS coordinates, remarks, or flag reasons. `from`/`to`
are required `YYYY-MM-DD`, `to ≥ from` else `422`.

### `GET /api/v1/finance/employees/{employeeId}/leave-summary?year=2026` — `FINANCE_EMPLOYMENT_DETAILS_VIEW`

```json
200
{
  "employeeId": "emp-mgr-uuid", "year": 2026,
  "balances": [{
    "leaveType": "CASUAL", "allocatedDays": "12.0", "usedDays": "3.0",
    "pendingDays": "1.0", "carriedOverDays": "2.0", "availableDays": "11.0"
  }],
  "requests": [
    { "status": "APPROVED", "count": 1, "totalDays": "3.0" },
    { "status": "PENDING",  "count": 1, "totalDays": "1.0" }
  ]
}
```

Balances + per-status rollups — never reasons or document contents.

## Step 13 — `GET /api/v1/finance/dashboard` — `FINANCE_DASHBOARD_READ` + `PROJECT_DASHBOARD_VIEW`

Aggregates only what exists (`groupBy` — no N+1); everything else is _declared_
in `unavailable`, never fabricated:

```json
200
{
  "projects": { "total": 1, "byStatus": { "ACTIVE": 1 } },
  "sites": { "total": 1, "byStatus": { "ACTIVE": 1 } },
  "workforce": { "total": 42, "byStatus": { "ACTIVE": 42 },
                 "byEngagementType": { "DIRECT_EMPLOYEE": 40, "DAILY_WAGE": 2 } },
  "budgets": { "total": 3, "byStatus": { "ACTIVE": 3 },
               "approvedTotals": [{ "currency": "INR", "totalAmount": "1500000.00" }] },
  "pendingBudgetReviews": 1,
  "cashFlowForecasts": {
    "total": 2,
    "byCurrency": [{ "currency": "INR", "totalInflow": "4000000.00",
                     "totalOutflow": "1500000.00", "net": "2500000.00" }]
  },
  "unavailable": [
    { "section": "workforce", "reason": "requires FINANCE_EMPLOYEE_READ + FINANCE_EMPLOYEE_DIRECTORY_VIEW" },
    { "section": "wallets", "reason": "no wallet data model yet" },
    { "section": "pettyCash", "reason": "no petty-cash data model yet" },
    { "section": "payroll", "reason": "no payroll data model yet" },
    { "section": "actualCosts", "reason": "no Finance transaction ledger — actuals are not fabricated" },
    { "section": "commitments", "reason": "no procurement/commitment data model yet" },
    { "section": "billing", "reason": "no billing/invoice data model yet" },
    { "section": "quotations", "reason": "no quotation data model yet" },
    { "section": "reports", "reason": "reporting slice not implemented" }
  ]
}
```

`workforce` is `null` + declared when the caller lacks the directory op.

## Step 14 — Budgets & cash-flow forecasts (summary)

Project-scoped, versioned, dual-gated; `expectedVersion` on every mutation;
`idempotencyKey` on every retryable create:

```
POST   /finance/projects/{projectId}/budgets              FINANCE_BUDGET_MANAGE + PROJECT_BUDGET_CREATE
GET    /finance/projects/{projectId}/budgets              FINANCE_BUDGET_READ   + PROJECT_BUDGET_VIEW
GET    /finance/budgets/{id}                              READ + VIEW
PATCH  /finance/budgets/{id}                              MANAGE + PROJECT_BUDGET_REVISE (header only)
POST   /finance/budgets/{id}/revisions                    MANAGE + REVISE (immutable lines, server total)
GET    /finance/budgets/{id}/revisions[/{revisionId}]     READ + VIEW
POST   /finance/budgets/{id}/revisions/{rev}/submit       MANAGE + REVISE (DRAFT→SUBMITTED)
POST   /finance/budgets/{id}/revisions/{rev}/decisions    MANAGE + PROJECT_BUDGET_APPROVE
       { action: APPROVE|REJECT|RETURN } — self-approval blocked;
       APPROVE promotes latestApprovedRevisionId
GET    /finance/budgets/{id}/revisions/{rev}/decisions    READ + VIEW (append-only history)
GET    /finance/projects/{projectId}/costs                READ + VIEW
       commitments/actuals = null — no ledger yet, never zero-fabricated
POST   /finance/projects/{projectId}/cash-flow-forecasts  MANAGE + PROJECT_CASH_FLOW_FORECAST_SUBMIT
GET    /finance/projects/{projectId}/cash-flow-forecasts  READ + VIEW
GET    /finance/cash-flow-forecasts/{id}                  READ + PROJECT_CASH_FLOW_REVIEW
PATCH  /finance/cash-flow-forecasts/{id}                  MANAGE + PROJECT_CASH_FLOW_FORECAST_REVISE
       (version-guarded, bumps revision, replaces lines atomically)
```

---

## Common errors

| Code                              | When                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| `401`                             | Missing/invalid token or missing `x-company-id`                      |
| `403 ACCESS_DENIED`               | API permission missing at required scope                             |
| `403 OPERATION_NOT_ASSIGNED`      | Business op not granted (and not `COMPANY_OWNER`)                    |
| `404 NOT_FOUND`                   | Entity missing **or belongs to another company** (no existence leak) |
| `409 FINANCE_MEMBERSHIP_REQUIRED` | `FINANCE_*` role grant without active FINANCE-dept membership        |
| `409 SELF_APPROVAL_FORBIDDEN`     | Reviewing your own submitted revision/leave                          |
| `409 IDEMPOTENCY_CONFLICT`        | Same `idempotencyKey`, different request fingerprint                 |
| `422 VALIDATION`                  | Bad `expectedVersion` (stale), date range, money format              |

## Roadmap — declared, not built

Wallets · petty cash · quotations · invoicing/billing · payments · payroll ·
procurement commitments · transaction ledger (unlocks real `actualCosts` /
`commitments` on `/costs` and the dashboard) · Finance reports/exports.
