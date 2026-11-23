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

    // lazyConnect means the client never connects on its own, and
    // enableOfflineQueue:false makes every command fail while disconnected.
    // Connect during boot so requests always hit a ready client — a dead
    // Redis fails the app start outright (fail-closed, same as the prod
    // rate-limit client). Tests skip this so buildApp() stays free of
    // network I/O.
    if (app.config.NODE_ENV !== 'test') {
      app.addHook('onReady', async () => {
        await redis.connect();
      });
    }

    app.decorate('redis', redis);

    app.addHook('onClose', async () => {
      redis.disconnect();
    });
  },
  { name: 'redis', dependencies: ['config'] },
);
