---
name: fastify-clean-architecture
description: >-
  Actionable guidelines, code patterns, and security practices for Fastify 5, TypeScript,
  and clean 3-tier backend architecture. Use when authoring routes, services, repositories,
  designing TypeBox schemas, implementing auth/guards, or structuring domain modules.
---

# Fastify 5 Clean Architecture & Security Guide

This skill defines the architectural blueprint, layered design patterns, and security invariants for the Sarjan Construction backend.

---

## 1. Three-Tier Architectural Layering

Every domain module must adhere strictly to three distinct layers:

```
[ HTTP Route Layer ]       ──► Request validation (TypeBox), status codes, HTTP headers, preHandlers (auth, guards)
         │
         ▼
[ Domain Service Layer ]   ──► Business rules, domain invariants, permissions check, orchestration, auditing
         │
         ▼
[ Unit of Work / Repo ]    ──► Database queries (Prisma), transactional consistency ($transaction), raw persistence
```

### Layer Rules
1. **Routes (`routes.ts`):**
   - Owns route declaration, URL pathing under `/api/v1`, and preHandler guards (`app.authenticate`, `app.tenantCompanyGuard`, `app.requirePermission`).
   - Must validate all incoming request bodies, params, and queries using TypeBox schemas.
   - Never contains database queries (`prisma.find...`) or core business domain calculations.
2. **Services (`service.ts`):**
   - Pure domain logic. Accepts plain TypeScript objects/inputs and returns domain responses.
   - Decoupled from HTTP objects (`FastifyRequest`, `FastifyReply`) for frictionless unit testing.
   - Enforces optimistic concurrency (`expectedVersion`), domain transitions, and audit logging.
3. **Repositories & Unit of Work (`repository.ts`):**
   - Isolates Prisma / SQL calls.
   - Groups multi-table mutations into atomic `$transaction` blocks via Unit of Work interfaces.

---

## 2. Fastify 5 Plugin & Encapsulation Conventions

- `src/app.ts` exports `buildApp(opts)` for end-to-end testing without opening listening network sockets.
- `src/server.ts` owns server bootstrap, listening on port, and graceful shutdown signal handlers (`SIGTERM`, `SIGINT`).
- Plugins register in strict dependency order:
  1. Core Configuration (`configPlugin`)
  2. Request Context & Correlation ID (`requestContextPlugin`)
  3. Centralized Error Handler (`errorHandlerPlugin`)
  4. Database Client (`prismaPlugin`)
  5. Cache & Queues (`redisPlugin`, BullMQ workers)
  6. Authentication & Authorization (`authenticationPlugin`, `authorizationPlugin`)
  7. Versioned Domain Routes (`/api/v1/*`)

---

## 3. Strict Request & Response Validation (TypeBox)

- Every endpoint must define strict TypeBox schemas for `body`, `querystring`, `params`, and `response[200/201]`.
- Disallow unknown fields and strip unvalidated inputs.
- Schema example:
```typescript
import { Type } from '@sinclair/typebox';

export const CreateSiteBody = Type.Object(
  {
    code: Type.String({ minLength: 2, maxLength: 32, pattern: '^[A-Z0-9_-]+$' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    geoLatitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
    geoLongitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
    geoFenceRadiusM: Type.Optional(Type.Integer({ minimum: 10, maximum: 5000 })),
  },
  { additionalProperties: false },
);
```

---

## 4. Security Invariants (OWASP-Aligned)

1. **Password Hashing:**
   - Always use Argon2id with OWASP-recommended parameters (`memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`).
   - Constant-time dummy hash verification on failed lookups to prevent user-enumeration timing attacks.
2. **Multi-Tenant Isolation:**
   - Every tenant route requires `x-company-id` header validated via `app.tenantCompanyGuard`.
   - Never trust client-supplied tenant identifiers; always cross-verify against caller's active role assignments.
3. **Zero-Trust Input Validation:**
   - Never trust frontend validation alone.
   - Re-validate business invariants, dates, and ownership on the server side.
4. **Error Privacy & Information Leakage:**
   - Uniform error envelope: `{ error: { code: string, message: string, requestId: string } }`.
   - Never leak internal file paths, stack traces, database schema details, or raw SQL queries in production error responses.

---

## 5. Clean Code (SOLID, DRY, KISS & YAGNI)

- **Single Responsibility (SRP):** Keep service methods focused on a single domain operation.
- **Dependency Inversion (DIP):** Inject repositories and external services (e.g., `MailService`, `Redis`, `UserProfileCache`) via constructor parameters to allow easy mocking in Vitest.
- **Fail Fast:** Validate preconditions and version locks at the entry point of service methods before performing expensive computations.
