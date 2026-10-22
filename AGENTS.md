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
