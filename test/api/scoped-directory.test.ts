import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { emptyEmpStore, fakeEmployee, FakeEmployeeUoW } from '../unit/employee/fakes.js';
import { fakeDepartment, fakeProject, fakeSite, FakeAuthorizer } from '../unit/department/fakes.js';
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
const PID = '00000000-0000-4000-8000-0000000000a1';
const SID = '00000000-0000-4000-8000-0000000000b1';
const DID = '00000000-0000-4000-8000-0000000000d1';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

async function makeApp(opts: { routeAllow?: boolean; svcAllow?: boolean } = {}) {
  const store = emptyEmpStore();
  const service = new EmployeeService(
    new FakeEmployeeUoW(store),
    new FakeAuthorizer(opts.svcAllow !== false),
  );
  const authService = {
    buildActorContext: async (claims: { sub?: string }) =>
      ({
        actorId: claims.sub ?? 'unknown',
        actorType: 'USER',
        sessionId: 's1',
      }) as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'pi1', sid: 's1' }),
  } as unknown as AuthService;
  const accessControl = {
    assertPermission: async () => {
      if (opts.routeAllow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;
  const app = await buildApp({
    env: testEnv,
    services: { authService, accessControl, employeeService: service, platformCompanyId: null },
  });
  return { app, store };
}

const tokenFor = (app: Awaited<ReturnType<typeof buildApp>>) => ({
  authorization: `Bearer ${app.tokenService.signAccessToken('pi1', 's1')}`,
  'x-company-id': CID,
});

const seedProjectTeam = (store: ReturnType<typeof emptyEmpStore>) => {
  store.projects.push(fakeProject({ id: PID, companyId: CID }));
  store.sites.push(fakeSite({ id: SID, companyId: CID, projectId: PID }));
  store.departments.push(
    fakeDepartment({ id: 'd-proj', companyId: CID, scopeType: 'PROJECT', projectId: PID }),
    fakeDepartment({ id: DID, companyId: CID, scopeType: 'SITE', siteId: SID }),
  );
  store.employees.push(
    fakeEmployee({
      id: 'e1',
      companyId: CID,
      employeeCode: 'WK-1',
      displayName: 'Site Worker',
      contactPhone: 'SECRET-PHONE',
      principalId: 'principal-secret',
    }),
  );
  store.memberships.push({
    id: 'm1',
    companyId: CID,
    employeeId: 'e1',
    departmentId: DID,
    isPrimary: true,
    startedAt: new Date(Date.now() - 86_400_000),
    endedAt: null,
    endReason: null,
    endNote: null,
    suspendUntil: null,
    supersededBy: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

describe('scoped workforce directory routes', () => {
  it('401 without a token on all three routes', async () => {
    const { app } = await makeApp();
    try {
      for (const url of [
        `/api/v1/org/projects/${PID}/team`,
        `/api/v1/org/sites/${SID}/team`,
        `/api/v1/departments/${DID}/members`,
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('403 when the route-level scoped permission check denies', async () => {
    const { app, store } = await makeApp({ routeAllow: false });
    seedProjectTeam(store);
    try {
      for (const url of [`/api/v1/org/projects/${PID}/team`, `/api/v1/org/sites/${SID}/team`]) {
        const res = await app.inject({ method: 'GET', url, headers: tokenFor(app) });
        expect(res.statusCode, url).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('403 on department members when the service-scope check denies', async () => {
    const { app, store } = await makeApp({ svcAllow: false });
    seedProjectTeam(store);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/departments/${DID}/members`,
        headers: tokenFor(app),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('404 on missing or cross-company targets', async () => {
    const { app, store } = await makeApp();
    const OTHER_CO_PROJECT = '00000000-0000-4000-8000-0000000000c2';
    store.projects.push(fakeProject({ id: OTHER_CO_PROJECT, companyId: 'other-company' }));
    try {
      for (const url of [
        `/api/v1/org/projects/${MISSING}/team`,
        `/api/v1/org/sites/${MISSING}/team`,
        `/api/v1/departments/${MISSING}/members`,
        `/api/v1/org/projects/${OTHER_CO_PROJECT}/team`,
      ]) {
        const res = await app.inject({ method: 'GET', url, headers: tokenFor(app) });
        expect(res.statusCode, url).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('returns the scoped team with safe fields only', async () => {
    const { app, store } = await makeApp();
    seedProjectTeam(store);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/projects/${PID}/team`,
        headers: tokenFor(app),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        items: {
          id: string;
          employeeCode: string;
          memberships: { departmentId: string; department: { scopeType: string } }[];
        }[];
        nextCursor: string | null;
      }>();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.employeeCode).toBe('WK-1');
      expect(body.items[0]?.memberships[0]?.departmentId).toBe(DID);
      const raw = res.body;
      for (const forbidden of [
        'contactPhone',
        'SECRET-PHONE',
        'principalId',
        'principal-secret',
        'loginId',
      ]) {
        expect(raw).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });

  it('site team returns only that site’s members', async () => {
    const { app, store } = await makeApp();
    seedProjectTeam(store);
    store.employees.push(fakeEmployee({ id: 'e-proj', companyId: CID }));
    store.memberships.push({
      id: 'm2',
      companyId: CID,
      employeeId: 'e-proj',
      departmentId: 'd-proj',
      isPrimary: false,
      startedAt: new Date(Date.now() - 86_400_000),
      endedAt: null,
      endReason: null,
      endNote: null,
      suspendUntil: null,
      supersededBy: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/sites/${SID}/team`,
        headers: tokenFor(app),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: { id: string }[] }>();
      expect(body.items.map((i) => i.id)).toEqual(['e1']);
    } finally {
      await app.close();
    }
  });

  it('department members honours includeEnded', async () => {
    const { app, store } = await makeApp();
    seedProjectTeam(store);
    store.memberships.push({
      id: 'm-old',
      companyId: CID,
      employeeId: 'e1',
      departmentId: DID,
      isPrimary: false,
      startedAt: new Date(Date.now() - 90 * 86_400_000),
      endedAt: new Date(Date.now() - 30 * 86_400_000),
      endReason: null,
      endNote: null,
      suspendUntil: null,
      supersededBy: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      const current = await app.inject({
        method: 'GET',
        url: `/api/v1/departments/${DID}/members`,
        headers: tokenFor(app),
      });
      const history = await app.inject({
        method: 'GET',
        url: `/api/v1/departments/${DID}/members?includeEnded=true`,
        headers: tokenFor(app),
      });
      expect(current.statusCode).toBe(200);
      expect(history.statusCode).toBe(200);
      const cur = current.json<{ items: { membershipId: string }[] }>();
      const hist = history.json<{ items: { membershipId: string }[] }>();
      expect(cur.items.map((m) => m.membershipId)).toEqual(['m1']);
      expect(hist.items.map((m) => m.membershipId).sort()).toEqual(['m-old', 'm1']);
    } finally {
      await app.close();
    }
  });

  it('422 on a malformed cursor; 400 on limit > 100', async () => {
    const { app, store } = await makeApp();
    seedProjectTeam(store);
    try {
      const bad = await app.inject({
        method: 'GET',
        url: `/api/v1/org/projects/${PID}/team?cursor=%%%not-base64%%%`,
        headers: tokenFor(app),
      });
      expect(bad.statusCode).toBe(422);
      const tooBig = await app.inject({
        method: 'GET',
        url: `/api/v1/org/projects/${PID}/team?limit=101`,
        headers: tokenFor(app),
      });
      expect(tooBig.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
