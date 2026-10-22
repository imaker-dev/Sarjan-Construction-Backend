import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import configPlugin from './plugins/config.js';
import requestContextPlugin from './plugins/request-context.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import healthRoutes from './modules/health/routes.js';

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const logLevel = opts.env?.LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info';

  const app = Fastify({
    logger: {
      level: logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[Redacted]',
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Infrastructure plugins in explicit dependency order.
  await app.register(configPlugin, { ...(opts.env !== undefined ? { env: opts.env } : {}) });
  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);

  // Domain route plugins, versioned.
  await app.register(healthRoutes, { prefix: '/api/v1' });

  return app;
}
