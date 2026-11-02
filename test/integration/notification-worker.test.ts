import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { NotificationWorker } from '../../src/modules/notification/worker.js';
import { resolveTestRedisUrl } from './test-redis-url.js';
import type { NotificationService } from '../../src/modules/notification/service.js';

// Production-like worker startup + job processing + clean shutdown.
// Disposable Redis only (loopback:56379) — no BullMQ worker without a real
// store; the service dependency is a stub so no DB is required.
const redisUrl = resolveTestRedisUrl(process.env.TEST_REDIS_URL);
const run = redisUrl === null ? it.skip : it;

let redis: Redis | undefined;
const workers: NotificationWorker[] = [];

beforeAll(() => {
  if (redisUrl !== null) {
    redis = new Redis(redisUrl);
    redis.on('error', () => undefined);
  }
});

afterAll(async () => {
  for (const w of workers) await w.close();
  redis?.disconnect();
});

describe('NotificationWorker lifecycle (disposable Redis)', () => {
  run(
    'starts, processes a batch job, and shuts down cleanly',
    async () => {
      if (redis === undefined) throw new Error('unreachable');
      const processed: string[] = [];
      const service = {
        processBatch: async () => {
          processed.push('batch');
          return { processed: 0 };
        },
        sweep: async () => {
          processed.push('sweep');
          return { swept: 0 };
        },
      } as unknown as NotificationService;

      const worker = new NotificationWorker(
        service,
        redis.duplicate({ maxRetriesPerRequest: null }),
      );
      workers.push(worker);

      // Production-like startup — BullMQ Worker boots against the dedicated
      // client (the maxRetriesPerRequest:null fix makes this possible).
      await worker.start();
      expect(worker.isReady()).toBe(true);

      // One job-processing path: wait for the scheduled relay/sweep tick.
      const deadline = Date.now() + 10_000;
      while (processed.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(processed.length).toBeGreaterThan(0);

      // Graceful shutdown — no leak of the dedicated connection.
      await worker.close();
      expect(worker.isReady()).toBe(false);
    },
    20_000,
  );
});
