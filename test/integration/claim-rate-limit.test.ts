import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import type { PlatformService } from '../../src/modules/platform/service.js';
import { resolveTestRedisUrl } from './test-redis-url.js';

// Shared-Redis rate-limit verification — two app instances must share ONE
// limit via the same Redis store, and a Redis outage must fail CLOSED (no
// per-process fallback) in production configuration.
const redisUrl = resolveTestRedisUrl(process.env.TEST_REDIS_URL);
const run = redisUrl === null ? it.skip : it;

const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '56379',
  NOTIFICATIONS_WORKER: 'off', // isolate rate-limit verification (see report)
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
};

const fakePlatformService = {
  consumeClaim: async () => ({ status: 'CLAIMED' }),
} as unknown as PlatformService;

const CLAIM_BODY = { token: 'x'.repeat(64), password: 'y'.repeat(12) };
const claim = (app: FastifyInstance) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/claim', payload: CLAIM_BODY });

let redis: Redis | undefined;
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  if (redisUrl !== null) {
    redis = new Redis(redisUrl);
    redis.on('error', () => undefined); // prevent unhandled-error noise
    await redis.flushall(); // limiter keys persist across runs — start clean
  }
});
afterAll(async () => {
  for (const a of apps) await a.close();
  redis?.disconnect();
});

describe('shared Redis claim rate limit (disposable Redis)', () => {
  run(
    'two app instances share one limit across the same client',
    async () => {
      const a1 = await buildApp({ env, services: { platformService: fakePlatformService } });
      const a2 = await buildApp({ env, services: { platformService: fakePlatformService } });
      apps.push(a1, a2);
      // 10 attempts allowed in 5min per client — split across both instances.
      let ok = 0;
      let limited = 0;
      const statuses = new Map<number, number>();
      const instances: FastifyInstance[] = [
        ...new Array<FastifyInstance>(8).fill(a1),
        ...new Array<FastifyInstance>(8).fill(a2),
      ];
      for (const app of instances) {
        const res = await claim(app);
        statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
        if (res.statusCode === 429) limited += 1;
        else if (res.statusCode === 200) ok += 1;
      }
      expect(statuses.get(500) ?? 0).toBe(0); // no limiter-store errors
      expect(ok).toBe(10); // shared limit, NOT 10-per-instance
      expect(limited).toBe(6);
    },
    30_000,
  );

  run(
    'Redis outage fails closed — no in-memory fallback',
    async () => {
      // Dead Redis in production config: onReady's explicit connect() fails at
      // first request → limited requests error (>=500), never a silent
      // per-process limit.
      const app = await buildApp({
        env: { ...env, REDIS_PORT: '56999' },
        services: { platformService: fakePlatformService },
      });
      apps.push(app);
      // Fail closed: the request errors outright (rejected inject or >=500) —
      // never silently allowed by a per-process limit.
      await expect(claim(app)).rejects.toThrow('Connection is closed');
    },
    30_000,
  );
});
