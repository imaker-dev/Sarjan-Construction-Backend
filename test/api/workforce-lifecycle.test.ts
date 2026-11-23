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
const S1 = '00000000-0000-4000-8000-0000000000b1';
const DA = '00000000-0000-4000-8000-0000000000d1';
const E1 = '00000000-0000-4000-8000-0000000000f1';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

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
  id: '00000000-0000-4000-8000-0000000000e1',
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
  store.projects.push(fakeProject({ id: P1, companyId: CID }));
  store.sites.push(fakeSite({ id: S1, companyId: CID, projectId: P1 }));
  store.departments.push(
    fakeDepartment({ id: DA, companyId: CID, scopeType: 'SITE', siteId: S1, status: 'ACTIVE' }),
  );
  store.employees.push(fakeEmployee({ id: E1, companyId: CID, status: 'ACTIVE' }));
};

const ROUTES = [
  `/api/v1/org/sites/${S1}/workforce/${E1}/suspend`,
  `/api/v1/org/sites/${S1}/workforce/${E1}/exit`,
  `/api/v1/org/sites/${S1}/workforce/${E1}/reinstate`,
  `/api/v1/org/projects/${P1}/workforce/${E1}/suspend`,
  `/api/v1/org/projects/${P1}/workforce/${E1}/exit`,
  `/api/v1/org/projects/${P1}/workforce/${E1}/reinstate`,
] as const;

describe('W4 workforce lifecycle routes', () => {
  it('401 on all six routes without a token', async () => {
    const { app } = await makeApp(new ApiAuth({ flag: true }));
    try {
      for (const url of ROUTES) {
        const res = await app.inject({
          method: 'POST',
          url,
          payload: url.endsWith('reinstate') ? {} : { reason: 'x' },
        });
        expect(res.statusCode, url).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('403 DELEGATION_DISABLED for scoped callers when flags are off', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([S1]), flag: false }));
    seed(store);
    store.memberships.push(membership({}));
    try {
      for (const action of ['suspend', 'exit', 'reinstate']) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/org/sites/${S1}/workforce/${E1}/${action}`,
          headers: tokenFor(app),
          payload: action === 'reinstate' ? {} : { reason: 'x' },
        });
        expect(res.statusCode, action).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('422 on unknown body fields — server-controlled fields are rejected', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([S1]), flag: true }));
    seed(store);
    store.memberships.push(membership({}));
    try {
      for (const [url, payload] of [
        // Caller-supplied scope/status/membership/timestamp fields — all
        // forbidden; scope comes from the path, everything else is computed.
        [`/api/v1/org/sites/${S1}/workforce/${E1}/suspend`, { reason: 'x', siteId: S1 }],
        [`/api/v1/org/sites/${S1}/workforce/${E1}/suspend`, { reason: 'x', status: 'ACTIVE' }],
        [`/api/v1/org/sites/${S1}/workforce/${E1}/exit`, { reason: 'x', endedAt: '2026-01-01' }],
        [`/api/v1/org/sites/${S1}/workforce/${E1}/exit`, { reason: 'x', companyId: CID }],
        [
          `/api/v1/org/sites/${S1}/workforce/${E1}/reinstate`,
          { membershipId: '00000000-0000-4000-8000-0000000000e1' },
        ],
        [`/api/v1/org/sites/${S1}/workforce/${E1}/reinstate`, { isPrimary: true }],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: tokenFor(app),
          payload,
        });
        expect(res.statusCode, `${url} ${JSON.stringify(payload)}`).toBe(422);
      }
    } finally {
      await app.close();
    }
  });

  it('400 when reason is missing or fails length bounds', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([S1]), flag: true }));
    seed(store);
    try {
      // AJV schema violations (missing required / minLength / maxLength) → 400;
      // unknown-field rejections via DomainValidationError → 422 (above).
      for (const payload of [{}, { reason: '' }, { reason: 'x'.repeat(501) }]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/org/sites/${S1}/workforce/${E1}/suspend`,
          headers: tokenFor(app),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('400 on non-UUID path params', async () => {
    const { app } = await makeApp(new ApiAuth({ scopes: new Set([S1]), flag: true }));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/sites/not-a-uuid/workforce/${E1}/suspend`,
        headers: tokenFor(app),
        payload: { reason: 'x' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('404 for an unknown site id', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([MISSING]), flag: true }));
    seed(store);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/sites/${MISSING}/workforce/${E1}/suspend`,
        headers: tokenFor(app),
        payload: { reason: 'x' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('suspend returns the full action contract', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([S1]), flag: true }));
    seed(store);
    store.memberships.push(membership({ isPrimary: true }));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/sites/${S1}/workforce/${E1}/suspend`,
        headers: tokenFor(app),
        payload: { reason: 'Safety hold', expectedReturnDate: '2026-02-01' },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{
        employeeId: string;
        action: string;
        scopeType: string;
        scopeId: string;
        ended: { membershipId: string; departmentId: string; wasPrimary: boolean }[];
        restored: unknown[];
        headsCleared: string[];
        suspendUntil: string | null;
        exitMarkerId: string | null;
      }>();
      expect(body).toMatchObject({
        employeeId: E1,
        action: 'SUSPEND',
        scopeType: 'SITE',
        scopeId: S1,
        ended: [{ membershipId: store.memberships[0]?.id, departmentId: DA, wasPrimary: true }],
        restored: [],
        headsCleared: [],
        suspendUntil: '2026-02-01',
        exitMarkerId: null,
      });
      // Contact data and free-text reasons never appear in the response.
      expect(res.body).not.toContain('Safety hold');
      expect(res.body).not.toContain('contactPhone');
    } finally {
      await app.close();
    }
  });

  it('exit returns the marker id and ends actives', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([S1, P1]), flag: true }));
    seed(store);
    store.memberships.push(membership({}));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/sites/${S1}/workforce/${E1}/exit`,
        headers: tokenFor(app),
        payload: { reason: 'Done' },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ action: string; exitMarkerId: string | null }>();
      expect(body.action).toBe('EXIT');
      expect(body.exitMarkerId).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('409 ALREADY_EXITED on repeat exit; 404 when no rows exist', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([S1]), flag: true }));
    seed(store);
    store.memberships.push(membership({}));
    try {
      const url = `/api/v1/org/sites/${S1}/workforce/${E1}/exit`;
      const first = await app.inject({
        method: 'POST',
        url,
        headers: tokenFor(app),
        payload: { reason: 'x' },
      });
      expect(first.statusCode).toBe(200);
      const again = await app.inject({
        method: 'POST',
        url,
        headers: tokenFor(app),
        payload: { reason: 'x' },
      });
      expect(again.statusCode).toBe(409);
      const nobody = await app.inject({
        method: 'POST',
        url: `/api/v1/org/sites/${S1}/workforce/00000000-0000-4000-8000-0000000000f9/exit`,
        headers: tokenFor(app),
        payload: { reason: 'x' },
      });
      expect(nobody.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('suspend → reinstate restores via the project route', async () => {
    const { app, store } = await makeApp(new ApiAuth({ scopes: new Set([S1, P1]), flag: true }));
    seed(store);
    store.memberships.push(membership({ isPrimary: true }));
    try {
      const sus = await app.inject({
        method: 'POST',
        url: `/api/v1/org/projects/${P1}/workforce/${E1}/suspend`,
        headers: tokenFor(app),
        payload: { reason: 'hold' },
      });
      expect(sus.statusCode).toBe(200);
      const re = await app.inject({
        method: 'POST',
        url: `/api/v1/org/projects/${P1}/workforce/${E1}/reinstate`,
        headers: tokenFor(app),
        payload: { note: 'returned' },
      });
      expect(re.statusCode, re.body).toBe(200);
      const body = re.json<{ restored: { isPrimary: boolean }[] }>();
      expect(body.restored).toHaveLength(1);
      expect(body.restored[0]?.isPrimary).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('company-wide admin bypasses delegation flags entirely', async () => {
    const { app, store } = await makeApp(new ApiAuth({ companyWide: true, flag: false }));
    seed(store);
    store.memberships.push(membership({}));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/sites/${S1}/workforce/${E1}/suspend`,
        headers: tokenFor(app),
        payload: { reason: 'x' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
