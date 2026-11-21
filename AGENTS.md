# Sarjan Construction Backend — Agent Guide

**Read `rule.md` first.** It is the engineering contract for this repository and takes precedence over local conventions. Everything under `sources/` is read-only reference material.

## Stack

Node.js LTS · Fastify 5 · TypeScript (strict) · PostgreSQL · Prisma · Redis · BullMQ · Vitest · Docker

## Commands

```bash
npm install          # install dependencies
npm run dev          # dev server (tsx watch)
npm run build        # compile to dist/
npm run typecheck    # strict type check
npm run lint         # ESLint (type-aware)
npm run format       # Prettier write
npm test             # Vitest (no DB/Redis needed for smoke tests)
npm run db:generate  # prisma generate
npm run db:migrate:dev    # create/apply dev migration (requires DB)
npm run db:migrate:deploy # apply migrations (release step)
docker compose up -d      # local PostgreSQL + Redis (see docker-compose.yml)
```

## Conventions

- `src/app.ts` exports `buildApp()` — import it in tests; `src/server.ts` owns listen/shutdown.
- Plugins live in `src/plugins/` and register in dependency order in `buildApp()`.
- Routes are versioned under `/api/v1` and validated with TypeBox schemas.
- Env validation happens in `src/config/` at app construction; never log secret values.
- Prisma schema changes go through migrations only — never `prisma db push` to production.

## Core Engineering & Optimization Rules

### 1. Database Optimization (High Priority)
- **N+1 Query Problem:** Avoid executing one query per record inside loops; batch lookups and pre-fetch relations.
- **Indexing:** Add indexes to frequently searched, filtered, joined, and sorted columns.
- **Select Specific Columns:** Avoid `SELECT *` / full record fetching when only a few fields are needed.
- **Pagination:** Always paginate list queries with cursor or limit/offset; never fetch unbounded result sets.
- **Query Optimization:** Inspect execution plans with `EXPLAIN` / `EXPLAIN ANALYZE` for performance-critical queries.
- **Connection Pooling:** Reuse connection pools across requests rather than opening ad-hoc connections.
- **Transactions:** Use atomic transactions (`$transaction` / unit of work) for operations that must succeed or fail together.
- **Bulk Operations:** Prefer bulk inserts/updates (`createMany`, `updateMany`, batch upserts) over row-by-row queries.
- **Avoid Duplicate Queries:** Reuse and cache intermediate query results where appropriate.
- **Composite Indexes:** Use multi-column composite indexes when multi-predicate filtering and sorting patterns justify them.

### 2. Memory Optimization (High Priority)
- **Memory Leaks:** Avoid retaining unused references and detached object trees.
- **Large Arrays:** Avoid buffering massive datasets into memory; paginate or chunk.
- **Streams:** Stream large file uploads/downloads and exports instead of loading entire buffers into RAM.
- **Garbage Collection:** Keep object lifecycles short and scoped to assist GC collection.
- **Event Listeners:** Remove event listeners and close subscriptions when no longer needed.
- **Timers:** Always clear active intervals and timeouts when tasks conclude or connections drop.
- **Caching:** Enforce TTLs and capacity bounds on in-memory and Redis caches.
- **Circular References:** Prevent unnecessary object-reference cycles that delay deallocation.
- **Buffer Management:** Avoid redundant copies of binary data and large buffers.

### 3. API & Backend Performance
- **Rate Limiting:** Protect public and expensive endpoints against abusive bursts.
- **Request Validation:** Strict runtime schema validation (TypeBox) on every incoming body, query, and parameter.
- **Response Compression:** Enable gzip/brotli compression for payload responses.
- **HTTP Caching:** Use `Cache-Control` and `ETags` for immutable or cacheable read endpoints.
- **Async Operations:** Keep the event loop unblocked; never execute sync CPU-intensive loops on the main thread.
- **Timeout Handling:** Explicit request timeouts on external services and outbound HTTP clients.
- **Retry Mechanism:** Exponential backoff with jitter on transient network/queue failures.
- **Idempotency:** Protect state-changing operations with idempotency keys (`idempotencyKey`).
- **Bulk API Operations:** Provide batch endpoints for turnstiles, kiosks, and multi-record actions.
- **Payload Size:** Enforce strict request body limits (e.g. 1MB default) and trim response envelopes.

### 4. Security Best Practices (Critical)
- **Password Storage:** Never store plain text passwords; use Argon2id with OWASP-recommended parameters.
- **Secrets Management:** Secrets stay in `.env` and environment variables; never hardcode or expose secrets to frontend clients.
- **Auth & Authz Separation:** Distinct authentication (`app.authenticate`) and granular authorization (`requirePermission`, scope checks).
- **Injection Prevention:** Parameterized SQL queries only (Prisma handles this natively; raw SQL requires `$queryRaw` tagged templates).
- **XSS & Output Encoding:** Sanitize and encode user inputs before returning or rendering in HTML templates/emails.
- **CSRF & CORS:** Strict CORS origin whitelisting; disable unsafe cross-origin credential sharing.
- **File Upload Security:** Validate MIME types, extension whitelists, and file size limits before processing.
- **Rate Limiting & Defense:** Multi-tier rate limiting for login, OTP, and public endpoints.
- **Zero Client Trust:** Never trust frontend validation alone; re-validate business invariants on the server.
- **Error Privacy:** Sanitize error responses; never leak database schemas, stack traces, or internal paths in production errors.

### 5. Clean Code & Architecture
- **SOLID Principles:** Single Responsibility, Open-Closed, Liskov Substitution, Interface Segregation, Dependency Inversion.
- **DRY:** Extract common logic, helpers, and schemas; avoid duplicate domain routines.
- **KISS & YAGNI:** Keep implementations simple and maintainable; avoid speculative or over-engineered features.
- **Separation of Concerns:** Clean layer boundaries between routes (HTTP), service (business domain logic), and repository (database persistence).
- **Reusability:** Build composable, reusable modules, utilities, and validation schemas.
- **Meaningful Naming:** Self-explanatory, semantic variable, function, and interface names.
- **Centralized Error Handling:** Uniform API error envelopes via custom `AppError` subclasses.
- **Dependency Injection:** Inject repositories and services into factories and route handlers for testability.
- **Strict Type Safety:** TypeScript strict mode with zero unchecked `any` types.
