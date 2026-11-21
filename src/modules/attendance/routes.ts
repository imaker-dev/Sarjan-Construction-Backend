import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import {
  ATTENDANCE_MANAGE,
  ATTENDANCE_READ,
  ATTENDANCE_RECORD,
  type AttendanceService,
} from './service.js';
import {
  AddTvtAttendeesBody,
  CalculateDailyReportBody,
  CreatePolicyBody,
  CreateTvtSessionBody,
  DailySummaryQuery,
  EndBreakBody,
  KioskBatchPunchInBody,
  KioskBatchPunchOutBody,
  KioskOfflineSyncBody,
  ListDailyReportsQuery,
  ListSessionsQuery,
  ListTvtSessionsQuery,
  LockDailyReportBody,
  MusterRollRangeQuery,
  PunchInBody,
  PunchOutBody,
  RegularizeSessionBody,
  RejectDailyReportBody,
  StartBreakBody,
  UpdateDailyReportBody,
  UpdateLabourSummaryBody,
  UpdatePolicyBody,
  type AddTvtAttendeesInput,
  type CalculateDailyReportInput,
  type CreatePolicyInput,
  type CreateTvtSessionInput,
  type DailySummaryFilter,
  type EndBreakInput,
  type KioskBatchPunchInInput,
  type KioskBatchPunchOutInput,
  type KioskOfflineSyncInput,
  type ListDailyReportsFilter,
  type ListSessionsFilter,
  type ListTvtSessionsFilter,
  type LockDailyReportInput,
  type MusterRollRangeFilter,
  type PunchInInput,
  type PunchOutInput,
  type RegularizeSessionInput,
  type RejectDailyReportInput,
  type StartBreakInput,
  type UpdateDailyReportInput,
  type UpdateLabourSummaryInput,
} from './types.js';

function companyIdOf(request: FastifyRequest): string {
  const c = request.headers['x-company-id'];
  if (typeof c !== 'string' || c.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return c;
}

const atCompany = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(r);
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};

const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

const PolicyParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const SessionParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const TvtParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const DailyReportParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const DailyReportLabourSummaryParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  summaryId: Type.String({ format: 'uuid' }),
});

const EffectivePolicyQuery = Type.Object({
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
});

export function attendanceRoutes(service: AttendanceService) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, atCompany)],
    });

    // -----------------------------------------------------------------------
    // Policy Routes
    // -----------------------------------------------------------------------

    app.get(
      '/attendance/policies',
      {
        schema: {
          querystring: Type.Object({
            scope: Type.Optional(
              Type.Union([
                Type.Literal('COMPANY'),
                Type.Literal('PROJECT'),
                Type.Literal('SITE'),
                Type.Literal('EMPLOYEE'),
              ]),
            ),
          }),
        },
        ...perm(ATTENDANCE_READ),
      },
      async (req) => {
        const query = req.query as { scope?: 'COMPANY' | 'PROJECT' | 'SITE' | 'EMPLOYEE' };
        return service.listPolicies(actorOf(req), companyIdOf(req), query.scope);
      },
    );

    app.post(
      '/attendance/policies',
      { schema: { body: CreatePolicyBody }, ...perm(ATTENDANCE_MANAGE) },
      async (req, reply) => {
        const created = await service.createPolicy(
          actorOf(req),
          companyIdOf(req),
          req.body as CreatePolicyInput,
        );
        return reply.code(201).send(created);
      },
    );

    app.get(
      '/attendance/policies/effective',
      { schema: { querystring: EffectivePolicyQuery }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        const query = req.query as { siteId?: string; employeeId?: string };
        return service.resolveEffectivePolicy(actorOf(req), companyIdOf(req), query);
      },
    );

    app.get(
      '/attendance/policies/:id',
      { schema: { params: PolicyParams }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getPolicy(actorOf(req), companyIdOf(req), id);
      },
    );

    app.patch(
      '/attendance/policies/:id',
      {
        schema: {
          params: PolicyParams,
          body: Type.Intersect([
            UpdatePolicyBody,
            Type.Object({ expectedVersion: Type.Optional(Type.Integer()) }),
          ]),
        },
        ...perm(ATTENDANCE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as Record<string, unknown>;
        const { expectedVersion, ...input } = body;
        return service.updatePolicy(
          actorOf(req),
          companyIdOf(req),
          id,
          input,
          expectedVersion as number | undefined,
        );
      },
    );

    // -----------------------------------------------------------------------
    // Punch In / Punch Out
    // -----------------------------------------------------------------------

    app.post(
      '/attendance/punch-in',
      { schema: { body: PunchInBody }, ...perm(ATTENDANCE_RECORD) },
      async (req, reply) => {
        const session = await service.punchIn(
          actorOf(req),
          companyIdOf(req),
          req.body as PunchInInput,
        );
        return reply.code(201).send(session);
      },
    );

    app.post(
      '/attendance/punch-out',
      { schema: { body: PunchOutBody }, ...perm(ATTENDANCE_RECORD) },
      async (req) => {
        return service.punchOut(actorOf(req), companyIdOf(req), req.body as PunchOutInput);
      },
    );

    // -----------------------------------------------------------------------
    // Dynamic Breaks
    // -----------------------------------------------------------------------

    app.post(
      '/attendance/breaks/start',
      { schema: { body: StartBreakBody }, ...perm(ATTENDANCE_RECORD) },
      async (req, reply) => {
        const brk = await service.startBreak(
          actorOf(req),
          companyIdOf(req),
          req.body as StartBreakInput,
        );
        return reply.code(201).send(brk);
      },
    );

    app.post(
      '/attendance/breaks/end',
      { schema: { body: EndBreakBody }, ...perm(ATTENDANCE_RECORD) },
      async (req) => {
        return service.endBreak(actorOf(req), companyIdOf(req), req.body as EndBreakInput);
      },
    );

    // -----------------------------------------------------------------------
    // Sessions & Muster Roll Summary
    // -----------------------------------------------------------------------

    app.get(
      '/attendance/sessions/active',
      {
        schema: {
          querystring: Type.Object({
            employeeId: Type.Optional(Type.String({ format: 'uuid' })),
          }),
        },
        ...perm(ATTENDANCE_READ),
      },
      async (req) => {
        const query = req.query as { employeeId?: string };
        const active = await service.getActiveSession(
          actorOf(req),
          companyIdOf(req),
          query.employeeId,
        );

        if (!active) {
          const summary = await service.getDailySummaryForEmployee(
            actorOf(req),
            companyIdOf(req),
            query.employeeId,
          );
          return {
            session: null,
            ...(summary ?? {}),
          };
        }

        return {
          session: active,
          ...(active.isDelayedClockIn !== undefined
            ? {
                isDelayedClockIn: active.isDelayedClockIn,
                delayedClockInMinutes: active.delayedClockInMinutes,
                delayedClockInTime: active.delayedClockInTime,
                delayedClockInFormatted: active.delayedClockInFormatted,
                clockOutTimeProper8Hours: active.clockOutTimeProper8Hours,
                expectedClockOutAt: active.expectedClockOutAt,
                scheduledClockInAt: active.scheduledClockInAt,
                targetWorkDurationMins: active.targetWorkDurationMins,
                remainingMinutesFor8Hours: active.remainingMinutesFor8Hours,
              }
            : {}),
          ...(active.activityLog !== undefined
            ? {
                businessDate: active.businessDate,
                totalCheckInsToday: active.totalCheckInsToday,
                totalCheckOutsToday: active.totalCheckOutsToday,
                currentlyCheckedIn: active.currentlyCheckedIn,
                totalWorkMinutesToday: active.totalWorkMinutesToday,
                totalBreakMinutesToday: active.totalBreakMinutesToday,
                activityLog: active.activityLog,
              }
            : {}),
        };
      },
    );

    app.get(
      '/attendance/sessions',
      { schema: { querystring: ListSessionsQuery }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        return service.listSessions(
          actorOf(req),
          companyIdOf(req),
          req.query as ListSessionsFilter,
        );
      },
    );

    app.get(
      '/attendance/sessions/:id',
      { schema: { params: SessionParams }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getSession(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/attendance/sessions/:id/regularize',
      {
        schema: {
          params: SessionParams,
          body: RegularizeSessionBody,
        },
        ...perm(ATTENDANCE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.regularizeSession(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as RegularizeSessionInput,
        );
      },
    );

    app.get(
      '/attendance/daily-summary',
      { schema: { querystring: DailySummaryQuery }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        return service.getDailySummary(
          actorOf(req),
          companyIdOf(req),
          req.query as DailySummaryFilter,
        );
      },
    );

    // -----------------------------------------------------------------------
    // Kiosk Batch Operations & Offline Sync
    // -----------------------------------------------------------------------

    app.post(
      '/attendance/kiosk/batch-punch-in',
      { schema: { body: KioskBatchPunchInBody }, ...perm(ATTENDANCE_RECORD) },
      async (req) => {
        return service.kioskBatchPunchIn(
          actorOf(req),
          companyIdOf(req),
          req.body as KioskBatchPunchInInput,
        );
      },
    );

    app.post(
      '/attendance/kiosk/batch-punch-out',
      { schema: { body: KioskBatchPunchOutBody }, ...perm(ATTENDANCE_RECORD) },
      async (req) => {
        return service.kioskBatchPunchOut(
          actorOf(req),
          companyIdOf(req),
          req.body as KioskBatchPunchOutInput,
        );
      },
    );

    app.post(
      '/attendance/kiosk/sync',
      { schema: { body: KioskOfflineSyncBody }, ...perm(ATTENDANCE_RECORD) },
      async (req) => {
        return service.kioskOfflineSync(
          actorOf(req),
          companyIdOf(req),
          req.body as KioskOfflineSyncInput,
        );
      },
    );

    // -----------------------------------------------------------------------
    // Safety Toolbox Talk (TVT) Gate Routes
    // -----------------------------------------------------------------------

    app.post(
      '/attendance/tvt',
      { schema: { body: CreateTvtSessionBody }, ...perm(ATTENDANCE_RECORD) },
      async (req, reply) => {
        const created = await service.createTvtSession(
          actorOf(req),
          companyIdOf(req),
          req.body as CreateTvtSessionInput,
        );
        reply.status(201);
        return created;
      },
    );

    app.get(
      '/attendance/tvt',
      { schema: { querystring: ListTvtSessionsQuery }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        return service.listTvtSessions(
          actorOf(req),
          companyIdOf(req),
          req.query as ListTvtSessionsFilter,
        );
      },
    );

    app.get(
      '/attendance/tvt/:id',
      { schema: { params: TvtParams }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getTvtSession(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/attendance/tvt/:id/attendees',
      {
        schema: {
          params: TvtParams,
          body: AddTvtAttendeesBody,
        },
        ...perm(ATTENDANCE_RECORD),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.addTvtAttendees(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as AddTvtAttendeesInput,
        );
      },
    );

    // -----------------------------------------------------------------------
    // Multi-Date Muster Roll Range Settlement Export
    // -----------------------------------------------------------------------

    app.get(
      '/attendance/muster-roll',
      { schema: { querystring: MusterRollRangeQuery }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        return service.getMusterRollRange(
          actorOf(req),
          companyIdOf(req),
          req.query as MusterRollRangeFilter,
        );
      },
    );

    // -----------------------------------------------------------------------
    // Daily Site Report (DSR) & End-of-Day Settlement Engine Routes
    // -----------------------------------------------------------------------

    app.post(
      '/attendance/daily-reports/calculate',
      { schema: { body: CalculateDailyReportBody }, ...perm(ATTENDANCE_MANAGE) },
      async (req, reply) => {
        const result = await service.calculateDailyReport(
          actorOf(req),
          companyIdOf(req),
          req.body as CalculateDailyReportInput,
        );
        reply.status(200);
        return result;
      },
    );

    app.get(
      '/attendance/daily-reports',
      { schema: { querystring: ListDailyReportsQuery }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        return service.getDailyReports(
          actorOf(req),
          companyIdOf(req),
          req.query as ListDailyReportsFilter,
        );
      },
    );

    app.get(
      '/attendance/daily-reports/:id',
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getDailyReportById(actorOf(req), companyIdOf(req), id);
      },
    );

    app.patch(
      '/attendance/daily-reports/:id',
      {
        schema: {
          params: DailyReportParams,
          body: UpdateDailyReportBody,
        },
        ...perm(ATTENDANCE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.updateDailyReport(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as UpdateDailyReportInput,
        );
      },
    );

    app.patch(
      '/attendance/daily-reports/:id/labour-summary/:summaryId',
      {
        schema: {
          params: DailyReportLabourSummaryParams,
          body: UpdateLabourSummaryBody,
        },
        ...perm(ATTENDANCE_MANAGE),
      },
      async (req) => {
        const { id, summaryId } = req.params as { id: string; summaryId: string };
        return service.updateLabourSummary(
          actorOf(req),
          companyIdOf(req),
          id,
          summaryId,
          req.body as UpdateLabourSummaryInput,
        );
      },
    );

    app.post(
      '/attendance/daily-reports/:id/submit',
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_RECORD) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.submitDailyReport(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/attendance/daily-reports/:id/approve',
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_MANAGE) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.approveDailyReport(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/attendance/daily-reports/:id/reject',
      {
        schema: {
          params: DailyReportParams,
          body: RejectDailyReportBody,
        },
        ...perm(ATTENDANCE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.rejectDailyReport(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as RejectDailyReportInput,
        );
      },
    );

    app.post(
      '/attendance/daily-reports/:id/lock',
      {
        schema: {
          params: DailyReportParams,
          body: Type.Optional(LockDailyReportBody),
        },
        ...perm(ATTENDANCE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.lockDailyReport(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as LockDailyReportInput,
        );
      },
    );

    app.get(
      '/attendance/daily-reports/:id/audit-trail',
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getDailyReportAuditTrail(actorOf(req), companyIdOf(req), id);
      },
    );
  };
}
