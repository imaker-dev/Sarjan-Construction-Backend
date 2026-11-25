import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AttendanceService } from '../../src/modules/attendance/service.js';
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
const SITE_ID = '00000000-0000-4000-8000-0000000000a1';
const REPORT_ID = '00000000-0000-4000-8000-0000000000d1';
const SUMMARY_ID = '00000000-0000-4000-8000-000000000002';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const allow = opts.allow ?? true;
  const mockAttendanceService = {
    calculateDailyReport: async (
      _actor: unknown,
      _cid: string,
      input: Record<string, unknown>,
    ) => ({
      id: REPORT_ID,
      companyId: CID,
      siteId: input.siteId,
      businessDate: input.businessDate,
      status: 'DRAFT',
      totalWorkersHeadcount: 15,
      totalPresentUnits: 14.5,
      totalOvertimeHours: 8.0,
      catAStaffCount: 2,
      catBDirectCount: 10,
      catCSubconCount: 3,
      labourSummaries: [
        {
          id: SUMMARY_ID,
          category: 'CAT_C_SUBCONTRACTOR',
          tradeCategory: 'BAR_BENDER',
          headcount: 3,
          presentUnits: 2.5,
          overtimeHours: 2.0,
        },
      ],
    }),
    getDailyReports: async () => ({
      items: [
        {
          id: REPORT_ID,
          companyId: CID,
          siteId: SITE_ID,
          businessDate: '2026-11-21',
          status: 'DRAFT',
          totalWorkersHeadcount: 15,
        },
      ],
      total: 1,
    }),
    getDailyReportById: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      companyId: CID,
      siteId: SITE_ID,
      businessDate: '2026-11-21',
      status: 'DRAFT',
      totalWorkersHeadcount: 15,
      labourSummaries: [
        {
          id: SUMMARY_ID,
          category: 'CAT_C_SUBCONTRACTOR',
          tradeCategory: 'BAR_BENDER',
          headcount: 3,
        },
      ],
      auditLogs: [],
    }),
    updateDailyReport: async (
      _actor: unknown,
      _cid: string,
      id: string,
      input: Record<string, unknown>,
    ) => ({
      id,
      companyId: CID,
      siteId: SITE_ID,
      status: 'DRAFT',
      ...input,
    }),
    updateLabourSummary: async (
      _actor: unknown,
      _cid: string,
      id: string,
      summaryId: string,
      input: Record<string, unknown>,
    ) => ({
      id,
      companyId: CID,
      labourSummaries: [
        {
          id: summaryId,
          headcount: input.headcount ?? 3,
          remarks: input.remarks,
        },
      ],
    }),
    submitDailyReport: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      status: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
    }),
    approveDailyReport: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      status: 'APPROVED',
      approvedAt: new Date().toISOString(),
    }),
    rejectDailyReport: async (
      _actor: unknown,
      _cid: string,
      id: string,
      input: { reason: string },
    ) => ({
      id,
      status: 'REJECTED',
      rejectionReason: input.reason,
    }),
    lockDailyReport: async (_actor: unknown, _cid: string, id: string) => ({
      id,
      status: 'LOCKED',
      lockedAt: new Date().toISOString(),
    }),
    getDailyReportAuditTrail: async (_actor: unknown, _cid: string, id: string) => [
      {
        id: 'aud-1',
        reportId: id,
        action: 'AUTO_CALCULATED',
        createdAt: new Date().toISOString(),
      },
    ],
    // Route-gate scope resolution — site target exercises the scoped path.
    resolveScope: async (companyId: string) => ({
      companyId,
      scopeType: 'SITE',
      scopeId: SITE_ID,
    }),
  };

  const mockAccessControl = {
    assertPermission: async () => {
      if (!allow) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;

  const mockAuthService = {
    buildActorContext: async (claims: { sub?: string }) =>
      ({ actorId: claims.sub ?? 'u1', actorType: 'USER', sessionId: 's1' }) as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'admin1', sid: 's1' }),
  } as unknown as AuthService;

  return buildApp({
    env,
    services: {
      attendanceService: mockAttendanceService as unknown as AttendanceService,
      accessControl: mockAccessControl,
      authService: mockAuthService,
      platformCompanyId: null,
    },
  });
}

interface DailyReportResponse {
  id: string;
  companyId: string;
  siteId: string;
  businessDate: string;
  status: string;
  weather?: string;
  weatherStoppageHours?: number;
  totalWorkersHeadcount: number;
  catCSubconCount?: number;
  rejectionReason?: string;
  labourSummaries?: {
    id: string;
    headcount: number;
    presentUnits?: number;
    remarks?: string;
  }[];
}

interface ListReportsResponse {
  total: number;
  items: { id: string }[];
}

interface AuditLogResponseItem {
  id: string;
  reportId: string;
  action: string;
}

const authed = (instance: FastifyInstance) => ({
  authorization: `Bearer ${instance.tokenService.signAccessToken('admin1', 's1')}`,
  'x-company-id': CID,
});

describe('Daily Site Report (DSR) & Attendance Settlement Routes', () => {
  it('triggers on-demand auto-calculation with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/daily-reports/calculate',
      headers: authed(app),
      payload: {
        siteId: SITE_ID,
        businessDate: '2026-11-21',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.id).toBe(REPORT_ID);
    expect(body.status).toBe('DRAFT');
    expect(body.totalWorkersHeadcount).toBe(15);
    expect(body.catCSubconCount).toBe(3);
  });

  it('triggers on-demand auto-calculation for headOfficeId with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/daily-reports/calculate',
      headers: authed(app),
      payload: {
        headOfficeId: '00000000-0000-4000-8000-0000000000b1',
        businessDate: '2026-11-21',
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('lists daily site reports with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/daily-reports?siteId=${SITE_ID}&fromDate=2026-11-01&toDate=2026-11-21`,
      headers: authed(app),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<ListReportsResponse>();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(REPORT_ID);
  });

  it('retrieves single daily site report details with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}`,
      headers: authed(app),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.id).toBe(REPORT_ID);
    expect(body.labourSummaries).toHaveLength(1);
  });

  it('updates report header and weather conditions with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}`,
      headers: authed(app),
      payload: {
        weather: 'OVERCAST',
        weatherStoppageHours: 2.0,
        workProgressNotes: 'Finished rebar tying for column C4-C8',
        version: 0,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.weather).toBe('OVERCAST');
    expect(body.weatherStoppageHours).toBe(2.0);
  });

  it('updates labour summary with mandatory justification reason with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}/labour-summary/${SUMMARY_ID}`,
      headers: authed(app),
      payload: {
        headcount: 5,
        remarks: 'Extra 2 bar benders added from Gang B',
        reason: 'Authorized gang reinforcement by PM',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.labourSummaries?.[0]?.headcount).toBe(5);
  });

  it('submits daily report for PM review with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}/submit`,
      headers: authed(app),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.status).toBe('SUBMITTED');
  });

  it('approves daily report by Project Manager with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}/approve`,
      headers: authed(app),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.status).toBe('APPROVED');
  });

  it('rejects daily report with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}/reject`,
      headers: authed(app),
      payload: {
        reason: 'Missing night shift concrete log',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.status).toBe('REJECTED');
    expect(body.rejectionReason).toBe('Missing night shift concrete log');
  });

  it('locks daily report by HO Admin with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}/lock`,
      headers: authed(app),
      payload: {
        reason: 'Finalized for fortnight payroll processing',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<DailyReportResponse>();
    expect(body.status).toBe('LOCKED');
  });

  it('fetches audit trail with 200', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}/audit-trail`,
      headers: authed(app),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<AuditLogResponseItem[]>();
    expect(body).toHaveLength(1);
    expect(body[0]?.action).toBe('AUTO_CALCULATED');
  });
});
