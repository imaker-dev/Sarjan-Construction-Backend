import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { emptyEmpStore, FakeEmployeeUoW } from '../unit/employee/fakes.js';
import { fakeDepartment, fakeProject, fakeSite } from '../unit/department/fakes.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { ScopeTarget } from '../../src/modules/access-control/service.js';
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
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const S1 = '00000000-0000-4000-8000-0000000000b1';
const DA = '00000000-0000-4000-8000-0000000000d1';
const DB = '00000000-0000-4000-8000-0000000000d2';
const DS = '00000000-0000-4000-8000-0000000000d3';
const DC = '00000000-0000-4000-8000-0000000000d4';
const M1 = '00000000-0000-4000-8000-0000000000e1';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const DOC1 = '00000000-0000-4000-8000-00000000d001';
const DOC_GONE = '00000000-0000-4000-8000-00000000d002';

const MIN_BODY = {
  employeeCode: 'WK-0001',
  displayName: 'Ramesh Kumar',
  engagementType: 'DAILY_WAGE',
};

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
};

describe('scoped workforce onboarding routes', () => {
  it('401 without a token on both routes', async () => {
    const { app } = await makeApp(new ApiAuth({ flag: true }));
    try {
      for (const [method, url, payload] of [
        ['POST', `/api/v1/departments/${DA}/onboard`, MIN_BODY],
      ] as const) {
        const res = await app.inject({ method, url, payload });
        expect(res.statusCode, url).toBe(401);
      }
      const get = await app.inject({
        method: 'GET',
        url: `/api/v1/departments/${DA}/members/${M1}`,
      });
      expect(get.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('onboards into a project department — principalId null, membership primary', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/onboard`,
        headers: tokenFor(app),
        payload: {
          ...MIN_BODY,
          designation: 'Mason',
          contactPhone: '9000000001',
          emergencyContactName: 'Sita',
          emergencyContactPhone: '9000000002',
          joiningDate: '2024-03-01',
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{
        employee: {
          employeeCode: string;
          principalId: string | null;
          contactPhone: string | null;
          status: string;
        };
        membership: { isPrimary: boolean; departmentId: string; endedAt: string | null };
        documentsLinked: number;
      }>();
      expect(body.employee.principalId).toBeNull();
      expect(body.employee.status).toBe('ACTIVE');
      expect(body.membership.isPrimary).toBe(true);
      expect(body.membership.endedAt).toBeNull();
      expect(body.documentsLinked).toBe(0);
      expect(store.employees).toHaveLength(1);
      expect(store.auditLog.some((a) => a.action === 'EMPLOYEE_ONBOARDED')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('403 DELEGATION_DISABLED when employeeOnboard is off or policy absent', async () => {
    for (const auth of [
      new ApiAuth({ scopes: new Set([P1]), flag: false }),
      new ApiAuth({ scopes: new Set([P1]) }),
    ]) {
      const { app, store } = await makeApp(auth);
      seed(store);
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/departments/${DA}/onboard`,
          headers: tokenFor(app),
          payload: MIN_BODY,
        });
        expect(res.statusCode).toBe(403);
        expect(store.employees).toHaveLength(0);
      } finally {
        await app.close();
      }
    }
  });

  it('company admin bypasses the flag and can use company-scope departments', async () => {
    const { app, store } = await makeApp(new ApiAuth({ companyWide: true }));
    seed(store);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DC}/onboard`,
        headers: tokenFor(app),
        payload: MIN_BODY,
      });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('403 on company-scope and sibling-project departments for scoped holders', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      for (const dept of [DB, DC]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/departments/${dept}/onboard`,
          headers: tokenFor(app),
          payload: MIN_BODY,
        });
        expect(res.statusCode, dept).toBe(403);
      }
      expect(store.employees).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('404 missing department; 400 non-UUID param; 409 duplicate code', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      const missing = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${MISSING}/onboard`,
        headers: tokenFor(app),
        payload: MIN_BODY,
      });
      expect(missing.statusCode).toBe(404);
      const badUuid = await app.inject({
        method: 'POST',
        url: '/api/v1/departments/not-a-uuid/onboard',
        headers: tokenFor(app),
        payload: MIN_BODY,
      });
      expect(badUuid.statusCode).toBe(400);
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/onboard`,
        headers: tokenFor(app),
        payload: MIN_BODY,
      });
      expect(first.statusCode).toBe(200);
      const dup = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/onboard`,
        headers: tokenFor(app),
        payload: MIN_BODY,
      });
      expect(dup.statusCode).toBe(409);
      expect(store.employees).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('422 on caller-controlled fields — login, status, membership fields rejected', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      for (const extra of [
        { principalId: M1 },
        { loginId: 'worker@example.com' },
        { password: 'hunter2' },
        { status: 'ARCHIVED' },
        { isPrimary: true },
        { startedAt: new Date().toISOString() },
        { endedAt: new Date().toISOString() },
        { companyId: 'other' },
        { expectedVersion: 3 },
        { idempotencyKey: 'k' },
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/departments/${DA}/onboard`,
          headers: tokenFor(app),
          payload: { ...MIN_BODY, ...extra },
        });
        expect(res.statusCode, JSON.stringify(extra)).toBe(422);
      }
      expect(store.employees).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('422 on emergency-contact half-pair and invalid document ref; 400 on bad enum', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    try {
      const half = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/onboard`,
        headers: tokenFor(app),
        payload: { ...MIN_BODY, emergencyContactName: 'Sita' },
      });
      expect(half.statusCode).toBe(422);
      const badDoc = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/onboard`,
        headers: tokenFor(app),
        payload: {
          ...MIN_BODY,
          documents: [{ documentId: DOC_GONE, documentType: 'PHOTO', title: 'x' }],
        },
      });
      expect(badDoc.statusCode).toBe(422);
      const badEnum = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/onboard`,
        headers: tokenFor(app),
        payload: { ...MIN_BODY, engagementType: 'SUPERADMIN' },
      });
      expect(badEnum.statusCode).toBe(400);
      expect(store.employees).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('links available documents atomically; member detail returns contact fields', async () => {
    const auth = new ApiAuth({ scopes: new Set([P1, S1]), flag: true });
    const { app, store } = await makeApp(auth);
    seed(store);
    store.documents.push({ id: DOC1, companyId: CID, status: 'AVAILABLE' });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/departments/${DA}/onboard`,
        headers: tokenFor(app),
        payload: {
          ...MIN_BODY,
          contactPhone: '9000000001',
          emergencyContactName: 'Sita',
          emergencyContactPhone: '9000000002',
          documents: [{ documentId: DOC1, documentType: 'PHOTO', title: 'ID photo' }],
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      const created = res.json<{
        membership: { membershipId: string };
        documentsLinked: number;
      }>();
      expect(created.documentsLinked).toBe(1);
      expect(store.employeeDocuments).toHaveLength(1);

      // Member detail — the scoped read-back path for contact fields.
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/departments/${DA}/members/${created.membership.membershipId}`,
        headers: tokenFor(app),
      });
      expect(detail.statusCode, detail.body).toBe(200);
      const emp = detail.json<{ employee: Record<string, unknown> | null }>().employee;
      expect(emp?.contactPhone).toBe('9000000001');
      expect(emp?.emergencyContactName).toBe('Sita');
      expect(emp).not.toHaveProperty('principalId');

      // Roster list keeps the safe projection — no contact fields.
      const roster = await app.inject({
        method: 'GET',
        url: `/api/v1/departments/${DA}/members`,
        headers: tokenFor(app),
      });
      const row = roster.json<{ items: { employee: Record<string, unknown> | null }[] }>().items[0];
      expect(row?.employee).not.toHaveProperty('contactPhone');
      expect(row?.employee).not.toHaveProperty('emergencyContactName');
    } finally {
      await app.close();
    }
  });
});
