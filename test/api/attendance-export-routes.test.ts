import { PassThrough } from 'node:stream';
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
const HO_ID = '00000000-0000-4000-8000-0000000000b1';
const REPORT_ID = '00000000-0000-4000-8000-0000000000d1';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

function makeMockStream(content: string) {
  const stream = new PassThrough();
  stream.end(Buffer.from(content));
  return stream;
}

async function makeApp(opts: { allow?: boolean } = {}) {
  const allow = opts.allow ?? true;
  const mockAttendanceService = {
    triggerAndExportReport: async (
      _actor: unknown,
      _cid: string,
      input: { reportType: string; format: string },
    ) => ({
      stream: makeMockStream(input.format === 'pdf' ? '%PDF-1.4\n' : 'PK\x03\x04'),
      contentType:
        input.format === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `${input.reportType.toLowerCase()}-report.${input.format}`,
    }),
    exportDailySiteReport: async (
      _actor: unknown,
      _cid: string,
      _id: string,
      format: string,
    ) => ({
      stream: makeMockStream(format === 'pdf' ? '%PDF-1.4\n' : 'PK\x03\x04'),
      contentType:
        format === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `site-report.${format}`,
    }),
    exportMusterRollReport: async (
      _actor: unknown,
      _cid: string,
      _filter: unknown,
      format: string,
    ) => ({
      stream: makeMockStream(format === 'pdf' ? '%PDF-1.4\n' : 'PK\x03\x04'),
      contentType:
        format === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `office-report.${format}`,
    }),
  } as unknown as AttendanceService;

  const mockAccessControl = {
    assertPermission: async () => {
      if (!allow) throw new AccessDeniedError();
    },
    hasPermission: async () => allow,
  } as unknown as AccessControlService;

  const mockAuth = {
    buildActorContext: async (claims: { sub?: string }) =>
      ({
        actorId: claims.sub ?? 'principal-1',
        actorType: 'USER',
        sessionId: 'sess-1',
      }) satisfies PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'admin1', sid: 'sess-1' }),
  } as unknown as AuthService;

  app = await buildApp({
    env,
    services: {
      authService: mockAuth,
      accessControl: mockAccessControl,
      attendanceService: mockAttendanceService,
      platformCompanyId: null,
    },
  });
  return app;
}

const authed = (instance: FastifyInstance) => ({
  authorization: `Bearer ${instance.tokenService.signAccessToken('admin1', 'sess-1')}`,
  'x-company-id': CID,
});

describe('Attendance Report Export Routes', () => {
  it('POST /api/v1/attendance/reports/export returns PDF for SITE report', async () => {
    const a = await makeApp();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/attendance/reports/export',
      headers: authed(a),
      payload: {
        reportType: 'SITE',
        format: 'pdf',
        siteId: SITE_ID,
        date: '2026-11-25',
        recalculate: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="site-report.pdf"');
    expect(res.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('POST /api/v1/attendance/reports/export returns XLSX for OFFICE report', async () => {
    const a = await makeApp();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/attendance/reports/export',
      headers: authed(a),
      payload: {
        reportType: 'OFFICE',
        format: 'xlsx',
        headOfficeId: HO_ID,
        period: 'WEEKLY',
        date: '2026-11-25',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toBe('attachment; filename="office-report.xlsx"');
  });

  it('GET /api/v1/attendance/daily-reports/:id/export downloads DSR as PDF', async () => {
    const a = await makeApp();
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/attendance/daily-reports/${REPORT_ID}/export?format=pdf`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  it('GET /api/v1/attendance/muster-roll/export downloads Office Muster Roll as XLSX', async () => {
    const a = await makeApp();
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/attendance/muster-roll/export?format=xlsx&headOfficeId=${HO_ID}&period=DAILY&date=2026-11-25`,
      headers: authed(a),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('rejects unauthenticated and unauthorized requests cleanly', async () => {
    const a = await makeApp({ allow: false });
    const unauth = await a.inject({
      method: 'POST',
      url: '/api/v1/attendance/reports/export',
      headers: { 'x-company-id': CID },
      payload: { reportType: 'OFFICE', format: 'pdf' },
    });
    expect(unauth.statusCode).toBe(401);

    const denied = await a.inject({
      method: 'POST',
      url: '/api/v1/attendance/reports/export',
      headers: authed(a),
      payload: { reportType: 'OFFICE', format: 'pdf' },
    });
    expect(denied.statusCode).toBe(403);
  });
});
