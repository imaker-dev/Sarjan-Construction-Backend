import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { emptyEmpStore, fakeEmployee, FakeEmployeeUoW } from '../unit/employee/fakes.js';
import { fakeDepartment, fakeProject, fakeSite } from '../unit/department/fakes.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { ScopeTarget } from '../../src/modules/access-control/service.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';
import type { DepartmentMembership } from '@prisma/client';

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
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const S1 = '00000000-0000-4000-8000-0000000000b1';
const DA = '00000000-0000-4000-8000-0000000000d1';
const DB = '00000000-0000-4000-8000-0000000000d2';
const DS = '00000000-0000-4000-8000-0000000000d3';
const DC = '00000000-0000-4000-8000-0000000000d4';
const E1 = '00000000-0000-4000-8000-0000000000f1';
const M1 = '00000000-0000-4000-8000-0000000000e1';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

// Scope-aware authorizer mirroring the real AccessControlService surface the
// service consumes: assertPermission / hasPermission / delegationEnabled.
class ApiAuth {
  constructor(
    private readonly opts: {
      companyWide?: boolean;
      scopes?: ReadonlySet<string>;
      flag?: boolean;
    } = {},
  ) {}

  async assertPermission(_pid: string, _key: string, target: ScopeTarget): Promise<void> {
    const ok =
      target.scopeType === 'COMPANY' ? this.opts.companyWide === true : this.inScope(target);
    if (!ok) throw new AccessDeniedError();
  }

  async hasPermission(_pid: string, _key: string, target: ScopeTarget): Promise<boolean> {
    return target.scopeType === 'COMPANY' ? this.opts.companyWide === true : this.inScope(target);
  }

  async delegationEnabled(): Promise<boolean> {
    return this.opts.flag === true;
  }

  private inScope(target: ScopeTarget): boolean {
    return this.opts.scopes?.has(target.scopeId) === true;
  }
}

async function makeApp(auth: ApiAuth) {
  const store = emptyEmpStore();
  const service = new EmployeeService(new FakeEmployeeUoW(store), auth);
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
    assertPermission: async () => undefined,
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

const membership = (over: Partial<DepartmentMembership>): DepartmentMembership => ({
  id: M1,
  companyId: CID,
  employeeId: E1,
  departmentId: DA,
  isPrimary: false,
  startedAt: new Date(Date.now() - 30 * 86_400_000),
  endedAt: null,
  endReason: null,
  endNote: null,
  suspendUntil: null,
  supersededBy: null,
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const seed = (store: ReturnType<typeof emptyEmpStore>) => {
  store.projects.push(
    fakeProject({ id: P1, companyId: CID }),
    fakeProject({ id: P2, companyId: CID }),
  );
  store.sites.push(fakeSite({ id: S1, companyId: CID, projectId: P1 }));
  store.departments.push(
    fakeDepartment({
      id: DA,
      companyId: CID,
      scopeType: 'PROJECT',
      projectId: P1,
      status: 'ACTIVE',
    }),
    fakeDepartment({
      id: DB,
      companyId: CID,
      scopeType: 'PROJECT',
      projectId: P2,
      status: 'ACTIVE',
    }),
    fakeDepartment({ id: DS, companyId: CID, scopeType: 'SITE', siteId: S1, status: 'ACTIVE' }),
    fakeDepartment({ id: DC, companyId: CID, scopeType: 'COMPANY', status: 'ACTIVE' }),
  );
  store.employees.push(fakeEmployee({ id: E1, companyId: CID, status: 'ACTIVE' }));
};

describe('scoped membership mutation routes', () => {
  it('401 without a token on all four routes', async () => {
    const { app } = await makeApp(new ApiAuth({ flag: true }));
    try {
      // Schema validation precedes auth — send valid bodies to reach the 401.
      for (const [method, url, payload] of [
        ['POST', `/api/v1/departments/${DA}/members`, { employeeId: E1 }],
        [
          'PATCH',
          `/api/v1/departments/${DA}/members/${M1}`,
          { isPrimary: true, expectedVersion: 0 },
        ],
        ['POST', `/api/v1/departments/${DA}/members/${M1}/end`, { expectedVersion: 0 }],
        [
          'POST',
          `/api/v1/departments/${DA}/members/${M1}/transfer`,
          { toDepartmentId: DS, expectedVersion: 0 },
        ],
      ] as const) {
        const res = await app.inject({ method, url, payload });
        expect(res.statusCode, url).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('adds a member inside the caller boundary', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members`,
        headers: tokenFor(app),
        payload: { employeeId: E1 },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ employeeId: string; departmentId: string }>();
      expect(body.employeeId).toBe(E1);
      expect(body.departmentId).toBe(DA);
    } finally {
      await app.close();
    }
  });

  it('403 DELEGATION_DISABLED when the placement flag is off or absent', async () => {
    for (const auth of [
      new ApiAuth({ scopes: new Set([P1]), flag: false }),
      new ApiAuth({ scopes: new Set([P1]) }),
    ]) {
      const { app, store } = await makeApp(auth);
      seed(store);
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/departments/${DA}/members`,
          headers: tokenFor(app),
          payload: { employeeId: E1 },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    }
  });

  it('company admins use EMPLOYEE_MANAGE@COMPANY without the flag', async () => {
    const auth = new ApiAuth({ companyWide: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DC}/members`,
        headers: tokenFor(app),
        payload: { employeeId: E1 },
      });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('403 on sibling/out-of-scope departments even with the flag on', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      for (const dept of [DB, DC]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/departments/${dept}/members`,
          headers: tokenFor(app),
          payload: { employeeId: E1 },
        });
        expect(res.statusCode, dept).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('404 on missing/cross-company departments; 400 on non-UUID params', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    store.departments.push(
      fakeDepartment({
        id: '00000000-0000-4000-8000-0000000000d9',
        companyId: 'other-company',
        scopeType: 'COMPANY',
        status: 'ACTIVE',
      }),
    );
    try {
      const missing = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${MISSING}/members`,
        headers: tokenFor(app),
        payload: { employeeId: E1 },
      });
      expect(missing.statusCode).toBe(404);
      const badUuid = await app.inject({
        method: 'POST',
        url: '/api/v1/departments/not-a-uuid/members',
        headers: tokenFor(app),
        payload: { employeeId: E1 },
      });
      expect(badUuid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('422 on unknown body fields and caller-supplied endedAt', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      for (const payload of [
        { employeeId: E1, endedAt: new Date().toISOString() },
        { employeeId: E1, version: 3 },
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/departments/${DA}/members`,
          headers: tokenFor(app),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
      expect(store.memberships).toHaveLength(0);
      // startedAt on transfer is rejected — transfers are immediate.
      store.memberships.push(membership({}));
      const xfer = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members/${M1}/transfer`,
        headers: tokenFor(app),
        payload: {
          toDepartmentId: DS,
          expectedVersion: 0,
          startedAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      expect(xfer.statusCode).toBe(422);
      expect(xfer.json<{ error: { code: string } }>().error.code).toBe('UNKNOWN_FIELD');
      expect(store.memberships.find((m) => m.id === M1)?.endedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('422 on a past-dated startedAt and on future-dated primary', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      const past = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members`,
        headers: tokenFor(app),
        payload: { employeeId: E1, startedAt: new Date(Date.now() - 86_400_000).toISOString() },
      });
      expect(past.statusCode).toBe(422);
      const futurePrimary = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members`,
        headers: tokenFor(app),
        payload: {
          employeeId: E1,
          isPrimary: true,
          startedAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      expect(futurePrimary.statusCode).toBe(422);
      expect(store.memberships).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('409 on out-of-scope primary, stale version, and duplicate active membership', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    // Primary parked in sibling project P2 → opaque 409.
    store.memberships.push(membership({ departmentId: DB, isPrimary: true }));
    try {
      const outOfScope = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members`,
        headers: tokenFor(app),
        payload: { employeeId: E1, isPrimary: true },
      });
      expect(outOfScope.statusCode).toBe(409);
      expect(outOfScope.json<{ error: { code: string } }>().error.code).toBe(
        'PRIMARY_OUT_OF_SCOPE',
      );

      // Same-department active membership → deliberate 409, not raw P2002.
      store.memberships.push(membership({ id: MISSING, departmentId: DA }));
      const dup = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members`,
        headers: tokenFor(app),
        payload: { employeeId: E1 },
      });
      expect(dup.statusCode).toBe(409);

      // Stale expectedVersion → 409 on the scoped routes.
      const stale = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members/${MISSING}/end`,
        headers: tokenFor(app),
        payload: { expectedVersion: 99 },
      });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('transfer is atomic across source and destination departments', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    store.memberships.push(membership({}));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members/${M1}/transfer`,
        headers: tokenFor(app),
        payload: { toDepartmentId: DS, expectedVersion: 0 },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ departmentId: string }>();
      expect(body.departmentId).toBe(DS);
      const source = store.memberships.find((m) => m.id === M1);
      expect(source?.endedAt).not.toBeNull();
      expect(store.memberships.some((m) => m.departmentId === DS && m.endedAt === null)).toBe(true);
      // One coherent audit event for the whole transfer.
      const audits = store.auditLog.filter((a) => a.action === 'MEMBERSHIP_TRANSFERRED');
      expect(audits).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('422 on transfer to an inactive department; 403 on out-of-scope destination', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    const DEAD = '00000000-0000-4000-8000-0000000000d8';
    store.departments.push(
      fakeDepartment({
        id: DEAD,
        companyId: CID,
        scopeType: 'SITE',
        siteId: S1,
        status: 'INACTIVE',
      }),
    );
    store.memberships.push(membership({}));
    try {
      const inactive = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members/${M1}/transfer`,
        headers: tokenFor(app),
        payload: { toDepartmentId: DEAD, expectedVersion: 0 },
      });
      expect(inactive.statusCode).toBe(422);
      const outOfScope = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/members/${M1}/transfer`,
        headers: tokenFor(app),
        payload: { toDepartmentId: DB, expectedVersion: 0 },
      });
      expect(outOfScope.statusCode).toBe(403);
      // Nothing changed.
      expect(store.memberships.find((m) => m.id === M1)?.endedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});
