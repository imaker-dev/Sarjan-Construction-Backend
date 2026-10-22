import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp(
  async function prismaPlugin(app: FastifyInstance) {
    // PrismaClient connects lazily on first query; constructing it does not
    // open a database connection, so buildApp() stays usable in tests.
    const prisma = new PrismaClient();

    app.decorate('prisma', prisma);

    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });
  },
  { name: 'prisma' },
);
