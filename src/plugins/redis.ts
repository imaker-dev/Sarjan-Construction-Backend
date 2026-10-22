import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(
  async function redisPlugin(app: FastifyInstance) {
    const config = app.config;

    // lazyConnect keeps app construction and tests free of network I/O.
    const redis = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      ...(config.REDIS_PASSWORD !== undefined ? { password: config.REDIS_PASSWORD } : {}),
      db: config.REDIS_DB,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });

    redis.on('error', (err: unknown) => {
      app.log.error({ err }, 'redis connection error');
    });

    app.decorate('redis', redis);

    app.addHook('onClose', async () => {
      redis.disconnect();
    });
  },
  { name: 'redis', dependencies: ['config'] },
);
