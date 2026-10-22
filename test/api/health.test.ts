import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

// Smoke test: app constructs and /health responds without PostgreSQL or Redis.
const testEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
};

describe('GET /api/v1/health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ env: testEnv });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 ok for liveness without external services', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nonexistent' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBeDefined();
    expect(body.error.requestId).toBeDefined();
  });
});
