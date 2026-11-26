import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { LeaveService } from '../../src/modules/leave/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';

const env = {
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
const EMP_ID = '00000000-0000-4000-8000-0000000000a1';
const POL_ID = '00000000-0000-4000-8000-0000000000b1';
const REQ_ID = '00000000-0000-4000-8000-0000000000e1';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const mockLeaveService = {
    resolveScope: async (opts: { companyId: string }) => ({
      companyId: opts.companyId,
      scopeType: 'COMPANY' as const,
      scopeId: opts.companyId,
    }),
    createTypeDef: async (_actor: unknown, _cid: string, input: Record<string, unknown>) => ({
      id: '00000000-0000-4000-8000-0000000000d1',
      companyId: CID,
      status: 'ACTIVE',
      version: 0,
      ...input,
    }),
    listTypeDefs: async () => [{ id: '00000000-0000-4000-8000-0000000000d1', code: 'CL' }],
    updateTypeDef: async (
      _actor: unknown,
      _cid: string,
      id: string,
      input: Record<string, unknown>,
    ) => ({
      id,
      companyId: CID,
      name: input.name ?? 'Casual Leave',
      status: 'ACTIVE',
    }),
    archiveTypeDef: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      companyId: CID,
      status: 'ARCHIVED',
    }),
    createPolicy: async (_actor: unknown, _cid: string, input: Record<string, unknown>) => ({
      policy: { id: POL_ID, companyId: CID, ...input },
      version: { id: '00000000-0000-4000-8000-0000000000d2', version: 1 },
    }),
    listPolicies: async () => [{ id: POL_ID, name: 'Casual Leave Policy' }],
    getPolicy: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      companyId: CID,
      name: 'Casual Leave Policy',
    }),
    archivePolicy: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      companyId: CID,
      isActive: false,
    }),
    addVersion: async (
      _actor: unknown,
      _cid: string,
      policyId: string,
      input: Record<string, unknown>,
    ) => ({
      id: '00000000-0000-4000-8000-0000000000d3',
      policyId,
      version: 2,
      status: 'ACTIVE',
      ...input,
    }),
    listVersions: async (_actor: unknown, _cid: string, policyId: string) => [
      { id: '00000000-0000-4000-8000-0000000000d2', policyId, version: 1, status: 'ACTIVE' },
    ],
    cancelVersion: async (_actor: unknown, _cid: string, _pid: string, vid: string) => ({
      id: vid,
      status: 'ARCHIVED',
    }),
    resolveEffectiveConfig: async () => ({
      policy: { id: POL_ID, name: 'Effective Casual Leave' },
      version: { id: '00000000-0000-4000-8000-0000000000d2', mode: 'NONE' },
      typeDef: { id: '00000000-0000-4000-8000-0000000000d1', code: 'CL' },
      resolvedVia: 'COMPANY',
    }),
    updatePolicy: async (
      _actor: unknown,
      _cid: string,
      id: string,
      input: Record<string, unknown>,
    ) => ({
      id,
      companyId: CID,
      name: input.name ?? 'Updated Policy',
    }),
    resolveEffectivePolicy: async () => ({
      id: POL_ID,
      name: 'Effective Casual Leave',
      annualAllowance: 12,
    }),
    allocateBalance: async (_actor: unknown, _cid: string, input: Record<string, unknown>) => ({
      id: '00000000-0000-4000-8000-0000000000f1',
      companyId: CID,
      ...input,
    }),
    listBalances: async () => [
      {
        id: '00000000-0000-4000-8000-0000000000f1',
        employeeId: EMP_ID,
        leaveType: 'CASUAL',
        allocatedDays: 12,
      },
    ],
    getEmployeeBalance: async () => ({
      id: '00000000-0000-4000-8000-0000000000f1',
      employeeId: EMP_ID,
      leaveType: 'CASUAL',
      allocatedDays: 12,
    }),
    submitRequest: async (_actor: unknown, _cid: string, input: Record<string, unknown>) => ({
      id: REQ_ID,
      companyId: CID,
      status: 'PENDING',
      ...input,
    }),
    listRequests: async () => [
      {
        id: REQ_ID,
        companyId: CID,
        employeeId: EMP_ID,
        status: 'PENDING',
      },
    ],
    getRequestById: async () => ({
      id: REQ_ID,
      companyId: CID,
      employeeId: EMP_ID,
      status: 'PENDING',
    }),
    reviewRequest: async (
      _actor: unknown,
      _cid: string,
      id: string,
      input: Record<string, unknown>,
    ) => ({
      id,
      companyId: CID,
      status: input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    }),
    cancelRequest: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      companyId: CID,
      status: 'CANCELLED',
    }),
    resubmitRequest: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      companyId: CID,
      status: 'PENDING',
    }),
  } as unknown as LeaveService;

  const mockAuthService = {
    buildActorContext: async () =>
      ({
        actorId: 'admin1',
        actorType: 'USER',
        sessionId: 's1',
      }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'admin1', sid: 's1' }),
  } as unknown as AuthService;

  const mockAccessControl = {
    assertPermission: async () => {
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;

  const instance = await buildApp({
    env,
    services: {
      authService: mockAuthService,
      accessControl: mockAccessControl,
      leaveService: mockLeaveService,
      platformCompanyId: null,
    },
  });

  return instance;
}

describe('Leave Management Routes (/api/v1/leave)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/policies',
      headers: { 'x-company-id': CID },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests missing x-company-id with 401', async () => {
    app = await makeApp();
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/policies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthorized users with 403', async () => {
    app = await makeApp({ allow: false });
    const token = app.tokenService.signAccessToken('no-perm-user', 's1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/policies',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a leave type definition with 201', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/types',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: { code: 'CL', name: 'Casual Leave', leaveType: 'CASUAL' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; code: string }>();
    expect(body.code).toBe('CL');
  });

  it('lists and archives leave type definitions', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/types',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': CID },
    });
    expect(listRes.statusCode).toBe(200);

    const TD = '00000000-0000-4000-8000-0000000000d1';
    const archRes = await app.inject({
      method: 'POST',
      url: `/api/v1/leave/types/${TD}/archive`,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': CID },
      payload: { expectedVersion: 0 },
    });
    expect(archRes.statusCode).toBe(200);
    expect(archRes.json<{ status: string }>().status).toBe('ARCHIVED');
  });

  it('creates a leave policy with 201', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/policies',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: {
        scopeType: 'COMPANY',
        typeDefId: '00000000-0000-4000-8000-0000000000d1',
        name: 'Standard Casual Leave',
        version: {
          effectiveFrom: '2026-01-01',
          mode: 'MONTHLY_CREDIT',
          monthlyCreditAmount: 4,
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ policy: { id: string; name: string } }>();
    expect(body.policy.id).toBe(POL_ID);
    expect(body.policy.name).toBe('Standard Casual Leave');
  });

  it('rejects a policy body that mixes accrual modes', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/policies',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: {
        scopeType: 'DEPARTMENT',
        name: 'Missing department id',
        version: { effectiveFrom: '2026-01-01', mode: 'NONE' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists leave policies', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/policies',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(POL_ID);
  });

  it('updates a leave policy with PATCH', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leave/policies/${POL_ID}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: {
        name: 'Updated Casual Leave Policy',
        expectedVersion: 0,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; name: string }>();
    expect(body.name).toBe('Updated Casual Leave Policy');
  });

  it('resolves effective leave policy config', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/leave/policies/effective?typeDefId=00000000-0000-4000-8000-0000000000d1&employeeId=${EMP_ID}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ policy: { id: string }; resolvedVia: string }>();
    expect(body.policy.id).toBe(POL_ID);
    expect(body.resolvedVia).toBe('COMPANY');
  });

  it('gets, archives, and versions a policy', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const headers = { authorization: `Bearer ${token}`, 'x-company-id': CID };

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/leave/policies/${POL_ID}`,
      headers,
    });
    expect(getRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/leave/policies/${POL_ID}/versions`,
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json<unknown[]>()).toHaveLength(1);

    const addRes = await app.inject({
      method: 'POST',
      url: `/api/v1/leave/policies/${POL_ID}/versions`,
      headers,
      payload: {
        effectiveFrom: '2026-07-01',
        mode: 'WORKED_DAYS_RATIO',
        ratioThresholdDays: 20,
        ratioEarnedAmount: 1,
        expectedVersion: 0,
      },
    });
    expect(addRes.statusCode).toBe(201);
    expect(addRes.json<{ version: number }>().version).toBe(2);

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/leave/policies/${POL_ID}/versions/00000000-0000-4000-8000-0000000000d3/cancel`,
      headers,
      payload: {},
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json<{ status: string }>().status).toBe('ARCHIVED');

    const archRes = await app.inject({
      method: 'POST',
      url: `/api/v1/leave/policies/${POL_ID}/archive`,
      headers,
      payload: { expectedVersion: 1 },
    });
    expect(archRes.statusCode).toBe(200);
    expect(archRes.json<{ isActive: boolean }>().isActive).toBe(false);
  });

  it('allocates leave balance with 201', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/allocations',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: {
        employeeId: EMP_ID,
        leaveType: 'CASUAL',
        year: 2026,
        allocatedDays: 12,
        carriedOverDays: 2,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; allocatedDays: number }>();
    expect(body.allocatedDays).toBe(12);
  });

  it('lists leave balances and gets by employeeId', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/balances',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });
    expect(listRes.statusCode).toBe(200);

    const empRes = await app.inject({
      method: 'GET',
      url: `/api/v1/leave/balances/${EMP_ID}?leaveType=CASUAL`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });
    expect(empRes.statusCode).toBe(200);
  });

  it('submits a leave request with 201', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/requests',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: {
        employeeId: EMP_ID,
        leaveType: 'CASUAL',
        startDate: '2026-11-20',
        endDate: '2026-11-20',
        reason: 'Family function in hometown',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string }>();
    expect(body.id).toBe(REQ_ID);
    expect(body.status).toBe('PENDING');
  });

  it('lists leave requests and gets details by id', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/requests',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });
    expect(listRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/leave/requests/${REQ_ID}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });
    expect(getRes.statusCode).toBe(200);
  });

  it('reviews a leave request (approves)', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/leave/requests/${REQ_ID}/review`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: {
        action: 'APPROVE',
        remarks: 'Approved by PM',
        expectedVersion: 0,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string }>();
    expect(body.status).toBe('APPROVED');
  });

  it('cancels a leave request', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/leave/requests/${REQ_ID}/cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
      payload: {
        reason: 'Change of plan',
        expectedVersion: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string }>();
    expect(body.status).toBe('CANCELLED');
  });
});
