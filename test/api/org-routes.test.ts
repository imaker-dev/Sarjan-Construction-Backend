import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

const testEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
};

const uuid = '00000000-0000-4000-8000-000000000001';

// Unauthenticated requests to organization/department routes must 401 —
// service-level checks are covered by unit tests.
describe('org + department routes require authentication', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env: testEnv });
  });
  afterAll(async () => {
    await app.close();
  });

  const cases: [string, string, Record<string, unknown>?][] = [
    ['GET', '/api/v1/org/company'],
    ['PATCH', '/api/v1/org/company', { name: 'X' }],
    ['POST', '/api/v1/org/head-offices', { code: 'HO', name: 'HQ' }],
    ['GET', '/api/v1/org/head-offices'],
    ['PATCH', `/api/v1/org/head-offices/${uuid}`, { name: 'X' }],
    ['POST', `/api/v1/org/head-offices/${uuid}/status`, { to: 'ARCHIVED' }],
    [
      'POST',
      '/api/v1/org/projects',
      { headOfficeId: uuid, code: 'P1', name: 'P1', timezone: 'Asia/Kolkata' },
    ],
    ['GET', '/api/v1/org/projects'],
    ['PATCH', `/api/v1/org/projects/${uuid}`, { name: 'X' }],
    ['POST', `/api/v1/org/projects/${uuid}/status`, { to: 'ARCHIVED' }],
    ['POST', '/api/v1/org/sites', { projectId: uuid, code: 'S1', name: 'S1' }],
    ['GET', '/api/v1/org/sites'],
    ['PATCH', `/api/v1/org/sites/${uuid}`, { name: 'X' }],
    ['POST', `/api/v1/org/sites/${uuid}/status`, { to: 'ARCHIVED' }],
    [
      'POST',
      '/api/v1/departments',
      { scopeType: 'COMPANY', code: 'FIN', name: 'Finance', category: 'FINANCE' },
    ],
    ['GET', '/api/v1/departments'],
    ['PATCH', `/api/v1/departments/${uuid}`, { name: 'X' }],
    ['POST', `/api/v1/departments/${uuid}/status`, { to: 'ACTIVE' }],
  ];

  for (const [method, url, payload] of cases) {
    it(`${method} ${url} → 401`, async () => {
      const res = await app.inject({
        method,
        url,
        headers: { 'x-company-id': uuid },
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode).toBe(401);
    });
  }
});
