import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { emptyEmpStore, FakeEmployeeUoW } from '../unit/employee/fakes.js';
import { FakeAuthorizer } from '../unit/department/fakes.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';

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

const CID = '00000000-0000-4000-8000-0000000000c1';
const EID = '00000000-0000-4000-8000-0000000000e1';

async function makeApp(opts: { allow?: boolean; actorId?: string } = {}) {
  const store = emptyEmpStore();
  const service = new EmployeeService(new FakeEmployeeUoW(store), new FakeAuthorizer(true));
  const authService = {
    buildActorContext: async (claims: { sub?: string }) =>
      ({
        actorId: claims.sub ?? 'unknown',
        actorType: 'USER',
        sessionId: 's1',
      }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: opts.actorId ?? 'admin1', sid: 's1' }),
  } as unknown as AuthService;
  const accessControl = {
    assertPermission: async () => {
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;
  const app = await buildApp({
    env: testEnv,
    services: {
      authService,
      accessControl,
      employeeService: service,
      platformCompanyId: null,
    },
  });
  return { app, store };
}

describe('employee routes', () => {
  it('401 without a token', async () => {
    const { app } = await makeApp();
    try {
      for (const url of ['/api/v1/employees', `/api/v1/employees/${EID}/status`]) {
        const res = await app.inject({
          method: url.includes('status') ? 'POST' : 'GET',
          url,
          headers: { 'x-company-id': CID },
          ...(url.includes('status') ? { payload: { to: 'INACTIVE', expectedVersion: 0 } } : {}),
        });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('403 when authenticated without EMPLOYEE permission', async () => {
    const { app } = await makeApp({ allow: false });
    try {
      const token = app.tokenService.signAccessToken('no-perm', 's1');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/employees',
        headers: { authorization: `Bearer ${token}`, 'x-company-id': CID },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('authorized create/update/list/status succeed end-to-end', async () => {
    const { app } = await makeApp({ allow: true });
    try {
      const token = app.tokenService.signAccessToken('admin1', 's1');
      const headers = { authorization: `Bearer ${token}`, 'x-company-id': CID };
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/employees',
        headers,
        payload: { employeeCode: 'E-01', displayName: 'Ram', engagementType: 'DIRECT_EMPLOYEE' },
      });
      expect(create.statusCode).toBe(200);
      const emp = create.json<{ id: string; version: number; status: string }>();
      const list = await app.inject({ method: 'GET', url: '/api/v1/employees', headers });
      expect(list.json<{ employees: unknown[] }>().employees).toHaveLength(1);
      const update = await app.inject({
        method: 'PATCH',
        url: `/api/v1/employees/${emp.id}`,
        headers,
        payload: { displayName: 'Ram Kumar', expectedVersion: emp.version },
      });
      expect(update.statusCode).toBe(200);
      const status = await app.inject({
        method: 'POST',
        url: `/api/v1/employees/${emp.id}/status`,
        headers,
        payload: { to: 'INACTIVE', expectedVersion: emp.version + 1 },
      });
      expect(status.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rejects mutations without expectedVersion and rejects stale versions', async () => {
    const { app } = await makeApp({ allow: true });
    try {
      const token = app.tokenService.signAccessToken('admin1', 's1');
      const headers = { authorization: `Bearer ${token}`, 'x-company-id': CID };
      const missing = await app.inject({
        method: 'PATCH',
        url: `/api/v1/employees/${EID}`,
        headers,
        payload: { displayName: 'X' },
      });
      expect(missing.statusCode).toBe(400); // schema requires expectedVersion
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/employees',
        headers,
        payload: { employeeCode: 'E-9', displayName: 'Y', engagementType: 'DIRECT_EMPLOYEE' },
      });
      const emp = create.json<{ id: string; version: number }>();
      const stale = await app.inject({
        method: 'PATCH',
        url: `/api/v1/employees/${emp.id}`,
        headers,
        payload: { displayName: 'X', expectedVersion: 999 },
      });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('cross-company access returns not-found, not data', async () => {
    const { app } = await makeApp({ allow: true });
    try {
      const token = app.tokenService.signAccessToken('admin1', 's1');
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/employees',
        headers: { authorization: `Bearer ${token}`, 'x-company-id': CID },
        payload: { employeeCode: 'E-1', displayName: 'Z', engagementType: 'DIRECT_EMPLOYEE' },
      });
      const emp = create.json<{ id: string }>();
      const other = await app.inject({
        method: 'PATCH',
        url: `/api/v1/employees/${emp.id}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-company-id': '00000000-0000-4000-8000-0000000000c2',
        },
        payload: { displayName: 'X', expectedVersion: 0 },
      });
      expect(other.statusCode).toBe(404);
      expect(other.json<{ error: { code: string } }>().error.code).toContain('NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});
