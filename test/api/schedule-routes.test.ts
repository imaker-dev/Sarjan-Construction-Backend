import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { ScheduleService } from '../../src/modules/schedule/service.js';
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
const SCHED_ID = '00000000-0000-4000-8000-0000000000b1';
const REV_ID = '00000000-0000-4000-8000-0000000000b2';
const OVR_ID = '00000000-0000-4000-8000-0000000000b3';
const CAL_ID = '00000000-0000-4000-8000-0000000000f1';
const CAT_ID = '00000000-0000-4000-8000-0000000000f2';
const HOL_ID = '00000000-0000-4000-8000-0000000000e9';

const CREATE_SCHEDULE = {
  scopeType: 'COMPANY',
  name: 'Standard Week',
  effectiveFrom: '2026-01-01',
  revision: {
    effectiveFrom: '2026-01-01',
    timezone: 'Asia/Kolkata',
    workingWeekdays: [1, 2, 3, 4, 5],
  },
};

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const mockScheduleService = {
    createSchedule: async (_a: unknown, _c: string, input: Record<string, unknown>) => ({
      schedule: { id: SCHED_ID, companyId: CID, status: 'ACTIVE', version: 0 },
      revision: { id: REV_ID, revision: 1, ...(input.revision as object) },
    }),
    listSchedules: async () => [{ id: SCHED_ID, name: 'Standard Week' }],
    getSchedule: async (_a: unknown, _c: string, id: string) => ({
      id,
      companyId: CID,
      name: 'Standard Week',
    }),
    updateSchedule: async (
      _a: unknown,
      _c: string,
      id: string,
      input: Record<string, unknown>,
    ) => ({ id, companyId: CID, version: (input.expectedVersion as number) + 1 }),
    archiveSchedule: async (_a: unknown, _c: string, id: string) => ({
      id,
      companyId: CID,
      status: 'ARCHIVED',
    }),
    resolveEffective: async () => ({
      schedule: { id: SCHED_ID, name: 'Standard Week', scopeType: 'COMPANY' },
      revision: { id: REV_ID, revision: 1 },
      resolvedVia: 'COMPANY',
      classification: { day: 'WORKING', reason: 'WORKING' },
    }),
    addRevision: async (_a: unknown, _c: string, _id: string, input: Record<string, unknown>) => ({
      id: REV_ID,
      revision: 2,
      ...input,
    }),
    listRevisions: async () => [{ id: REV_ID, revision: 1 }],
    cancelRevision: async () => ({ id: REV_ID, status: 'ARCHIVED' }),
    addOverride: async (_a: unknown, _c: string, _id: string, input: Record<string, unknown>) => ({
      id: OVR_ID,
      status: 'ACTIVE',
      ...input,
    }),
    listOverrides: async () => [{ id: OVR_ID, date: '2026-03-17', disposition: 'OFF' }],
    cancelOverride: async () => ({ id: OVR_ID, status: 'ARCHIVED' }),
    classifyScheduleDate: async () => ({
      revision: { id: REV_ID, revision: 1 },
      classification: { day: 'WORKING', reason: 'WORKING' },
    }),
    createCalendar: async (_a: unknown, _c: string, input: Record<string, unknown>) => ({
      id: CAL_ID,
      companyId: CID,
      status: 'ACTIVE',
      version: 0,
      ...input,
    }),
    listCalendars: async () => [{ id: CAL_ID, code: 'STD' }],
    updateCalendar: async (_a: unknown, _c: string, id: string) => ({ id, companyId: CID }),
    archiveCalendar: async (_a: unknown, _c: string, id: string) => ({
      id,
      companyId: CID,
      status: 'ARCHIVED',
    }),
    createCategory: async (_a: unknown, _c: string, input: Record<string, unknown>) => ({
      id: CAT_ID,
      companyId: CID,
      status: 'ACTIVE',
      version: 0,
      ...input,
    }),
    listCategories: async () => [{ id: CAT_ID, code: 'regional' }],
    archiveCategory: async (_a: unknown, _c: string, id: string) => ({
      id,
      companyId: CID,
      status: 'ARCHIVED',
    }),
    addHoliday: async (_a: unknown, _c: string, _cal: string, input: Record<string, unknown>) => ({
      id: HOL_ID,
      companyId: CID,
      status: 'ACTIVE',
      ...input,
    }),
    addHolidaysBulk: async () => ({ created: 2 }),
    cancelHoliday: async () => undefined,
    listHolidays: async () => [
      { id: HOL_ID, date: '2026-01-26', name: 'Republic Day', categoryId: CAT_ID },
    ],
  } as unknown as ScheduleService;

  const mockAuthService = {
    buildActorContext: async () =>
      ({ actorId: 'admin1', actorType: 'USER', sessionId: 's1' }) as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'admin1', sid: 's1' }),
  } as unknown as AuthService;

  const mockAccessControl = {
    assertPermission: async () => {
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;

  return buildApp({
    env,
    services: {
      authService: mockAuthService,
      accessControl: mockAccessControl,
      scheduleService: mockScheduleService,
      platformCompanyId: null,
    },
  });
}

const AUTH = (a: FastifyInstance) => ({
  authorization: `Bearer ${a.tokenService.signAccessToken('admin1', 's1')}`,
  'x-company-id': CID,
});

describe('Schedule Routes (/api/v1/schedules)', () => {
  it('POST /schedules creates a schedule + first revision (201)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: AUTH(app),
      payload: CREATE_SCHEDULE,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      schedule: { id: SCHED_ID, companyId: CID },
      revision: { id: REV_ID, revision: 1 },
    });
  });

  it('POST /schedules accepts a rotation pattern (201)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: AUTH(app),
      payload: {
        ...CREATE_SCHEDULE,
        revision: {
          effectiveFrom: '2026-01-05',
          timezone: 'Asia/Kolkata',
          workingWeekdays: [],
          rotation: {
            anchor: '2026-01-05',
            lengthDays: 7,
            workingOffsets: [0, 1, 2, 3, 4, 5],
            offOffsets: [6],
          },
        },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST /schedules rejects a body missing required fields (400)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: AUTH(app),
      payload: { scopeType: 'COMPANY', name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /schedules rejects out-of-range weekdays (400)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: AUTH(app),
      payload: {
        ...CREATE_SCHEDULE,
        revision: {
          effectiveFrom: '2026-01-01',
          timezone: 'Asia/Kolkata',
          workingWeekdays: [8],
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /schedules lists schedules', async () => {
    app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/schedules', headers: AUTH(app) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('GET /schedules/effective resolves the schedule', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/schedules/effective',
      headers: AUTH(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resolvedVia: 'COMPANY' });
  });

  it('PATCH /schedules/:id requires expectedVersion', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/schedules/${SCHED_ID}`,
      headers: AUTH(app),
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /schedules/:id/revisions appends an immutable revision (201)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/schedules/${SCHED_ID}/revisions`,
      headers: AUTH(app),
      payload: {
        effectiveFrom: '2026-06-01',
        timezone: 'Asia/Kolkata',
        workingWeekdays: [1, 2, 3, 4, 5, 6],
        expectedVersion: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ revision: 2 });
  });

  it('POST .../revisions/:revisionId/cancel cancels a revision', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/schedules/${SCHED_ID}/revisions/${REV_ID}/cancel`,
      headers: AUTH(app),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET+POST /schedules/:id/overrides manage per-date overrides', async () => {
    app = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/schedules/${SCHED_ID}/overrides`,
      headers: AUTH(app),
    });
    expect(list.statusCode).toBe(200);
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/schedules/${SCHED_ID}/overrides`,
      headers: AUTH(app),
      payload: { date: '2026-03-17', disposition: 'OFF', name: 'Plant shutdown' },
    });
    expect(add.statusCode).toBe(201);
  });

  it('POST /schedules/:id/overrides rejects an invalid disposition (400)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/schedules/${SCHED_ID}/overrides`,
      headers: AUTH(app),
      payload: { date: '2026-03-17', disposition: 'HALF_DAY' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST .../overrides/:overrideId/cancel cancels an override', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/schedules/${SCHED_ID}/overrides/${OVR_ID}/cancel`,
      headers: AUTH(app),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /schedules/:id/classify/:date classifies a date', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/schedules/${SCHED_ID}/classify/2026-03-17`,
      headers: AUTH(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ classification: { day: 'WORKING' } });
  });

  it('mutations are denied without permission', async () => {
    app = await makeApp({ allow: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: AUTH(app),
      payload: CREATE_SCHEDULE,
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('requires authentication', async () => {
    app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/schedules' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Holiday Calendar Routes (/api/v1/holiday-calendars)', () => {
  it('POST /holiday-calendars creates a calendar (201)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/holiday-calendars',
      headers: AUTH(app),
      payload: { code: 'std', name: 'Standard Holidays' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: CAL_ID });
  });

  it('POST /holiday-calendars/:id/holidays adds a holiday via categoryId (201)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/holiday-calendars/${CAL_ID}/holidays`,
      headers: AUTH(app),
      payload: { date: '2026-01-26', name: 'Republic Day', categoryId: CAT_ID },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST /holiday-calendars/:id/holidays rejects the removed "kind" field pattern (400)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/holiday-calendars/${CAL_ID}/holidays`,
      headers: AUTH(app),
      payload: { date: '2026-01-26', name: 'Republic Day' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST .../holidays/bulk accepts a bounded list (201)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/holiday-calendars/${CAL_ID}/holidays/bulk`,
      headers: AUTH(app),
      payload: {
        holidays: [
          { date: '2026-01-26', name: 'Republic Day', categoryId: CAT_ID },
          { date: '2026-08-15', name: 'Independence Day', categoryId: CAT_ID },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: 2 });
  });

  it('POST .../holidays rejects an invalid date shape (400)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/holiday-calendars/${CAL_ID}/holidays`,
      headers: AUTH(app),
      payload: { date: '26-01-2026', name: 'Bad Date', categoryId: CAT_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST .../holidays/:holidayId/cancel cancels (not deletes) a holiday', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/holiday-calendars/${CAL_ID}/holidays/${HOL_ID}/cancel`,
      headers: AUTH(app),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE .../holidays/:holidayId is no longer a route (404)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/holiday-calendars/${CAL_ID}/holidays/${HOL_ID}`,
      headers: AUTH(app),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Holiday Category Routes (/api/v1/holiday-categories)', () => {
  it('POST /holiday-categories creates an admin-defined category (201)', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/holiday-categories',
      headers: AUTH(app),
      payload: { code: 'regional', name: 'Regional Festival' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: CAT_ID, code: 'regional' });
  });

  it('GET /holiday-categories lists categories', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/holiday-categories',
      headers: AUTH(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('POST /holiday-categories/:id/archive archives a category', async () => {
    app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/holiday-categories/${CAT_ID}/archive`,
      headers: AUTH(app),
      payload: { expectedVersion: 0 },
    });
    expect(res.statusCode).toBe(200);
  });
});
