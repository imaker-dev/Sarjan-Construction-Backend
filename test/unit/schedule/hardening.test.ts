import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type {
  ScheduleRepos,
  ScheduleUnitOfWork,
} from '../../../src/modules/schedule/repository.js';
import { ScheduleService } from '../../../src/modules/schedule/service.js';
import type { RevisionWithCalendar } from '../../../src/modules/schedule/repository.js';
import type { WorkSchedule } from '@prisma/client';
import { ForbiddenError } from '../../../src/common/errors/app-error.js';
import type { CreateWorkScheduleInput } from '../../../src/modules/schedule/types.js';

const CID = '00000000-0000-4000-8000-0000000000c1';
const DEPT_SITE = '00000000-0000-4000-8000-0000000000d1';
const DEPT_HO = '00000000-0000-4000-8000-0000000000d3';
const HO = '00000000-0000-4000-8000-0000000000e0';
const SITE = '00000000-0000-4000-8000-0000000000e1';
const PROJ = '00000000-0000-4000-8000-0000000000e2';
const EMP = '00000000-0000-4000-8000-0000000000a1';
const SCHED = '00000000-0000-4000-8000-000000000051';

const actor: ActorContext = { actorId: 'u1', actorType: 'USER' };

const scheduleRow = (over: Partial<WorkSchedule> = {}): WorkSchedule => ({
  id: SCHED,
  companyId: CID,
  scopeType: 'COMPANY',
  departmentId: null,
  projectId: null,
  siteId: null,
  employeeId: null,
  name: 'Schedule',
  description: null,
  effectiveFrom: new Date('2025-01-01T00:00:00Z'),
  effectiveTo: null,
  status: 'ACTIVE',
  archivedAt: null,
  version: 0,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  ...over,
});

const revisionRow = (over: Partial<RevisionWithCalendar> = {}): RevisionWithCalendar => ({
  id: 'rev-1',
  scheduleId: SCHED,
  companyId: CID,
  revision: 1,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  timezone: 'Asia/Kolkata',
  workingWeekdays: [1, 2, 3, 4, 5],
  offNthWeekdays: null,
  rotationAnchor: null,
  rotationLengthDays: null,
  rotationWorkingOffsets: [],
  rotationOffOffsets: [],
  holidayCalendarId: null,
  holidayCalendar: null,
  scheduledStartMins: null,
  scheduledEndMins: null,
  graceInMins: null,
  graceOutMins: null,
  breakWindowMode: null,
  breakWindowStartMins: null,
  breakWindowEndMins: null,
  breakDurationMins: null,
  autoClockOutMode: null,
  autoClockOutGraceMins: null,
  status: 'ACTIVE',
  note: null,
  createdByPrincipalId: 'u1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

function makeRepos(overrides: Partial<ScheduleRepos> = {}): ScheduleRepos {
  return {
    schedules: {
      findById: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(async (_c: string, data: Partial<WorkSchedule>) => scheduleRow(data)),
      update: vi.fn(),
      findAtScope: vi.fn().mockResolvedValue(null),
    },
    revisions: {
      create: vi.fn(async (_c: string, data: Partial<RevisionWithCalendar>) => revisionRow(data)),
      findEffective: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      nextRevisionNumber: vi.fn().mockResolvedValue(2),
      countActive: vi.fn().mockResolvedValue(2),
      cancel: vi.fn(),
      countReferencingCalendar: vi.fn().mockResolvedValue(0),
    },
    overrides: {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findActiveForDate: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      cancel: vi.fn(),
    },
    calendars: {
      findById: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    categories: {
      findById: vi.fn().mockResolvedValue(null),
      findByCode: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    holidays: {
      create: vi.fn(),
      createMany: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      cancel: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      activeDatesInRange: vi.fn().mockResolvedValue([]),
    },
    departments: {
      findById: vi.fn().mockResolvedValue(null),
    },
    projects: {
      findById: vi.fn(async (_c: string, id: string) =>
        id === PROJ ? { id, status: 'ACTIVE' } : null,
      ),
    },
    sites: {
      findById: vi.fn(async (_c: string, id: string) =>
        id === SITE ? { id, status: 'ACTIVE' } : null,
      ),
    },
    employees: {
      findById: vi.fn(async (_c: string, id: string) =>
        id === EMP ? { id, status: 'ACTIVE' } : null,
      ),
    },
    memberships: { findActiveByEmployee: vi.fn().mockResolvedValue([]) },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  } as unknown as ScheduleRepos;
}

const makeUow = (repos: ScheduleRepos): ScheduleUnitOfWork => ({ run: async (fn) => fn(repos) });

const BASE_INPUT: CreateWorkScheduleInput = {
  scopeType: 'SITE',
  siteId: SITE,
  name: 'Site 8–17',
  effectiveFrom: '2026-01-01',
  revision: {
    effectiveFrom: '2026-01-01',
    timezone: 'Asia/Kolkata',
    workingWeekdays: [1, 2, 3, 4, 5],
  },
};

describe('HO department vs site schedule precedence', () => {
  const deptScopedSchedule = (scope: { scopeType: string }): WorkSchedule =>
    scheduleRow({
      id: `sched-${scope.scopeType}`,
      scopeType: scope.scopeType as WorkSchedule['scopeType'],
      name: `${scope.scopeType} schedule`,
    });

  it('an HO-department employee resolves the DEPARTMENT-tier schedule, never SITE', async () => {
    const repos = makeRepos({
      memberships: {
        findActiveByEmployee: vi
          .fn()
          .mockResolvedValue([{ departmentId: DEPT_HO, isPrimary: true }]),
      },
      departments: {
        findById: vi.fn(async (_c: string, id: string) =>
          id === DEPT_HO
            ? {
                id,
                status: 'ACTIVE',
                scopeType: 'COMPANY',
                baseHeadOfficeId: HO,
                projectId: null,
                siteId: null,
              }
            : null,
        ),
      },
      schedules: {
        findById: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        findAtScope: vi.fn(async (_c: string, t: { scopeType: string; siteId?: string | null }) =>
          t.scopeType === 'DEPARTMENT'
            ? deptScopedSchedule(t)
            : t.scopeType === 'SITE'
              ? deptScopedSchedule(t)
              : null,
        ),
      },
      revisions: {
        create: vi.fn(),
        findEffective: vi.fn(async (_c, scheduleId) => revisionRow({ id: `rev-${scheduleId}` })),
        findById: vi.fn(),
        list: vi.fn(),
        nextRevisionNumber: vi.fn(),
        countActive: vi.fn(),
        cancel: vi.fn(),
        countReferencingCalendar: vi.fn(),
      },
    });
    const service = new ScheduleService(makeUow(repos), {
      assertPermission: vi.fn().mockResolvedValue(undefined),
      hasPermission: vi.fn().mockResolvedValue(true),
    });
    const result = await service.resolveForEmployee(CID, EMP, new Date('2026-03-02T10:00:00Z'));
    // DEPT wins over SITE even though a SITE schedule exists — the employee's
    // HO department must never leak site hours.
    expect(result?.resolvedVia).toBe('DEPARTMENT');
    expect(result?.schedule.id).toBe('sched-DEPARTMENT');
    expect(result?.revision.id).toBe('rev-sched-DEPARTMENT');
  });

  it('a site-department employee falls to the SITE tier when no dept schedule exists', async () => {
    const repos = makeRepos({
      memberships: {
        findActiveByEmployee: vi
          .fn()
          .mockResolvedValue([{ departmentId: DEPT_SITE, isPrimary: true }]),
      },
      departments: {
        findById: vi.fn(async (_c: string, id: string) =>
          id === DEPT_SITE
            ? {
                id,
                status: 'ACTIVE',
                scopeType: 'SITE',
                baseHeadOfficeId: null,
                projectId: PROJ,
                siteId: SITE,
              }
            : null,
        ),
      },
      schedules: {
        findById: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        findAtScope: vi.fn(async (_c: string, t: { scopeType: string }) =>
          t.scopeType === 'SITE' ? deptScopedSchedule(t) : null,
        ),
      },
      revisions: {
        create: vi.fn(),
        findEffective: vi.fn(async (_c, scheduleId) => revisionRow({ id: `rev-${scheduleId}` })),
        findById: vi.fn(),
        list: vi.fn(),
        nextRevisionNumber: vi.fn(),
        countActive: vi.fn(),
        cancel: vi.fn(),
        countReferencingCalendar: vi.fn(),
      },
    });
    const service = new ScheduleService(makeUow(repos), {
      assertPermission: vi.fn().mockResolvedValue(undefined),
      hasPermission: vi.fn().mockResolvedValue(true),
    });
    const result = await service.resolveForEmployee(CID, EMP, new Date('2026-03-02T10:00:00Z'));
    expect(result?.resolvedVia).toBe('SITE');
    expect(result?.schedule.id).toBe('sched-SITE');
  });
});

describe('scheduleManage delegation gate', () => {
  const scopedOnly = {
    // Holds WORK_SCHEDULE_MANAGE only at the SITE chain — never company-wide.
    assertPermission: vi.fn().mockResolvedValue(undefined),
    hasPermission: vi
      .fn()
      .mockImplementation(
        async (_p: string, _k: string, t: { scopeType: string }) => t.scopeType === 'SITE',
      ),
  };

  const makeScopedService = (delegated: boolean, auth = scopedOnly) => {
    const repos = makeRepos({
      departments: { findById: vi.fn().mockResolvedValue(null) },
      memberships: { findActiveByEmployee: vi.fn().mockResolvedValue([]) },
    });
    const service = new ScheduleService(makeUow(repos), auth, {
      delegationEnabled: vi.fn().mockResolvedValue(delegated),
    });
    return { service, repos };
  };

  it('flag OFF → scoped PI is denied with DELEGATION_DISABLED', async () => {
    const { service } = makeScopedService(false);
    await expect(service.createSchedule(actor, CID, BASE_INPUT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('flag ON → scoped PI creates a site schedule', async () => {
    const { service, repos } = makeScopedService(true);
    const result = await service.createSchedule(actor, CID, BASE_INPUT);
    expect(repos.schedules.create).toHaveBeenCalledOnce();
    expect(result.schedule.id).toBe(SCHED);
  });

  it('company-wide WORK_SCHEDULE_MANAGE bypasses the flag entirely', async () => {
    const companyWide = {
      assertPermission: vi.fn().mockResolvedValue(undefined),
      hasPermission: vi.fn().mockResolvedValue(true),
    };
    const { service } = makeScopedService(false, companyWide);
    await expect(service.createSchedule(actor, CID, BASE_INPUT)).resolves.toBeDefined();
  });

  it('delegation never unlocks HEAD_OFFICE targets — HO stays Finance/Admin', async () => {
    const deptScopedPi = {
      // Asserts the resolved target — HEAD_OFFICE (via baseHeadOfficeId)
      // must be what PI is checked against, and PI lacks it.
      assertPermission: vi
        .fn()
        .mockImplementation(async (_p: string, _k: string, t: { scopeType: string }) => {
          if (t.scopeType !== 'SITE' && t.scopeType !== 'PROJECT') throw new ForbiddenError('X');
        }),
      hasPermission: vi.fn().mockResolvedValue(false),
    };
    const repos = makeRepos({
      departments: {
        findById: vi.fn(async (_c: string, id: string) =>
          id === DEPT_HO
            ? {
                id,
                status: 'ACTIVE',
                scopeType: 'COMPANY',
                baseHeadOfficeId: HO,
                projectId: null,
                siteId: null,
              }
            : null,
        ),
      },
    });
    const service = new ScheduleService(makeUow(repos), deptScopedPi, {
      delegationEnabled: vi.fn().mockResolvedValue(true),
    });
    await expect(
      service.createSchedule(actor, CID, {
        scopeType: 'DEPARTMENT',
        departmentId: DEPT_HO,
        name: 'HO 10–19',
        effectiveFrom: '2026-01-01',
        revision: {
          effectiveFrom: '2026-01-01',
          timezone: 'Asia/Kolkata',
          workingWeekdays: [1, 2, 3, 4, 5],
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('holiday and OFF-day override classification', () => {
  const effectiveRepos = (over: Partial<ScheduleRepos> = {}) =>
    makeRepos({
      schedules: {
        findById: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        findAtScope: vi.fn(async (_c: string, t: { scopeType: string }) =>
          t.scopeType === 'COMPANY' ? scheduleRow({ id: 'comp-sched' }) : null,
        ),
      },
      revisions: {
        create: vi.fn(),
        findEffective: vi
          .fn()
          .mockImplementation(async (_c, scheduleId) =>
            revisionRow({ id: `rev-${scheduleId}`, holidayCalendarId: 'cal-1' }),
          ),
        findById: vi.fn(),
        list: vi.fn(),
        nextRevisionNumber: vi.fn(),
        countActive: vi.fn(),
        cancel: vi.fn(),
        countReferencingCalendar: vi.fn(),
      },
      ...over,
    });

  const auth = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
    hasPermission: vi.fn().mockResolvedValue(true),
  };

  it('a holiday calendar date classifies HOLIDAY', async () => {
    const repos = effectiveRepos({
      holidays: {
        create: vi.fn(),
        createMany: vi.fn(),
        findById: vi.fn(),
        cancel: vi.fn(),
        list: vi.fn(),
        activeDatesInRange: vi.fn().mockResolvedValue([new Date('2026-03-02T00:00:00Z')]),
      },
    });
    const service = new ScheduleService(makeUow(repos), auth);
    const result = await service.resolveEffective(actor, CID, { asOf: '2026-03-02' });
    expect(result.classification.day).toBe('HOLIDAY');
  });

  it('an OFF override flips a working weekday to WEEKLY_OFF', async () => {
    const repos = effectiveRepos({
      overrides: {
        create: vi.fn(),
        findById: vi.fn(),
        findActiveForDate: vi.fn().mockResolvedValue({ disposition: 'OFF' }),
        list: vi.fn(),
        cancel: vi.fn(),
      },
    });
    const service = new ScheduleService(makeUow(repos), auth);
    const result = await service.resolveEffective(actor, CID, { asOf: '2026-03-02' }); // Monday
    expect(result.classification.day).toBe('WEEKLY_OFF');
    expect(result.classification.reason).toBe('OVERRIDE');
  });

  it('a WORKING override flips a weekly-off day back to WORKING', async () => {
    const repos = effectiveRepos({
      overrides: {
        create: vi.fn(),
        findById: vi.fn(),
        findActiveForDate: vi.fn().mockResolvedValue({ disposition: 'WORKING' }),
        list: vi.fn(),
        cancel: vi.fn(),
      },
    });
    const service = new ScheduleService(makeUow(repos), auth);
    const result = await service.resolveEffective(actor, CID, { asOf: '2026-03-01' }); // Sunday
    expect(result.classification.day).toBe('WORKING');
    expect(result.classification.reason).toBe('OVERRIDE');
  });
});
