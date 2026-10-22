import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export default fp(async function requestContextPlugin(app: FastifyInstance) {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request) => {
    const header = request.headers['x-correlation-id'];
    request.correlationId =
      typeof header === 'string' && header.length > 0 && header.length <= 128
        ? header
        : request.id || randomUUID();
  });
});
