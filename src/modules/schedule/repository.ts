import {
  Prisma,
  type Holiday,
  type HolidayCalendar,
  type HolidayCategory,
  type PrismaClient,
  type WorkSchedule,
  type WorkScheduleOverride,
  type WorkScheduleRevision,
} from '@prisma/client';
import { scopedUpdate, type AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';
import {
  DuplicateHolidayError,
  DuplicateOverrideError,
  ScheduleRangeConflictError,
} from './errors.js';
import type {
  ListHolidayCalendarsFilter,
  ListHolidayCategoriesFilter,
  ListWorkSchedulesFilter,
} from './types.js';
import type { OrgNodeStatus } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Repository-facing date-range filters (parsed Dates, not API strings). */
export interface DateRangeFilter {
  from?: Date;
  to?: Date;
}

export interface HolidayListFilter extends DateRangeFilter {
  status?: OrgNodeStatus;
}

export interface OverrideListFilter extends DateRangeFilter {
  status?: OrgNodeStatus;
}

export interface EffectiveScheduleTarget {
  scopeType: 'COMPANY' | 'DEPARTMENT' | 'PROJECT' | 'SITE' | 'EMPLOYEE';
  departmentId?: string;
  projectId?: string;
  siteId?: string;
  employeeId?: string;
}

export type RevisionWithCalendar = WorkScheduleRevision & {
  holidayCalendar: Pick<HolidayCalendar, 'id' | 'code' | 'name'> | null;
};

export type HolidayWithCategory = Holiday & {
  category: Pick<HolidayCategory, 'id' | 'code' | 'name'>;
};

export interface ScheduleRepos {
  schedules: {
    findById: (companyId: string, id: string) => Promise<WorkSchedule | null>;
    list: (companyId: string, filter?: ListWorkSchedulesFilter) => Promise<WorkSchedule[]>;
    create: (
      companyId: string,
      data: Omit<Prisma.WorkScheduleCreateInput, 'company'>,
    ) => Promise<WorkSchedule>;
    update: (
      companyId: string,
      id: string,
      data: Prisma.WorkScheduleUpdateInput,
      expectedVersion?: number,
    ) => Promise<WorkSchedule>;
    /** Newest ACTIVE schedule whose window covers `asOf` at the scope target. */
    findAtScope: (
      companyId: string,
      target: EffectiveScheduleTarget,
      asOf: Date,
    ) => Promise<WorkSchedule | null>;
  };
  revisions: {
    create: (
      companyId: string,
      data: Omit<Prisma.WorkScheduleRevisionCreateInput, 'company' | 'schedule'> & {
        scheduleId: string;
      },
    ) => Promise<WorkScheduleRevision>;
    /** Latest ACTIVE revision with effectiveFrom <= asOf; same-date ties go
     *  to the higher revision number. */
    findEffective: (
      companyId: string,
      scheduleId: string,
      asOf: Date,
    ) => Promise<RevisionWithCalendar | null>;
    findById: (
      companyId: string,
      scheduleId: string,
      revisionId: string,
    ) => Promise<WorkScheduleRevision | null>;
    list: (companyId: string, scheduleId: string) => Promise<RevisionWithCalendar[]>;
    nextRevisionNumber: (companyId: string, scheduleId: string) => Promise<number>;
    countActive: (companyId: string, scheduleId: string) => Promise<number>;
    cancel: (companyId: string, revisionId: string) => Promise<WorkScheduleRevision>;
    /** ACTIVE revisions on non-archived schedules referencing the calendar. */
    countReferencingCalendar: (companyId: string, calendarId: string) => Promise<number>;
  };
  overrides: {
    create: (
      companyId: string,
      data: Omit<Prisma.WorkScheduleOverrideCreateInput, 'company' | 'schedule'> & {
        scheduleId: string;
      },
    ) => Promise<WorkScheduleOverride>;
    findById: (
      companyId: string,
      scheduleId: string,
      overrideId: string,
    ) => Promise<WorkScheduleOverride | null>;
    findActiveForDate: (
      companyId: string,
      scheduleId: string,
      date: Date,
    ) => Promise<Pick<WorkScheduleOverride, 'id' | 'disposition'> | null>;
    list: (
      companyId: string,
      scheduleId: string,
      filter?: OverrideListFilter,
    ) => Promise<WorkScheduleOverride[]>;
    cancel: (companyId: string, overrideId: string) => Promise<WorkScheduleOverride>;
  };
  calendars: {
    findById: (companyId: string, id: string) => Promise<HolidayCalendar | null>;
    list: (companyId: string, filter?: ListHolidayCalendarsFilter) => Promise<HolidayCalendar[]>;
    create: (
      companyId: string,
      data: Omit<Prisma.HolidayCalendarCreateInput, 'company'>,
    ) => Promise<HolidayCalendar>;
    update: (
      companyId: string,
      id: string,
      data: Prisma.HolidayCalendarUpdateInput,
      expectedVersion?: number,
    ) => Promise<HolidayCalendar>;
  };
  categories: {
    findById: (companyId: string, id: string) => Promise<HolidayCategory | null>;
    findByCode: (companyId: string, code: string) => Promise<HolidayCategory | null>;
    list: (companyId: string, filter?: ListHolidayCategoriesFilter) => Promise<HolidayCategory[]>;
    create: (
      companyId: string,
      data: Omit<Prisma.HolidayCategoryCreateInput, 'company'>,
    ) => Promise<HolidayCategory>;
    update: (
      companyId: string,
      id: string,
      data: Prisma.HolidayCategoryUpdateInput,
      expectedVersion?: number,
    ) => Promise<HolidayCategory>;
  };
  holidays: {
    create: (
      companyId: string,
      data: Omit<Prisma.HolidayCreateInput, 'company'>,
    ) => Promise<Holiday>;
    createMany: (
      companyId: string,
      rows: Omit<Prisma.HolidayCreateManyInput, 'companyId'>[],
    ) => Promise<number>;
    findById: (
      companyId: string,
      calendarId: string,
      holidayId: string,
    ) => Promise<HolidayWithCategory | null>;
    cancel: (companyId: string, holidayId: string) => Promise<Holiday>;
    list: (
      companyId: string,
      calendarId: string,
      filter?: HolidayListFilter,
    ) => Promise<HolidayWithCategory[]>;
    /** ACTIVE holiday dates in a calendar within [from, to] — for classification. */
    activeDatesInRange: (
      companyId: string,
      calendarId: string,
      from: Date,
      to: Date,
    ) => Promise<Date[]>;
  };
  departments: {
    findById: (
      companyId: string,
      id: string,
    ) => Promise<{
      id: string;
      status: string;
      scopeType: string;
      projectId: string | null;
      siteId: string | null;
    } | null>;
  };
  projects: {
    findById: (companyId: string, id: string) => Promise<{ id: string; status: string } | null>;
  };
  sites: {
    findById: (companyId: string, id: string) => Promise<{ id: string; status: string } | null>;
  };
  employees: {
    findById: (companyId: string, id: string) => Promise<{ id: string; status: string } | null>;
  };
  memberships: {
    /** Memberships effective at `asOf` (startedAt <= asOf, not yet ended).
     *  Omitting `asOf` returns currently-open memberships (endedAt IS NULL). */
    findActiveByEmployee: (
      companyId: string,
      employeeId: string,
      asOf?: Date,
    ) => Promise<{ departmentId: string; isPrimary: boolean }[]>;
  };
  audit: AuditRepository;
}

/** Maps constraint violations raised by schedule/holiday writes. */
function mapScheduleWriteError(error: unknown): never {
  if (error instanceof Error && error.message.includes('work_schedule_no_overlap')) {
    throw new ScheduleRangeConflictError();
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' ||
      (error.code === 'P2010' && error.message.includes('Holiday_calendarId_date')))
  ) {
    throw new DuplicateHolidayError('(requested date)');
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' &&
    error.message.includes('WorkScheduleOverride_scheduleId_date')
  ) {
    throw new DuplicateOverrideError('(requested date)');
  }
  throw error;
}

export function makeScheduleRepos(tx: Tx): ScheduleRepos {
  const audit: AuditRepository = {
    record: async (entry: AuditRecord) => {
      await tx.auditLog.create({
        data: {
          eventKey: entry.eventKey,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          actorId: entry.actorId,
          actorType: entry.actorType,
          companyId: entry.companyId ?? null,
          correlationId: entry.correlationId ?? null,
          statusBefore: entry.statusBefore ?? null,
          statusAfter: entry.statusAfter ?? null,
          ...(entry.changedFields !== undefined
            ? { changedFields: entry.changedFields as Prisma.InputJsonValue }
            : {}),
          ...(entry.metadata !== undefined
            ? { metadata: entry.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });
    },
  };

  const schedules = {
    findById: (companyId: string, id: string) =>
      tx.workSchedule.findFirst({ where: { id, companyId } }),
    list: (companyId: string, filter?: ListWorkSchedulesFilter) =>
      tx.workSchedule.findMany({
        where: {
          companyId,
          ...(filter?.scopeType ? { scopeType: filter.scopeType } : {}),
          ...(filter?.departmentId ? { departmentId: filter.departmentId } : {}),
          ...(filter?.projectId ? { projectId: filter.projectId } : {}),
          ...(filter?.siteId ? { siteId: filter.siteId } : {}),
          ...(filter?.employeeId ? { employeeId: filter.employeeId } : {}),
          ...(filter?.status ? { status: filter.status } : {}),
        },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      }),
    create: async (companyId: string, data: Omit<Prisma.WorkScheduleCreateInput, 'company'>) => {
      try {
        return await tx.workSchedule.create({
          data: {
            ...data,
            company: { connect: { id: companyId } },
          },
        });
      } catch (error) {
        mapScheduleWriteError(error);
      }
    },
    update: (
      companyId: string,
      id: string,
      data: Prisma.WorkScheduleUpdateInput,
      expectedVersion?: number,
    ) =>
      scopedUpdate(
        'WORK_SCHEDULE',
        { id, companyId },
        data as Record<string, unknown>,
        expectedVersion,
        (args) => tx.workSchedule.updateMany(args),
        () => tx.workSchedule.findFirst({ where: { id, companyId } }),
      ),
    findAtScope: (companyId: string, target: EffectiveScheduleTarget, asOf: Date) =>
      tx.workSchedule.findFirst({
        where: {
          companyId,
          scopeType: target.scopeType,
          // Applicable when ACTIVE now, or when it was still active on asOf —
          // archiving must never reclassify already-past dates.
          OR: [{ status: 'ACTIVE' }, { status: 'ARCHIVED', archivedAt: { gt: asOf } }],
          effectiveFrom: { lte: asOf },
          AND: { OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }] },
          ...(target.departmentId !== undefined ? { departmentId: target.departmentId } : {}),
          ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
          ...(target.siteId !== undefined ? { siteId: target.siteId } : {}),
          ...(target.employeeId !== undefined ? { employeeId: target.employeeId } : {}),
        },
        orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      }),
  };

  const revisions = {
    create: async (
      companyId: string,
      data: Omit<Prisma.WorkScheduleRevisionCreateInput, 'company' | 'schedule'> & {
        scheduleId: string;
      },
    ) => {
      const { scheduleId, ...rest } = data;
      return tx.workScheduleRevision.create({
        data: {
          ...rest,
          company: { connect: { id: companyId } },
          schedule: { connect: { id_companyId: { id: scheduleId, companyId } } },
        },
      });
    },
    findEffective: (companyId: string, scheduleId: string, asOf: Date) =>
      tx.workScheduleRevision.findFirst({
        where: {
          companyId,
          scheduleId,
          status: 'ACTIVE',
          effectiveFrom: { lte: asOf },
        },
        include: { holidayCalendar: { select: { id: true, code: true, name: true } } },
        orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
      }),
    findById: (companyId: string, scheduleId: string, revisionId: string) =>
      tx.workScheduleRevision.findFirst({
        where: { id: revisionId, scheduleId, companyId },
      }),
    list: (companyId: string, scheduleId: string) =>
      tx.workScheduleRevision.findMany({
        where: { companyId, scheduleId },
        include: { holidayCalendar: { select: { id: true, code: true, name: true } } },
        orderBy: [{ effectiveFrom: 'asc' }, { revision: 'asc' }],
      }),
    nextRevisionNumber: async (companyId: string, scheduleId: string) => {
      const agg = await tx.workScheduleRevision.aggregate({
        where: { companyId, scheduleId },
        _max: { revision: true },
      });
      return (agg._max.revision ?? 0) + 1;
    },
    countActive: (companyId: string, scheduleId: string) =>
      tx.workScheduleRevision.count({
        where: { companyId, scheduleId, status: 'ACTIVE' },
      }),
    cancel: async (companyId: string, revisionId: string) => {
      await tx.workScheduleRevision.updateMany({
        where: { id: revisionId, companyId },
        data: { status: 'ARCHIVED' },
      });
      const row = await tx.workScheduleRevision.findFirst({
        where: { id: revisionId, companyId },
      });
      if (row === null) throw new Error('revision vanished during cancel');
      return row;
    },
    countReferencingCalendar: (companyId: string, calendarId: string) =>
      tx.workScheduleRevision.count({
        where: {
          companyId,
          holidayCalendarId: calendarId,
          status: 'ACTIVE',
          schedule: { status: { not: 'ARCHIVED' } },
        },
      }),
  };

  const overrides = {
    create: async (
      companyId: string,
      data: Omit<Prisma.WorkScheduleOverrideCreateInput, 'company' | 'schedule'> & {
        scheduleId: string;
      },
    ) => {
      const { scheduleId, ...rest } = data;
      try {
        return await tx.workScheduleOverride.create({
          data: {
            ...rest,
            company: { connect: { id: companyId } },
            schedule: { connect: { id_companyId: { id: scheduleId, companyId } } },
          },
        });
      } catch (error) {
        mapScheduleWriteError(error);
      }
    },
    findById: (companyId: string, scheduleId: string, overrideId: string) =>
      tx.workScheduleOverride.findFirst({
        where: { id: overrideId, scheduleId, companyId },
      }),
    findActiveForDate: (companyId: string, scheduleId: string, date: Date) =>
      tx.workScheduleOverride.findFirst({
        where: { companyId, scheduleId, date, status: 'ACTIVE' },
        select: { id: true, disposition: true },
      }),
    list: (companyId: string, scheduleId: string, filter?: OverrideListFilter) =>
      tx.workScheduleOverride.findMany({
        where: {
          companyId,
          scheduleId,
          ...(filter?.from ? { date: { gte: filter.from } } : {}),
          ...(filter?.to ? { date: { lte: filter.to } } : {}),
          ...(filter?.status ? { status: filter.status } : {}),
        },
        orderBy: [{ date: 'asc' }],
        take: 400,
      }),
    cancel: async (companyId: string, overrideId: string) => {
      await tx.workScheduleOverride.updateMany({
        where: { id: overrideId, companyId },
        data: { status: 'ARCHIVED', cancelledAt: new Date() },
      });
      const row = await tx.workScheduleOverride.findFirst({
        where: { id: overrideId, companyId },
      });
      if (row === null) throw new Error('override vanished during cancel');
      return row;
    },
  };

  const calendars = {
    findById: (companyId: string, id: string) =>
      tx.holidayCalendar.findFirst({ where: { id, companyId } }),
    list: (companyId: string, filter?: ListHolidayCalendarsFilter) =>
      tx.holidayCalendar.findMany({
        where: {
          companyId,
          ...(filter?.status ? { status: filter.status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }],
        take: 100,
      }),
    create: (companyId: string, data: Omit<Prisma.HolidayCalendarCreateInput, 'company'>) =>
      tx.holidayCalendar.create({
        data: {
          ...data,
          company: { connect: { id: companyId } },
        },
      }),
    update: (
      companyId: string,
      id: string,
      data: Prisma.HolidayCalendarUpdateInput,
      expectedVersion?: number,
    ) =>
      scopedUpdate(
        'HOLIDAY_CALENDAR',
        { id, companyId },
        data as Record<string, unknown>,
        expectedVersion,
        (args) => tx.holidayCalendar.updateMany(args),
        () => tx.holidayCalendar.findFirst({ where: { id, companyId } }),
      ),
  };

  const categories = {
    findById: (companyId: string, id: string) =>
      tx.holidayCategory.findFirst({ where: { id, companyId } }),
    findByCode: (companyId: string, code: string) =>
      tx.holidayCategory.findFirst({ where: { companyId, code } }),
    list: (companyId: string, filter?: ListHolidayCategoriesFilter) =>
      tx.holidayCategory.findMany({
        where: {
          companyId,
          ...(filter?.status ? { status: filter.status } : {}),
        },
        orderBy: [{ code: 'asc' }],
        take: 200,
      }),
    create: (companyId: string, data: Omit<Prisma.HolidayCategoryCreateInput, 'company'>) =>
      tx.holidayCategory.create({
        data: {
          ...data,
          company: { connect: { id: companyId } },
        },
      }),
    update: (
      companyId: string,
      id: string,
      data: Prisma.HolidayCategoryUpdateInput,
      expectedVersion?: number,
    ) =>
      scopedUpdate(
        'HOLIDAY_CATEGORY',
        { id, companyId },
        data as Record<string, unknown>,
        expectedVersion,
        (args) => tx.holidayCategory.updateMany(args),
        () => tx.holidayCategory.findFirst({ where: { id, companyId } }),
      ),
  };

  const holidays = {
    create: async (companyId: string, data: Omit<Prisma.HolidayCreateInput, 'company'>) => {
      try {
        return await tx.holiday.create({
          data: {
            ...data,
            company: { connect: { id: companyId } },
          },
        });
      } catch (error) {
        mapScheduleWriteError(error);
      }
    },
    createMany: async (
      companyId: string,
      rows: Omit<Prisma.HolidayCreateManyInput, 'companyId'>[],
    ) => {
      try {
        const result = await tx.holiday.createMany({
          data: rows.map((r) => ({ ...r, companyId })),
        });
        return result.count;
      } catch (error) {
        mapScheduleWriteError(error);
      }
    },
    findById: (companyId: string, calendarId: string, holidayId: string) =>
      tx.holiday.findFirst({
        where: { id: holidayId, calendarId, companyId },
        include: { category: { select: { id: true, code: true, name: true } } },
      }),
    cancel: async (companyId: string, holidayId: string) => {
      await tx.holiday.updateMany({
        where: { id: holidayId, companyId },
        data: { status: 'ARCHIVED', cancelledAt: new Date() },
      });
      const row = await tx.holiday.findFirst({ where: { id: holidayId, companyId } });
      if (row === null) throw new Error('holiday vanished during cancel');
      return row;
    },
    list: (companyId: string, calendarId: string, filter?: HolidayListFilter) =>
      tx.holiday.findMany({
        where: {
          companyId,
          calendarId,
          ...(filter?.from ? { date: { gte: filter.from } } : {}),
          ...(filter?.to ? { date: { lte: filter.to } } : {}),
          ...(filter?.status !== undefined ? { status: filter.status } : { status: 'ACTIVE' }),
        },
        include: { category: { select: { id: true, code: true, name: true } } },
        orderBy: [{ date: 'asc' }],
        take: 400,
      }),
    activeDatesInRange: async (companyId: string, calendarId: string, from: Date, to: Date) => {
      const rows = await tx.holiday.findMany({
        where: {
          companyId,
          calendarId,
          status: 'ACTIVE',
          date: { gte: from, lte: to },
        },
        select: { date: true },
      });
      return rows.map((r) => r.date);
    },
  };

  const departments = {
    findById: (companyId: string, id: string) =>
      tx.department.findFirst({
        where: { id, companyId },
        select: { id: true, status: true, scopeType: true, projectId: true, siteId: true },
      }),
  };
  const projects = {
    findById: (companyId: string, id: string) =>
      tx.project.findFirst({ where: { id, companyId }, select: { id: true, status: true } }),
  };
  const sites = {
    findById: (companyId: string, id: string) =>
      tx.site.findFirst({ where: { id, companyId }, select: { id: true, status: true } }),
  };
  const employees = {
    findById: (companyId: string, id: string) =>
      tx.employee.findFirst({ where: { id, companyId }, select: { id: true, status: true } }),
  };
  const memberships = {
    findActiveByEmployee: (companyId: string, employeeId: string, asOf?: Date) =>
      tx.departmentMembership.findMany({
        where:
          asOf === undefined
            ? { companyId, employeeId, endedAt: null }
            : {
                companyId,
                employeeId,
                startedAt: { lte: asOf },
                OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
              },
        select: { departmentId: true, isPrimary: true },
      }),
  };

  return {
    schedules,
    revisions,
    overrides,
    calendars,
    categories,
    holidays,
    departments,
    projects,
    sites,
    employees,
    memberships,
    audit,
  };
}

export interface ScheduleUnitOfWork {
  run<T>(fn: (repos: ScheduleRepos) => Promise<T>): Promise<T>;
}

export class PrismaScheduleUnitOfWork implements ScheduleUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: ScheduleRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeScheduleRepos(tx)));
  }
}
