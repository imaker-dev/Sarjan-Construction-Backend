import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import { WORK_SCHEDULE_MANAGE, WORK_SCHEDULE_READ, type ScheduleService } from './service.js';
import {
  AddHolidayBody,
  AddOverrideBody,
  AddRevisionBody,
  ArchiveHolidayCategoryBody,
  ArchiveWorkScheduleBody,
  BulkAddHolidaysBody,
  CancelHolidayBody,
  CancelOverrideBody,
  CreateHolidayCalendarBody,
  CreateHolidayCategoryBody,
  CreateWorkScheduleBody,
  EffectiveScheduleQuery,
  ListHolidayCalendarsQuery,
  ListHolidayCategoriesQuery,
  ListHolidaysQuery,
  ListOverridesQuery,
  ListWorkSchedulesQuery,
  UpdateHolidayCalendarBody,
  UpdateWorkScheduleBody,
  type AddHolidayInput,
  type AddOverrideInput,
  type AddRevisionInput,
  type ArchiveHolidayCategoryInput,
  type ArchiveWorkScheduleInput,
  type BulkAddHolidaysInput,
  type CreateHolidayCalendarInput,
  type CreateHolidayCategoryInput,
  type CreateWorkScheduleInput,
  type EffectiveScheduleCriteria,
  type ListHolidayCalendarsFilter,
  type ListHolidayCategoriesFilter,
  type ListHolidaysFilter,
  type ListOverridesFilter,
  type ListWorkSchedulesFilter,
  type UpdateHolidayCalendarInput,
  type UpdateWorkScheduleInput,
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

const IdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const RevisionParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  revisionId: Type.String({ format: 'uuid' }),
});

const OverrideParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  overrideId: Type.String({ format: 'uuid' }),
});

const CalendarParams = Type.Object({
  calendarId: Type.String({ format: 'uuid' }),
});

const HolidayParams = Type.Object({
  calendarId: Type.String({ format: 'uuid' }),
  holidayId: Type.String({ format: 'uuid' }),
});

const ClassifyParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
});

export function scheduleRoutes(service: ScheduleService) {
  return async function routes(app: FastifyInstance) {
    // Route gates resolve the permission target from server-loaded entities
    // — the schedule's own scope for :id routes, the criteria entity for
    // create/list/effective. Scoped PI/PD holders pass only for their own
    // project/site; unresolvable refs fall back to COMPANY (fail closed).
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

    const atSchedule = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScopeTargetForSchedule(companyIdOf(r), (r.params as { id: string }).id);

    const atCriteria = (r: FastifyRequest): Promise<ScopeTarget> => {
      const src = {
        ...(r.query !== null && typeof r.query === 'object' ? r.query : {}),
        ...(r.body !== null && typeof r.body === 'object' ? r.body : {}),
      } as { siteId?: string; projectId?: string; employeeId?: string; departmentId?: string };
      return service.resolveScopeTargetForCriteria(companyIdOf(r), src);
    };

    // -------------------------------------------------------------------------
    // Work schedules
    // -------------------------------------------------------------------------

    app.post(
      '/schedules',
      { schema: { body: CreateWorkScheduleBody }, ...perm(WORK_SCHEDULE_MANAGE, atCriteria) },
      async (req, reply) => {
        const result = await service.createSchedule(
          actorOf(req),
          companyIdOf(req),
          req.body as CreateWorkScheduleInput,
        );
        reply.code(201);
        return result;
      },
    );

    app.get(
      '/schedules',
      { schema: { querystring: ListWorkSchedulesQuery }, ...perm(WORK_SCHEDULE_READ, atCriteria) },
      async (req) => {
        return service.listSchedules(
          actorOf(req),
          companyIdOf(req),
          req.query as ListWorkSchedulesFilter,
        );
      },
    );

    app.get(
      '/schedules/effective',
      { schema: { querystring: EffectiveScheduleQuery }, ...perm(WORK_SCHEDULE_READ, atCriteria) },
      async (req) => {
        return service.resolveEffective(
          actorOf(req),
          companyIdOf(req),
          req.query as EffectiveScheduleCriteria,
        );
      },
    );

    app.get(
      '/schedules/:id',
      { schema: { params: IdParams }, ...perm(WORK_SCHEDULE_READ, atSchedule) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getSchedule(actorOf(req), companyIdOf(req), id);
      },
    );

    app.patch(
      '/schedules/:id',
      {
        schema: { params: IdParams, body: UpdateWorkScheduleBody },
        ...perm(WORK_SCHEDULE_MANAGE, atSchedule),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.updateSchedule(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as UpdateWorkScheduleInput,
        );
      },
    );

    app.post(
      '/schedules/:id/archive',
      {
        schema: { params: IdParams, body: ArchiveWorkScheduleBody },
        ...perm(WORK_SCHEDULE_MANAGE, atSchedule),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as ArchiveWorkScheduleInput;
        return service.archiveSchedule(actorOf(req), companyIdOf(req), id, body.expectedVersion);
      },
    );

    // -------------------------------------------------------------------------
    // Revisions — append-only pattern history
    // -------------------------------------------------------------------------

    app.get(
      '/schedules/:id/revisions',
      { schema: { params: IdParams }, ...perm(WORK_SCHEDULE_READ, atSchedule) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.listRevisions(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/schedules/:id/revisions',
      {
        schema: { params: IdParams, body: AddRevisionBody },
        ...perm(WORK_SCHEDULE_MANAGE, atSchedule),
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const revision = await service.addRevision(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as AddRevisionInput,
        );
        reply.code(201);
        return revision;
      },
    );

    app.post(
      '/schedules/:id/revisions/:revisionId/cancel',
      { schema: { params: RevisionParams }, ...perm(WORK_SCHEDULE_MANAGE, atSchedule) },
      async (req) => {
        const { id, revisionId } = req.params as { id: string; revisionId: string };
        return service.cancelRevision(actorOf(req), companyIdOf(req), id, revisionId);
      },
    );

    // -------------------------------------------------------------------------
    // Date-specific overrides
    // -------------------------------------------------------------------------

    app.get(
      '/schedules/:id/overrides',
      {
        schema: { params: IdParams, querystring: ListOverridesQuery },
        ...perm(WORK_SCHEDULE_READ, atSchedule),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.listOverrides(
          actorOf(req),
          companyIdOf(req),
          id,
          req.query as ListOverridesFilter,
        );
      },
    );

    app.post(
      '/schedules/:id/overrides',
      {
        schema: { params: IdParams, body: AddOverrideBody },
        ...perm(WORK_SCHEDULE_MANAGE, atSchedule),
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const override = await service.addOverride(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as AddOverrideInput,
        );
        reply.code(201);
        return override;
      },
    );

    app.post(
      '/schedules/:id/overrides/:overrideId/cancel',
      {
        schema: { params: OverrideParams, body: CancelOverrideBody },
        ...perm(WORK_SCHEDULE_MANAGE, atSchedule),
      },
      async (req) => {
        const { id, overrideId } = req.params as { id: string; overrideId: string };
        return service.cancelOverride(actorOf(req), companyIdOf(req), id, overrideId);
      },
    );

    app.get(
      '/schedules/:id/classify/:date',
      { schema: { params: ClassifyParams }, ...perm(WORK_SCHEDULE_READ, atSchedule) },
      async (req) => {
        const { id, date } = req.params as { id: string; date: string };
        return service.classifyScheduleDate(actorOf(req), companyIdOf(req), id, date);
      },
    );

    // -------------------------------------------------------------------------
    // Holiday calendars
    // -------------------------------------------------------------------------

    app.post(
      '/holiday-calendars',
      { schema: { body: CreateHolidayCalendarBody }, ...perm(WORK_SCHEDULE_MANAGE) },
      async (req, reply) => {
        const calendar = await service.createCalendar(
          actorOf(req),
          companyIdOf(req),
          req.body as CreateHolidayCalendarInput,
        );
        reply.code(201);
        return calendar;
      },
    );

    app.get(
      '/holiday-calendars',
      { schema: { querystring: ListHolidayCalendarsQuery }, ...perm(WORK_SCHEDULE_READ) },
      async (req) => {
        return service.listCalendars(
          actorOf(req),
          companyIdOf(req),
          req.query as ListHolidayCalendarsFilter,
        );
      },
    );

    app.patch(
      '/holiday-calendars/:id',
      {
        schema: { params: IdParams, body: UpdateHolidayCalendarBody },
        ...perm(WORK_SCHEDULE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.updateCalendar(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as UpdateHolidayCalendarInput,
        );
      },
    );

    app.post(
      '/holiday-calendars/:id/archive',
      {
        schema: { params: IdParams, body: ArchiveWorkScheduleBody },
        ...perm(WORK_SCHEDULE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as ArchiveWorkScheduleInput;
        return service.archiveCalendar(actorOf(req), companyIdOf(req), id, body.expectedVersion);
      },
    );

    // -------------------------------------------------------------------------
    // Holiday categories (administrator-defined vocabulary)
    // -------------------------------------------------------------------------

    app.post(
      '/holiday-categories',
      { schema: { body: CreateHolidayCategoryBody }, ...perm(WORK_SCHEDULE_MANAGE) },
      async (req, reply) => {
        const category = await service.createCategory(
          actorOf(req),
          companyIdOf(req),
          req.body as CreateHolidayCategoryInput,
        );
        reply.code(201);
        return category;
      },
    );

    app.get(
      '/holiday-categories',
      { schema: { querystring: ListHolidayCategoriesQuery }, ...perm(WORK_SCHEDULE_READ) },
      async (req) => {
        return service.listCategories(
          actorOf(req),
          companyIdOf(req),
          req.query as ListHolidayCategoriesFilter,
        );
      },
    );

    app.post(
      '/holiday-categories/:id/archive',
      {
        schema: { params: IdParams, body: ArchiveHolidayCategoryBody },
        ...perm(WORK_SCHEDULE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as ArchiveHolidayCategoryInput;
        return service.archiveCategory(actorOf(req), companyIdOf(req), id, body.expectedVersion);
      },
    );

    // -------------------------------------------------------------------------
    // Holidays
    // -------------------------------------------------------------------------

    app.get(
      '/holiday-calendars/:calendarId/holidays',
      {
        schema: { params: CalendarParams, querystring: ListHolidaysQuery },
        ...perm(WORK_SCHEDULE_READ),
      },
      async (req) => {
        const { calendarId } = req.params as { calendarId: string };
        return service.listHolidays(
          actorOf(req),
          companyIdOf(req),
          calendarId,
          req.query as ListHolidaysFilter,
        );
      },
    );

    app.post(
      '/holiday-calendars/:calendarId/holidays',
      { schema: { params: CalendarParams, body: AddHolidayBody }, ...perm(WORK_SCHEDULE_MANAGE) },
      async (req, reply) => {
        const { calendarId } = req.params as { calendarId: string };
        const holiday = await service.addHoliday(
          actorOf(req),
          companyIdOf(req),
          calendarId,
          req.body as AddHolidayInput,
        );
        reply.code(201);
        return holiday;
      },
    );

    app.post(
      '/holiday-calendars/:calendarId/holidays/bulk',
      {
        schema: { params: CalendarParams, body: BulkAddHolidaysBody },
        ...perm(WORK_SCHEDULE_MANAGE),
      },
      async (req, reply) => {
        const { calendarId } = req.params as { calendarId: string };
        const result = await service.addHolidaysBulk(
          actorOf(req),
          companyIdOf(req),
          calendarId,
          req.body as BulkAddHolidaysInput,
        );
        reply.code(201);
        return result;
      },
    );

    app.post(
      '/holiday-calendars/:calendarId/holidays/:holidayId/cancel',
      {
        schema: { params: HolidayParams, body: CancelHolidayBody },
        ...perm(WORK_SCHEDULE_MANAGE),
      },
      async (req) => {
        const { calendarId, holidayId } = req.params as { calendarId: string; holidayId: string };
        await service.cancelHoliday(actorOf(req), companyIdOf(req), calendarId, holidayId);
        return { cancelled: true };
      },
    );
  };
}
