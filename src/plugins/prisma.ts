import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

// Explicit pool sizing — pg defaults are max:10 / idle:10s / no connect
// timeout; a bounded connect timeout keeps a dead database from holding
// requests forever.
const POOL_CONFIG: pg.PoolConfig = {
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
};

export default fp(
  async function prismaPlugin(app: FastifyInstance) {
    // Prisma 7: queries run through the pg driver adapter. The pool is
    // caller-owned — we create and close it; PrismaClient only disconnects.
    const pool = new pg.Pool({
      ...POOL_CONFIG,
      connectionString: app.config.DATABASE_URL,
    });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    app.decorate('prisma', prisma);

    app.addHook('onClose', async () => {
      await prisma.$disconnect();
      await pool.end();
    });
  },
  { name: 'prisma' },
);
