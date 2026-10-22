# Sarjan Construction Backend

Modular monolith backend for a multi-company, multi-project, multi-site construction ERP.

> **Contributors:** read [`rule.md`](./rule.md) before changing code. It is the engineering contract for this repository.

## Stack

- Node.js 24 LTS, Fastify 5, TypeScript (strict)
- PostgreSQL + Prisma (authoritative store)
- Redis + BullMQ (disposable cache/queue layer)
- Vitest, ESLint, Prettier, Docker

## Getting started

```bash
cp .env.example .env        # fill in local values (placeholders match docker-compose)
npm install
npm run db:generate         # generate Prisma client (no DB connection needed)
docker compose up -d        # start local PostgreSQL + Redis
npm run db:migrate:dev      # apply migrations (when they exist)
npm run dev                 # start dev server with watch mode
```

Endpoints:

- `GET /api/v1/health` — liveness (no external dependencies)
- `GET /api/v1/ready` — readiness (checks PostgreSQL + Redis connectivity)

## Project layout

```text
src/
  app.ts                  buildApp() factory (testable, no listener)
  server.ts               startup + graceful shutdown
  config/                 env validation (TypeBox)
  plugins/                config, request-context, error-handler, prisma, redis
  common/errors/          AppError types
  modules/health/         health/readiness routes
prisma/schema.prisma      minimal scaffold — business models arrive per milestone
test/api/                 Vitest + fastify inject() tests
```

## Testing

```bash
npm test            # runs smoke tests without PostgreSQL/Redis
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## Docker

- `docker-compose.yml` — local dev PostgreSQL + Redis with named volumes and health checks.
- `Dockerfile` — multi-stage production build, non-root runtime, no baked-in secrets.
