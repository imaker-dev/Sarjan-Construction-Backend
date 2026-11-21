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
const POL_ID = '00000000-0000-4000-8000-0000000000b1';
const SESS_ID = '00000000-0000-4000-8000-0000000000e1';
const TVT_ID = '00000000-0000-4000-8000-0000000000f1';
const BATCH_ID = '00000000-0000-4000-8000-000000000011';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const calls: string[] = [];
  const mockAttendanceService = {
    listPolicies: async () => [{ id: POL_ID, name: 'Standard 8AM Policy' }],
    createPolicy: async (_actor: unknown, _cid: string, input: Record<string, unknown>) => ({
      id: POL_ID,
      companyId: CID,
      ...input,
    }),
    resolveEffectivePolicy: async () => ({
      id: POL_ID,
      name: 'Effective Policy',
      dayStartHour: 8,
      dayStartMinute: 0,
      shiftDurationMins: 480,
    }),
    getPolicy: async () => ({ id: POL_ID, name: 'Standard 8AM Policy' }),
    updatePolicy: async (
      _actor: unknown,
      _cid: string,
      id: string,
      input: Record<string, unknown>,
    ) => ({
      id,
      ...input,
    }),
    punchIn: async (_actor: unknown, _cid: string, input: Record<string, unknown>) => ({
      id: SESS_ID,
      siteId: input.siteId,
      status: 'IN_PROGRESS',
      businessDate: '2026-11-17',
      punchInAt: new Date().toISOString(),
    }),
    punchOut: async () => ({
      id: SESS_ID,
      status: 'COMPLETED',
      presentUnits: 1.0,
      overtimePUnits: 0.5,
      totalPUnits: 1.5,
      overtimeHours: 0.0,
    }),
    startBreak: async () => ({
      id: 'brk-1',
      sessionId: SESS_ID,
      breakType: 'LUNCH',
      startedAt: new Date().toISOString(),
    }),
    endBreak: async () => ({
      id: 'brk-1',
      sessionId: SESS_ID,
      durationMins: 45,
    }),
    getActiveSession: async () => ({
      id: SESS_ID,
      status: 'IN_PROGRESS',
      businessDate: '2026-11-21',
      isDelayedClockIn: true,
      delayedClockInMinutes: 20,
      delayedClockInTime: '00:20',
      clockOutTimeProper8Hours: '2026-11-21T16:20:00.000Z',
      expectedClockOutAt: '2026-11-21T17:20:00.000Z',
      totalCheckInsToday: 2,
      totalCheckOutsToday: 1,
      currentlyCheckedIn: true,
      totalWorkMinutesToday: 240,
      totalBreakMinutesToday: 30,
      activityLog: [
        {
          type: 'CHECK_IN' as const,
          timestamp: '2026-11-21T03:00:00.000Z',
          sessionId: 'sess-prev',
        },
        {
          type: 'CHECK_OUT' as const,
          timestamp: '2026-11-21T07:00:00.000Z',
          sessionId: 'sess-prev',
        },
        {
          type: 'CHECK_IN' as const,
          timestamp: '2026-11-21T08:00:00.000Z',
          sessionId: SESS_ID,
        },
      ],
    }),
    listSessions: async () => [
      {
        id: SESS_ID,
        status: 'COMPLETED',
        presentUnits: 1.0,
      },
    ],
    getSession: async () => ({
      id: SESS_ID,
      status: 'COMPLETED',
      breaks: [],
    }),
    regularizeSession: async (
      _actor: unknown,
      _cid: string,
      id: string,
      input: Record<string, unknown>,
    ) => ({
      id,
      status: 'COMPLETED',
      source: 'MANUAL_CORRECTION',
      presentUnits: input.presentUnits ?? 1.0,
    }),
    getDailySummary: async () => ({
      siteId: SITE_ID,
      businessDate: '2026-11-17',
      totalWorkers: 15,
      totalTotalPUnits: 18.5,
      totalOvertimeHours: 4.5,
    }),
    kioskBatchPunchIn: async () => ({
      siteId: SITE_ID,
      totalSubmitted: 2,
      successCount: 2,
      failureCount: 0,
      results: [{ employeeId: '00000000-0000-4000-8000-0000000000e2', success: true }],
    }),
    kioskBatchPunchOut: async () => ({
      siteId: SITE_ID,
      totalSubmitted: 1,
      successCount: 1,
      failureCount: 0,
      results: [
        {
          employeeId: '00000000-0000-4000-8000-0000000000e2',
          success: true,
          presentUnits: 1.0,
        },
      ],
    }),
    kioskOfflineSync: async () => ({
      syncBatchId: BATCH_ID,
      totalSubmitted: 1,
      syncedCount: 1,
      alreadySyncedCount: 0,
      results: [{ clientSessionId: '00000000-0000-4000-8000-0000000000c2', status: 'SYNCED' }],
    }),
    createTvtSession: async () => ({
      id: TVT_ID,
      siteId: SITE_ID,
      topic: 'Excavation Safety',
      attendees: [],
    }),
    listTvtSessions: async () => [
      {
        id: TVT_ID,
        topic: 'Excavation Safety',
        _count: { attendees: 5 },
      },
    ],
    getTvtSession: async () => ({
      id: TVT_ID,
      topic: 'Excavation Safety',
      attendees: [],
    }),
    addTvtAttendees: async () => ({
      sessionId: TVT_ID,
      addedCount: 2,
      totalAttendees: 2,
    }),
    getMusterRollRange: async () => ({
      siteId: SITE_ID,
      from: '2026-11-01',
      to: '2026-11-07',
      totalSessions: 10,
      totalMandays: 10,
      totalPresentUnits: 10.0,
      workerSummaries: [],
    }),
  } as unknown as AttendanceService;

  const authService = {
    buildActorContext: async (claims: { sub?: string }) =>
      ({ actorId: claims.sub ?? 'u1', actorType: 'USER', sessionId: 's1' }) as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'admin1', sid: 's1' }),
  } as unknown as AuthService;

  const accessControl = {
    assertPermission: async () => {
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;

  app = await buildApp({
    env,
    services: {
      attendanceService: mockAttendanceService,
      authService,
      accessControl,
      platformCompanyId: null,
    },
  });

  return { app, calls };
}

const authed = (instance: FastifyInstance) => ({
  authorization: `Bearer ${instance.tokenService.signAccessToken('admin1', 's1')}`,
  'x-company-id': CID,
});

describe('attendance routes', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: '/api/v1/attendance/policies',
      headers: { 'x-company-id': CID },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests missing x-company-id with 401', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: '/api/v1/attendance/policies',
      headers: {
        authorization: `Bearer ${testApp.tokenService.signAccessToken('admin1', 's1')}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthorized users with 403', async () => {
    const { app: testApp } = await makeApp({ allow: false });
    const res = await testApp.inject({
      method: 'GET',
      url: '/api/v1/attendance/policies',
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates an attendance policy with 201', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/policies',
      headers: authed(testApp),
      payload: {
        name: 'Block A Shift Policy',
        dayStartHour: 8,
        dayStartMinute: 0,
        shiftDurationMins: 480,
        breakMode: 'FIXED',
        overtimeMode: 'P_MULTIPLIER',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ name: string }>().name).toBe('Block A Shift Policy');
  });

  it('lists attendance policies', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: '/api/v1/attendance/policies',
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown[]>()).toHaveLength(1);
  });

  it('resolves effective attendance policy', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: `/api/v1/attendance/policies/effective?siteId=${SITE_ID}`,
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ dayStartHour: number }>().dayStartHour).toBe(8);
  });

  it('records punch in with 201', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/punch-in',
      headers: authed(testApp),
      payload: {
        siteId: SITE_ID,
        latitude: 23.23,
        longitude: 72.57,
        source: 'MOBILE_SELF',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ status: string; businessDate: string }>();
    expect(body.status).toBe('IN_PROGRESS');
    expect(body.businessDate).toBe('2026-11-17');
  });

  it('records dynamic break start and end', async () => {
    const { app: testApp } = await makeApp();
    const startRes = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/breaks/start',
      headers: authed(testApp),
      payload: { breakType: 'LUNCH' },
    });
    expect(startRes.statusCode).toBe(201);

    const endRes = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/breaks/end',
      headers: authed(testApp),
      payload: { remarks: 'Lunch finished' },
    });
    expect(endRes.statusCode).toBe(200);
  });

  it('records punch out with 200 and calculates hazri units', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/punch-out',
      headers: authed(testApp),
      payload: {
        latitude: 23.23,
        longitude: 72.57,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; totalPUnits: number }>();
    expect(body.status).toBe('COMPLETED');
    expect(body.totalPUnits).toBe(1.5);
  });

  it('allows supervisor regularization with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: `/api/v1/attendance/sessions/${SESS_ID}/regularize`,
      headers: authed(testApp),
      payload: {
        presentUnits: 1.0,
        remarks: 'Approved by Site Engineer',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ source: string }>().source).toBe('MANUAL_CORRECTION');
  });

  it('retrieves daily muster roll / hazri summary', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: `/api/v1/attendance/daily-summary?siteId=${SITE_ID}&businessDate=2026-11-17`,
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalWorkers: number; totalTotalPUnits: number }>();
    expect(body.totalWorkers).toBe(15);
    expect(body.totalTotalPUnits).toBe(18.5);
  });

  it('performs kiosk batch punch in with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/kiosk/batch-punch-in',
      headers: authed(testApp),
      payload: {
        siteId: SITE_ID,
        employeeIds: ['00000000-0000-4000-8000-0000000000e2'],
        latitude: 23.23,
        longitude: 72.57,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalSubmitted: number; successCount: number }>();
    expect(body.totalSubmitted).toBe(2);
    expect(body.successCount).toBe(2);
  });

  it('performs kiosk batch punch out with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/kiosk/batch-punch-out',
      headers: authed(testApp),
      payload: {
        siteId: SITE_ID,
        employeeIds: ['00000000-0000-4000-8000-0000000000e2'],
        latitude: 23.23,
        longitude: 72.57,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalSubmitted: number; successCount: number }>();
    expect(body.totalSubmitted).toBe(1);
    expect(body.successCount).toBe(1);
  });

  it('syncs offline kiosk sessions with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/kiosk/sync',
      headers: authed(testApp),
      payload: {
        siteId: SITE_ID,
        syncBatchId: BATCH_ID,
        sessions: [
          {
            clientSessionId: '00000000-0000-4000-8000-0000000000c2',
            employeeId: '00000000-0000-4000-8000-0000000000e2',
            punchInAt: '2026-11-17T08:30:00.000Z',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ syncedCount: number }>();
    expect(body.syncedCount).toBe(1);
  });

  it('creates a TVT session with 201', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: '/api/v1/attendance/tvt',
      headers: authed(testApp),
      payload: {
        siteId: SITE_ID,
        topic: 'Excavation Safety',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ topic: string }>().topic).toBe('Excavation Safety');
  });

  it('lists TVT sessions with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: `/api/v1/attendance/tvt?siteId=${SITE_ID}`,
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('gets a TVT session by ID with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: `/api/v1/attendance/tvt/${TVT_ID}`,
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ topic: string }>().topic).toBe('Excavation Safety');
  });

  it('adds attendees to a TVT session with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'POST',
      url: `/api/v1/attendance/tvt/${TVT_ID}/attendees`,
      headers: authed(testApp),
      payload: {
        employeeIds: ['00000000-0000-4000-8000-0000000000e2'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ addedCount: number }>().addedCount).toBe(2);
  });

  it('retrieves multi-date muster roll range settlement with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: `/api/v1/attendance/muster-roll?siteId=${SITE_ID}&from=2026-11-01&to=2026-11-07`,
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalSessions: number; totalMandays: number }>();
    expect(body.totalSessions).toBe(10);
    expect(body.totalMandays).toBe(10);
  });

  it('retrieves active session with delayed clock in and proper 8-hour clock out timing with 200', async () => {
    const { app: testApp } = await makeApp();
    const res = await testApp.inject({
      method: 'GET',
      url: '/api/v1/attendance/sessions/active',
      headers: authed(testApp),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      session: {
        id: string;
        isDelayedClockIn: boolean;
        delayedClockInMinutes: number;
        delayedClockInTime: string;
        clockOutTimeProper8Hours: string;
      };
      isDelayedClockIn: boolean;
      delayedClockInMinutes: number;
      delayedClockInTime: string;
      clockOutTimeProper8Hours: string;
    }>();
    expect(body.session.id).toBe(SESS_ID);
    expect(body.session.isDelayedClockIn).toBe(true);
    expect(body.session.delayedClockInMinutes).toBe(20);
    expect(body.session.delayedClockInTime).toBe('00:20');
    expect(body.session.clockOutTimeProper8Hours).toBe('2026-11-21T16:20:00.000Z');
    // Also available at top-level
    expect(body.isDelayedClockIn).toBe(true);
    expect(body.delayedClockInMinutes).toBe(20);
    expect(body.delayedClockInTime).toBe('00:20');
    expect(body.clockOutTimeProper8Hours).toBe('2026-11-21T16:20:00.000Z');

    // Activity log & daily check-in / check-out counters
    const fullBody = res.json<{
      totalCheckInsToday: number;
      totalCheckOutsToday: number;
      currentlyCheckedIn: boolean;
      totalWorkMinutesToday: number;
      activityLog: { type: string; sessionId: string }[];
    }>();
    expect(fullBody.totalCheckInsToday).toBe(2);
    expect(fullBody.totalCheckOutsToday).toBe(1);
    expect(fullBody.currentlyCheckedIn).toBe(true);
    expect(fullBody.totalWorkMinutesToday).toBe(240);
    expect(fullBody.activityLog).toHaveLength(3);
  });
});
