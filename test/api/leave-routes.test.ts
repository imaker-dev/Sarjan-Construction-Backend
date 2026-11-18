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
    createPolicy: async (_actor: unknown, _cid: string, input: Record<string, unknown>) => ({
      id: POL_ID,
      companyId: CID,
      ...input,
    }),
    listPolicies: async () => [{ id: POL_ID, name: 'Casual Leave Policy' }],
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
        leaveType: 'CASUAL',
        name: 'Standard Casual Leave',
        annualAllowance: 12,
        allowHalfDay: true,
        sandwichRule: false,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string }>();
    expect(body.id).toBe(POL_ID);
    expect(body.name).toBe('Standard Casual Leave');
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

  it('resolves effective leave policy', async () => {
    app = await makeApp({ allow: true });
    const token = app.tokenService.signAccessToken('admin1', 's1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leave/policies/effective?leaveType=CASUAL',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': CID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; name: string }>();
    expect(body.id).toBe(POL_ID);
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
