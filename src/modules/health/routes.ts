import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
});

const ReadyResponse = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
  checks: Type.Object({
    database: Type.Union([Type.Literal('up'), Type.Literal('down')]),
    redis: Type.Union([Type.Literal('up'), Type.Literal('down')]),
  }),
});

export default async function healthRoutes(app: FastifyInstance) {
  // Liveness: process is up. Must not depend on external services.
  app.get('/health', { schema: { response: { 200: HealthResponse } } }, () => ({
    status: 'ok' as const,
  }));

  // Readiness: dependency connectivity, checked only when invoked.
  app.get(
    '/ready',
    { schema: { response: { 200: ReadyResponse, 503: ReadyResponse } } },
    async (request, reply) => {
      const [db, redis] = await Promise.all([
        app.prisma.$queryRaw`SELECT 1`.then(() => 'up' as const).catch(() => 'down' as const),
        app.redis
          .ping()
          .then(() => 'up' as const)
          .catch(() => 'down' as const),
      ]);

      const ready = db === 'up' && redis === 'up';
      request.log.info({ checks: { database: db, redis } }, 'readiness check');
      return reply.status(ready ? 200 : 503).send({
        status: ready ? ('ready' as const) : ('not_ready' as const),
        checks: { database: db, redis },
      });
    },
  );
}
