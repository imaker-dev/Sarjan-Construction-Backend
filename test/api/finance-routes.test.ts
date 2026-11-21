import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { FinanceService } from '../../src/modules/finance/service.js';
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
const PRJ = '00000000-0000-4000-8000-0000000000a1';
const BUD = '00000000-0000-4000-8000-0000000000b1';
const REV = '00000000-0000-4000-8000-0000000000b2';
const FCF = '00000000-0000-4000-8000-0000000000f1';
const EMP = '00000000-0000-4000-8000-0000000000e1';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, impl: (...a: unknown[]) => unknown) => {
    const list: unknown[][] = [];
    calls[name] = list;
    return async (...a: unknown[]) => {
      list.push(a);
      return impl(...a);
    };
  };
  const mockFinanceService = {
    createBudget: record('createBudget', async () => ({
      budget: { id: BUD, projectId: PRJ, code: 'B1', currency: 'INR', status: 'ACTIVE' },
      replayed: false,
    })),
    listBudgets: record('listBudgets', async () => []),
    getBudget: record('getBudget', async () => ({ id: BUD, revisions: [] })),
    updateBudget: record('updateBudget', async () => ({ id: BUD, version: 1 })),
    createRevision: record('createRevision', async () => ({
      revision: { id: REV, revision: 1, status: 'DRAFT', totalAmount: '2000.00' },
      replayed: false,
    })),
    listRevisions: record('listRevisions', async () => []),
    getRevision: record('getRevision', async () => ({ id: REV, lines: [], decisions: [] })),
    submitRevision: record('submitRevision', async () => ({
      revision: { id: REV, status: 'SUBMITTED' },
      replayed: false,
    })),
    listDecisions: record('listDecisions', async () => []),
    decideRevision: record('decideRevision', async () => ({
      revision: { id: REV, status: 'APPROVED' },
      decision: { id: 'd1', action: 'APPROVE' },
      replayed: false,
    })),
    getProjectCosts: record('getProjectCosts', async () => ({
      projectId: PRJ,
      budgets: [],
      cashFlowForecasts: { count: 0, totalInflow: '0.00', totalOutflow: '0.00', net: '0.00' },
      commitments: null,
      actuals: null,
    })),
    createForecast: record('createForecast', async () => ({
      forecast: { id: FCF, projectId: PRJ, status: 'ACTIVE', revision: 1 },
      replayed: false,
    })),
    listForecasts: record('listForecasts', async () => []),
    getForecast: record('getForecast', async () => ({ id: FCF, lines: [] })),
    reviseForecast: record('reviseForecast', async () => ({
      forecast: { id: FCF, revision: 2 },
      replayed: false,
    })),
    listProjects: record('listProjects', async () => ({
      items: [{ id: PRJ, code: 'P1', name: 'Tower', status: 'ACTIVE', headOffice: { id: 'h1' } }],
      nextCursor: undefined,
    })),
    listProjectSites: record('listProjectSites', async () => ({
      items: [{ id: 'site-1', code: 'S1', name: 'Gate', status: 'ACTIVE' }],
      nextCursor: undefined,
    })),
    listEmployees: record('listEmployees', async () => ({
      items: [{ id: EMP, employeeCode: 'E1', displayName: 'Fin User', status: 'ACTIVE' }],
      nextCursor: undefined,
    })),
    getEmployee: record('getEmployee', async () => ({
      id: EMP,
      employeeCode: 'E1',
      displayName: 'Fin User',
      status: 'ACTIVE',
      memberships: [],
      employmentDetails: null,
    })),
    getAttendanceSummary: record('getAttendanceSummary', async () => ({
      employeeId: EMP,
      from: '2026-11-01',
      to: '2026-11-30',
      sessions: 2,
      presentUnits: '1.5',
      overtimeUnits: '0.0',
      totalUnits: '1.5',
      overtimeHours: '1.50',
      grossMinutes: 1080,
      netMinutes: 960,
      flaggedSessions: 0,
      sitesWorked: 1,
    })),
    getLeaveSummary: record('getLeaveSummary', async () => ({
      employeeId: EMP,
      year: 2026,
      balances: [],
      requests: [],
    })),
    getDashboard: record('getDashboard', async () => ({
      projects: { total: 1, byStatus: { ACTIVE: 1 } },
      sites: { total: 1, byStatus: { ACTIVE: 1 } },
      workforce: { total: 1, byStatus: { ACTIVE: 1 }, byEngagementType: {} },
      budgets: { total: 1, byStatus: { ACTIVE: 1 }, approvedTotals: [] },
      pendingBudgetReviews: 0,
      cashFlowForecasts: { total: 0, byCurrency: [] },
      unavailable: [{ section: 'wallets', reason: 'module not implemented' }],
    })),
  } as unknown as FinanceService;

  const mockAuthService = {
    buildActorContext: async () =>
      ({ actorId: 'fin1', actorType: 'USER', sessionId: 's1' }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'fin1', sid: 's1' }),
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
      financeService: mockFinanceService,
      platformCompanyId: null,
    },
  });
  return { app: instance, calls };
}

const tokenFor = (a: FastifyInstance) => a.tokenService.signAccessToken('fin1', 's1');
const authed = (a: FastifyInstance) => ({
  authorization: `Bearer ${tokenFor(a)}`,
  'x-company-id': CID,
});

describe('Finance budget routes', () => {
  it('rejects unauthenticated and missing-tenant requests', async () => {
    const { app: a } = await makeApp();
    app = a;
    const noAuth = await a.inject({ method: 'GET', url: `/api/v1/finance/budgets/${BUD}` });
    expect(noAuth.statusCode).toBe(401);
    const noTenant = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/budgets/${BUD}`,
      headers: { authorization: `Bearer ${tokenFor(a)}` },
    });
    expect(noTenant.statusCode).toBe(401);
  });

  it('403s without FINANCE_BUDGET_READ', async () => {
    const { app: a } = await makeApp({ allow: false });
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/budgets/${BUD}`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a budget — 201 with service result', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/finance/projects/${PRJ}/budgets`,
      headers: authed(a),
      payload: { code: 'b1', name: 'Base', currency: 'INR', idempotencyKey: 'k1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ budget: { id: string } }>().budget.id).toBe(BUD);
    expect(calls.createBudget?.[0]?.[2]).toBe(PRJ);
  });

  it('validates create body — rejects bad money/extra fields', async () => {
    const { app: a } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/finance/budgets/${BUD}/revisions`,
      headers: authed(a),
      payload: {
        lines: [{ category: 'MATERIAL', description: 'x', amount: 'abc' }],
        hacker: true,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('revision lifecycle: submit then decide returns 201 with decision', async () => {
    const { app: a } = await makeApp();
    app = a;
    const submit = await a.inject({
      method: 'POST',
      url: `/api/v1/finance/budgets/${BUD}/revisions/${REV}/submit`,
      headers: authed(a),
      payload: { expectedVersion: 0 },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json<{ revision: { status: string } }>().revision.status).toBe('SUBMITTED');

    const decide = await a.inject({
      method: 'POST',
      url: `/api/v1/finance/budgets/${BUD}/revisions/${REV}/decisions`,
      headers: authed(a),
      payload: { action: 'APPROVE', reason: 'ok', idempotencyKey: 'd1' },
    });
    expect(decide.statusCode).toBe(201);
    expect(decide.json<{ decision: { action: string } }>().decision.action).toBe('APPROVE');
  });

  it('rejects invalid decide actions', async () => {
    const { app: a } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/finance/budgets/${BUD}/revisions/${REV}/decisions`,
      headers: authed(a),
      payload: { action: 'FORCE_APPROVE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exposes costs read model', async () => {
    const { app: a } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/projects/${PRJ}/costs`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ actuals: unknown; commitments: unknown }>();
    expect(body.actuals).toBeNull();
    expect(body.commitments).toBeNull();
  });
});

describe('Finance forecast routes', () => {
  it('creates a forecast — validates period/lines', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const bad = await a.inject({
      method: 'POST',
      url: `/api/v1/finance/projects/${PRJ}/cash-flow-forecasts`,
      headers: authed(a),
      payload: {
        name: 'Q1',
        currency: 'INR',
        periodStart: '2026-01-01',
        periodEnd: '2026-03-31',
        lines: [],
      },
    });
    expect(bad.statusCode).toBe(400);
    const good = await a.inject({
      method: 'POST',
      url: `/api/v1/finance/projects/${PRJ}/cash-flow-forecasts`,
      headers: authed(a),
      payload: {
        name: 'Q1',
        currency: 'INR',
        periodStart: '2026-01-01',
        periodEnd: '2026-03-31',
        lines: [{ direction: 'INFLOW', category: 'CLIENT_RECEIPT', amount: '5000.00' }],
      },
    });
    expect(good.statusCode).toBe(201);
    expect(calls.createForecast).toHaveLength(1);
  });

  it('revises a forecast — requires expectedVersion', async () => {
    const { app: a } = await makeApp();
    app = a;
    const missing = await a.inject({
      method: 'PATCH',
      url: `/api/v1/finance/cash-flow-forecasts/${FCF}`,
      headers: authed(a),
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(400);
    const ok = await a.inject({
      method: 'PATCH',
      url: `/api/v1/finance/cash-flow-forecasts/${FCF}`,
      headers: authed(a),
      payload: { expectedVersion: 0, reason: 'update' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ forecast: { revision: number } }>().forecast.revision).toBe(2);
  });
});

describe('Finance read-only portfolio/workforce routes', () => {
  it('GET /finance/projects — 200 with filters forwarded to service', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/projects?status=ACTIVE&search=tower&limit=5&cursor=${PRJ}`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    const q = calls.listProjects?.[0]?.[2] as Record<string, unknown>;
    expect(q).toMatchObject({ status: 'ACTIVE', search: 'tower', limit: 5, cursor: PRJ });
  });

  it('GET /finance/projects — rejects bad status and limit > 100', async () => {
    const { app: a } = await makeApp();
    app = a;
    const bad = await a.inject({
      method: 'GET',
      url: '/api/v1/finance/projects?status=BOGUS',
      headers: authed(a),
    });
    expect(bad.statusCode).toBe(400);
    const big = await a.inject({
      method: 'GET',
      url: '/api/v1/finance/projects?limit=101',
      headers: authed(a),
    });
    expect(big.statusCode).toBe(400);
  });

  it('GET /finance/projects/:id/sites — 200, tenant + params forwarded', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/projects/${PRJ}/sites?status=ACTIVE`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    expect(calls.listProjectSites?.[0]?.[1]).toBe(CID);
    expect(calls.listProjectSites?.[0]?.[2]).toBe(PRJ);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(res.json<{ items: { geoLatitude?: string }[] }>().items[0]?.geoLatitude).toBeUndefined();
  });

  it('GET /finance/employees — 200 with all filters forwarded', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees?projectId=${PRJ}&siteId=${PRJ}&departmentId=${PRJ}&status=ACTIVE&search=ram&limit=20`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    const q = calls.listEmployees?.[0]?.[2] as Record<string, unknown>;
    expect(q).toMatchObject({
      projectId: PRJ,
      siteId: PRJ,
      departmentId: PRJ,
      status: 'ACTIVE',
      search: 'ram',
      limit: 20,
    });
  });

  it('GET /finance/employees/:id — 200 detail', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees/${EMP}`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    expect(calls.getEmployee?.[0]?.[2]).toBe(EMP);
    expect(res.json<{ employmentDetails: null }>().employmentDetails).toBeNull();
  });

  it('GET /finance/employees/:id/attendance-summary — requires from+to dates', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const missing = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees/${EMP}/attendance-summary`,
      headers: authed(a),
    });
    expect(missing.statusCode).toBe(400);
    const badDate = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees/${EMP}/attendance-summary?from=11-01-2026&to=2026-11-30`,
      headers: authed(a),
    });
    expect(badDate.statusCode).toBe(400);
    const ok = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees/${EMP}/attendance-summary?from=2026-11-01&to=2026-11-30`,
      headers: authed(a),
    });
    expect(ok.statusCode).toBe(200);
    expect(calls.getAttendanceSummary?.[0]?.[3]).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
    });
    const body = ok.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('punchInLat');
    expect(body).not.toHaveProperty('sessions_detail');
  });

  it('GET /finance/employees/:id/leave-summary — year required and validated', async () => {
    const { app: a, calls } = await makeApp();
    app = a;
    const missing = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees/${EMP}/leave-summary`,
      headers: authed(a),
    });
    expect(missing.statusCode).toBe(400);
    const bad = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees/${EMP}/leave-summary?year=99`,
      headers: authed(a),
    });
    expect(bad.statusCode).toBe(400);
    const ok = await a.inject({
      method: 'GET',
      url: `/api/v1/finance/employees/${EMP}/leave-summary?year=2026`,
      headers: authed(a),
    });
    expect(ok.statusCode).toBe(200);
    expect(calls.getLeaveSummary?.[0]?.[3]).toBe(2026);
  });

  it('GET /finance/dashboard — 200 with declared unavailable sections', async () => {
    const { app: a } = await makeApp();
    app = a;
    const res = await a.inject({
      method: 'GET',
      url: '/api/v1/finance/dashboard',
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      projects: { total: number };
      unavailable: { section: string }[];
    }>();
    expect(body.projects.total).toBe(1);
    expect(body.unavailable.length).toBeGreaterThan(0);
  });

  it('all new read routes 403 without permission and 401 without tenant', async () => {
    const { app: a } = await makeApp({ allow: false });
    app = a;
    for (const url of [
      '/api/v1/finance/projects',
      `/api/v1/finance/projects/${PRJ}/sites`,
      '/api/v1/finance/employees',
      `/api/v1/finance/employees/${EMP}`,
      `/api/v1/finance/employees/${EMP}/attendance-summary?from=2026-11-01&to=2026-11-30`,
      `/api/v1/finance/employees/${EMP}/leave-summary?year=2026`,
      '/api/v1/finance/dashboard',
    ]) {
      const res = await a.inject({ method: 'GET', url, headers: authed(a) });
      expect(res.statusCode, url).toBe(403);
      const noTenant = await a.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${tokenFor(a)}` },
      });
      expect(noTenant.statusCode, url).toBe(401);
    }
  });
});
