# Sarjan Construction ERP — API Implementation Flow

Complete step-by-step guide: **Platform Super Admin → Company Admin → Head Office → Departments → Projects → Sites → Employees → Memberships → Roles → Operations**.

All routes are prefixed with `/api/v1`. Swagger UI is available at `/docs` when `SWAGGER_UI=true` (dev only).

## Quick Reference — Access Patterns

| Pattern                          | `Authorization` header | `x-company-id` header | Permission check                    |
| -------------------------------- | ---------------------- | --------------------- | ----------------------------------- |
| **auth** (login, claim)          | No                     | No                    | No                                  |
| **platform** (super admin)       | Bearer                 | Ignored               | `PLATFORM_*` keys, platform company |
| **tenant** (org/dept/employee/…) | Bearer                 | **Required**          | Role→permission in company scope    |
| **health**                       | No                     | No                    | No                                  |

Every mutating tenant route also enforces optimistic concurrency (`expectedVersion`) and writes an audit record.

---

## Step 0 — Health check

```bash
GET /api/v1/health          # liveness — always 'ok'
GET /api/v1/ready           # readiness — checks PostgreSQL + Redis
```

---

## Step 1 — Platform Super Admin creates a company

Platform operator logs in first (seeded platform admin), then creates a tenant company. `x-company-id` is **not** sent on platform routes — the platform company is resolved server-side.

```bash
POST /api/v1/auth/login
{ "loginId": "platform-admin@imaker.tech", "password": "…" }
→ { "accessToken": "…", "refreshToken": "…" }
```

```bash
POST /api/v1/platform/companies
Authorization: Bearer <platform-token>

{
  "companyCode": "SARJAN",
  "companyName": "Sarjan Constructions Pvt Ltd",
  "adminLoginId": "admin@sarjan.com",
  "adminDisplayName": "Rakesh Sharma",

  // optional company profile (all optional)
  "legalName": "Sarjan Constructions Private Limited",
  "entityType": "PRIVATE_LIMITED",
  "pan": "AAACS1234A",
  "cin": "U45201DL2020PTC123456",
  "contactEmail": "accounts@sarjan.com",
  "contactPhone": "+91-9876543210"
  // …regAddressLine1, regCity, regStateUt, regPin, etc.
}
→ 200 {
    "companyId": "<uuid>",
    "claimCode": "<raw-claim-code>",      // shown ONCE — save it
    "claimExpiresAt": "…"
  }
```

The platform admin shares `claimCode` with the company admin (out of band — email/SMS).

Other platform routes:

```bash
GET  /api/v1/platform/companies                              # list all tenants
POST /api/v1/platform/companies/:companyId/claim-token       # reissue claim code
     { "adminPrincipalId": "<uuid>" }
```

---

## Step 2 — Company Admin claims the account (unauthenticated)

Two options:

### Option A — Simple claim (set password only)

```bash
GET /api/v1/auth/claim/verify?token=<claim-code>   # check code is still valid
→ { "valid": true, "companyName": "Sarjan…", "loginId": "admin@sarjan.com" }

POST /api/v1/auth/claim
{ "token": "<claim-code>", "password": "SecurePass123!" }
→ { "ok": true }
```

### Option B — Full onboarding (recommended, one-shot)

Sets password **and** creates the company profile + first Head Office in one transaction:

```bash
POST /api/v1/auth/claim/onboard
{
  "token": "<claim-code>",
  "password": "SecurePass123!",
  "loginId": "admin@sarjan.com",          // optional — defaults to adminLoginId
  "displayName": "Rakesh Sharma",          // optional
  "company": {                             // optional profile fields
    "legalName": "Sarjan Constructions Private Limited",
    "entityType": "PRIVATE_LIMITED",
    "pan": "AAACS1234A"
  },
  "headOffice": {                          // optional — first HO, forced primary
    "code": "HO-001",
    "name": "Delhi Head Office",
    "addressLine1": "Plot 42, Sector 44",
    "city": "Gurugram", "state": "Haryana", "pinCode": "122003",
    "contactEmail": "ho@sarjan.com"
  }
}
→ { "principalId": "<uuid>", "companyId": "<uuid>" }
```

### Step 2b — Admin logs in

```bash
POST /api/v1/auth/login
{ "loginId": "admin@sarjan.com", "password": "SecurePass123!" }
→ {
    "accessToken": "<jwt>",
    "refreshToken": "<refresh>",
    "user": {
      "id": "…", "loginId": "admin@sarjan.com",
      "companyId": "…", "companyCode": "SARJAN",
      "role": "TENANT_OWNER", "roles": ["TENANT_OWNER"],
      "operations": []                    // effective ops — empty until assigned
    }
  }
```

**From here on, every request carries:**

```
Authorization: Bearer <accessToken>
x-company-id: <companyId>
```

Other session routes:

```bash
POST /api/v1/auth/refresh   { "refreshToken": "…" }          # rotate tokens
POST /api/v1/auth/logout    # invalidates the session
GET  /api/v1/auth/me        # cached profile + live operations[]: roles, permissions,
                            # dept memberships, employeeId. operations[] is resolved
                            # fresh each call — admin op toggles reflect immediately.
```

---

## Step 3 — Organization setup (Company Admin / Owner)

Prerequisite order matters: **Head Office → Departments → Projects → Sites**.

### 3a — Head Office

```bash
POST /api/v1/org/head-offices          # ORG_HEAD_OFFICE_CREATE
{
  "code": "HO-001",
  "name": "Delhi Head Office",
  "addressLine1": "Plot 42, Sector 44",
  "city": "Gurugram",
  "state": "Haryana",
  "pinCode": "122003",
  "contactName": "Office Manager",
  "contactPhone": "+91-9810012345"
}
→ { "id": "<ho-id>", "isPrimary": true, "status": "ACTIVE", "version": 1 }
```

Invariant: **exactly one primary HO per company**. First HO is forced primary; promoting another HO demotes the previous primary in the same transaction.

```bash
GET   /api/v1/org/head-offices?status=ACTIVE          # ORG_HEAD_OFFICE_READ
PATCH /api/v1/org/head-offices/:id
      { "name": "…", "expectedVersion": 1 }           # ORG_HEAD_OFFICE_UPDATE
POST  /api/v1/org/head-offices/:id/status
      { "to": "SUSPENDED", "expectedVersion": 1 }     # ORG_HEAD_OFFICE_STATUS
```

### 3b — Departments

A department = organizational container + work boundary. `scopeType` + `scopeId` place it in the org tree; `category` is a controlled enum.

```bash
POST /api/v1/departments               # DEPARTMENT_CONFIGURE
{
  "scopeType": "COMPANY",              // COMPANY | PROJECT | SITE
  "code": "FIN",
  "name": "Finance Department",
  "category": "FINANCE",               // FINANCE | ADMINISTRATION | HR | PROCUREMENT |
                                       // STORE | MACHINERY | SAFETY | QUALITY |
                                       // SITE_ENGINEERING | KITCHEN | OPERATIONS | CUSTOM
  "baseHeadOfficeId": "<ho-id>"        // physical location — NOT a permission scope
}
→ { "id": "<dept-id>", "capabilityKey": "DEPT_FINANCE", "status": "DRAFT" }
```

Rules:

- `CUSTOM` category requires `categoryLabel`.
- `PROJECT`/`SITE` scope requires `scopeId` (`<project-id>` / `<site-id>`); `COMPANY` scope omits it.
- Codes are unique **per scope** — two projects can each have a `SITE_ENG` dept.
- New departments start as `DRAFT` — activate them before use.

```bash
POST  /api/v1/departments/:id/status
      { "to": "ACTIVE", "expectedVersion": 1 }
GET   /api/v1/departments?projectId=<id>&siteId=<id>   # list/filter
PATCH /api/v1/departments/:id                        # name, headEmployeeId, base HO
```

**Project prerequisite:** a project can only be created once the company has **active company-wide `FINANCE` and `ADMINISTRATION` departments** — so create and activate those two first.

### 3c — Projects

```bash
POST /api/v1/org/projects              # ORG_PROJECT_CREATE
{
  "code": "P-SKYWALK",
  "name": "Skywalk Residency",
  "projectType": "RESIDENTIAL",        // RESIDENTIAL | COMMERCIAL | INDUSTRIAL |
                                       // INFRASTRUCTURE | OTHER
  "clientName": "ABC Developers",
  "contractRef": "CTR-2026-0042",
  "locationCity": "Noida",
  "locationState": "Uttar Pradesh",
  "locationPin": "201301",
  "timezone": "Asia/Kolkata",          // required
  "startDate": "2026-12-01",
  "endDate": "2027-11-30"
}
→ { "id": "<project-id>", "headOfficeId": "<primary-ho-id>", "status": "ACTIVE" }
```

`headOfficeId` is **derived server-side** from the active primary HO — never sent by the client. Changing the primary HO while projects are attached is blocked.

```bash
GET   /api/v1/org/projects?status=ACTIVE&headOfficeId=<ho-id>
PATCH /api/v1/org/projects/:id         { "name": "…", "expectedVersion": 1 }
POST  /api/v1/org/projects/:id/status  { "to": "COMPLETED", "expectedVersion": 1 }
```

### 3d — Sites

```bash
POST /api/v1/org/sites                 # ORG_SITE_CREATE
{
  "projectId": "<project-id>",
  "code": "S-BLOCK-A",
  "name": "Block A Construction Site",
  "addressLine1": "Plot 12, Sector 150",
  "city": "Noida", "state": "Uttar Pradesh", "pinCode": "201301",
  "geoLatitude": 28.3957,
  "geoLongitude": 77.3219,
  "geoFenceRadiusM": 250               // 10–5000 m
}
→ { "id": "<site-id>", "timezone": "Asia/Kolkata" }   // inherits project timezone if omitted
```

Both coordinates must be present or absent together (422 otherwise).

```bash
GET   /api/v1/org/sites?projectId=<id>
PATCH /api/v1/org/sites/:id
POST  /api/v1/org/sites/:id/status     { "to": "SUSPENDED", "expectedVersion": 1 }
```

### 3e — Company profile

```bash
GET   /api/v1/org/company              # ORG_COMPANY_READ
PATCH /api/v1/org/company              # ORG_COMPANY_UPDATE
      { "legalName": "…", "pan": "…", "regAddressLine1": "…", "expectedVersion": 1 }
```

---

## Step 4 — Employees + Department Memberships

### 4a — Create employee profile (no login account yet)

```bash
POST /api/v1/employees                 # EMPLOYEE_MANAGE
{
  "employeeCode": "E-100",
  "displayName": "Ramesh Kumar",
  "engagementType": "DIRECT_EMPLOYEE", // DIRECT_EMPLOYEE | CONTRACTOR_WORKER | DAILY_WAGE |
                                     // APPRENTICE | CONSULTANT | OTHER
  "designation": "Cashier",
  "tradeCategory": "FINANCE_STAFF",
  "joiningDate": "2026-11-01",
  "contactPhone": "+91-9998877665",
  "contactEmail": "ramesh@sarjan.com",
  "emergencyContactName": "Sunita Kumar",     // both or neither
  "emergencyContactPhone": "+91-9998877666"
}
→ { "id": "<emp-id>", "status": "ACTIVE", "version": 1 }
```

Employee profile ≠ login account — the profile exists first; the account is invited separately.

```bash
GET   /api/v1/employees?status=ACTIVE&limit=50      # EMPLOYEE_READ
GET   /api/v1/employees/:id
PATCH /api/v1/employees/:id            { "designation": "Sr Cashier", "expectedVersion": 1 }
POST  /api/v1/employees/:id/status     { "to": "INACTIVE", "expectedVersion": 1 }
      # deactivation ends all memberships + revokes roles atomically
```

### 4b — Department membership (placement only, grants nothing)

```bash
POST /api/v1/employees/:id/memberships # EMPLOYEE_MANAGE
{
  "departmentId": "<dept-id>",
  "isPrimary": true                    // one active primary membership per employee
}
→ { "id": "<membership-id>", "startedAt": "…", "endedAt": null }
```

```bash
GET   /api/v1/employees/:id/memberships
PATCH /api/v1/employees/:id/memberships/:membershipId
      { "isPrimary": true, "expectedVersion": 1 }      // demotes previous primary atomically
POST  /api/v1/employees/:id/memberships/:membershipId/end
      { "expectedVersion": 1 }                         // endedAt = server time; row kept as history
```

### 4c — Invite login + assign roles

```bash
POST /api/v1/employees/:id/invite      # EMPLOYEE_INVITE
{ "loginId": "ramesh@sarjan.com", "loginIdType": "EMAIL" }
→ { "claimCode": "<raw>", "claimExpiresAt": "…" }       # share with employee

POST /api/v1/employees/:id/invite/resend
POST /api/v1/auth/claim                # employee sets password (unauthenticated)
{ "token": "<claim-code>", "password": "…" }

POST /api/v1/employees/:id/assignments          # ACCESS_ROLE_ASSIGN
{
  "roleKey": "HO_ADMIN",               // assignable template key — not the display name
  "scopeType": "HEAD_OFFICE",          // COMPANY | HEAD_OFFICE | PROJECT | SITE
  "scopeId": "<ho-uuid>"               // required for HEAD_OFFICE/PROJECT/SITE; omit for COMPANY
}
GET    /api/v1/employees/:id/assignments          # ROLE_ASSIGNMENT_READ
DELETE /api/v1/employees/:id/assignments/:assignmentId   # ACCESS_ROLE_REVOKE
```

Assignable template keys: `COMPANY_OWNER`@COMPANY, `HO_ADMIN`@HEAD_OFFICE (primary HO only), `PROJECT_MANAGER`@PROJECT, `SITE_ENGINEER`@SITE, `PROJECT_DIRECTOR`@PROJECT, `PROJECT_INCHARGE`@PROJECT, `DEPT_HEAD`@COMPANY, `EMPLOYEE`@COMPANY.

**Project leadership (PD/PI):**

```bash
POST /api/v1/employees/:id/assignments
{
  "roleKey": "PROJECT_DIRECTOR",       // or "PROJECT_INCHARGE"
  "scopeType": "PROJECT",
  "scopeId": "<project-uuid>"          // a real ACTIVE project in this company
}
```

Rules enforced by the service:

- Each project has at most **one active PD and one active PI**; granting a second holder replaces (revokes) the incumbent, audited as `ROLE_ASSIGNMENT_REPLACED`.
- One employee may hold PD/PI on **multiple projects**.
- Self-grant is denied; cross-company project/employee and inactive project/employee are rejected.
- PD/PI authority covers the project **and its sites** (downward scope inheritance) — never other projects or Head Office scope.
- PD/PI automatically see every non-sensitive operation enabled on departments inside their assigned projects/sites — no per-employee grant needed. Sensitive ops (payroll, bank, company-wide finance) always require an explicit grant.

**Membership vs role:** membership = "sits in Finance" (organizational, grants nothing). Role assignment = "can call `ORG_PROJECT_CREATE` at company scope" (API permission). Both exist independently.

---

## Step 5 — Operations (the work layer)

Two-level assignment: admin **enables** ops on the department, then **assigns a subset** to each employee.

### 5a — Browse the catalogue

```bash
GET /api/v1/operations                 # OPERATION_READ
→ [
    { "key": "EMPLOYEE_PAYROLL_PREPARE", "domain": "PAYROLL",
      "name": "Prepare payroll", "description": "…", "sensitive": false },
    { "key": "SALARY_PAYMENT_APPROVE", "domain": "PAYROLL", … },
    // 36 Finance operations: employee-records, payroll, billing,
    // quotations, wallet/petty-cash, reports
  ]
```

### 5b — Enable ops on the Finance department

```bash
POST /api/v1/departments/:deptId/operations     # OPERATION_CONFIGURE
{ "operationKey": "EMPLOYEE_PAYROLL_PREPARE" }  → { "enabled": true }

# repeat for every op the department supports — e.g.:
# EMPLOYEE_PAYROLL_PREPARE, PAYROLL_REVIEW, SALARY_PAYMENT_APPROVE,
# SALARY_PAYMENT_PROCESS, PAYROLL_REPORT_GENERATE, CLIENT_BILL_DRAFT,
# CLIENT_BILL_REVIEW, CLIENT_BILL_APPROVE, PETTY_CASH_REQUEST_REVIEW,
# PETTY_CASH_REQUEST_APPROVE, PROJECT_WALLET_CREDIT_PROCESS, …

GET    /api/v1/departments/:deptId/operations   # DEPARTMENT_READ
DELETE /api/v1/departments/:deptId/operations/:key   # OPERATION_CONFIGURE
```

### 5c — Assign a subset to each employee

Cashier and approver sit in the **same** Finance department but get different slices:

```bash
# Cashier — prepare only
POST /api/v1/employees/<cashier-id>/operations    # OPERATION_EMPLOYEE_ASSIGN
{ "operationKey": "EMPLOYEE_PAYROLL_PREPARE" }    → { "assigned": true }
{ "operationKey": "PETTY_CASH_REQUEST_REVIEW" }   → { "assigned": true }

# Approver — review/approve only
POST /api/v1/employees/<approver-id>/operations
{ "operationKey": "PAYROLL_REVIEW" }
{ "operationKey": "SALARY_PAYMENT_APPROVE" }
{ "operationKey": "PETTY_CASH_REQUEST_APPROVE" }

GET    /api/v1/employees/:id/operations         # EMPLOYEE_READ — effective ops
DELETE /api/v1/employees/:id/operations/:key    # OPERATION_EMPLOYEE_ASSIGN
```

**Validation:** assignment is rejected (422) unless the employee is an **active member** of a department where that operation is **already enabled**. Ending a membership instantly removes the dept's ops from the employee's effective set (the grants stay stored but become inert).

### 5d — Employee logs in → gets their operations

```bash
POST /api/v1/auth/login
→ { "user": { …,
      "operations": ["EMPLOYEE_PAYROLL_PREPARE", "PETTY_CASH_REQUEST_REVIEW"] } }
```

`operations` = employee grants ∩ ops enabled on departments where they hold active membership — computed at login time.

---

## Step 6 — Supporting flows

### Compliance records

```bash
POST /api/v1/compliance-records        # COMPLIANCE_MANAGE
{
  "category": "GST",                   // PAN | TAN | GST | EPF | ESI | LABOUR_LICENSE |
                                       // CLRA | PROFESSIONAL_TAX | INSURANCE | OTHER
  "identifier": "06AAACS1234A1Z5",
  "jurisdiction": "Haryana",
  "issuingAuthority": "GST Council",
  "issueDate": "2020-04-01"
}
GET   /api/v1/compliance-records
PATCH /api/v1/compliance-records/:id        { "expiryDate": "…", "expectedVersion": 1 }
POST  /api/v1/compliance-records/:id/status { "to": "EXPIRED", "expectedVersion": 1 }
POST  /api/v1/compliance-records/:id/verify { "documentId": "<doc>", "expectedVersion": 1 }
```

### Notifications

```bash
POST /api/v1/notifications/ticket      # get a 30s WS ticket
     { "companyId": "<company-id>" }   → { "ticket": "<jwt>" }

GET  /api/v1/notifications?status=UNREAD
POST /api/v1/notifications/:id/read

# WebSocket stream (browser):
# GET /api/v1/notifications/stream  +  Sec-WebSocket-Protocol: sarjan-ticket.<ticket>
```

---

## End-to-End Cheat Sheet

```
PLATFORM ADMIN                          COMPANY ADMIN (tenant)
─────────────                           ─────────────────────
POST /auth/login ─┐
POST /platform/companies ──► claimCode  POST /auth/claim/onboard  (unauthenticated)
                                        POST /auth/login ──► accessToken + x-company-id
                                        POST /org/head-offices            # 3a
                                        POST /departments (FIN) ──► status ACTIVE
                                        POST /departments (ADMIN) ──► status ACTIVE
                                        POST /org/projects      # needs FIN+ADMIN active
                                        POST /org/sites
                                        POST /employees         # profile
                                        POST /employees/:id/memberships   # place in dept
                                        POST /departments/:id/operations  # enable ops
                                        POST /employees/:id/operations    # assign subset
                                        POST /employees/:id/invite ──► claimCode
                                        POST /employees/:id/assignments   # role → API perms
                                        ──► employee: POST /auth/claim ──► /auth/login
                                            gets role + role scope + effective operations
```

## Common Errors

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 400  | Invalid payload (TypeBox schema)                                          |
| 401  | Missing/expired token, or missing `x-company-id`                          |
| 403  | Permission key not held in the resolved scope                             |
| 404  | Entity not found (or cross-tenant leak → hidden as 404)                   |
| 409  | Duplicate unique key, or `expectedVersion` mismatch                       |
| 422  | Business-rule violation (inactive dept, op not enabled, orphan coords, …) |
