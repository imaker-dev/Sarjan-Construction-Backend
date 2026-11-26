import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { DelegationService } from '../../src/modules/organization/delegation.js';
import type { OrganizationService } from '../../src/modules/organization/service.js';
import type { DepartmentService } from '../../src/modules/department/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import { VersionConflictError } from '../../src/modules/organization/errors.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';
import type { ScopeTarget } from '../../src/modules/access-control/service.js';

// Route-level checks for company delegation switches + scoped site/dept
// mutation targets. Services are substituted at the boundary; the real auth,
// tenant-guard, and permission pipeline runs.

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

interface Harness {
  targets: ScopeTarget[];
  keys: string[];
}

async function makeApp(opts: { allow?: boolean; delegationError?: Error } = {}) {
  const calls: Harness = { targets: [], keys: [] };
  const authService = {
    buildActorContext: async () =>
      ({ actorId: 'p1', actorType: 'USER', sessionId: 's1' }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'p1', sid: 's1' }),
  } as unknown as AuthService;
  const accessControl = {
    assertPermission: async (_pid: string, key: string, target: ScopeTarget) => {
      calls.keys.push(key);
      calls.targets.push(target);
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => opts.allow !== false,
  } as unknown as AccessControlService;
  const delegationService = {
    getPolicy: async () => ({
      siteCreate: false,
      siteUpdate: true,
      deptManage: false,
      version: 3,
    }),
    updatePolicy: async () => {
      if (opts.delegationError !== undefined) throw opts.delegationError;
      return { siteCreate: true, siteUpdate: true, deptManage: false, version: 4 };
    },
    isEnabled: async () => false,
  } as unknown as DelegationService;
  const organizationService = {
    createSite: async () => ({ id: SID, code: 's1', name: 'S' }),
    updateSite: async () => ({ id: SID }),
    getSite: async () => ({ id: SID }),
    listSites: async () => ({ items: [], nextCursor: null }),
  } as unknown as OrganizationService;
  const departmentService = {
    createDepartment: async () => ({ id: 'd1', name: 'Crew' }),
    getDepartment: async () => ({ id: 'd1' }),
    listDepartments: async () => ({ items: [], nextCursor: null }),
  } as unknown as DepartmentService;
  const app = await buildApp({
    env,
    services: {
      authService,
      accessControl,
      delegationService,
      organizationService,
      departmentService,
      platformCompanyId: null,
    },
  });
  return { app, calls };
}

describe('delegation policy routes', () => {
  it('401 without authentication', async () => {
    const { app } = await makeApp();
    try {
      const get = await app.inject({
        method: 'GET',
        url: '/api/v1/org/company/delegations',
        headers: { 'x-company-id': CID },
      });
      expect(get.statusCode).toBe(401);
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/company/delegations',
        headers: { 'x-company-id': CID },
        payload: { expectedVersion: 0, siteCreate: true },
      });
      expect(patch.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('403 without company admin permission', async () => {
    const { app } = await makeApp({ allow: false });
    try {
      const get = await app.inject({
        method: 'GET',
        url: '/api/v1/org/company/delegations',
        headers: authHeaders(app),
      });
      expect(get.statusCode).toBe(403);
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/company/delegations',
        headers: authHeaders(app),
        payload: { expectedVersion: 0, siteCreate: true },
      });
      expect(patch.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET returns the policy for an authorized admin', async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/company/delegations',
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        siteCreate: false,
        siteUpdate: true,
        deptManage: false,
        version: 3,
      });
    } finally {
      await app.close();
    }
  });

  it('PATCH updates switches and returns the new version', async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/company/delegations',
        headers: authHeaders(app),
        payload: { expectedVersion: 3, siteCreate: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        siteCreate: true,
        siteUpdate: true,
        deptManage: false,
        version: 4,
      });
    } finally {
      await app.close();
    }
  });

  it('PATCH rejects unknown policy fields', async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/company/delegations',
        headers: authHeaders(app),
        payload: { expectedVersion: 3, bogusFlag: true },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('UNKNOWN_FIELD');
    } finally {
      await app.close();
    }
  });

  it('PATCH maps a stale version to the conflict response', async () => {
    const { app } = await makeApp({
      delegationError: new VersionConflictError('DELEGATION_POLICY'),
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/company/delegations',
        headers: authHeaders(app),
        payload: { expectedVersion: 0, siteCreate: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('VERSION_CONFLICT');
    } finally {
      await app.close();
    }
  });
});

describe('scoped mutation targets', () => {
  it('site create evaluates permission at the body project scope', async () => {
    const { app, calls } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/sites',
        headers: authHeaders(app),
        payload: { projectId: PID, code: 's1', name: 'S' },
      });
      expect(res.statusCode).toBe(201);
      expect(calls.keys).toContain('ORG_SITE_CREATE');
      const idx = calls.keys.indexOf('ORG_SITE_CREATE');
      expect(calls.targets[idx]).toEqual({
        companyId: CID,
        scopeType: 'PROJECT',
        scopeId: PID,
      });
    } finally {
      await app.close();
    }
  });

  it('site update evaluates permission at the site scope', async () => {
    const { app, calls } = await makeApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/org/sites/${SID}`,
        headers: authHeaders(app),
        payload: { expectedVersion: 0, name: 'S2' },
      });
      expect(res.statusCode).toBe(200);
      const idx = calls.keys.indexOf('ORG_SITE_UPDATE');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(calls.targets[idx]).toEqual({ companyId: CID, scopeType: 'SITE', scopeId: SID });
    } finally {
      await app.close();
    }
  });

  it('project-scoped department create evaluates at the declared scope', async () => {
    const { app, calls } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/departments',
        headers: authHeaders(app),
        payload: {
          scopeType: 'PROJECT',
          scopeId: PID,
          code: 'crew',
          name: 'Crew',
          category: 'OPERATIONS',
        },
      });
      expect(res.statusCode).toBe(200);
      const idx = calls.keys.indexOf('DEPARTMENT_CONFIGURE');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(calls.targets[idx]).toEqual({
        companyId: CID,
        scopeType: 'PROJECT',
        scopeId: PID,
      });
    } finally {
      await app.close();
    }
  });

  it('company-scope department create keeps the company target', async () => {
    const { app, calls } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/departments',
        headers: authHeaders(app),
        payload: {
          scopeType: 'COMPANY',
          code: 'hqops',
          name: 'HQ Ops',
          category: 'ADMINISTRATION',
        },
      });
      expect(res.statusCode).toBe(200);
      const idx = calls.keys.indexOf('DEPARTMENT_CONFIGURE');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(calls.targets[idx]).toEqual({
        companyId: CID,
        scopeType: 'COMPANY',
        scopeId: CID,
      });
    } finally {
      await app.close();
    }
  });

  it('scoped site create denied when permission check fails', async () => {
    const { app } = await makeApp({ allow: false });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/sites',
        headers: authHeaders(app),
        payload: { projectId: PID, code: 's1', name: 'S' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('site list with projectId evaluates ORG_SITE_READ at PROJECT scope', async () => {
    const { app, calls } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/sites?projectId=${PID}`,
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      const idx = calls.keys.indexOf('ORG_SITE_READ');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(calls.targets[idx]).toEqual({
        companyId: CID,
        scopeType: 'PROJECT',
        scopeId: PID,
      });
    } finally {
      await app.close();
    }
  });

  it('site list without projectId evaluates ORG_SITE_READ at COMPANY scope', async () => {
    const { app, calls } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/sites',
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      const idx = calls.keys.indexOf('ORG_SITE_READ');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(calls.targets[idx]).toEqual({
        companyId: CID,
        scopeType: 'COMPANY',
        scopeId: CID,
      });
    } finally {
      await app.close();
    }
  });
});
