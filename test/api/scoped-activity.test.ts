import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { AuditService } from '../../src/modules/audit/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';

// Route-level verification of the scoped activity feed: real auth + permission
// pipeline (services substituted at the boundary, per repo test conventions).

const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
};

const CID = '00000000-0000-4000-8000-0000000000c0';
const PID = '00000000-0000-4000-8000-0000000000a1';
const SID = '00000000-0000-4000-8000-000000000051';

const authHeaders = (app: {
  tokenService: { signAccessToken: (s: string, sid: string) => string };
}) => ({
  authorization: `Bearer ${app.tokenService.signAccessToken('p1', 's1')}`,
  'x-company-id': CID,
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const authService = {
    buildActorContext: async () =>
      ({ actorId: 'p1', actorType: 'USER', sessionId: 's1' }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'p1', sid: 's1' }),
  } as unknown as AuthService;
  const accessControl = {
    assertPermission: async () => {
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => opts.allow !== false,
  } as unknown as AccessControlService;
  const auditService = {
    listCompanyLogs: async () => ({ items: [], nextCursor: null }),
    getCompanyLogById: async () => ({}),
    listScopedActivity: async () => ({ items: [], nextCursor: null }),
  } as unknown as AuditService;
  const app = await buildApp({
    env,
    services: { authService, accessControl, auditService, platformCompanyId: null },
  });
  return app;
}

describe('scoped activity routes', () => {
  it('401 without authentication', async () => {
    const app = await makeApp();
    try {
      for (const url of [
        `/api/v1/org/projects/${PID}/activity`,
        `/api/v1/org/sites/${SID}/activity`,
      ]) {
        const res = await app.inject({ method: 'GET', url, headers: { 'x-company-id': CID } });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('403 when caller lacks the scope read permission', async () => {
    const app = await makeApp({ allow: false });
    try {
      const proj = await app.inject({
        method: 'GET',
        url: `/api/v1/org/projects/${PID}/activity`,
        headers: authHeaders(app),
      });
      expect(proj.statusCode).toBe(403);
      const site = await app.inject({
        method: 'GET',
        url: `/api/v1/org/sites/${SID}/activity`,
        headers: authHeaders(app),
      });
      expect(site.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('200 with the scoped permission', async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/projects/${PID}/activity?limit=10`,
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    } finally {
      await app.close();
    }
  });
});
