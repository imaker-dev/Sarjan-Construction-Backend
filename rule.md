# Construction ERP Backend Engineering Rules

**Audience:** Claude Code and contributors working on this repository  
**Status:** Repository-level engineering guidance  
**Stack:** Node.js LTS, Fastify, TypeScript, PostgreSQL, Prisma, Redis, BullMQ, Docker

This file is the engineering contract for Claude and every contributor working on the Construction ERP backend. Follow it before changing code. Treat the existing project and user data as authoritative; inspect the repository before proposing or applying structural changes.

## 1. Product and architecture goal

Build a secure, multi-company, multi-project, multi-site construction operations ERP. The platform must support configurable departments, operations, forms, approval paths, attendance, labour allocation, notifications, documents, audit history, reports, and communication.

The product is configuration-driven, but not an arbitrary-code platform. Administrators configure data that the backend interprets through supported field types, workflow actions, conditions, and rule operators. Never execute administrator-entered JavaScript, SQL, templates, or executable JSON Schema.

Start with a **modular monolith** using Node.js, Fastify, TypeScript, PostgreSQL, Prisma, Redis, and Docker. Keep domain boundaries clean so a high-volume or operationally independent module can be extracted into a service later. Do not begin with microservices, distributed transactions, or a generic event-sourcing rewrite.

## 2. Non-negotiable engineering rules

1. Read this file, `AGENTS.md`, package scripts, and the relevant module before editing. Respect all repository-specific instructions.
2. Treat `sources/` and synced project files as read-only reference material. Never edit, move, rename, or delete them.
3. Do not overwrite user work or perform broad refactors unrelated to the requested feature.
4. Work in small, reviewable vertical slices. A feature is not complete when only its route or database model exists.
5. Use strict TypeScript. Avoid `any`; use `unknown` at untrusted boundaries and narrow it with validation.
6. Validate every external input. Never trust tenant, project, site, department, role, owner, or approval IDs supplied by a client until authorized against the authenticated actor.
7. Keep business rules in domain services, database operations in repositories, transport concerns in routes, and cross-cutting behavior in Fastify plugins.
8. Use Prisma migrations for schema changes. Never edit the production database schema manually or use `prisma db push` as a production deployment strategy.
9. Use transactions for business actions with multiple dependent writes. Keep transactions short and never make network calls while a database transaction is open.
10. Record audit history for security-sensitive and business-significant actions. Normal users must not update or delete audit history.
11. Use Redis as a disposable cache/queue/presence layer, not as the source of truth for business records.
12. Make retries safe with idempotency keys or unique event/job identifiers where duplicate processing would cause duplicate effects.
13. Add or update focused tests for changed behavior. Do not claim tests passed unless they were run and passed.
14. Before finishing, report the files changed, behavior implemented, commands/tests actually run, and known limitations.

### Instruction priority and unresolved decisions

- Follow platform/system safety requirements and explicit project-owner instructions first, then this file, then local module conventions. Follow all applicable repository instructions such as `AGENTS.md`.
- If this file conflicts with a nested instruction file, identify the conflict and follow the most specific applicable instruction unless it conflicts with a higher-priority instruction.
- Existing code is not automatically correct. Inspect it and explain material security, data, or reliability risks before preserving or changing the pattern.
- Do not silently invent policy for approval thresholds, attendance cutoffs, overtime, retention, financial rounding, or self-approval. Ask for clarification when the missing decision materially changes security, money, safety, legal retention, or irreversible workflow behavior.
- Record significant architecture or data-contract decisions in a short ADR under `docs/decisions/` only if the repository uses ADRs or the decision merits a durable record.

## 3. Technology and runtime

- **Node.js:** use an actively supported LTS line in production; pin the major line in development, CI, and Docker. Reassess the LTS line during planned upgrades.
- **Fastify:** use typed plugins, route schemas, hooks, decorators, lifecycle hooks, and structured logging. Keep route handlers small. Register plugins in an explicit dependency order.
- **TypeScript:** enable `strict`, `noUncheckedIndexedAccess` where practical, and type-aware linting. Compile to a production `dist/` directory.
- **PostgreSQL:** authoritative store for ERP data, configuration versions, workflow history, audit records, and transactional outbox records.
- **Prisma:** schema, generated client, migrations, typed queries, and transactions. Use parameterized raw SQL only for a measured query that Prisma cannot express well; document and test it.
- **Redis:** queue backend, cache, short-lived coordination, rate-limit storage, and realtime presence. Set TTLs for transient keys and define recovery behavior if Redis is unavailable.
- **BullMQ:** preferred Redis-backed job queue for retryable background work when jobs are needed. Keep queue messages small, make handlers idempotent, and persist business truth in PostgreSQL.
- **Docker:** reproducible local development and production images. Use a non-root runtime user, health checks, secrets through environment/secret injection, and separate development/production compose settings.
- **Logging:** use Fastify's Pino-based structured logger with request IDs and correlation IDs; redact credentials, tokens, OTPs, biometric information, and sensitive personal data.
- **Tests:** unit tests for domain rules, integration tests against real PostgreSQL/Redis-compatible services, and API tests for permissions and scope boundaries.

Pin dependencies through the package manager lockfile. Do not select `latest` at build time or silently upgrade major framework/ORM versions.

## 4. Domain hierarchy and scope

The business hierarchy is:

```text
Company
  └─ Head Office
      └─ Project
          └─ Site
              └─ Department
                  └─ Operation
                      └─ Form / Workflow / Rule
                          └─ Transaction and its history
```

People and access are related to this hierarchy through explicit assignments:

```text
Employee -> Role assignment(s) -> Scope assignment(s)
Employee -> Department membership(s) -> Project/Site assignment(s)
```

Every scoped business entity must carry the minimum scope needed to authorize and query it, normally `companyId`, `projectId`, and `siteId` where applicable. Use foreign keys and database constraints to prevent invalid parent-child relationships. Do not infer a site from a display name or trust the frontend to enforce scope.

Use UUIDs or another consistent opaque ID strategy. Use UTC timestamps in storage and convert to the configured site/company timezone for display and attendance business-day calculations. Store both event time and server-recorded time when offline field submissions are supported.

## 5. Backend folder structure

Adapt this layout to the repository if a sound convention already exists; do not rename an established codebase just to match it.

```text
src/
  app.ts
  server.ts
  config/
  plugins/
    prisma.ts
    redis.ts
    authentication.ts
    request-context.ts
    authorization.ts
    rate-limit.ts
  common/
    errors/
    schemas/
    pagination/
    ids/
    time/
    logging/
  modules/
    company/
    projects/
    sites/
    identity/
    access-control/
    departments/
    operations/
    forms/
    workflows/
    rules/
    attendance/
    labour/
    documents/
    notifications/
    audit/
    inventory/
    purchase/
    machinery/
    qaqc/
    site-engineering/
    kitchen/
    finance/
    communication/
  jobs/
  infrastructure/
prisma/
  schema.prisma
  migrations/
test/
  unit/
  integration/
  api/
```

Within a module, use a small, consistent structure such as `routes.ts`, `schemas.ts`, `service.ts`, `repository.ts`, `permissions.ts`, and `events.ts`. Add `jobs/`, `workers/`, `scripts/`, `docs/`, `tests/workflows/`, or `tests/fixtures/` only where the project needs them. Do not add empty files or layers that merely forward calls without enforcing a boundary or removing duplication.

Responsibilities:

- Routes map HTTP requests to commands/queries, apply schemas and authentication hooks, then return response DTOs.
- Schemas define runtime input validation and the public API contract.
- Services/use cases enforce business rules, scope, state transitions, and transaction boundaries.
- Repositories contain focused data access. Avoid generic abstractions that hide query cost or scope predicates.
- Jobs/workers perform retry-safe asynchronous work and reload current business state before acting.
- Modules call another module through its public service interface, not its internal repository. Avoid circular dependencies.

## 6. Fastify application rules

- Build the app through a `buildApp()` function that can be imported by tests without starting a network listener. Keep `server.ts` responsible for startup and graceful shutdown.
- Register configuration, Prisma, Redis, logging, authentication, and common error handling before domain route plugins that depend on them.
- Register each domain as a Fastify plugin with a versioned route prefix such as `/api/v1/sites`.
- Use Fastify encapsulation intentionally. Put shared decorators in a documented root plugin; keep module hooks and routes scoped to their module where possible.
- Use JSON Schema/TypeBox (or the repository's chosen typed schema provider) for request and response schemas. Define schemas in source-controlled code. Do not compile client-supplied schema definitions.
- Validate `params`, `querystring`, `headers`, and `body`; define response schemas to prevent accidental exposure of internal fields.
- Use hooks for cross-cutting request processing such as authentication and request context. Enforce resource-specific authorization in service-level policy checks as well, so alternate entry points cannot bypass it.
- Use one error format with stable machine-readable error codes, a safe message, and a request ID. Never return stack traces, SQL, secrets, or internal infrastructure details to clients.
- Set explicit body size, request timeout, rate limit, CORS, trusted proxy, and content-type policies. Avoid permissive wildcard CORS in production.
- Apply authentication to all protected routes by default; public routes must be explicitly marked and reviewed.
- Explicitly map permitted request fields into service commands. Never spread an untrusted request body directly into a Prisma create/update call.
- Whitelist sortable fields and supported filters. Never turn arbitrary client-provided strings into SQL identifiers or raw SQL fragments.
- Use explicit command routes for state changes such as `POST /store-requests/:id/approve`; do not let generic `PATCH` set arbitrary status values.
- Generate and maintain OpenAPI documentation from route schemas, including required permission and scope notes.
- Use Fastify's `inject()` for API tests so route behavior can be tested without binding a network port.

## 7. Authentication and permission model

Implement **RBAC plus scoped authorization**. Roles bundle permissions; scope assignments limit where those permissions apply. Add relationship checks when access depends on ownership or workflow participation.

### Authentication

- Store passwords only as strong salted hashes using a maintained password-hashing library. Never log passwords or tokens.
- Use secure, expiring sessions or short-lived access tokens with refresh-token rotation and revocation. Choose cookie or bearer-token behavior consistently for web/mobile clients.
- Enforce login throttling, generic failure responses, session/device management, logout/revocation, password reset controls, and optional MFA.
- Face/biometric authentication must use platform/device-supported authentication or a reviewed identity provider. Do not store raw face images/templates as credentials unless the product has an explicit, reviewed legal/security design.
- Capture security events for login, failed login, session expiry/revocation, device registration/change, permission changes, and geo-fence exceptions. Mask sensitive values.

### Permission records

Permissions are stable action codes, for example:

```text
SITE_CREATE
EMPLOYEE_CREATE
DEPARTMENT_CONFIGURE
FORM_PUBLISH
WORKFLOW_PUBLISH
LABOUR_CREATE
TVT_ATTENDANCE_MARK
JOB_CARD_CREATE
DPR_SUBMIT
STORE_REQUEST_CREATE
STORE_REQUEST_APPROVE
STOCK_ISSUE
PURCHASE_APPROVE
MACHINE_BOOK
QA_RESULT_VERIFY
SOS_ACKNOWLEDGE
AUDIT_LOG_VIEW
```

Model role grants and user scope separately. Do not encode every site/employee combination as a new role. Support effective dates and revocation for assignments where relevant. Changes to grants, role membership, and scope must be audited.

- Define grant/deny precedence explicitly; never use an undocumented "last row wins" rule.
- Direct user grants, if allowed, must be exceptional, scoped, time-bounded where practical, and audited.
- A user cannot grant permissions beyond their own delegated authority or approve their own privilege escalation.
- Seed system permission codes idempotently. Never delete client-created permissions during a seed run.
- Assignment to a workflow task or department does not itself grant approval authority; the required action permission and policy must also pass.

### Authorization decision

Every protected operation must check all of the following:

1. Is the actor authenticated and active?
2. Does the actor have the required action permission through an effective role assignment?
3. Does the permission assignment cover the target company/project/site/department?
4. Is the target record actually inside that scope and in a state where the action is allowed?
5. Does ownership, workflow assignment, separation-of-duties, or approval policy add a further restriction?

Fail closed. Do not return a record and filter it later in the client. Do not accept `actorId`, role, or permission claims from request bodies. For list endpoints, apply scope filters in the database query before pagination.

Example policy intent:

```text
PI can approve STORE_REQUEST_APPROVE only when:
  actor has the permission at the target site/project scope
  AND request belongs to that scope
  AND actor is not the requester when separation-of-duties is enabled
  AND request is awaiting the PI approval step
```

Add automated negative tests proving one site cannot read or mutate another site's data, even with a guessed record ID.

## 8. Dynamic department, operation, form, and workflow design

Dynamic configuration is versioned data interpreted by trusted backend code.

### Department and operation configuration

An authorized user can create a department at a company/project/site scope, assign a department head and employees, and attach operations. Use capability/operation identifiers rather than hard-coding department names into workflow logic. For example, route to a configured `PROCUREMENT_REVIEW` capability that a site may assign to Purchase or Commercial.

### Forms

- Support a defined allowlist of field types: text, number, decimal, date, time, select, multi-select, boolean, employee, department, project, site, labour, material, machine, vendor, file, image, signature, QR, and GPS as needed.
- Keep an **operation definition** (the reusable catalog/configuration) separate from an **operation instance** (a real request, hazard, booking, job, or register entry).
- Store form definitions and published versions separately from submissions.
- Validate submissions against the server-side published version and authorization scope.
- Store typed fields relationally when needed for filtering, reporting, arithmetic, uniqueness, or joins. Store flexible, low-query form answers in JSON with an explicit version and validation result.
- Do not silently change old submissions when a form changes. Every submission references the exact form version used.
- Limit field count, nesting, file size, allowed file types, and regex complexity to avoid resource abuse.

### Workflows

Represent a workflow as versioned steps and transitions. Support sequential and parallel steps only when explicitly required. Each transition must be a known action and have an auditable actor, reason, time, previous state, next state, and workflow version.

Keep assignment, execution, approval, verification, and closure as distinct actions. Assignment to a person or department does not grant approval authority. Not every operation needs every stage; its published workflow defines the applicable lifecycle. Preserve the actor, time, reason, result, and workflow version for each stage.

Minimum transaction states should be shared where possible (`DRAFT`, `SUBMITTED`, `IN_REVIEW`, `RETURNED`, `APPROVED`, `REJECTED`, `IN_PROGRESS`, `PARTIALLY_FULFILLED`, `COMPLETED`, `CANCELLED`, `CLOSED`) while modules may add domain states. Define valid transitions; never accept arbitrary status strings from a client.

Do not treat `RESOLVED` as synonymous with `CLOSED`; for example, a hazard may require independent safety verification after corrective action.

Use optimistic concurrency (`version` column or equivalent) for conflicting updates. A stale write must receive a conflict response and must not silently overwrite a newer approval or stock balance.

### Rules

Rules consist of allowlisted conditions/operators and allowlisted actions. Validate rule definitions when saved and again when published. Version rules. Log rule inputs/result/action, but redact private data. Add execution limits, timeouts, loop protection, and dead-letter handling for failed jobs.

## 9. Attendance, labour, and work allocation

Keep these concepts separate in the data model:

```text
AttendanceSession: evidence of presence/session
TVTRecord: safety training attendance and eligibility result
LabourAssignment: allocation to an engineer/job/work and time interval
JobCard: defined work package
ProductivityEntry: calculated or reviewed labour output/P/OT
DPR: daily work summary and submission history
```

Rules:

- Record event time, server receive time, employee/labour, company/project/site, device/source, GPS and accuracy when enabled, geo-fence decision, and policy/configuration version.
- Geo-fence must be checked server-side. GPS is evidence with accuracy limits, not proof of identity by itself.
- Enforce eligibility before work assignment, including required onboarding, active status, medical/TVT completion, and site assignment.
- Prevent overlapping active labour assignments unless a configured and permission-checked exception allows it.
- Treat automatic release as a background command with a stable idempotency key. Record the configured schedule and actual execution time.
- Store raw time intervals and the versioned calculation policy. Derive P/OT from explicit rules; never make computed attendance indistinguishable from manual correction.
- Manual attendance/productivity corrections require permission, reason, actor, before/after values, and approval when configured.
- Support offline capture through client-generated event IDs, server idempotency, conflict handling, and delayed synchronization. Preserve both event timestamp and server receipt timestamp.
- Site timezone and attendance/business-day boundary must be configurable and versioned. Do not assume midnight is the start of a construction workday.

## 10. Database and Prisma rules

### Schema conventions

- Use explicit model and field names with one repository-wide naming convention. Map to snake_case database names consistently if that convention is selected.
- Use foreign keys, unique constraints, check constraints, and non-null constraints to enforce invariants at the database layer where possible.
- Use `createdAt`, `updatedAt`, and appropriate actor IDs on mutable business records. Use append-only records for events/history.
- Prefer explicit join models when a relationship needs scope, status, effective dates, metadata, or audit fields.
- Use decimal/numeric types for money and exact measurements where rounding matters. Never use floating-point types for currency.
- Use soft deletion only when restoration/history is a real requirement. Enforce uniqueness and query behavior deliberately for soft-deleted rows.
- Use enums for stable finite technical states; use versioned configuration for client-configurable labels/categories. Do not let arbitrary display labels become state-machine values.
- Do not generate request/document/business sequence numbers with `COUNT(*) + 1`. Use a database sequence or transaction-safe scoped counter and a uniqueness constraint.
- Define measurement units, currency, decimal precision, and rounding policy. Use Prisma `Decimal`/PostgreSQL `numeric` for money and exact quantities; do not calculate finance with JavaScript floating-point numbers.
- Keep migration diffs reviewed and data migration behavior explicit. Production migrations must be backward-compatible with the currently deployed application when feasible: expand, deploy compatible code, backfill, then contract in a later release.

### Query performance and indexes

Design indexes from real query patterns, not by adding an index to every field. For each major list/report, document its filters, ordering, pagination, and expected data scale. Verify important plans with representative data and `EXPLAIN (ANALYZE, BUFFERS)` in a safe environment.

Baseline rules:

- Primary keys and unique business identifiers must have database constraints.
- Index foreign keys that are frequently used for joins/deletes and scope filters.
- For common scoped lists, consider compound indexes with equality filters first and sort/range columns after them. Example: `(site_id, status, created_at)` for site-scoped pending requests ordered by creation time.
- For actor/workflow inboxes, consider `(assignee_id, status, due_at)` or the actual query shape; confirm leading-column behavior with PostgreSQL plans.
- For audit timelines, consider `(company_id, entity_type, entity_id, created_at)` and optionally `(project_id, site_id, created_at)` based on access patterns.
- Use unique compound constraints for tenant-scoped identifiers, e.g. `(company_id, project_code)` or `(site_id, employee_code)` when the business rule requires uniqueness within that scope.
- Use partial indexes for stable, frequently queried subsets such as open tasks only when the query predicate matches the index predicate and measured workload justifies it.
- Before declaring a partial index in Prisma, verify support in the repository's pinned Prisma version. If unsupported or preview-only, use a reviewed SQL migration and document introspection/rollback implications; do not enable preview features casually.
- Avoid redundant indexes, very wide compound indexes, and indexing low-selectivity fields without evidence. Indexes cost storage and slow writes.
- Use cursor/keyset pagination for large changing lists; use a stable unique tie-breaker such as `(created_at, id)`. Bound page size. Avoid unbounded queries and deep offset pagination on high-volume tables.
- Select only required fields (`select`); avoid fetching large attachments or JSON payloads for list views.
- Avoid N+1 access patterns. Use suitable relation loading or batched queries, but do not include huge relation graphs by default.
- Use transactions for invariants such as stock issue, approval state transition, labour assignment, and cash movement. Use conditional updates/locking or suitable isolation for contested balances and reservations.
- Do not cache authorization decisions or mutable inventory balances without explicit invalidation/versioning. A stale permission cache must never grant access after revocation.
- Set database connection-pool limits across all API replicas and workers; use bounded query/job concurrency to avoid exhausting PostgreSQL connections.

PostgreSQL B-tree compound indexes are most effective when leading columns match common equality filters; partial indexes are specialized tools and should match real query predicates. [PostgreSQL multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html), [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)

### High-volume tables

Plan retention, indexes, and eventual partitioning for `audit_log`, `event_log`, attendance, chat metadata, notifications, and realtime delivery records. Partition only when actual volume and retention needs justify the operational cost. Keep partition keys aligned with common retention and query boundaries.

### Query review checklist

For each high-traffic list, inbox, dashboard, or report, identify:

1. Expected filters and allowed sort fields.
2. Scope predicates that must apply before pagination.
3. Columns and relations the response actually needs.
4. Pagination strategy and stable ordering.
5. Candidate supporting index and its write/storage trade-off.
6. Risks such as N+1 queries, full scans, large JSON retrieval, or unbounded memory use.
7. Evidence for an optimization: representative data, query plan, timings, and row counts where available.

Do not claim an index is optimal without checking the query shape. Without representative data or a plan, label an index as a candidate to validate. PostgreSQL's compound B-tree indexes are most useful when leading columns match common equality filters; partial indexes should match query predicates and measured workload.

## 11. Transactions, audit log, and outbox

For a business action with multiple database writes, perform the business mutation, workflow history, immutable audit event, and transactional outbox insert in one Prisma transaction:

```text
validate actor and scope
check expected record version/state
apply business mutation
append workflow/history record
append immutable audit record
insert outbox event with unique event ID
commit
```

After commit, a worker delivers notifications, WebSocket messages, search indexing, and integrations. Do not send external notifications inside the transaction. Retry outbox delivery safely and record attempts/result. Use a dead-letter state and an operator-visible recovery path.

Recommended audit fields:

```text
id, eventKey, entityType, entityId,
companyId, projectId, siteId, departmentId,
actorId, actorRoleSnapshot, source,
correlationId, requestId, occurredAt, recordedAt,
statusBefore, statusAfter, changedFields,
workflowInstanceId, workflowStepId, approvalId,
metadata, attachmentReferences, result
```

Use field-level before/after values for meaningful changes. Never store credentials, tokens, raw biometrics, or unnecessary personal data in audit metadata. Audit viewing/exporting and archive actions must themselves be audited. Normal application roles must not update/delete audit rows; use database permissions and a narrowly controlled archive process as defense in depth.

Prisma supports transactions for grouping writes; keep them short and avoid external I/O inside them. [Prisma transactions](https://www.prisma.io/docs/orm/fundamentals/transactions)

### Inventory and financial concurrency

- Every balance-changing action writes a ledger/movement record. Decide and document whether balances are derived from the ledger, maintained transactionally, or both; reconcile maintained balances.
- Check available stock inside the transaction and use a guarded atomic update, row lock, or appropriate isolation so concurrent issues cannot oversell stock.
- Keep requested, approved, received, accepted, rejected, issued, returned, and pending quantities distinct when the workflow needs them.
- Partial fulfillment stays open until fully fulfilled or explicitly cancelled according to policy. Do not close it merely because one issue occurred.
- Record item, quantity, unit, source/destination, linked request/job, actor, timestamp, and reason for every movement.
- Prevent negative stock unless a documented policy explicitly permits it and an authorized action records the exception.
- For cash, expenses, payment, and budget transitions, use exact decimal arithmetic, explicit currency/rounding rules, and a durable transaction history.
- Test simultaneous stock issues, duplicate receipts/approvals, number generation, and payment posting under concurrency.

## 12. Redis and background jobs

Use Redis for:

- BullMQ (or a maintained equivalent) queues for notifications, scheduled reminders, escalations, and outbox delivery.
- Short-lived cache for non-sensitive reference data with explicit TTL and invalidation.
- Rate limiting and short-lived verification challenges.
- Realtime presence/connection metadata.
- Distributed coordination only when a database constraint/transaction cannot solve the problem more simply.

Queue rules:

- Every job has a stable ID or idempotency key, bounded retries with backoff, timeout, and structured logs.
- Jobs must be safe to retry and safe to run after process restart.
- Make failure visible through dead-letter/retry dashboards and operator actions.
- Use database records as truth for business status. Redis job state alone cannot prove that a workflow was completed.
- Scheduled tasks must be timezone-aware, versioned/configurable, and guarded against duplicate execution.
- Configure bounded attempts, backoff policy, job timeout, concurrency, and stalled-job recovery. Route exhausted failures to an operator-visible failed/dead-letter workflow; do not silently discard them.
- Workers must reload the referenced business record and re-check its current state, scope, and version before acting because queued work can become stale.
- Gracefully close workers and queue connections during shutdown.

## 13. API design

- Use `/api/v1` versioning. Keep resource paths nouns and actions explicit where a domain command is not CRUD, e.g. `POST /store-requests/:id/approve`.
- Use consistent pagination, filtering, sorting allowlists, response envelopes (if adopted), and error codes.
- Return `201` for created resources, `202` for accepted asynchronous work, `204` when no body is needed, and appropriate `4xx/5xx` status codes.
- Use idempotency keys for mobile/offline submissions and externally retried create/command operations.
- Use ETags or explicit record versions for concurrent edits to approvals, stock, bookings, and attendance corrections.
- Define OpenAPI output from route schemas and keep it in sync with implementation.
- Never expose internal database shape directly as a permanent API contract. Use request/response DTOs.
- Avoid giant endpoints that mutate multiple departments at once; model a business command and authorize each effect.
- Use a durable idempotency record in PostgreSQL for critical retried commands and integrations. Same key plus same request returns the prior result; the same key with a different request returns a conflict. Do not rely on Redis alone for durable idempotency.
- For concurrent edits, use a record version or equivalent precondition; stale approval, booking, stock, and attendance correction attempts must return a conflict rather than overwrite newer state.
- For large exports, use a background job and bounded/streamed reads instead of loading the entire result into process memory.

## 14. Logging, monitoring, and security

Use Fastify structured JSON logging in production and readable logs in local development. Include `requestId`, `correlationId`, route, method, status, duration, and actor/scope identifiers where safe. Redact `authorization`, cookies, passwords, OTPs, tokens, biometric fields, and sensitive identifiers. Never log whole request bodies by default.

Separate:

- Application logs: operational diagnostics, errors, timing.
- Audit logs: immutable business/security history.
- Metrics: latency, error rate, throughput, queue age, database pool use, job failure counts.
- Traces: request propagation across API, database, jobs, and integrations.

Security baseline:

- TLS at ingress and secure proxy configuration.
- Secret management through environment/secret injection; no secrets in source, images, or logs.
- Least-privilege database credentials; separate migration and runtime database roles where practical.
- Rate limits and abuse controls on authentication, upload, QR, search, and public endpoints.
- Validate upload size/type and scan files if the deployment environment provides scanning.
- Protect against IDOR by checking scope on every read/write.
- Use parameterized Prisma queries; never interpolate untrusted values into raw SQL.
- Apply secure headers, CORS allowlists, CSRF protection for cookie-authenticated browser flows, and safe password reset behavior.
- Define backup, restore, encryption, retention, incident response, and access-review procedures before production launch.
- Verify webhook signatures and provider event IDs; enforce replay protection and bounded HTTP timeouts/retries.
- Prevent SSRF in URL/document processing: allowlist destinations and block private/internal network ranges unless explicitly required and secured.
- Track p50/p95/p99 latency, error rates, database pool saturation, slow queries, lock waits, queue depth/age, job failures, CPU/memory, and event-loop lag. Set alert thresholds from observed baselines.

## 15. Docker and environments

Provide a reproducible local stack with API, PostgreSQL, and Redis. Use Docker Compose for development dependencies and local workflows. Production orchestration can be chosen later based on hosting needs.

- Validate required environment variables at startup and fail fast with a clear, secret-free error.
- Keep `.env.example` to placeholder names/values; ignore real `.env` files and never print the full environment.
- Keep local, test, staging, and production credentials/configuration separate. Never use production data or credentials in tests.
- Create one managed Prisma Client per process, not per request. Configure connection pooling with the number of API replicas and workers in mind.
- Use idempotent system/reference seeds. Keep demo data separate and disabled in production.

- Use a multi-stage Docker build: install dependencies, build TypeScript, then copy only production artifacts/dependencies into a small runtime image.
- Run the app as a non-root user. Do not bake `.env` files or secrets into an image.
- Add container health checks for the API and dependency readiness checks where appropriate. A health endpoint must distinguish process liveness from readiness to serve traffic.
- Persist PostgreSQL data in a named volume for local development. Do not treat a development volume as a backup.
- Set resource limits and graceful shutdown behavior in deployment configuration.
- Handle `SIGTERM`/`SIGINT` by stopping new requests, draining active work within a bounded grace period, closing Fastify, Prisma, Redis, and queue workers, then exiting.
- Keep API containers stateless. Compose is the local development stack; use an explicit production deployment design and managed services or deliberately operated persistent services.
- Run migrations as an explicit release step using a controlled migration identity, not automatically from every API replica at startup.
- Keep development, test, staging, and production configuration distinct. Production must not run seed data or development debug settings.
- Pin base image versions/digests through a reviewed update process and scan images/dependencies in CI.

## 16. Testing policy

Use the repository's existing test framework if established. Otherwise, choose a maintained TypeScript test runner and document the choice.

Required test layers:

1. **Unit tests:** permission decisions, state transitions, rule evaluation, attendance/business-day calculations, productivity/P/OT, inventory calculations, and input normalization.
2. **Integration tests:** repositories and services against PostgreSQL; Redis queue/cache behavior where relevant. Use isolated test databases and deterministic cleanup.
3. **API tests:** Fastify `inject()` requests for validation, authentication, authorization, response schemas, and errors without binding a real port.
4. **End-to-end workflow tests:** representative workflows from create through approval/rejection/resubmission/closure, including notifications/outbox behavior.
5. **Security regression tests:** cross-company/site access denial, guessed-ID access, role revocation, self-approval prohibition, and malformed dynamic form/rule payloads.
6. **Concurrency tests:** simultaneous stock issues, duplicate receipt/approval, sequence allocation, and attendance uniqueness.
7. **Migration and recovery tests:** clean install, supported upgrade path, outbox recovery, worker retry, and backup/restore rehearsal where infrastructure permits.

Test both success and failure paths. Minimum workflow cases include missing permission, wrong scope, invalid state transition, concurrent update, duplicate idempotency key, partial fulfillment, rejection, resubmission, timeout, retry, and background-job duplicate execution.

Do not make tests depend on production data or real third-party services. Use test doubles only at external boundaries; do not mock the business logic being tested.

## 17. CI and code quality

The CI pipeline should run, in order:

```text
install from lockfile
format check
lint
TypeScript typecheck
unit tests
integration/API tests with PostgreSQL and Redis services
Prisma schema validation and migration checks
production build
dependency/security scan
Docker image build
```

Use required checks before merging. Keep migrations and seed scripts reviewable. Seeds must be idempotent and limited to local/test environments unless a production bootstrap is intentionally designed. Add scripts appropriate to the selected tools, such as `dev`, `build`, `start`, `typecheck`, `lint`, `format`, `format:check`, `test`, `test:coverage`, `db:generate`, `db:migrate:dev`, `db:migrate:deploy`, and `db:seed`; do not add scripts that do not match actual project behavior.

## 18. Build sequence for the ERP

Do not start all modules at once. Implement in this dependency order and deliver each as a tested vertical slice.

### Milestone 0 - Repository and runtime foundation

Inspect existing requirements and repository conventions, then set up TypeScript, Fastify app factory, validated environment configuration, structured logging/redaction, error mapping, Prisma/PostgreSQL, Redis, Docker Compose, health/readiness endpoints, graceful shutdown, CI, and test harness.

### Milestone 1 - Company, HO, project, site

Build master data, constraints, scope context, site timezone, geo-fence configuration, and audit history. Add scoped list/read/write tests.

### Milestone 2 - Identity and permissions

Build employee, login/session lifecycle, roles, permissions, scope assignments, department memberships, permission hooks/helpers, audit security events, and cross-site denial tests.

### Milestone 3 - Departments and operations

Build configurable departments and operation definitions, site assignment, owner/role assignment, activation, and configuration versioning.

### Milestone 4 - Forms and workflow engine

Build safe form versions/submissions, workflow definitions/versions/instances/tasks, state-transition checks, approvals, rejection, correction, resubmission, reassignment, SLA, escalation, concurrency control, and workflow history.

### Milestone 5 - Platform services

Build immutable audit, transactional outbox, document metadata/versioning, notification delivery, BullMQ workers for retryable jobs, realtime event delivery, search, and reporting foundations. Keep the API and worker process deployable separately when operationally useful, while retaining modular monolith boundaries and shared domain interfaces.

### Milestone 6 - Attendance and labour vertical slice

Build employee attendance, contractor/labour onboarding, medical verification, QR, TVT, eligibility, labour assignment, auto-release, manual correction, productivity policy, and DPR integration.

### Milestone 7 - Construction modules in business order

Recommended order: Safety -> Store/Inventory -> Purchase -> Machinery -> QA/QC -> Site Engineering -> Admin -> Kitchen -> Finance. Adjust based on validated client priorities and shared dependencies.

### Milestone 8 - Communication and rollout

Build chat metadata and attachments, voice/video provider integration, SOS, feedback, complaints, escalation, retention configuration, load/security review, UAT, migration rehearsal, backup/restore rehearsal, and staged rollout.

### Phase gates

Do not start the next milestone merely because the current code compiles. Each milestone needs:

- Reviewed data model and migration plan where schema changes are involved.
- Positive and negative authorization tests for the scope it introduces.
- A demonstrable end-to-end path for its core use case.
- Updated API documentation and setup instructions.
- A short record of unresolved client decisions and known limitations.

## 19. Definition of done for every feature

A feature is done only when all applicable items are complete:

- Requirement and supported scenarios are recorded, including exception paths.
- Prisma schema and migration are reviewed; constraints and indexes reflect real queries.
- Permission and scope checks are enforced in the backend and covered by positive and negative tests.
- Request/response schemas and API documentation are updated.
- Business logic uses explicit state transitions and handles concurrency/idempotency.
- Audit/history and outbox events are written for relevant actions.
- Notifications/jobs are retry-safe and observable.
- Data is filtered and paginated efficiently; no unbounded production query is introduced.
- Unit, integration, and API tests appropriate to risk pass.
- Logs redact sensitive data and errors are actionable without exposing internals.
- Migration/deployment and rollback or forward-fix strategy is documented.

## 20. Claude working protocol

When asked to implement a feature:

1. Inspect the relevant repository files, instructions, Prisma schema, route patterns, permissions, and tests.
2. Summarize the existing pattern and identify the smallest coherent implementation boundary.
3. List the data model, permissions/scope, state transitions, audit events, API endpoints, and exception scenarios that the change requires.
4. Implement the feature in the existing style. Do not replace established architecture without evidence and a clear migration path.
5. Add focused tests for behavior and authorization boundaries.
6. Run only relevant checks available in the project; report exact checks and results.
7. Review the final diff for unrelated edits, secrets, missing scope filters, unbounded queries, and migration hazards.
8. Summarize changed files, behavior, checks run, and remaining decisions.

If a requirement is ambiguous, use existing client requirements and domain configuration as the source of truth. Ask only when a missing decision changes data ownership, permission boundaries, financial calculations, legal retention, or irreversible workflow behavior. Do not invent business policy silently.

For significant multi-file changes, structure the final report around: understanding and plan; key design decisions; files/schema/API changes; permission, scope, transaction, and audit implications; exact checks run and results; migration/deployment notes; remaining risks or decisions. Keep small-task reports concise.

## 21. Official references

- Fastify plugins and encapsulation: https://fastify.dev/docs/latest/Reference/Plugins/
- Fastify TypeScript: https://fastify.dev/docs/latest/Reference/TypeScript/
- Fastify validation and serialization: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- Fastify hooks: https://fastify.dev/docs/latest/Reference/Hooks/
- Prisma transactions: https://www.prisma.io/docs/orm/fundamentals/transactions
- Prisma indexes: https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes
- BullMQ idempotent jobs: https://docs.bullmq.io/patterns/idempotent-jobs
- BullMQ retries and backoff: https://docs.bullmq.io/guide/retrying-failing-jobs
- BullMQ production guidance: https://docs.bullmq.io/guide/going-to-production
- PostgreSQL multicolumn indexes: https://www.postgresql.org/docs/current/indexes-multicolumn.html
- PostgreSQL partial indexes: https://www.postgresql.org/docs/current/indexes-partial.html
- Node.js supported release lines: https://nodejs.org/en/about/previous-releases
- Docker Compose production guidance: https://docs.docker.com/compose/how-tos/production/
