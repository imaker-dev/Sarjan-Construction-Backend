# PI / PD API — Step-by-Step Developer Guide

Complete, sequential walkthrough of every API in the Project In-charge (PI) /
Project Director (PD) journey: **admin bootstrap → claim + login → self punch
in/out → leave → scoped team/site/department administration → activity feed.**

Every step shows the **exact request** and a **representative real response**.
Run them top to bottom — later steps use IDs created by earlier ones.

```
Base URL : http://localhost:3000/api/v1
Auth     : Authorization: Bearer <accessToken>
Tenant   : x-company-id: <company-uuid>     ← required on EVERY tenant call
```

---

## 0. DFD — why the system is shaped this way

```mermaid
flowchart TD
    subgraph Actors
        ADM[Company Admin / Owner]
        PI[Project In-charge]
        PD[Project Director]
        WK[Site Worker]
    end

    subgraph Identity["Identity & Access (JWT)"]
        LOGIN[/auth/login]
        CLAIM[/auth/claim]
        ME[/auth/me]
        ACL[(RoleAssignment +<br/>Permission cache)]
    end

    subgraph Org["Org Structure (tenant scoped)"]
        HO[HeadOffice]
        PRJ[Project]
        SITE[Site]
        DEPT[Department<br/>scopeType: PROJECT|SITE|COMPANY]
        MEM[DepartmentMembership]
    end

    subgraph Policy["Delegation Switches"]
        DEL[(CompanyDelegationPolicy<br/>7 flags, version + expectedVersion)]
    end

    subgraph SelfSvc["Self Service (EMPLOYEE@COMPANY)"]
        PUNCH[/attendance/punch-*]
        LEAVE[/leave/requests]
    end

    subgraph Scoped["Scoped Admin (PI/PD @PROJECT)"]
        SITEW[POST /org/sites]
        DEPTW[POST /departments]
        ONB[POST /departments/:id/onboard]
        PLC[/departments/:id/members*]
        WFL[/org/{sites,projects}/:id/workforce/:emp/*]
    end

    subgraph Evidence["Evidence (append-only)"]
        AUD[(AuditLog)]
        OUT[(Outbox → Notifications)]
        FEED[/org/{projects,sites}/:id/activity]
    end

    ADM -->|creates| HO --> PRJ --> SITE --> DEPT
    ADM -->|1. invite| CLAIM
    CLAIM -->|activates principal| ACL
    ADM -->|2. grant EMPLOYEE@COMPANY| ACL
    ADM -->|3. grant PI/PD@PROJECT| ACL
    ADM -->|4. add membership| MEM
    ADM -->|5. set flags| DEL
    PI --> LOGIN --> ME
    PI -->|ATTENDANCE_RECORD@COMPANY| PUNCH
    PI -->|LEAVE_APPLY@COMPANY| LEAVE
    PI -->|perm + scope + DEL flag| SITEW & DEPTW & ONB & PLC & WFL
    SITEW & DEPTW & ONB & PLC & WFL --> AUD
    AUD --> FEED --> PI & PD
    ONB & PLC & WFL --> MEM
    PUNCH --> AUD
    PD -.->|same reads + lifecycle,<br/>NO site/dept writes| Scoped
```

### Why each piece exists

| Piece | Why |
|---|---|
| `x-company-id` + `tenantCompanyGuard` | Multi-tenant DB — every query/mutation must be pinned to one company; the header selects the tenant, the guard proves the caller belongs to it. |
| `RoleAssignment` (scope-bound) | A PI grant is `PROJECT` scoped — it never bleeds into a sibling project or the whole company. `EMPLOYEE@COMPANY` is a *separate* grant that unlocks self-service; that's why a PI holds **two** roles. |
| `CompanyDelegationPolicy` switches | Scoped holders get write power **only** where the company opts in (`siteCreate`, `deptManage`, `placement`, `employeeOnboard`, `memberSuspend`, `memberExit`). Fail-closed: switch off → `403 DELEGATION_DISABLED`. |
| `DepartmentMembership` | Attendance/leave/team access resolves through *effective* memberships — suspend/exit work by ending these rows, not by touching the global login. |
| `expectedVersion` | Optimistic concurrency — two admins editing the same record can't silently overwrite each other (`409 VERSION_CONFLICT`). |
| `AuditLog` + `Outbox` | Every mutation is appended once (immutable evidence) and notifications are delivered transactionally — the scoped activity feed is a redacted view over AuditLog. |

---

## PHASE A — Company admin bootstrap (runs once)

The admin (`COMPANY_OWNER`/`ORG_*`@COMPANY) prepares everything a PI needs:
org structure → PI's employee record → invite → role grants → membership →
delegation switches.

### A1 — Admin login

```bash
POST /api/v1/auth/login
Content-Type: application/json

{ "loginId": "owner@acme.com", "password": "Owner@123" }
```

```json
→ 200
{
  "accessToken": "eyJhbGciOi…",
  "refreshToken": "eyJhbGciOi…",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```

Use this token as `$ADMIN` below. Find your company id via `GET /api/v1/org/company` (`ORG_COMPANY_READ`).

### A2 — Create primary head office

```bash
POST /api/v1/org/head-offices
Authorization: Bearer $ADMIN        x-company-id: $CO

{ "code": "HO-01", "name": "Acme HQ", "isPrimary": true,
  "addressLine1": "1 MG Road", "city": "Pune", "state": "MH",
  "pinCode": "411001", "country": "IN" }
```

```json
→ 201
{ "id": "b1c9f6e0-…", "code": "HO-01", "name": "Acme HQ",
  "isPrimary": true, "status": "ACTIVE", "version": 1 }
```

### A3 — Create the project

```bash
POST /api/v1/org/projects

{ "code": "P-101", "name": "Skyline Tower", "timezone": "Asia/Kolkata" }
```

```json
→ 201
{ "id": "7d3a1c44-…", "code": "P-101", "name": "Skyline Tower",
  "headOfficeId": "b1c9f6e0-…", "status": "ACTIVE", "version": 1 }
```

→ save as `$PROJECT` (`headOfficeId` is resolved server-side).

### A4 — Create a site under the project

```bash
POST /api/v1/org/sites

{ "projectId": "$PROJECT", "code": "S-01", "name": "Tower A Site",
  "addressLine1": "Plot 42", "city": "Pune", "state": "MH",
  "pinCode": "411001", "country": "IN",
  "geoLatitude": 18.52, "geoLongitude": 73.85,
  "geoFenceRadiusM": 300, "timezone": "Asia/Kolkata" }
```

```json
→ 201
{ "id": "a4f2d8b1-…", "projectId": "7d3a1c44-…", "code": "S-01",
  "name": "Tower A Site", "status": "ACTIVE",
  "geoFenceRadiusM": 300, "version": 1 }
```

→ save as `$SITE`.

### A5 — Create a site department

```bash
POST /api/v1/departments

{ "scopeType": "SITE", "scopeId": "$SITE",
  "code": "CIVIL", "name": "Civil Works", "category": "SITE_ENGINEERING" }
```

```json
→ 200
{ "id": "e8c1a2f5-…", "scopeType": "SITE", "scopeId": "a4f2d8b1-…",
  "projectId": "7d3a1c44-…", "siteId": "a4f2d8b1-…",
  "code": "CIVIL", "name": "Civil Works", "category": "SITE_ENGINEERING",
  "headEmployeeId": null, "status": "ACTIVE", "version": 1 }
```

→ save as `$DEPT`.

### A6 — Create the PI's employee record

```bash
POST /api/v1/employees

{ "employeeCode": "PI-01", "displayName": "Ramesh Yadav",
  "engagementType": "DIRECT_EMPLOYEE", "designation": "Project In-charge",
  "joiningDate": "2026-01-05",
  "contactPhone": "+91-9800000001", "contactEmail": "ramesh@acme.com" }
```

```json
→ 200
{ "id": "c7e9b3d2-…", "employeeCode": "PI-01", "displayName": "Ramesh Yadav",
  "engagementType": "DIRECT_EMPLOYEE", "designation": "Project In-charge",
  "status": "ACTIVE", "principalId": null, "version": 1 }
```

→ save as `$PI_EMP`. `principalId: null` — no login yet.

### A7 — Invite the PI (mint `EMPLOYEE_INVITE` claim token)

```bash
POST /api/v1/employees/$PI_EMP/invite        # EMPLOYEE_INVITE@COMPANY

{ "loginId": "ramesh@acme.com", "loginIdType": "EMAIL" }
```

```json
→ 200
{ "claimCode": "9f4c…e7",                     ← one-time, returned once only
  "claimUrl": "http://localhost:3000/verify-employee?token=9f4c…e7",
  "claimExpiresAt": "2026-02-03T10:15:00.000Z",
  "delivery": "EMAIL_SENT" }                    ← or EMAIL_FAILED / NOT_ATTEMPTED
```

`claimUrl` is `null` when no trusted origin resolves — hand `claimCode` over
manually (dev SMTP password is a placeholder → expect `EMAIL_FAILED`/`NOT_ATTEMPTED`;
the code still works).

### A8 — PI claims the account (unauthenticated, rate-limited)

```bash
GET  /api/v1/auth/claim/verify?token=9f4c…e7        # optional pre-check
→ 200 { "valid": true, "companyName": "Acme Constructions",
        "employeeCode": "PI-01", "displayName": "Ramesh Yadav" }

POST /api/v1/auth/claim
{ "token": "9f4c…e7", "password": "Ramesh@123" }
```

```json
→ 200 { "claimed": true }
```

Employee-invite tokens can **only** activate this employee — `/auth/claim/onboard`
rejects them (`401 CLAIM_INVALID`) without consuming. Claim fails closed if the
employee was deactivated or unlinked before claiming.

### A9 — Grant `EMPLOYEE` @COMPANY (unlocks self-service)

```bash
POST /api/v1/employees/$PI_EMP/assignments       # ACCESS_ROLE_ASSIGN@COMPANY

{ "roleKey": "EMPLOYEE", "scopeType": "COMPANY" }
```

```json
→ 200 { "id": "asg-…", "roleKey": "EMPLOYEE", "scopeType": "COMPANY",
        "scopeId": null, "revokedAt": null }
```

> **Why two roles?** `ATTENDANCE_RECORD`/`LEAVE_APPLY` route checks resolve at
> company scope — a project-scoped PI grant alone gets `403` on `/attendance/*`
> and `/leave/*`. `EMPLOYEE`@COMPANY is the built-in template for every staff
> login's own-record actions.

### A10 — Grant `PROJECT_INCHARGE` @PROJECT

```bash
POST /api/v1/employees/$PI_EMP/assignments

{ "roleKey": "PROJECT_INCHARGE", "scopeType": "PROJECT", "scopeId": "$PROJECT" }
```

```json
→ 200 { "id": "asg-…", "roleKey": "PROJECT_INCHARGE",
        "scopeType": "PROJECT", "scopeId": "7d3a1c44-…", "revokedAt": null }
```

One active PI per project — a second grant **replaces** the prior holder
(revoked in the same transaction, `ROLE_ASSIGNMENT_REPLACED` audit). Same rule
for `PROJECT_DIRECTOR`. Self-grant is denied (separation of duties).

### A11 — Add the PI as a member of the site department

Required for punch-in — attendance resolves through an effective membership
at the punch site.

```bash
POST /api/v1/employees/$PI_EMP/memberships       # EMPLOYEE_MANAGE@COMPANY

{ "departmentId": "$DEPT", "isPrimary": true }
```

```json
→ 200 { "membershipId": "m1-…", "employeeId": "c7e9b3d2-…",
        "departmentId": "e8c1a2f5-…", "isPrimary": true,
        "startedAt": "2026-02-02T…", "endedAt": null }
```

### A12 — Enable the delegation switches the PI needs

```bash
GET   /api/v1/org/company/delegations            # ORG_COMPANY_READ@COMPANY
→ 200 { "siteCreate": false, "siteUpdate": false, "deptManage": false,
        "placement": false, "employeeOnboard": false,
        "memberSuspend": false, "memberExit": false, "version": 0 }

PATCH /api/v1/org/company/delegations            # ORG_COMPANY_UPDATE@COMPANY
{ "expectedVersion": 0,                          # ← from GET, optimistic lock
  "siteCreate": true, "siteUpdate": true, "deptManage": true,
  "placement": true, "employeeOnboard": true,
  "memberSuspend": true, "memberExit": true }
```

```json
→ 200 { "siteCreate": true, "siteUpdate": true, "deptManage": true,
        "placement": true, "employeeOnboard": true,
        "memberSuspend": true, "memberExit": true, "version": 1 }
```

Unknown keys → `422 UNKNOWN_FIELD`. All flags optional; omit what you don't want
the PI/PD doing.

---

## PHASE B — PI/PD daily self-service (EMPLOYEE@COMPANY)

### B1 — PI login

```bash
POST /api/v1/auth/login
{ "loginId": "ramesh@acme.com", "password": "Ramesh@123" }
→ 200 { "accessToken": "<PI_TOKEN>", "refreshToken": "…", "expiresIn": 900 }
```

Use `$PI` below. Token refresh: `POST /auth/refresh { "refreshToken": "…" }`.

### B2 — Who am I / what can I do

```bash
GET /api/v1/auth/me
Authorization: Bearer $PI        x-company-id: $CO
```

```json
→ 200
{ "principalId": "…", "loginId": "ramesh@acme.com",
  "employee": { "id": "c7e9b3d2-…", "employeeCode": "PI-01",
                "displayName": "Ramesh Yadav", "status": "ACTIVE" },
  "assignments": [
    { "roleKey": "EMPLOYEE", "scopeType": "COMPANY", "scopeId": null },
    { "roleKey": "PROJECT_INCHARGE", "scopeType": "PROJECT",
      "scopeId": "7d3a1c44-…" } ],
  "operations": [ { "key": "ATTENDANCE_RECORD", "scopeType": "COMPANY" },
                  { "key": "EMPLOYEE_MEMBER_MANAGE", "scopeType": "PROJECT",
                    "scopeId": "7d3a1c44-…" }, … ] }
```

### B3 — Punch in at the site

```bash
POST /api/v1/attendance/punch-in                 # ATTENDANCE_RECORD@COMPANY

{ "siteId": "$SITE",                             # XOR headOfficeId — exactly one
  "latitude": 18.5201, "longitude": 73.8502,
  "source": "MOBILE_SELF", "remarks": "Morning shift" }
```

```json
→ 201
{ "id": "sess-…", "employeeId": "c7e9b3d2-…", "siteId": "a4f2d8b1-…",
  "headOfficeId": null, "businessDate": "2026-02-02",
  "status": "IN_PROGRESS", "source": "MOBILE_SELF",
  "punchInAt": "2026-02-02T08:31:00.000Z",
  "punchInLat": "18.5201000", "punchInLng": "73.8502000",
  "punchInDistanceM": 41, "punchInWithinGeofence": true,
  "punchOutAt": null, "presentUnits": null }
```

`employeeId` is optional — self-punch resolves the caller's own ACTIVE employee.
Geofence distance is computed server-side (`geoLatitude/geoLongitude/geoFenceRadiusM`
on the site); outside → `422 GEO_FENCE` or flagged session per policy.

### B4 — Breaks (optional)

```bash
POST /api/v1/attendance/breaks/start
{ "sessionId": "sess-…", "breakType": "LUNCH", "remarks": "lunch" }
→ 201 { "id": "brk-…", "sessionId": "sess-…",
        "breakType": "LUNCH", "startedAt": "…", "endedAt": null }

POST /api/v1/attendance/breaks/end
{ "breakId": "brk-…" }
→ 200 { "id": "brk-…", "endedAt": "…", "durationMinutes": 42 }
```

### B5 — Punch out

```bash
POST /api/v1/attendance/punch-out
{ "sessionId": "sess-…", "latitude": 18.5203, "longitude": 73.8501 }
```

```json
→ 200
{ "id": "sess-…", "status": "COMPLETED",
  "punchOutAt": "2026-02-02T17:12:00.000Z",
  "workedMinutes": 479, "breakMinutes": 42,
  "presentUnits": 1.0, "overtimeMinutes": 0 }
```

### B6 — My sessions

```bash
GET /api/v1/attendance/sessions?employeeId=$PI_EMP&businessDate=2026-02-02
→ 200 { "items": [ { "id","businessDate","status","punchInAt","punchOutAt",
                     "presentUnits", "siteId", … } ], "nextCursor": null }
```

### B7 — Leave (apply → view → cancel)

```bash
# balance first (admin allocates via POST /leave/allocations — LEAVE_MANAGE@COMPANY)
GET /api/v1/leave/balances/$PI_EMP?leaveType=CASUAL&year=2026
→ 200 { "employeeId": "c7e9b3d2-…", "leaveType": "CASUAL", "year": 2026,
        "allocatedDays": 12, "carriedOverDays": 0, "usedDays": 1.5,
        "availableDays": 10.5 }

POST /api/v1/leave/requests                      # LEAVE_APPLY@COMPANY
{ "leaveType": "CASUAL", "startDate": "2026-02-10", "endDate": "2026-02-11",
  "reason": "Family function" }
→ 201 { "id": "lr-…", "employeeId": "c7e9b3d2-…", "leaveType": "CASUAL",
        "status": "PENDING", "totalDays": 2, "version": 1, … }

GET  /api/v1/leave/requests/lr-…                 # LEAVE_READ
POST /api/v1/leave/requests/lr-…/cancel          # own request, LEAVE_APPLY
{ "reason": "Plans changed", "expectedVersion": 1 }
→ 200 { "id": "lr-…", "status": "CANCELLED", "version": 2 }
```

> PI/PD own leave goes to **company-scope approvers** — they can hold
> `LEAVE_APPROVE`@PROJECT but never approve their own request
> (`SelfApprovalNotAllowed`).

---

## PHASE C — PI scoped administration (PI/PD @PROJECT + switches)

### C1 — Read own scope

```bash
GET /api/v1/org/projects/$PROJECT                 # ORG_PROJECT_READ@PROJECT
→ 200 { "id","code","name","status","headOfficeId","version",… }

GET /api/v1/org/sites/$SITE                       # ORG_SITE_READ@SITE
→ 200 { "id","projectId","code","name","status","geoFenceRadiusM",… }

GET /api/v1/departments?projectId=$PROJECT        # DEPARTMENT_READ (scoped list)
GET /api/v1/departments?siteId=$SITE
GET /api/v1/departments/$DEPT
→ 200 { "id","scopeType","scopeId","code","name","category",
        "headEmployeeId","status","version" }
```

### C2 — Delegated site create/update *(PI only — `siteCreate`/`siteUpdate`)*

```bash
POST /api/v1/org/sites                            # ORG_SITE_CREATE@PROJECT(body.projectId)
{ "projectId": "$PROJECT", "code": "S-02", "name": "Tower B Site",
  "addressLine1": "Plot 43", "city": "Pune", "state": "MH",
  "pinCode": "411002", "country": "IN",
  "geoLatitude": 18.53, "geoLongitude": 73.86, "geoFenceRadiusM": 250 }
→ 201 { "id": "$SITE2", "projectId": "$PROJECT", "status": "ACTIVE", "version": 1 }

PATCH /api/v1/org/sites/$SITE2                    # ORG_SITE_UPDATE@SITE + siteUpdate
{ "name": "Tower B — Podium", "geoFenceRadiusM": 300, "expectedVersion": 1 }
→ 200 { "id": "$SITE2", "version": 2, … }
```

PD gets `403` here — `ORG_SITE_CREATE`/`ORG_SITE_UPDATE` are not on the PD template.

### C3 — Delegated department writes *(PI only — `deptManage`)*

```bash
POST /api/v1/departments                          # DEPARTMENT_CONFIGURE@declared scope
{ "scopeType": "PROJECT", "scopeId": "$PROJECT",
  "code": "QC", "name": "Quality Control", "category": "QUALITY" }
→ 200 { "id": "d2-…", "scopeType": "PROJECT", "scopeId": "$PROJECT", … }

PATCH /api/v1/departments/d2-…
{ "name": "Quality & Lab", "expectedVersion": 1 }
POST /api/v1/departments/d2-…/status
{ "to": "INACTIVE", "expectedVersion": 2 }
→ 200 { … }
```

### C4 — Onboard a worker into a department (`employeeOnboard`)

```bash
POST /api/v1/departments/$DEPT/onboard            # EMPLOYEE_ONBOARD@dept scope
{ "employeeCode": "WK-0142",
  "displayName": "Suresh Kumar",
  "engagementType": "DAILY_WAGE",
  "designation": "Mason", "tradeCategory": "CIVIL",
  "joiningDate": "2026-01-15",
  "contactPhone": "+91-9800000042",
  "emergencyContactName": "Meena Kumar",
  "emergencyContactPhone": "+91-9800000043" }
```

```json
→ 200
{ "employee": { "id": "wk-…", "employeeCode": "WK-0142",
                "displayName": "Suresh Kumar", "engagementType": "DAILY_WAGE",
                "status": "ACTIVE", "principalId": null },
  "membership": { "membershipId": "m-…", "departmentId": "e8c1a2f5-…",
                  "isPrimary": true, "startedAt": "…", "endedAt": null },
  "documentsLinked": 0 }
```

Creates **profile + primary membership only** — no login/invite/role/operation.
Optional `"documents": [{ "documentId","documentType","title", … }]` links
existing `AVAILABLE` company documents (max 20).

### C5 — Membership placement (`placement`)

```bash
POST /api/v1/departments/$DEPT/members            # EMPLOYEE_MEMBER_MANAGE@dept scope
{ "employeeId": "$OTHER_EMP", "isPrimary": true }
→ 200 { "membershipId","employeeId","departmentId","isPrimary","startedAt",
        "endedAt": null, "employee": {…}, "department": {…} }

PATCH /api/v1/departments/$DEPT/members/$MID
{ "isPrimary": false, "expectedVersion": 1 }
→ 200 { … }

POST /api/v1/departments/$DEPT/members/$MID/transfer
{ "toDepartmentId": "d2-…", "expectedVersion": 1, "isPrimary": true }
→ 200 { …new membership… }        # atomic — ends source row + creates target row

POST /api/v1/departments/$DEPT/members/$MID/end
{ "expectedVersion": 1 }
→ 200 { …, "endedAt": "2026-02-02T…" }   # history preserved, never deleted
```

`409 PRIMARY_CONFLICT` if the employee already holds an active primary;
`409 ACTIVE_MEMBERSHIP_EXISTS` on duplicate active membership.

### C6 — Workforce lifecycle (`memberSuspend` / `memberExit`)

Same three verbs at **site** and **project** scope; scope comes from the path.

```bash
# SUSPEND — needs memberSuspend. Ends ACTIVE in-scope memberships (SUSPENDED),
# clears worker as dept head, blocks punch-in at this scope. Login untouched.
POST /api/v1/org/sites/$SITE/workforce/wk-…/suspend
{ "reason": "Safety violation — pending inquiry",
  "expectedReturnDate": "2026-03-01" }
```

```json
→ 200
{ "employeeId": "wk-…", "action": "SUSPEND",
  "scopeType": "SITE", "scopeId": "a4f2d8b1-…",
  "ended": [ { "membershipId": "m-…", "departmentId": "e8c1a2f5-…",
               "wasPrimary": true } ],
  "restored": [], "headsCleared": [ "e8c1a2f5-…" ],
  "suspendUntil": "2026-03-01", "exitMarkerId": null }
```

```bash
# REINSTATE — needs memberSuspend. Recreates SUSPENDED memberships
# (new rows supersede old; never reopens ended rows). All-or-nothing.
POST /api/v1/org/sites/$SITE/workforce/wk-…/reinstate
{ "note": "Cleared after inquiry" }
→ 200 { "employeeId": "wk-…", "action": "REINSTATE", …,
        "restored": [ { "membershipId": "m2-…", "departmentId": "e8c1a2f5-…",
                        "isPrimary": true } ],
        "ended": [], "headsCleared": [], "suspendUntil": null }

# EXIT — needs memberExit. Permanent for this scope: SiteWorkforceExit marker
# blocks all future reinstatement/membership at this site/project.
POST /api/v1/org/sites/$SITE/workforce/wk-…/exit
{ "reason": "Contract completed" }
→ 200 { "employeeId": "wk-…", "action": "EXIT", …,
        "exitMarkerId": "x-…" }
```

Project variants: `POST /org/projects/$PROJECT/workforce/wk-…/{suspend,reinstate,exit}` —
they touch every in-scope department (project dept + child-site depts).

### C7 — Rosters & member detail

```bash
GET /api/v1/org/projects/$PROJECT/team?status=ACTIVE&limit=50   # incl. child-site depts
GET /api/v1/org/sites/$SITE/team?q=kumar                        # this site only
→ 200 { "items": [ { "id","employeeCode","displayName","engagementType",
                     "designation","tradeCategory","status",
                     "memberships":[{ "membershipId","departmentId","isPrimary",
                       "startedAt","endedAt","department":{…} }] } ],
        "nextCursor": null }

GET /api/v1/departments/$DEPT/members?includeEnded=false
→ 200 { "items": [ { "membershipId","employeeId","departmentId","isPrimary",
                     "startedAt","endedAt","department":{…},"employee":{…} } ],
        "nextCursor": null }

GET /api/v1/departments/$DEPT/members/$MID      # contact fields ONLY here
→ 200 { "membershipId",…,"employee": { "id","employeeCode","displayName",
          "contactPhone","contactEmail",
          "emergencyContactName","emergencyContactPhone", … } }
```

### C8 — Documents (register + attach)

```bash
GET  /api/v1/org/projects/$PROJECT/documents      # DOCUMENT_READ@PROJECT
GET  /api/v1/org/sites/$SITE/documents            # DOCUMENT_READ@SITE
POST /api/v1/org/sites/$SITE/documents            # DOCUMENT_LINK@SITE
{ "documentId": "doc-…", "documentType": "SITE_PLAN",
  "title": "Tower A layout v2" }
→ 201 { "id": "lnk-…", "status": "ACTIVE", … }
```

### C9 — Scoped activity feed (their audit window)

```bash
GET /api/v1/org/projects/$PROJECT/activity?limit=50&action=MEMBERSHIP_SUSPENDED
GET /api/v1/org/sites/$SITE/activity?entityType=DEPARTMENT_MEMBERSHIP&from=2026-02-01
```

```json
→ 200
{ "items": [
    { "id": "…", "eventKey": "…", "action": "MEMBERSHIP_SUSPENDED",
      "entityType": "DEPARTMENT_MEMBERSHIP", "entityId": "m-…",
      "actorId": "…", "actorType": "USER",
      "actor": { "id": "…", "type": "USER",
                 "displayName": "Ramesh Yadav", "employeeCode": "PI-01" },
      "occurredAt": "2026-02-02T11:00:00.000Z",
      "statusBefore": "ACTIVE", "statusAfter": "SUSPENDED",
      "changedFields": { "suspendUntil": { "before": null, "after": "2026-03-01" } },
      "scope": { "projectId": "7d3a1c44-…", "siteId": "a4f2d8b1-…" } } ],
  "nextCursor": null }
```

Project feed includes child-site events; free text (`reason`/`note`) is
redacted — only structured fields survive.

---

## PHASE C.5 — Operations coverage (the capability layer)

Separate from *permission keys* (which gate routes), **operations** are the
business-work catalogue (`OperationCatalogueEntry`, 300+ keys) — they describe
*what work types* an employee can perform. Three sources combine into the
effective set resolved by `GET /auth/me` and `GET /employees/:id/operations`:

| Source | How it lands |
|---|---|
| `DEPARTMENT` | Ops **enabled** on an ACTIVE department flow to every open member. |
| `DIRECT` | Per-employee grant (`POST /employees/:id/operations`) — must be backed by an enabled member department. INACTIVE/REVOKED rows *subtract* coverage. |
| `ROLE` | PD/PI `@PROJECT` assignments cover every `leadershipInheritable`, non-`sensitive` op enabled on departments under their project (incl. child sites). Derived live — grant = gain, revoke = loss, no rows written. |

### Auto-enable on department create

New `PROJECT`/`SITE`-scoped departments start with the **full reviewed
inheritable set enabled** (~200 keys: site admin, work plans/tasks/milestones,
workforce, attendance/leave, wallet/expense requests, procurement, quality,
safety, materials, reports). `COMPANY`-scope departments stay manual.

```bash
# Browse the catalogue — returns every entry (OPERATION_READ)
GET /api/v1/operations
→ 200 { "items": [ { "key": "TASK_CREATE", "domain": "WORK_EXECUTION",
                     "name": "Task Create", "sensitive": false,
                     "leadershipInheritable": true,
                     "appliesTo": ["COMPANY","HEAD_OFFICE","PROJECT","SITE"] } ] }

# See what's enabled on a department (DEPARTMENT_READ)
GET /api/v1/departments/$DEPT/operations
→ 200 { "items": [ { "operationKey": "SITE_ATTENDANCE_VIEW", "status": "ACTIVE" }, … ] }

# Admin adjusts per department (OPERATION_DEPARTMENT_ASSIGN@COMPANY)
POST   /api/v1/departments/$DEPT/operations   { "operationKey": "SITE_CLOSE" }
DELETE /api/v1/departments/$DEPT/operations/SITE_LOG_CREATE

# Admin sees an employee's effective ops incl. source tags (EMPLOYEE_READ@COMPANY)
GET /api/v1/employees/$PI_EMP/operations
→ 200 [ { "operationKey": "TASK_CREATE", "source": "ROLE",
          "status": "ACTIVE", "operation": { "domain": "WORK_EXECUTION", … } },
        { "operationKey": "LABOUR_ATTENDANCE_MARK", "source": "DEPARTMENT", … } ]

# Per-employee grant/subtract (OPERATION_EMPLOYEE_ASSIGN@COMPANY)
POST   /api/v1/employees/$PI_EMP/operations            { "operationKey": "…" }
POST   /api/v1/employees/$PI_EMP/operations/SITE_AUDIT_VIEW/status  { "status": "INACTIVE" }
```

Rules that bite:

- Ops are **coverage, not permission** — a member can "cover" `SITE_LEAVE_APPROVE`
  but the route still needs `LEAVE_APPROVE` + scope + delegation to act.
- Coverage flows only through **ACTIVE** departments — a DRAFT department's
  enabled ops derive nothing until the dept is activated.
- `sensitive` ops (payroll/payment/finance-restricted) never role-derive and
  are never auto-seeded.
- Per-employee `INACTIVE`/`REVOKED` overrides subtract coverage everywhere —
  `/auth/me`, effective checks, scope inspection.

---

## PHASE D — PD vs PI (what differs)

| Capability | PI | PD |
|---|---|---|
| All scoped reads (project/site/dept/team/members/documents/feed) | ✓ | ✓ |
| Contact fields (`EMPLOYEE_CONTACT_READ`) | ✓ | ✓ |
| `siteCreate`/`siteUpdate` (`ORG_SITE_*`) | ✓ (switch) | ✗ key not on template |
| `deptManage` (`DEPARTMENT_CONFIGURE`) | ✓ (switch) | ✗ key not on template |
| `placement` (`EMPLOYEE_MEMBER_MANAGE`) | ✓ (switch) | ✓ (switch) |
| `employeeOnboard` | ✓ (switch) | ✓ (switch) |
| `memberSuspend`/`memberExit` lifecycle | ✓ (switch) | ✓ (switch) |
| `ATTENDANCE_RECORD`/`ATTENDANCE_MANAGE` | ✓ keys exist — scoped routes pending | ✗ (has `ATTENDANCE_READ` only) |
| `LEAVE_APPLY` on template | ✓ | ✗ (own leave needs `EMPLOYEE`@COMPANY or similar) |
| `COMPLIANCE_READ` | ✗ | ✓ |

Grant: same `POST /employees/:id/assignments` call, `"roleKey": "PROJECT_DIRECTOR"`.

---

## Appendix — errors you'll meet

```json
{ "statusCode": 403, "code": "DELEGATION_DISABLED", "message": "…" }
```

| Code | When |
|---|---|
| `ACCESS_DENIED` (403) | Right key, wrong scope — or key missing entirely |
| `DELEGATION_DISABLED` (403) | Scoped holder + the company switch is off |
| `VERSION_CONFLICT` (409) | Stale `expectedVersion` |
| `UNKNOWN_FIELD` (422) | Extra key in a security-sensitive body |
| `PRIMARY_CONFLICT` / `ACTIVE_MEMBERSHIP_EXISTS` (409) | Membership invariants |
| `WORKFORCE_NOT_ACTIVE` / `NOTHING_TO_REINSTATE` / `ALREADY_EXITED` (409) | Lifecycle preconditions |
| `EMPLOYEE_NOT_LINKED` (409) | Grant on a profile-only employee (no principal) |
| `EMPLOYEE_NOT_ACTIVE` (409) | Lifecycle on inactive employee |
| `CLAIM_INVALID` (401) | Bad/expired/wrong-purpose claim token |
| `ACCOUNT_ALREADY_CLAIMED` (409) | Invite resend on an activated account |
| `GEOFENCE_BREACH` (422) | Punch outside site radius when policy `geofenceStrict` — otherwise session flagged, not rejected |
| `COMPANY_REQUIRED` (401) | Missing `x-company-id` |
| `429` | Rate limit — login/claim endpoints |

## Still not possible (designed, not bugs)

- Scoped worker **invite** — `/employees/:id/invite` is `EMPLOYEE_INVITE`@COMPANY only; PI/PD-scoped invite (`memberInvite` flag) is the pending Slice C milestone.
- Scoped attendance **routes** — `/attendance/*` gates at company scope today; the PI `ATTENDANCE_*` keys exist for the pending scoped-attendance slice.
- `/leave/requests/:id/review` for own project team — `LEAVE_APPROVE`@COMPANY route gate; scoped leave approval is pending.
- `/finance/*`, `/audit-logs` (company feed), `/platform/*`, company/HO/project lifecycle — admin-only by design.
