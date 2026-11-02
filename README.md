# Sarjan Construction Backend

Modular monolith backend for a multi-company, multi-project, multi-site construction ERP.

> **Contributors:** read [`rule.md`](./rule.md) before changing code. It is the engineering contract for this repository.

## Stack

- Node.js 24 LTS, Fastify 5, TypeScript (strict)
- PostgreSQL + Prisma 7 (authoritative store, `pg` + `PrismaPg` adapter)
- Redis + BullMQ (outbox publish + notification delivery)
- @node-rs/argon2 (passwords) · @fastify/jwt (HS256) · @fastify/websocket (realtime)
- Vitest, ESLint, Prettier, Docker

## Getting started

```bash
cp .env.example .env        # fill in local values (placeholders match docker-compose)
npm install
npm run db:generate         # generate Prisma client (no DB connection needed)
docker-compose up -d        # start local PostgreSQL + Redis (compose v2 CLI)
npx prisma migrate deploy   # apply migrations
npm run dev                 # start dev server with watch mode
```

Health endpoints:

- `GET /api/v1/health` — liveness (no external dependencies)
- `GET /api/v1/ready` — readiness (checks PostgreSQL + Redis connectivity)

## First-company setup

```bash
# One-time bootstrap — credentials via env only, never args, never logged
DATABASE_URL=... BOOTSTRAP_COMPANY_CODE=ACME BOOTSTRAP_COMPANY_NAME="Acme" \
BOOTSTRAP_OWNER_LOGIN_ID=owner@acme.test BOOTSTRAP_OWNER_PASSWORD=... \
npm run db:bootstrap        # → Company + primary HO + Finance/Admin depts + owner

npm run db:reconcile        # idempotent: adds EMPLOYEE_* keys to COMPANY_OWNER roles
npm run db:seed             # permission catalogue upsert
```

## API

All routes are under `/api/v1`. Auth: `Authorization: Bearer <accessToken>` + `x-company-id: <uuid>` headers. Mutations require `expectedVersion` for optimistic concurrency. Errors: `{ "error": { "code", "message", "requestId" } }` — `401` no token · `403` no permission · `404` cross-company/unknown · `409` duplicate code / stale version · `422` validation.

### Auth — `/api/v1/auth`

```
POST /auth/login        { "loginId": "owner@acme.test", "password": "..." }
                      → { accessToken, refreshToken, tokenType: "Bearer" }
POST /auth/refresh    { "refreshToken": "..." }  → rotated pair
POST /auth/logout     (Bearer)
```

### Organization — `/api/v1/org` (perms `ORG_*`)

```
GET/PATCH  /org/company                        ORG_COMPANY_READ / _UPDATE
POST/GET   /org/head-offices                   ORG_HEAD_OFFICE_CREATE / _READ
PATCH      /org/head-offices/:id               ORG_HEAD_OFFICE_UPDATE  (isPrimary promote-demotion in one tx)
POST       /org/head-offices/:id/status        ORG_HEAD_OFFICE_STATUS  (ARCHIVED rejected on primary)
POST/GET   /org/projects  {headOfficeId, code, name, timezone}         ORG_PROJECT_* (IANA timezone required)
PATCH/POST /org/projects/:id [/status]         ORG_PROJECT_UPDATE / _STATUS
POST/GET   /org/sites  {projectId, code, name, ...geo, timezone?}      ORG_SITE_*
PATCH/POST /org/sites/:id [/status]            ORG_SITE_UPDATE / _STATUS
```

### Departments — `/api/v1/departments` (perms `DEPARTMENT_*`)

```
POST /departments    {scopeType: COMPANY|PROJECT|SITE, scopeId?, code, name,
                      capabilityKey?, headEmployeeId?, baseHeadOfficeId?}
GET  /departments?status=&projectId=&siteId=
PATCH /departments/:id            {name?, capabilityKey?, headEmployeeId?,
                                   baseHeadOfficeId?, expectedVersion}
POST /departments/:id/status      {to: DRAFT|ACTIVE|SUSPENDED|ARCHIVED}
```

`baseHeadOfficeId` = physical location only (never a permission scope); head must be an ACTIVE same-company employee.

### Employees — `/api/v1/employees` (perms `EMPLOYEE_READ`, `EMPLOYEE_MANAGE`)

```
GET  /employees?status=&cursor=&limit=    → { employees: [...], nextCursor }
POST /employees    {employeeCode, displayName}   → ACTIVE profile (principalId always null)
PATCH /employees/:id         {displayName?, expectedVersion}
POST /employees/:id/status   {to: ACTIVE|INACTIVE, expectedVersion}
```

Deactivation is atomic: revokes the employee's **in-company** role assignments (global Principal untouched), clears `headEmployeeId` references with version bumps, audits `ACCESS_ROLE_REVOKED`/`DEPT_HEAD_CLEARED`/`EMPLOYEE_DEACTIVATED`. Lockout guard rejects deactivating the last active admin. Profiles ≠ login accounts — no permission flows through an employee record.

### Notifications — `/api/v1/notifications` (`NOTIFICATION_READ`)

```
GET /notifications/inbox?cursor=&limit=   → { notifications, nextCursor }
GET /notifications/stream                 (WebSocket — native: Authorization header;
                                           browser: ws-ticket via Sec-WebSocket-Protocol)
POST /notifications/ws-ticket             → { ticket } (single-use, Redis-backed)
```

Transactional outbox (`OutboxEvent` + lease/retry) delivers durable in-app notifications for workflow transitions, approval task events, and document review outcomes.

## Modules

| Module           | Responsibility                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization`   | Company, HeadOffice (one primary per company — partial unique index + promote-by-replacement), Project, Site; scope-first repos, composite same-company FKs, lifecycle state machines |
| `department`     | Departments (COMPANY/PROJECT/SITE scope; HEAD_OFFICE rejected); `baseHeadOfficeId` location vs permission scope                                                                       |
| `employee`       | Profile directory; offboarding (revoke + head-clear + audit in one tx); last-admin lockout guard                                                                                      |
| `auth`           | Argon2 passwords, `{sub,sid}` JWTs, live-session actor context, login/refresh/logout                                                                                                  |
| `access-control` | `Permission`/`Role`/`RolePermission`/`RoleAssignment` + scope-chain coverage (`COMPANY→HEAD_OFFICE→PROJECT→SITE`)                                                                     |
| `setup`          | Operator bootstrap + owner-permission reconcile (SYSTEM actor, one tx, idempotent)                                                                                                    |
| `workflow`       | Definitions/instances/transitions; transactional outbox emission                                                                                                                      |
| `approval`       | Approval tasks with conflict-safe pending uniqueness (`ApprovalTask_one_pending` partial index)                                                                                       |
| `document`       | Private storage: `UPLOADING` reservations → `QUARANTINED` → `AVAILABLE`; `DOCUMENT_REVIEW` at doc scope; sanitized attachment serving; no public URLs                                 |
| `notification`   | Durable `Notification` inbox + `OutboxEvent` lease/retry + WS realtime + browser tickets                                                                                              |
| `health`         | Liveness/readiness                                                                                                                                                                    |

## Testing

```bash
npm test            # 270+ unit/API tests — no PostgreSQL/Redis needed
npm run typecheck && npm run lint && npm run format:check && npm run build
TEST_DATABASE_URL=postgresql://test:test@localhost:55432/erp_test \
  npx vitest run test/integration   # real-PG rollback checks (disposable test DB only)
```

## Security posture

- Multi-tenant: every query scoped `(id, companyId)`; composite same-company FKs; scope columns constrained by CHECK.
- Audit: append-only `AuditLog`, same-transaction as every mutation, explicit actor (USER or SYSTEM — no invented actors).
- `npm audit` clean (Prisma 7 + Vitest 4 + scoped minimatch@11 override).
- JWTs carry only `{sub, sid}` — permissions resolved live so revocation is immediate.
