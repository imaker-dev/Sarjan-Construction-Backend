import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type {
  HolidayCalendar,
  HolidayCategory,
  WorkSchedule,
  WorkScheduleOverride,
  WorkScheduleRevision,
} from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { assertValidTimezone, normalizeCode } from '../organization/validation.js';
import { OrgValidationError } from '../organization/errors.js';
import type {
  EffectiveScheduleTarget,
  HolidayWithCategory,
  RevisionWithCalendar,
  ScheduleRepos,
  ScheduleUnitOfWork,
} from './repository.js';
import { classifyWithOverrides, type ClassifiedDay, type ScheduleWeekSpec } from './classify.js';
import {
  AmbiguousScheduleContextError,
  DuplicateOverrideError,
  HolidayCalendarInUseError,
  HolidayCalendarNotFoundError,
  HolidayCategoryNotFoundError,
  HolidayNotFoundError,
  InvalidScheduleStateError,
  LastActiveRevisionError,
  NoEffectiveScheduleError,
  ScheduleOverrideNotFoundError,
  ScheduleRevisionNotFoundError,
  ScheduleScopeShapeError,
  ScheduleTargetNotFoundError,
  ScheduleValidationError,
  WorkScheduleNotFoundError,
} from './errors.js';
import type {
  AddHolidayInput,
  AddOverrideInput,
  AddRevisionInput,
  BulkAddHolidaysInput,
  CreateHolidayCalendarInput,
  CreateHolidayCategoryInput,
  CreateWorkScheduleInput,
  EffectiveScheduleCriteria,
  ListHolidayCalendarsFilter,
  ListHolidayCategoriesFilter,
  ListHolidaysFilter,
  ListOverridesFilter,
  ListWorkSchedulesFilter,
  RevisionPatternInput,
  UpdateHolidayCalendarInput,
  UpdateWorkScheduleInput,
} from './types.js';

export const WORK_SCHEDULE_READ = 'WORK_SCHEDULE_READ';
export const WORK_SCHEDULE_MANAGE = 'WORK_SCHEDULE_MANAGE';

interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
}

const auditEntry = (
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord => ({
  eventKey: randomUUID(),
  actorId: actor.actorId,
  actorType: actor.actorType,
  ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
  ...base,
});

const companyTarget = (companyId: string): ScopeTarget => ({
  companyId,
  scopeType: 'COMPANY',
  scopeId: companyId,
});

const SCOPE_REFS = ['departmentId', 'projectId', 'siteId', 'employeeId'] as const;
const SCOPE_REQUIRED_REF: Record<string, (typeof SCOPE_REFS)[number] | null> = {
  COMPANY: null,
  DEPARTMENT: 'departmentId',
  PROJECT: 'projectId',
  SITE: 'siteId',
  EMPLOYEE: 'employeeId',
};

const VALID_NTHS = new Set([-1, 1, 2, 3, 4, 5]);

export interface EffectiveScheduleResult {
  schedule: WorkSchedule;
  /** The immutable revision whose pattern applies on `asOf`. */
  revision: RevisionWithCalendar;
  resolvedVia: 'EMPLOYEE' | 'DEPARTMENT' | 'SITE' | 'PROJECT' | 'COMPANY';
  /** Classification of the asOf date under the resolved revision. */
  classification: ClassifiedDay;
}

function parseDate(dateStr: string, field: string): Date {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new ScheduleValidationError(field, 'must be a valid calendar date (YYYY-MM-DD)');
  }
  return d;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Convert an instant into the calendar date it falls on in `timezone`,
 * expressed as a UTC-midnight Date (the same shape parseDate produces for
 * 'YYYY-MM-DD' inputs). Used only when the caller omits asOf — an explicit
 * date is already the local work date and must not be re-shifted.
 */
function instantToLocalWorkDate(instant: Date, timezone: string): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00.000Z`);
}

function revisionSpec(rev: WorkScheduleRevision): ScheduleWeekSpec {
  return {
    workingWeekdays: rev.workingWeekdays,
    offNthWeekdays: (rev.offNthWeekdays as ScheduleWeekSpec['offNthWeekdays']) ?? null,
    rotation:
      rev.rotationAnchor !== null && rev.rotationLengthDays !== null
        ? {
            anchor: toDateStr(rev.rotationAnchor),
            lengthDays: rev.rotationLengthDays,
            workingOffsets: rev.rotationWorkingOffsets,
            offOffsets: rev.rotationOffOffsets,
          }
        : null,
  };
}

export class ScheduleService {
  constructor(
    private readonly uow: ScheduleUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  // -------------------------------------------------------------------------
  // Work schedules (identity)
  // -------------------------------------------------------------------------

  async createSchedule(
    actor: ActorContext,
    companyId: string,
    input: CreateWorkScheduleInput,
  ): Promise<{ schedule: WorkSchedule; revision: WorkScheduleRevision }> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );
    this.validateScopeShape(input);
    const validated = this.validateRevisionPattern(input.revision);
    const scheduleFrom = parseDate(input.effectiveFrom, 'effectiveFrom');
    if (input.effectiveTo !== undefined) {
      const to = parseDate(input.effectiveTo, 'effectiveTo');
      if (to < scheduleFrom) {
        throw new ScheduleValidationError('effectiveTo', 'must be on or after effectiveFrom');
      }
    }
    const revFrom = parseDate(input.revision.effectiveFrom, 'revision.effectiveFrom');
    if (revFrom < scheduleFrom) {
      throw new ScheduleValidationError(
        'revision.effectiveFrom',
        'cannot be before the schedule effectiveFrom',
      );
    }

    return this.uow.run(async (repos) => {
      await this.assertScopeTarget(repos, companyId, input);
      await this.assertCalendarUsable(repos, companyId, input.revision.holidayCalendarId);

      const schedule = await repos.schedules.create(companyId, {
        scopeType: input.scopeType,
        ...(input.departmentId !== undefined
          ? { department: { connect: { id_companyId: { id: input.departmentId, companyId } } } }
          : {}),
        ...(input.projectId !== undefined
          ? { project: { connect: { id_companyId: { id: input.projectId, companyId } } } }
          : {}),
        ...(input.siteId !== undefined
          ? { site: { connect: { id_companyId: { id: input.siteId, companyId } } } }
          : {}),
        ...(input.employeeId !== undefined
          ? { employee: { connect: { id_companyId: { id: input.employeeId, companyId } } } }
          : {}),
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        effectiveFrom: scheduleFrom,
        effectiveTo:
          input.effectiveTo !== undefined ? parseDate(input.effectiveTo, 'effectiveTo') : null,
      });

      const revision = await repos.revisions.create(companyId, {
        scheduleId: schedule.id,
        revision: 1,
        effectiveFrom: revFrom,
        ...this.revisionCreateData(validated, companyId, input.revision.holidayCalendarId),
        note: input.revision.note?.trim() ?? null,
        createdByPrincipalId: actor.actorId,
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'WORK_SCHEDULE_CREATED',
          entityType: 'WORK_SCHEDULE',
          entityId: schedule.id,
          companyId,
          metadata: {
            name: schedule.name,
            scopeType: schedule.scopeType,
            departmentId: schedule.departmentId,
            projectId: schedule.projectId,
            siteId: schedule.siteId,
            employeeId: schedule.employeeId,
            effectiveFrom: schedule.effectiveFrom,
            revisionId: revision.id,
          },
        }),
      );
      return { schedule, revision };
    });
  }

  async listSchedules(
    actor: ActorContext,
    companyId: string,
    filter: ListWorkSchedulesFilter,
  ): Promise<WorkSchedule[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    return this.uow.run((repos) => repos.schedules.list(companyId, filter));
  }

  async getSchedule(actor: ActorContext, companyId: string, id: string): Promise<WorkSchedule> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    const schedule = await this.uow.run((repos) => repos.schedules.findById(companyId, id));
    if (!schedule) throw new WorkScheduleNotFoundError();
    return schedule;
  }

  /** Identity-level edits only (name, description, validity window). Pattern
   *  changes go through addRevision — revisions are immutable history. */
  async updateSchedule(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: UpdateWorkScheduleInput,
  ): Promise<WorkSchedule> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const existing = await repos.schedules.findById(companyId, id);
      if (!existing) throw new WorkScheduleNotFoundError();
      if (existing.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError(
          'Archived schedules are immutable; create a new schedule',
        );
      }

      // effectiveFrom is immutable after creation: moving it would silently
      // change which schedule resolves for already-past dates (a later from
      // drops coverage; an earlier one retro-inserts it).
      if (input.effectiveFrom !== undefined) {
        const requested = parseDate(input.effectiveFrom, 'effectiveFrom');
        if (requested.getTime() !== existing.effectiveFrom.getTime()) {
          throw new ScheduleValidationError(
            'effectiveFrom',
            'is immutable once created — archive this schedule and create a new one to change coverage',
          );
        }
      }
      const effectiveTo =
        input.effectiveTo !== undefined
          ? input.effectiveTo === null
            ? null
            : parseDate(input.effectiveTo, 'effectiveTo')
          : existing.effectiveTo;
      if (effectiveTo !== null && effectiveTo < existing.effectiveFrom) {
        throw new ScheduleValidationError('effectiveTo', 'must be on or after effectiveFrom');
      }
      // A past-dated cutoff silently reclassifies dates that already resolved
      // under this schedule. Only checked when the caller changes the value —
      // a window that already ended stays untouched by name-only edits.
      if (input.effectiveTo !== undefined) {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        if (effectiveTo !== null && effectiveTo < today) {
          throw new ScheduleValidationError(
            'effectiveTo',
            'cannot be a past date — that would retroactively change already-classified days',
          );
        }
      }

      const data: Record<string, unknown> = {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim() ?? null }
          : {}),
        ...(input.effectiveTo !== undefined ? { effectiveTo } : {}),
      };

      const updated = await repos.schedules.update(companyId, id, data, input.expectedVersion);

      await repos.audit.record(
        auditEntry(actor, {
          action: 'WORK_SCHEDULE_UPDATED',
          entityType: 'WORK_SCHEDULE',
          entityId: id,
          companyId,
          changedFields: { version: { before: input.expectedVersion, after: updated.version } },
          metadata: { name: updated.name, scopeType: updated.scopeType },
        }),
      );
      return updated;
    });
  }

  async archiveSchedule(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion: number,
  ): Promise<WorkSchedule> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const existing = await repos.schedules.findById(companyId, id);
      if (!existing) throw new WorkScheduleNotFoundError();
      if (existing.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError('Schedule is already archived');
      }
      const updated = await repos.schedules.update(
        companyId,
        id,
        { status: 'ARCHIVED', archivedAt: new Date() },
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WORK_SCHEDULE_ARCHIVED',
          entityType: 'WORK_SCHEDULE',
          entityId: id,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
        }),
      );
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Revisions (immutable pattern history)
  // -------------------------------------------------------------------------

  async addRevision(
    actor: ActorContext,
    companyId: string,
    scheduleId: string,
    input: AddRevisionInput,
  ): Promise<WorkScheduleRevision> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );
    const validated = this.validateRevisionPattern(input);
    const effectiveFrom = parseDate(input.effectiveFrom, 'effectiveFrom');

    return this.uow.run(async (repos) => {
      const schedule = await this.assertScheduleMutable(repos, companyId, scheduleId);
      if (schedule.effectiveTo !== null && effectiveFrom > schedule.effectiveTo) {
        throw new ScheduleValidationError(
          'effectiveFrom',
          'cannot be after the schedule effectiveTo',
        );
      }
      await this.assertCalendarUsable(repos, companyId, input.holidayCalendarId);

      const revision = await repos.revisions.create(companyId, {
        scheduleId,
        revision: await repos.revisions.nextRevisionNumber(companyId, scheduleId),
        effectiveFrom,
        ...this.revisionCreateData(validated, companyId, input.holidayCalendarId),
        note: input.note?.trim() ?? null,
        createdByPrincipalId: actor.actorId,
      });

      // Identity version bump so concurrent adds serialize through expectedVersion.
      await repos.schedules.update(companyId, scheduleId, {}, input.expectedVersion);

      await repos.audit.record(
        auditEntry(actor, {
          action: 'WORK_SCHEDULE_REVISION_ADDED',
          entityType: 'WORK_SCHEDULE_REVISION',
          entityId: revision.id,
          companyId,
          metadata: {
            scheduleId,
            revision: revision.revision,
            effectiveFrom: revision.effectiveFrom,
            timezone: revision.timezone,
            holidayCalendarId: revision.holidayCalendarId,
          },
        }),
      );
      return revision;
    });
  }

  async listRevisions(
    actor: ActorContext,
    companyId: string,
    scheduleId: string,
  ): Promise<RevisionWithCalendar[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    return this.uow.run(async (repos) => {
      const schedule = await repos.schedules.findById(companyId, scheduleId);
      if (!schedule) throw new WorkScheduleNotFoundError();
      return repos.revisions.list(companyId, scheduleId);
    });
  }

  /** Cancel a mistaken revision (e.g. wrong future-dated pattern). The row is
   *  retained with status ARCHIVED — never applied — and the cancellation is
   *  audited. The sole ACTIVE revision cannot be cancelled; archive the
   *  schedule instead. */
  async cancelRevision(
    actor: ActorContext,
    companyId: string,
    scheduleId: string,
    revisionId: string,
  ): Promise<WorkScheduleRevision> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      await this.assertScheduleMutable(repos, companyId, scheduleId);
      const revision = await repos.revisions.findById(companyId, scheduleId, revisionId);
      if (!revision) throw new ScheduleRevisionNotFoundError();
      if (revision.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError('Revision is already cancelled');
      }
      if ((await repos.revisions.countActive(companyId, scheduleId)) <= 1) {
        throw new LastActiveRevisionError();
      }
      const cancelled = await repos.revisions.cancel(companyId, revisionId);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WORK_SCHEDULE_REVISION_CANCELLED',
          entityType: 'WORK_SCHEDULE_REVISION',
          entityId: revisionId,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
          metadata: { scheduleId, revision: revision.revision },
        }),
      );
      return cancelled;
    });
  }

  // -------------------------------------------------------------------------
  // Date-specific overrides
  // -------------------------------------------------------------------------

  async addOverride(
    actor: ActorContext,
    companyId: string,
    scheduleId: string,
    input: AddOverrideInput,
  ): Promise<WorkScheduleOverride> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );
    const date = parseDate(input.date, 'date');

    return this.uow.run(async (repos) => {
      await this.assertScheduleMutable(repos, companyId, scheduleId);
      const existing = await repos.overrides.findActiveForDate(companyId, scheduleId, date);
      if (existing) throw new DuplicateOverrideError(input.date);

      const override = await repos.overrides.create(companyId, {
        scheduleId,
        date,
        disposition: input.disposition,
        name: input.name?.trim() ?? null,
        createdByPrincipalId: actor.actorId,
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WORK_SCHEDULE_OVERRIDE_ADDED',
          entityType: 'WORK_SCHEDULE_OVERRIDE',
          entityId: override.id,
          companyId,
          metadata: { scheduleId, date: input.date, disposition: input.disposition },
        }),
      );
      return override;
    });
  }

  async listOverrides(
    actor: ActorContext,
    companyId: string,
    scheduleId: string,
    filter: ListOverridesFilter,
  ): Promise<WorkScheduleOverride[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    return this.uow.run(async (repos) => {
      const schedule = await repos.schedules.findById(companyId, scheduleId);
      if (!schedule) throw new WorkScheduleNotFoundError();
      return repos.overrides.list(companyId, scheduleId, {
        ...(filter.from !== undefined ? { from: parseDate(filter.from, 'from') } : {}),
        ...(filter.to !== undefined ? { to: parseDate(filter.to, 'to') } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
      });
    });
  }

  async cancelOverride(
    actor: ActorContext,
    companyId: string,
    scheduleId: string,
    overrideId: string,
  ): Promise<WorkScheduleOverride> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      await this.assertScheduleMutable(repos, companyId, scheduleId);
      const override = await repos.overrides.findById(companyId, scheduleId, overrideId);
      if (!override) throw new ScheduleOverrideNotFoundError();
      if (override.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError('Override is already cancelled');
      }
      const cancelled = await repos.overrides.cancel(companyId, overrideId);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WORK_SCHEDULE_OVERRIDE_CANCELLED',
          entityType: 'WORK_SCHEDULE_OVERRIDE',
          entityId: overrideId,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
          metadata: { scheduleId, date: override.date, disposition: override.disposition },
        }),
      );
      return cancelled;
    });
  }

  // -------------------------------------------------------------------------
  // Effective resolution + classification
  // -------------------------------------------------------------------------

  /**
   * Deterministic resolution order:
   *   EMPLOYEE > DEPARTMENT (primary membership effective on asOf; exactly-one
   *   effective membership also counts; >1 without primary fails closed) >
   *   SITE > PROJECT > COMPANY.
   * Site/project context derives from the placed department first, then from
   * caller-supplied criteria. At each tier the schedule must (a) be ACTIVE
   * with a window covering asOf and (b) have an ACTIVE revision effective on
   * asOf — otherwise the tier is skipped (a schedule whose pattern has not
   * started yet does not block lower tiers). The returned revision is the
   * immutable pattern that applies to the asOf date — historical evaluation
   * always resolves the revision in force on that date.
   */
  async resolveEffective(
    actor: ActorContext,
    companyId: string,
    criteria: EffectiveScheduleCriteria,
  ): Promise<EffectiveScheduleResult> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    const asOf = criteria.asOf !== undefined ? parseDate(criteria.asOf, 'asOf') : new Date();
    const hasExplicitDate = criteria.asOf !== undefined;

    return this.uow.run(async (repos) => {
      let ctxSiteId = criteria.siteId;
      let ctxProjectId = criteria.projectId;

      const withRevision = async (
        scope: EffectiveScheduleTarget,
        via: EffectiveScheduleResult['resolvedVia'],
      ): Promise<EffectiveScheduleResult | null> => {
        const schedule = await repos.schedules.findAtScope(companyId, scope, asOf);
        if (!schedule) return null;
        const revision = await repos.revisions.findEffective(companyId, schedule.id, asOf);
        if (!revision) return null;
        // An explicit asOf is already the local work date. When omitted, the
        // instant must be classified on the schedule-timezone's local date —
        // a UTC slice can pick the wrong day near midnight.
        const workDate = hasExplicitDate ? asOf : instantToLocalWorkDate(asOf, revision.timezone);
        const classification = await this.classifyForRevision(
          repos,
          companyId,
          schedule.id,
          revision,
          workDate,
        );
        return { schedule, revision, resolvedVia: via, classification };
      };

      if (criteria.employeeId !== undefined) {
        const employee = await repos.employees.findById(companyId, criteria.employeeId);
        if (!employee) throw new ScheduleTargetNotFoundError('EMPLOYEE', criteria.employeeId);

        const empResult = await withRevision(
          { scopeType: 'EMPLOYEE', employeeId: criteria.employeeId },
          'EMPLOYEE',
        );
        if (empResult) return empResult;

        // Membership effective on the classified date — a future membership
        // must not apply early and a current one must not rewrite history.
        // Same primary/ambiguity rules as leave-policy resolution.
        const memberships = await repos.memberships.findActiveByEmployee(
          companyId,
          criteria.employeeId,
          asOf,
        );
        const primary = memberships.find((m) => m.isPrimary);
        let departmentId: string | undefined;
        if (primary !== undefined) {
          departmentId = primary.departmentId;
        } else if (memberships.length === 1) {
          departmentId = memberships[0]?.departmentId;
        } else if (memberships.length > 1) {
          throw new AmbiguousScheduleContextError();
        }

        if (departmentId !== undefined) {
          const dept = await repos.departments.findById(companyId, departmentId);
          if (dept !== null && dept.status !== 'ARCHIVED') {
            const deptResult = await withRevision(
              { scopeType: 'DEPARTMENT', departmentId },
              'DEPARTMENT',
            );
            if (deptResult) return deptResult;
            ctxSiteId = ctxSiteId ?? dept.siteId ?? undefined;
            ctxProjectId = ctxProjectId ?? dept.projectId ?? undefined;
          }
        }
      }

      if (ctxSiteId !== undefined) {
        const siteResult = await withRevision({ scopeType: 'SITE', siteId: ctxSiteId }, 'SITE');
        if (siteResult) return siteResult;
      }
      if (ctxProjectId !== undefined) {
        const projResult = await withRevision(
          { scopeType: 'PROJECT', projectId: ctxProjectId },
          'PROJECT',
        );
        if (projResult) return projResult;
      }
      const companyResult = await withRevision({ scopeType: 'COMPANY' }, 'COMPANY');
      if (companyResult) return companyResult;
      throw new NoEffectiveScheduleError();
    });
  }

  /**
   * Classify a date under a specific schedule — useful for admins previewing
   * deductions/offs without resolving scope. Fetches the revision effective
   * for the date (historical), the calendar's ACTIVE holidays on the date,
   * and the ACTIVE override on the date.
   */
  async classifyScheduleDate(
    actor: ActorContext,
    companyId: string,
    scheduleId: string,
    dateStr: string,
  ): Promise<{ revision: RevisionWithCalendar; classification: ClassifiedDay }> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    const date = parseDate(dateStr, 'date');

    return this.uow.run(async (repos) => {
      const schedule = await repos.schedules.findById(companyId, scheduleId);
      if (!schedule) throw new WorkScheduleNotFoundError();
      const revision = await repos.revisions.findEffective(companyId, scheduleId, date);
      if (!revision) throw new NoEffectiveScheduleError();
      const classification = await this.classifyForRevision(
        repos,
        companyId,
        scheduleId,
        revision,
        date,
      );
      return { revision, classification };
    });
  }

  // -------------------------------------------------------------------------
  // Holiday calendars
  // -------------------------------------------------------------------------

  async createCalendar(
    actor: ActorContext,
    companyId: string,
    input: CreateHolidayCalendarInput,
  ): Promise<HolidayCalendar> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );
    const code = normalizeCode(input.code);

    return this.uow.run(async (repos) => {
      const created = await repos.calendars.create(companyId, {
        code,
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_CALENDAR_CREATED',
          entityType: 'HOLIDAY_CALENDAR',
          entityId: created.id,
          companyId,
          metadata: { code: created.code, name: created.name },
        }),
      );
      return created;
    });
  }

  async listCalendars(
    actor: ActorContext,
    companyId: string,
    filter: ListHolidayCalendarsFilter,
  ): Promise<HolidayCalendar[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    return this.uow.run((repos) => repos.calendars.list(companyId, filter));
  }

  async updateCalendar(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: UpdateHolidayCalendarInput,
  ): Promise<HolidayCalendar> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const existing = await repos.calendars.findById(companyId, id);
      if (!existing) throw new HolidayCalendarNotFoundError();
      if (existing.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError('Archived calendars are immutable');
      }
      const updated = await repos.calendars.update(
        companyId,
        id,
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() ?? null }
            : {}),
        },
        input.expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_CALENDAR_UPDATED',
          entityType: 'HOLIDAY_CALENDAR',
          entityId: id,
          companyId,
          changedFields: { version: { before: input.expectedVersion, after: updated.version } },
        }),
      );
      return updated;
    });
  }

  async archiveCalendar(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion: number,
  ): Promise<HolidayCalendar> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const existing = await repos.calendars.findById(companyId, id);
      if (!existing) throw new HolidayCalendarNotFoundError();
      if (existing.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError('Calendar is already archived');
      }
      const inUse = await repos.revisions.countReferencingCalendar(companyId, id);
      if (inUse > 0) throw new HolidayCalendarInUseError();
      const updated = await repos.calendars.update(
        companyId,
        id,
        { status: 'ARCHIVED' },
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_CALENDAR_ARCHIVED',
          entityType: 'HOLIDAY_CALENDAR',
          entityId: id,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
        }),
      );
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Holiday categories
  // -------------------------------------------------------------------------

  async createCategory(
    actor: ActorContext,
    companyId: string,
    input: CreateHolidayCategoryInput,
  ): Promise<HolidayCategory> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );
    const code = normalizeCode(input.code);

    return this.uow.run(async (repos) => {
      const created = await repos.categories.create(companyId, {
        code,
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_CATEGORY_CREATED',
          entityType: 'HOLIDAY_CATEGORY',
          entityId: created.id,
          companyId,
          metadata: { code: created.code, name: created.name },
        }),
      );
      return created;
    });
  }

  async listCategories(
    actor: ActorContext,
    companyId: string,
    filter: ListHolidayCategoriesFilter,
  ): Promise<HolidayCategory[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );
    return this.uow.run((repos) => repos.categories.list(companyId, filter));
  }

  /** Archived categories remain valid on existing holidays (historical
   *  meaning preserved) but cannot be used for new holidays. */
  async archiveCategory(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion: number,
  ): Promise<HolidayCategory> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const existing = await repos.categories.findById(companyId, id);
      if (!existing) throw new HolidayCategoryNotFoundError();
      if (existing.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError('Category is already archived');
      }
      const updated = await repos.categories.update(
        companyId,
        id,
        { status: 'ARCHIVED' },
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_CATEGORY_ARCHIVED',
          entityType: 'HOLIDAY_CATEGORY',
          entityId: id,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
        }),
      );
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Holidays
  // -------------------------------------------------------------------------

  async addHoliday(
    actor: ActorContext,
    companyId: string,
    calendarId: string,
    input: AddHolidayInput,
  ): Promise<HolidayWithCategory> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const calendar = await this.assertCalendarMutable(repos, companyId, calendarId);
      await this.assertCategoryUsable(repos, companyId, input.categoryId);
      const created = await repos.holidays.create(companyId, {
        calendar: { connect: { id_companyId: { id: calendar.id, companyId } } },
        category: { connect: { id_companyId: { id: input.categoryId, companyId } } },
        date: parseDate(input.date, 'date'),
        name: input.name.trim(),
      });
      const holiday = await repos.holidays.findById(companyId, calendar.id, created.id);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_ADDED',
          entityType: 'HOLIDAY',
          entityId: created.id,
          companyId,
          metadata: {
            calendarId,
            date: input.date,
            name: created.name,
            categoryId: input.categoryId,
          },
        }),
      );
      if (holiday === null) throw new Error('holiday vanished after create');
      return holiday;
    });
  }

  async addHolidaysBulk(
    actor: ActorContext,
    companyId: string,
    calendarId: string,
    input: BulkAddHolidaysInput,
  ): Promise<{ created: number }> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const calendar = await this.assertCalendarMutable(repos, companyId, calendarId);
      const seen = new Set<string>();
      for (const h of input.holidays) {
        if (seen.has(h.date)) {
          throw new ScheduleValidationError('holidays', `duplicate date ${h.date} in request`);
        }
        seen.add(h.date);
        parseDate(h.date, 'date');
        await this.assertCategoryUsable(repos, companyId, h.categoryId);
      }
      const created = await repos.holidays.createMany(
        companyId,
        input.holidays.map((h) => ({
          calendarId: calendar.id,
          categoryId: h.categoryId,
          date: parseDate(h.date, 'date'),
          name: h.name.trim(),
        })),
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_BULK_ADDED',
          entityType: 'HOLIDAY_CALENDAR',
          entityId: calendarId,
          companyId,
          metadata: { count: created },
        }),
      );
      return { created };
    });
  }

  /** Cancel keeps the row (status ARCHIVED) so classification history and the
   *  audit trail stay explainable; the date becomes free for re-adding. */
  async cancelHoliday(
    actor: ActorContext,
    companyId: string,
    calendarId: string,
    holidayId: string,
  ): Promise<void> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const calendar = await this.assertCalendarMutable(repos, companyId, calendarId);
      const target = await repos.holidays.findById(companyId, calendar.id, holidayId);
      if (!target) throw new HolidayNotFoundError();
      if (target.status === 'ARCHIVED') {
        throw new InvalidScheduleStateError('Holiday is already cancelled');
      }
      await repos.holidays.cancel(companyId, holidayId);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'HOLIDAY_CANCELLED',
          entityType: 'HOLIDAY',
          entityId: holidayId,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
          metadata: { calendarId, date: target.date, name: target.name },
        }),
      );
    });
  }

  async listHolidays(
    actor: ActorContext,
    companyId: string,
    calendarId: string,
    filter: ListHolidaysFilter,
  ): Promise<HolidayWithCategory[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      WORK_SCHEDULE_READ,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const calendar = await repos.calendars.findById(companyId, calendarId);
      if (!calendar) throw new HolidayCalendarNotFoundError();
      return repos.holidays.list(companyId, calendarId, {
        ...(filter.from !== undefined ? { from: parseDate(filter.from, 'from') } : {}),
        ...(filter.to !== undefined ? { to: parseDate(filter.to, 'to') } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  private async assertScheduleMutable(
    repos: ScheduleRepos,
    companyId: string,
    scheduleId: string,
  ): Promise<WorkSchedule> {
    const schedule = await repos.schedules.findById(companyId, scheduleId);
    if (!schedule) throw new WorkScheduleNotFoundError();
    if (schedule.status === 'ARCHIVED') {
      throw new InvalidScheduleStateError('Archived schedules cannot be modified');
    }
    return schedule;
  }

  private async assertCalendarMutable(
    repos: ScheduleRepos,
    companyId: string,
    calendarId: string,
  ): Promise<HolidayCalendar> {
    const calendar = await repos.calendars.findById(companyId, calendarId);
    if (!calendar) throw new HolidayCalendarNotFoundError();
    if (calendar.status === 'ARCHIVED') {
      throw new InvalidScheduleStateError('Archived calendars cannot be modified');
    }
    return calendar;
  }

  private async assertCalendarUsable(
    repos: ScheduleRepos,
    companyId: string,
    calendarId: string | null | undefined,
  ): Promise<void> {
    if (calendarId === undefined || calendarId === null) return;
    const cal = await repos.calendars.findById(companyId, calendarId);
    if (cal?.status !== 'ACTIVE') {
      throw new ScheduleValidationError(
        'holidayCalendarId',
        'must reference an ACTIVE calendar in this company',
      );
    }
  }

  private async assertCategoryUsable(
    repos: ScheduleRepos,
    companyId: string,
    categoryId: string,
  ): Promise<void> {
    const category = await repos.categories.findById(companyId, categoryId);
    if (category === null) throw new HolidayCategoryNotFoundError();
    if (category.status === 'ARCHIVED') {
      throw new ScheduleValidationError(
        'categoryId',
        'must reference an ACTIVE category in this company',
      );
    }
  }

  private async classifyForRevision(
    repos: ScheduleRepos,
    companyId: string,
    scheduleId: string,
    revision: RevisionWithCalendar,
    date: Date,
  ): Promise<ClassifiedDay> {
    const dateStr = toDateStr(date);
    const holidayDates = new Set<string>();
    if (revision.holidayCalendarId !== null) {
      const dates = await repos.holidays.activeDatesInRange(
        companyId,
        revision.holidayCalendarId,
        date,
        date,
      );
      for (const d of dates) holidayDates.add(toDateStr(d));
    }
    const override = await repos.overrides.findActiveForDate(companyId, scheduleId, date);
    return classifyWithOverrides(
      revisionSpec(revision),
      dateStr,
      holidayDates,
      override?.disposition ?? null,
    );
  }

  private validateScopeShape(input: {
    scopeType: string;
    departmentId?: string | undefined;
    projectId?: string | undefined;
    siteId?: string | undefined;
    employeeId?: string | undefined;
  }): void {
    const required = SCOPE_REQUIRED_REF[input.scopeType];
    if (required === undefined) {
      throw new ScheduleScopeShapeError(`unknown scopeType ${input.scopeType}`);
    }
    for (const ref of SCOPE_REFS) {
      const present = input[ref] !== undefined;
      if (ref === required && !present) {
        throw new ScheduleScopeShapeError(`scopeType ${input.scopeType} requires ${ref}`);
      }
      if (ref !== required && present) {
        throw new ScheduleScopeShapeError(`scopeType ${input.scopeType} must not set ${ref}`);
      }
    }
  }

  private async assertScopeTarget(
    repos: ScheduleRepos,
    companyId: string,
    input: CreateWorkScheduleInput,
  ): Promise<void> {
    switch (input.scopeType) {
      case 'DEPARTMENT': {
        const id = input.departmentId;
        if (id === undefined) {
          throw new ScheduleScopeShapeError('scopeType DEPARTMENT requires departmentId');
        }
        const status = (await repos.departments.findById(companyId, id))?.status;
        if (status === undefined || status === 'ARCHIVED') {
          throw new ScheduleTargetNotFoundError('DEPARTMENT', id);
        }
        break;
      }
      case 'PROJECT': {
        const id = input.projectId;
        if (id === undefined) {
          throw new ScheduleScopeShapeError('scopeType PROJECT requires projectId');
        }
        const status = (await repos.projects.findById(companyId, id))?.status;
        if (status === undefined || status === 'ARCHIVED') {
          throw new ScheduleTargetNotFoundError('PROJECT', id);
        }
        break;
      }
      case 'SITE': {
        const id = input.siteId;
        if (id === undefined) {
          throw new ScheduleScopeShapeError('scopeType SITE requires siteId');
        }
        const status = (await repos.sites.findById(companyId, id))?.status;
        if (status === undefined || status === 'ARCHIVED') {
          throw new ScheduleTargetNotFoundError('SITE', id);
        }
        break;
      }
      case 'EMPLOYEE': {
        const id = input.employeeId;
        if (id === undefined) {
          throw new ScheduleScopeShapeError('scopeType EMPLOYEE requires employeeId');
        }
        const status = (await repos.employees.findById(companyId, id))?.status;
        if (status !== 'ACTIVE') {
          throw new ScheduleTargetNotFoundError('EMPLOYEE', id);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Validates the administrator-configured pattern. Every element is
   * allowlisted structured data — no expressions, no executable content.
   * Returns normalized values (validated timezone, deduped-sorted weekdays).
   */
  private validateRevisionPattern(input: RevisionPatternInput): {
    timezone: string;
    workingWeekdays: number[];
    offNthWeekdays: { weekday: number; nths: number[] }[] | null;
    rotation: {
      anchor: Date;
      lengthDays: number;
      workingOffsets: number[];
      offOffsets: number[];
    } | null;
  } {
    let timezone: string;
    try {
      timezone = assertValidTimezone(input.timezone);
    } catch (e) {
      if (e instanceof OrgValidationError) {
        throw new ScheduleValidationError('timezone', 'must be a valid IANA timezone name');
      }
      throw e;
    }

    const weekdays = [...new Set(input.workingWeekdays)].sort((a, b) => a - b);
    if (weekdays.length !== input.workingWeekdays.length) {
      throw new ScheduleValidationError('workingWeekdays', 'must not contain duplicates');
    }
    if (weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new ScheduleValidationError('workingWeekdays', 'must be integers 0 (Sun) .. 6 (Sat)');
    }

    const seenOffWeekdays = new Set<number>();
    const offNthWeekdays = (input.offNthWeekdays ?? []).map((entry) => {
      if (seenOffWeekdays.has(entry.weekday)) {
        throw new ScheduleValidationError(
          'offNthWeekdays',
          `weekday ${entry.weekday} listed more than once`,
        );
      }
      seenOffWeekdays.add(entry.weekday);
      const nths = [...new Set(entry.nths)].sort((a, b) => a - b);
      if (nths.length !== entry.nths.length) {
        throw new ScheduleValidationError('offNthWeekdays', 'nths must not contain duplicates');
      }
      if (nths.some((n) => !VALID_NTHS.has(n))) {
        throw new ScheduleValidationError('offNthWeekdays', 'nths must be -1 (last) or 1..5');
      }
      return { weekday: entry.weekday, nths };
    });

    let rotation: {
      anchor: Date;
      lengthDays: number;
      workingOffsets: number[];
      offOffsets: number[];
    } | null = null;
    if (input.rotation !== undefined) {
      const r = input.rotation;
      const anchor = parseDate(r.anchor, 'rotation.anchor');
      const validateOffsets = (offsets: number[], field: string): number[] => {
        const unique = [...new Set(offsets)].sort((a, b) => a - b);
        if (unique.length !== offsets.length) {
          throw new ScheduleValidationError(field, 'must not contain duplicates');
        }
        if (unique.some((o) => !Number.isInteger(o) || o < 0 || o >= r.lengthDays)) {
          throw new ScheduleValidationError(
            field,
            `must be integers 0..${r.lengthDays - 1} (within the cycle)`,
          );
        }
        return unique;
      };
      const workingOffsets = validateOffsets(r.workingOffsets, 'rotation.workingOffsets');
      const offOffsets = validateOffsets(r.offOffsets, 'rotation.offOffsets');
      const overlap = workingOffsets.filter((o) => offOffsets.includes(o));
      if (overlap.length > 0) {
        throw new ScheduleValidationError(
          'rotation.offOffsets',
          `offsets ${overlap.join(',')} cannot be both working and off`,
        );
      }
      rotation = { anchor, lengthDays: r.lengthDays, workingOffsets, offOffsets };
    }

    if (weekdays.length === 0 && (rotation === null || rotation.workingOffsets.length === 0)) {
      throw new ScheduleValidationError(
        'workingWeekdays',
        'required unless rotation.workingOffsets defines a pure rotating cycle',
      );
    }

    return { timezone, workingWeekdays: weekdays, offNthWeekdays, rotation };
  }

  private revisionCreateData(
    validated: ReturnType<ScheduleService['validateRevisionPattern']>,
    companyId: string,
    holidayCalendarId: string | null | undefined,
  ): Omit<
    Prisma.WorkScheduleRevisionCreateInput,
    'company' | 'schedule' | 'revision' | 'effectiveFrom'
  > {
    return {
      timezone: validated.timezone,
      workingWeekdays: validated.workingWeekdays,
      offNthWeekdays: validated.offNthWeekdays ?? Prisma.JsonNull,
      rotationAnchor: validated.rotation?.anchor ?? null,
      rotationLengthDays: validated.rotation?.lengthDays ?? null,
      rotationWorkingOffsets: validated.rotation?.workingOffsets ?? [],
      rotationOffOffsets: validated.rotation?.offOffsets ?? [],
      ...(holidayCalendarId !== undefined && holidayCalendarId !== null
        ? {
            holidayCalendar: {
              connect: { id_companyId: { id: holidayCalendarId, companyId } },
            },
          }
        : {}),
    };
  }
}
