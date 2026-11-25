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
  DailyReportExportQuery,
  DailySummaryQuery,
  EndBreakBody,
  KioskBatchPunchInBody,
  KioskBatchPunchOutBody,
  KioskOfflineSyncBody,
  ListDailyReportsQuery,
  ListSessionsQuery,
  ListTvtSessionsQuery,
  LockDailyReportBody,
  ManualSessionBody,
  MusterRollExportQuery,
  MusterRollRangeQuery,
  PunchInBody,
  PunchOutBody,
  RegularizeSessionBody,
  RejectDailyReportBody,
  StartBreakBody,
  TriggerReportExportBody,
  UpdateDailyReportBody,
  UpdateLabourSummaryBody,
  UpdatePolicyBody,
  type AddTvtAttendeesInput,
  type CalculateDailyReportInput,
  type CreatePolicyInput,
  type CreateTvtSessionInput,
  type DailyReportExportFilter,
  type DailySummaryFilter,
  type EndBreakInput,
  type KioskBatchPunchInInput,
  type KioskBatchPunchOutInput,
  type KioskOfflineSyncInput,
  type ListDailyReportsFilter,
  type ListSessionsFilter,
  type ListTvtSessionsFilter,
  type LockDailyReportInput,
  type ManualSessionInput,
  type MusterRollExportFilter,
  type MusterRollRangeFilter,
  type PunchInInput,
  type PunchOutInput,
  type RegularizeSessionInput,
  type RejectDailyReportInput,
  type StartBreakInput,
  type TriggerReportExportInput,
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

const siteTarget = (companyId: string, siteId: string): ScopeTarget => ({
  companyId,
  scopeType: 'SITE',
  scopeId: siteId,
});

const headOfficeTarget = (companyId: string, headOfficeId: string): ScopeTarget => ({
  companyId,
  scopeType: 'HEAD_OFFICE',
  scopeId: headOfficeId,
});

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
    const resolveScope = (r: FastifyRequest): ScopeTarget => {
      const companyId = companyIdOf(r);
      const q = (r.query ?? {}) as Record<string, unknown>;
      const b = (r.body ?? {}) as Record<string, unknown>;
      const siteId = typeof q.siteId === 'string' ? q.siteId : typeof b.siteId === 'string' ? b.siteId : undefined;
      if (siteId) return { companyId, scopeType: 'SITE', scopeId: siteId };
      const headOfficeId =
        typeof q.headOfficeId === 'string'
          ? q.headOfficeId
          : typeof b.headOfficeId === 'string'
            ? b.headOfficeId
            : undefined;
      if (headOfficeId) return { companyId, scopeType: 'HEAD_OFFICE', scopeId: headOfficeId };
      const projectId =
        typeof q.projectId === 'string'
          ? q.projectId
          : typeof b.projectId === 'string'
            ? b.projectId
            : undefined;
      if (projectId) return { companyId, scopeType: 'PROJECT', scopeId: projectId };
      return { companyId, scopeType: 'COMPANY', scopeId: companyId };
    };

    // Route gates resolve the permission target from server-loaded entities —
    // never from caller-supplied employee/site combinations alone. PI/PD
    // scoped grants pass only for their own project/site targets; anything
    // unresolvable falls back to COMPANY and fails closed.
    const perm = (
      key: string,
      resolveScope: (r: FastifyRequest) => ScopeTarget | Promise<ScopeTarget> = atCompany,
    ) => ({
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(key, resolveScope),
      ],
    });

    const bodyScope = (r: FastifyRequest): Promise<ScopeTarget> | ScopeTarget => {
      const companyId = companyIdOf(r);
      const b = (r.body ?? {}) as {
        siteId?: string;
        headOfficeId?: string;
        departmentId?: string;
        employeeId?: string;
        sessionId?: string;
      };
      if (b.sessionId !== undefined) return service.resolveScope(companyId, 'session', b.sessionId);
      if (b.siteId !== undefined) return siteTarget(companyId, b.siteId);
      if (b.headOfficeId !== undefined) return headOfficeTarget(companyId, b.headOfficeId);
      if (b.departmentId !== undefined)
        return service.resolveScope(companyId, 'department', b.departmentId);
      if (b.employeeId !== undefined)
        return service.resolveScope(companyId, 'employee', b.employeeId);
      return service.resolveScope(
        companyId,
        'principal',
        (r.principal as { actorId: string }).actorId,
      );
    };

    const queryScope = (r: FastifyRequest): Promise<ScopeTarget> | ScopeTarget => {
      const companyId = companyIdOf(r);
      const q = (r.query ?? {}) as {
        siteId?: string;
        headOfficeId?: string;
        departmentId?: string;
        employeeId?: string;
      };
      if (q.siteId !== undefined) return siteTarget(companyId, q.siteId);
      if (q.headOfficeId !== undefined) return headOfficeTarget(companyId, q.headOfficeId);
      if (q.departmentId !== undefined)
        return service.resolveScope(companyId, 'department', q.departmentId);
      if (q.employeeId !== undefined)
        return service.resolveScope(companyId, 'employee', q.employeeId);
      return atCompany(r);
    };

    const atSession = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScope(companyIdOf(r), 'session', (r.params as { id: string }).id);
    const atReport = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScope(companyIdOf(r), 'dailyReport', (r.params as { id: string }).id);
    const atTvt = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScope(companyIdOf(r), 'tvt', (r.params as { id: string }).id);
    const atPrincipal = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScope(
        companyIdOf(r),
        'principal',
        (r.principal as { actorId: string }).actorId,
      );
    const scopedPerm = (key: string) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, resolveScope)],
    });
    const anyScopePerm = (key: string) => ({
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requireAnyScopePermission(key, companyIdOf),
      ],
    });
    const authOnly = {
      preHandler: [app.authenticate, app.tenantCompanyGuard],
    };

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
        ...anyScopePerm(ATTENDANCE_READ),
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
      { schema: { querystring: EffectivePolicyQuery }, ...scopedPerm(ATTENDANCE_READ, queryScope) },
      async (req) => {
        const query = req.query as { siteId?: string; employeeId?: string };
        return service.resolveEffectivePolicy(actorOf(req), companyIdOf(req), query);
      },
    );

    app.get(
      '/attendance/policies/:id',
      { schema: { params: PolicyParams }, ...anyScopePerm(ATTENDANCE_READ) },
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
      { schema: { body: PunchInBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
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
      { schema: { body: PunchOutBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
      async (req) => {
        return service.punchOut(actorOf(req), companyIdOf(req), req.body as PunchOutInput);
      },
    );

    // -----------------------------------------------------------------------
    // Dynamic Breaks
    // -----------------------------------------------------------------------

    app.post(
      '/attendance/breaks/start',
      { schema: { body: StartBreakBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
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
      { schema: { body: EndBreakBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
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
        ...perm(ATTENDANCE_READ, (r) => {
          const q = r.query as { employeeId?: string };
          return q.employeeId !== undefined
            ? service.resolveScope(companyIdOf(r), 'employee', q.employeeId)
            : atPrincipal(r);
        }),
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
            ...(summary?.weeklyProgress !== undefined
              ? { weeklyProgress: summary.weeklyProgress }
              : {}),
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
          ...(active.weeklyProgress !== undefined
            ? {
              weeklyProgress: active.weeklyProgress,
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
      { schema: { querystring: ListSessionsQuery }, ...perm(ATTENDANCE_READ, queryScope) },
      async (req) => {
        return service.listSessions(
          actorOf(req),
          companyIdOf(req),
          req.query as ListSessionsFilter,
        );
      },
    );

    // Manual missed-session correction — ATTENDANCE_MANAGE at the resolved
    // site/head-office target. The server sets source='MANUAL_CORRECTION'
    // and requires remarks; clientSessionId makes replays idempotent.
    app.post(
      '/attendance/sessions',
      {
        schema: {
          body: ManualSessionBody,
          description:
            'Create a manual attendance-session correction (missed punch). ' +
            'Requires ATTENDANCE_MANAGE at the resolved site/head-office target. ' +
            'source is server-set to MANUAL_CORRECTION and must not be sent.',
        },
        ...perm(ATTENDANCE_MANAGE, bodyScope),
      },
      async (req, reply) => {
        const session = await service.createManualSession(
          actorOf(req),
          companyIdOf(req),
          req.body as ManualSessionInput,
        );
        return reply.code(201).send(session);
      },
    );

    app.get(
      '/attendance/sessions/:id',
      { schema: { params: SessionParams }, ...perm(ATTENDANCE_READ, atSession) },
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
        ...perm(ATTENDANCE_MANAGE, atSession),
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
      { schema: { querystring: DailySummaryQuery }, ...perm(ATTENDANCE_READ, queryScope) },
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
      { schema: { body: KioskBatchPunchInBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
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
      { schema: { body: KioskBatchPunchOutBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
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
      { schema: { body: KioskOfflineSyncBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
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
      { schema: { body: CreateTvtSessionBody }, ...perm(ATTENDANCE_RECORD, bodyScope) },
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
      { schema: { querystring: ListTvtSessionsQuery }, ...perm(ATTENDANCE_READ, queryScope) },
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
      { schema: { params: TvtParams }, ...perm(ATTENDANCE_READ, atTvt) },
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
        ...perm(ATTENDANCE_RECORD, atTvt),
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
      { schema: { querystring: MusterRollRangeQuery }, ...perm(ATTENDANCE_READ, queryScope) },
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
      { schema: { body: CalculateDailyReportBody }, ...perm(ATTENDANCE_MANAGE, bodyScope) },
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
      { schema: { querystring: ListDailyReportsQuery }, ...perm(ATTENDANCE_READ, queryScope) },
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
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_READ, atReport) },
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
        ...perm(ATTENDANCE_MANAGE, atReport),
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
        ...perm(ATTENDANCE_MANAGE, atReport),
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
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_RECORD, atReport) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.submitDailyReport(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/attendance/daily-reports/:id/approve',
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_MANAGE, atReport) },
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
        ...perm(ATTENDANCE_MANAGE, atReport),
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
        ...perm(ATTENDANCE_MANAGE, atReport),
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
      { schema: { params: DailyReportParams }, ...perm(ATTENDANCE_READ, atReport) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getDailyReportAuditTrail(actorOf(req), companyIdOf(req), id);
      },
    );

    // -----------------------------------------------------------------------
    // Server-Side PDF & Excel Report Trigger / Download Routes
    // -----------------------------------------------------------------------

    app.post(
      '/attendance/reports/export',
      { schema: { body: TriggerReportExportBody }, ...scopedPerm(ATTENDANCE_READ) },
      async (req, reply) => {
        const body = req.body as TriggerReportExportInput;
        const exported = await service.triggerAndExportReport(actorOf(req), companyIdOf(req), body);
        reply.header('content-type', exported.contentType);
        reply.header('content-disposition', `attachment; filename="${exported.fileName}"`);
        return reply.send(exported.stream);
      },
    );

    app.get(
      '/attendance/daily-reports/:id/export',
      {
        schema: { params: DailyReportParams, querystring: DailyReportExportQuery },
        ...authOnly,
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const { format } = req.query as DailyReportExportFilter;
        const exported = await service.exportDailySiteReport(
          actorOf(req),
          companyIdOf(req),
          id,
          format,
        );
        reply.header('content-type', exported.contentType);
        reply.header('content-disposition', `attachment; filename="${exported.fileName}"`);
        return reply.send(exported.stream);
      },
    );

    app.get(
      '/attendance/muster-roll/export',
      { schema: { querystring: MusterRollExportQuery }, ...scopedPerm(ATTENDANCE_READ) },
      async (req, reply) => {
        const { format, ...filter } = req.query as MusterRollExportFilter;
        const exported = await service.exportMusterRollReport(
          actorOf(req),
          companyIdOf(req),
          filter,
          format,
        );
        reply.header('content-type', exported.contentType);
        reply.header('content-disposition', `attachment; filename="${exported.fileName}"`);
        return reply.send(exported.stream);
      },
    );
  };
}
