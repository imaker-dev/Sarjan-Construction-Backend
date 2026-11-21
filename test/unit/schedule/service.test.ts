import { describe, expect, it, vi } from 'vitest';
import type {
  HolidayCalendar,
  HolidayCategory,
  WorkSchedule,
  WorkScheduleOverride,
} from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import {
  AmbiguousScheduleContextError,
  DuplicateOverrideError,
  HolidayCalendarInUseError,
  HolidayCategoryNotFoundError,
  InvalidScheduleStateError,
  LastActiveRevisionError,
  NoEffectiveScheduleError,
  ScheduleScopeShapeError,
  ScheduleRevisionNotFoundError,
  ScheduleTargetNotFoundError,
  ScheduleValidationError,
  WorkScheduleNotFoundError,
} from '../../../src/modules/schedule/errors.js';
import type {
  HolidayWithCategory,
  RevisionWithCalendar,
  ScheduleRepos,
  ScheduleUnitOfWork,
} from '../../../src/modules/schedule/repository.js';
import { ScheduleService } from '../../../src/modules/schedule/service.js';
import type { CreateWorkScheduleInput } from '../../../src/modules/schedule/types.js';

const CID = '00000000-0000-4000-8000-0000000000c1';
const DEPT = '00000000-0000-4000-8000-0000000000d1';
const SITE = '00000000-0000-4000-8000-0000000000e1';
const PROJ = '00000000-0000-4000-8000-0000000000e2';
const EMP = '00000000-0000-4000-8000-0000000000a1';
const CAL = '00000000-0000-4000-8000-0000000000f1';
const CAT = '00000000-0000-4000-8000-0000000000b1';
const SCHED = '00000000-0000-4000-8000-000000000051';

const actor: ActorContext = { actorId: 'u1', actorType: 'USER' };
const authorizer = { assertPermission: vi.fn().mockResolvedValue(undefined) };

const BASE_REVISION = {
  effectiveFrom: '2026-01-01',
  timezone: 'Asia/Kolkata',
  workingWeekdays: [1, 2, 3, 4, 5],
};

const BASE_INPUT: CreateWorkScheduleInput = {
  scopeType: 'COMPANY',
  name: 'Standard Week',
  effectiveFrom: '2026-01-01',
  revision: { ...BASE_REVISION },
};

const scheduleRow: WorkSchedule = {
  id: SCHED,
  companyId: CID,
  scopeType: 'COMPANY',
  departmentId: null,
  projectId: null,
  siteId: null,
  employeeId: null,
  name: 'Standard Week',
  description: null,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  status: 'ACTIVE',
  archivedAt: null,
  version: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const calendarRow: HolidayCalendar = {
  id: CAL,
  companyId: CID,
  code: 'std',
  name: 'Standard',
  description: null,
  status: 'ACTIVE',
  version: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const categoryRow: HolidayCategory = {
  id: CAT,
  companyId: CID,
  code: 'national',
  name: 'National',
  description: null,
  status: 'ACTIVE',
  version: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const holidayRow = (over: Record<string, unknown> = {}): HolidayWithCategory => ({
  id: 'hol-1',
  companyId: CID,
  calendarId: CAL,
  categoryId: CAT,
  category: categoryRow,
  date: new Date('2026-01-26T00:00:00Z'),
  name: 'Republic Day',
  status: 'ACTIVE',
  cancelledAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const overrideRow = (over: Record<string, unknown> = {}): WorkScheduleOverride => ({
  id: 'ovr-1',
  scheduleId: SCHED,
  companyId: CID,
  date: new Date('2026-03-17T00:00:00Z'),
  disposition: 'OFF',
  name: 'Plant shutdown',
  status: 'ACTIVE',
  cancelledAt: null,
  createdByPrincipalId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const revisionRow = (over: Record<string, unknown> = {}) =>
  ({
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
    status: 'ACTIVE',
    note: null,
    createdByPrincipalId: 'u1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }) as RevisionWithCalendar;

function makeRepos(overrides: Partial<ScheduleRepos> = {}): ScheduleRepos {
  return {
    schedules: {
      findById: vi.fn().mockResolvedValue(scheduleRow),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(async (_c: string, data: Record<string, unknown>) => ({
        ...scheduleRow,
        ...data,
      })),
      update: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => ({
        ...scheduleRow,
        version: 1,
        ...data,
      })),
      findAtScope: vi.fn().mockResolvedValue(null),
    },
    revisions: {
      create: vi.fn(async (_c: string, data: Record<string, unknown>) => revisionRow({ ...data })),
      findEffective: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      nextRevisionNumber: vi.fn().mockResolvedValue(2),
      countActive: vi.fn().mockResolvedValue(2),
      cancel: vi.fn(async () => revisionRow({ status: 'ARCHIVED' })),
      countReferencingCalendar: vi.fn().mockResolvedValue(0),
    },
    overrides: {
      create: vi.fn(async (_c: string, data: Record<string, unknown>) => ({
        id: 'ovr-1',
        scheduleId: SCHED,
        companyId: CID,
        status: 'ACTIVE',
        ...data,
      })),
      findById: vi.fn().mockResolvedValue(null),
      findActiveForDate: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      cancel: vi.fn(async () => ({ id: 'ovr-1', status: 'ARCHIVED' })),
    },
    calendars: {
      findById: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(async (_c: string, data: Record<string, unknown>) => ({
        id: CAL,
        companyId: CID,
        status: 'ACTIVE',
        version: 0,
        ...data,
      })),
      update: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => ({
        id: CAL,
        companyId: CID,
        status: 'ACTIVE',
        version: 1,
        ...data,
      })),
    },
    categories: {
      findById: vi.fn().mockResolvedValue(null),
      findByCode: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(async (_c: string, data: Record<string, unknown>) => ({
        id: CAT,
        companyId: CID,
        status: 'ACTIVE',
        version: 0,
        ...data,
      })),
      update: vi.fn(async () => ({ id: CAT, status: 'ARCHIVED' })),
    },
    holidays: {
      create: vi.fn(async (_c: string, data: Record<string, unknown>) => ({
        id: 'hol-1',
        companyId: CID,
        ...data,
      })),
      createMany: vi.fn().mockResolvedValue(2),
      findById: vi.fn().mockResolvedValue(null),
      cancel: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      activeDatesInRange: vi.fn().mockResolvedValue([]),
    },
    departments: {
      findById: vi.fn(async (_c: string, id: string) =>
        id === DEPT
          ? { id, status: 'ACTIVE', scopeType: 'SITE', projectId: PROJ, siteId: SITE }
          : null,
      ),
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

function makeUow(repos: ScheduleRepos): ScheduleUnitOfWork {
  return { run: async (fn) => fn(repos) };
}

function makeService(overrides: Partial<ScheduleRepos> = {}) {
  const repos = makeRepos(overrides);
  return { service: new ScheduleService(makeUow(repos), authorizer), repos };
}

// ---------------------------------------------------------------------------

describe('ScheduleService.createSchedule', () => {
  it('creates a schedule + revision 1 and audits both', async () => {
    const { service, repos } = makeService();
    const result = await service.createSchedule(actor, CID, BASE_INPUT);
    expect(repos.schedules.create).toHaveBeenCalledOnce();
    expect(repos.revisions.create).toHaveBeenCalledWith(
      CID,
      expect.objectContaining({ scheduleId: SCHED, revision: 1 }),
    );
    expect(result.revision.revision).toBe(1);
    expect(repos.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WORK_SCHEDULE_CREATED' }),
    );
  });

  it('rejects revision.effectiveFrom before schedule.effectiveFrom', async () => {
    const { service } = makeService();
    await expect(
      service.createSchedule(actor, CID, {
        ...BASE_INPUT,
        revision: { ...BASE_REVISION, effectiveFrom: '2025-12-31' },
      }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
  });

  it('rejects malformed scope shapes', async () => {
    const { service } = makeService();
    await expect(
      service.createSchedule(actor, CID, { ...BASE_INPUT, projectId: PROJ }),
    ).rejects.toBeInstanceOf(ScheduleScopeShapeError);
    await expect(
      service.createSchedule(actor, CID, { ...BASE_INPUT, scopeType: 'PROJECT' }),
    ).rejects.toBeInstanceOf(ScheduleScopeShapeError);
  });

  it('rejects unknown/archived scope targets', async () => {
    const { service } = makeService();
    await expect(
      service.createSchedule(actor, CID, {
        ...BASE_INPUT,
        scopeType: 'DEPARTMENT',
        departmentId: '00000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toBeInstanceOf(ScheduleTargetNotFoundError);
    const dept = await service
      .createSchedule(actor, CID, {
        ...BASE_INPUT,
        scopeType: 'DEPARTMENT',
        departmentId: DEPT,
      })
      .catch((e: unknown) => e);
    expect(dept).not.toBeInstanceOf(ScheduleTargetNotFoundError);
  });

  it('rejects a missing holiday calendar reference', async () => {
    const { service } = makeService();
    await expect(
      service.createSchedule(actor, CID, {
        ...BASE_INPUT,
        revision: { ...BASE_REVISION, holidayCalendarId: CAL },
      }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
  });

  it('accepts a pure-rotation revision (N-on/M-off cycle, empty weekdays)', async () => {
    const { service } = makeService();
    const result = await service.createSchedule(actor, CID, {
      ...BASE_INPUT,
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
    });
    expect(result.revision.revision).toBe(1);
  });
});

describe('ScheduleService revision validation', () => {
  const create = (rev: Record<string, unknown>) =>
    makeService().service.createSchedule(actor, CID, {
      ...BASE_INPUT,
      revision: { ...BASE_REVISION, ...rev },
    });

  it('rejects duplicate weekdays and out-of-range values', async () => {
    await expect(create({ workingWeekdays: [1, 1, 2, 3, 4] })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
    await expect(create({ workingWeekdays: [7] })).rejects.toBeInstanceOf(ScheduleValidationError);
  });

  it('rejects empty weekdays without rotation working offsets', async () => {
    await expect(create({ workingWeekdays: [] })).rejects.toBeInstanceOf(ScheduleValidationError);
  });

  it('rejects duplicate weekday entries in offNthWeekdays', async () => {
    await expect(
      create({
        offNthWeekdays: [
          { weekday: 6, nths: [2] },
          { weekday: 6, nths: [4] },
        ],
      }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
  });

  it('rejects duplicate nths and out-of-range nths', async () => {
    await expect(create({ offNthWeekdays: [{ weekday: 6, nths: [2, 2] }] })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
    await expect(create({ offNthWeekdays: [{ weekday: 6, nths: [0] }] })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
  });

  it('rejects rotation offsets outside the cycle, duplicates, and overlap', async () => {
    const rotation = (w: number[], o: number[]) => ({
      anchor: '2026-01-05',
      lengthDays: 14,
      workingOffsets: w,
      offOffsets: o,
    });
    await expect(create({ rotation: rotation([14], []) })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
    await expect(create({ rotation: rotation([1, 1], []) })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
    await expect(create({ rotation: rotation([3], [3]) })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
  });

  it('rejects an invalid timezone', async () => {
    await expect(create({ timezone: 'Not/AZone' })).rejects.toBeInstanceOf(ScheduleValidationError);
  });
});

describe('ScheduleService.addRevision / cancelRevision', () => {
  it('appends the next revision number and bumps identity version', async () => {
    const { service, repos } = makeService();
    const rev = await service.addRevision(actor, CID, SCHED, {
      ...BASE_REVISION,
      effectiveFrom: '2026-06-01',
      workingWeekdays: [1, 2, 3, 4, 5, 6],
      expectedVersion: 0,
    });
    expect(repos.revisions.create).toHaveBeenCalledWith(
      CID,
      expect.objectContaining({ revision: 2 }),
    );
    expect(repos.schedules.update).toHaveBeenCalledWith(CID, SCHED, {}, 0);
    expect(repos.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WORK_SCHEDULE_REVISION_ADDED' }),
    );
    expect(rev.revision).toBe(2);
  });

  it('refuses to cancel the sole active revision', async () => {
    const { service, repos } = makeService();
    vi.mocked(repos.revisions.findById).mockResolvedValue(revisionRow());
    vi.mocked(repos.revisions.countActive).mockResolvedValue(1);
    await expect(service.cancelRevision(actor, CID, SCHED, 'rev-1')).rejects.toBeInstanceOf(
      LastActiveRevisionError,
    );
  });

  it('cancels a non-sole revision and audits the transition', async () => {
    const { service, repos } = makeService();
    vi.mocked(repos.revisions.findById).mockResolvedValue(revisionRow());
    const cancelled = await service.cancelRevision(actor, CID, SCHED, 'rev-1');
    expect(cancelled.status).toBe('ARCHIVED');
    expect(repos.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WORK_SCHEDULE_REVISION_CANCELLED' }),
    );
  });

  it('rejects cancel on unknown/already-cancelled revisions', async () => {
    const { service, repos } = makeService();
    await expect(service.cancelRevision(actor, CID, SCHED, 'missing')).rejects.toBeInstanceOf(
      ScheduleRevisionNotFoundError,
    );
    vi.mocked(repos.revisions.findById).mockResolvedValue(revisionRow({ status: 'ARCHIVED' }));
    await expect(service.cancelRevision(actor, CID, SCHED, 'rev-1')).rejects.toBeInstanceOf(
      InvalidScheduleStateError,
    );
  });
});

describe('ScheduleService overrides', () => {
  it('adds an override and audits it', async () => {
    const { service, repos } = makeService();
    await service.addOverride(actor, CID, SCHED, {
      date: '2026-03-17',
      disposition: 'OFF',
      name: 'Plant shutdown',
    });
    expect(repos.overrides.create).toHaveBeenCalledWith(
      CID,
      expect.objectContaining({ scheduleId: SCHED, disposition: 'OFF' }),
    );
    expect(repos.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WORK_SCHEDULE_OVERRIDE_ADDED' }),
    );
  });

  it('rejects a duplicate active override on the same date', async () => {
    const { service, repos } = makeService();
    vi.mocked(repos.overrides.findActiveForDate).mockResolvedValue(overrideRow());
    await expect(
      service.addOverride(actor, CID, SCHED, { date: '2026-03-17', disposition: 'OFF' }),
    ).rejects.toBeInstanceOf(DuplicateOverrideError);
  });

  it('cancels an override with an audited transition', async () => {
    const { service, repos } = makeService();
    vi.mocked(repos.overrides.findById).mockResolvedValue(overrideRow());
    await service.cancelOverride(actor, CID, SCHED, 'ovr-1');
    expect(repos.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WORK_SCHEDULE_OVERRIDE_CANCELLED' }),
    );
  });
});

describe('ScheduleService.resolveEffective', () => {
  const atScope = (impl: (t: { scopeType: string; siteId?: string | null }) => object | null) =>
    (async (_c: string, t: { scopeType: string; siteId?: string | null }) =>
      impl(t)) as ScheduleRepos['schedules']['findAtScope'];

  const withEffective = (repos: ScheduleRepos) => {
    vi.mocked(repos.revisions.findEffective).mockImplementation(async (_c, scheduleId) =>
      revisionRow({ id: `rev-${scheduleId}` }),
    );
  };

  it('employee override wins over everything', async () => {
    const { service, repos } = makeService({
      schedules: {
        ...makeRepos().schedules,
        findAtScope: atScope((t) =>
          t.scopeType === 'EMPLOYEE' ? { id: 'emp-sched' } : { id: `${t.scopeType}-sched` },
        ),
      },
    });
    withEffective(repos);
    const result = await service.resolveEffective(actor, CID, { employeeId: EMP });
    expect(result.resolvedVia).toBe('EMPLOYEE');
    expect(result.revision.id).toBe('rev-emp-sched');
    expect(result.classification.day).toBeDefined();
  });

  it('resolves via the primary department membership', async () => {
    const repos = makeRepos();
    vi.mocked(repos.memberships.findActiveByEmployee).mockResolvedValue([
      { departmentId: '00000000-0000-4000-8000-0000000000d2', isPrimary: false },
      { departmentId: DEPT, isPrimary: true },
    ]);
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) => (t.scopeType === 'DEPARTMENT' ? { id: 'dept-sched' } : null)),
    );
    withEffective(repos);
    const service = new ScheduleService(makeUow(repos), authorizer);
    const result = await service.resolveEffective(actor, CID, { employeeId: EMP });
    expect(result.resolvedVia).toBe('DEPARTMENT');
  });

  it('a single non-primary membership is used deterministically', async () => {
    const repos = makeRepos();
    vi.mocked(repos.memberships.findActiveByEmployee).mockResolvedValue([
      { departmentId: DEPT, isPrimary: false },
    ]);
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) => (t.scopeType === 'DEPARTMENT' ? { id: 'dept-sched' } : null)),
    );
    withEffective(repos);
    const service = new ScheduleService(makeUow(repos), authorizer);
    const result = await service.resolveEffective(actor, CID, { employeeId: EMP });
    expect(result.resolvedVia).toBe('DEPARTMENT');
  });

  it('fails closed when multiple active memberships have no primary', async () => {
    const repos = makeRepos();
    vi.mocked(repos.memberships.findActiveByEmployee).mockResolvedValue([
      { departmentId: '00000000-0000-4000-8000-0000000000d2', isPrimary: false },
      { departmentId: DEPT, isPrimary: false },
    ]);
    const service = new ScheduleService(makeUow(repos), authorizer);
    await expect(service.resolveEffective(actor, CID, { employeeId: EMP })).rejects.toBeInstanceOf(
      AmbiguousScheduleContextError,
    );
  });

  it('department placement supplies site context for the SITE tier', async () => {
    const repos = makeRepos();
    vi.mocked(repos.memberships.findActiveByEmployee).mockResolvedValue([
      { departmentId: DEPT, isPrimary: true },
    ]);
    const seen: string[] = [];
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) => {
        seen.push(`${t.scopeType}:${t.siteId ?? ''}`);
        return t.scopeType === 'SITE' ? { id: 'site-sched' } : null;
      }),
    );
    withEffective(repos);
    const service = new ScheduleService(makeUow(repos), authorizer);
    const result = await service.resolveEffective(actor, CID, { employeeId: EMP });
    expect(result.resolvedVia).toBe('SITE');
    expect(seen).toContain(`SITE:${SITE}`);
  });

  it('falls back site -> project -> company', async () => {
    const repos = makeRepos();
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) => (t.scopeType === 'COMPANY' ? { id: 'company-sched' } : null)),
    );
    withEffective(repos);
    const service = new ScheduleService(makeUow(repos), authorizer);
    const result = await service.resolveEffective(actor, CID, { siteId: SITE, projectId: PROJ });
    expect(result.resolvedVia).toBe('COMPANY');
  });

  it('skips a schedule with no effective revision for asOf (tier fall-through)', async () => {
    const repos = makeRepos();
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) => ({ id: `${t.scopeType}-sched` })),
    );
    // Only the COMPANY schedule has an effective revision.
    vi.mocked(repos.revisions.findEffective).mockImplementation(async (_c, scheduleId) =>
      scheduleId === 'COMPANY-sched' ? revisionRow({ id: 'rev-company' }) : null,
    );
    const service = new ScheduleService(makeUow(repos), authorizer);
    const result = await service.resolveEffective(actor, CID, { employeeId: EMP });
    expect(result.resolvedVia).toBe('COMPANY');
  });

  it('historical asOf resolves the revision effective on that date', async () => {
    const repos = makeRepos();
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope(() => ({ id: 'company-sched' })),
    );
    vi.mocked(repos.revisions.findEffective).mockImplementation(async (_c, _id, asOf: Date) =>
      asOf < new Date('2026-06-01T00:00:00Z')
        ? revisionRow({ id: 'rev-old', revision: 1 })
        : revisionRow({ id: 'rev-new', revision: 2 }),
    );
    const service = new ScheduleService(makeUow(repos), authorizer);
    const past = await service.resolveEffective(actor, CID, { asOf: '2026-03-01' });
    expect(past.revision.id).toBe('rev-old');
    const now = await service.resolveEffective(actor, CID, { asOf: '2026-07-01' });
    expect(now.revision.id).toBe('rev-new');
  });

  it('throws when nothing matches', async () => {
    const { service } = makeService();
    await expect(service.resolveEffective(actor, CID, {})).rejects.toBeInstanceOf(
      NoEffectiveScheduleError,
    );
  });

  it('rejects an unknown employee', async () => {
    const { service } = makeService();
    await expect(
      service.resolveEffective(actor, CID, { employeeId: '00000000-0000-4000-8000-0000000000ff' }),
    ).rejects.toBeInstanceOf(ScheduleTargetNotFoundError);
  });

  it('passes the asOf date to membership resolution', async () => {
    const repos = makeRepos();
    const service = new ScheduleService(makeUow(repos), authorizer);
    await service
      .resolveEffective(actor, CID, { employeeId: EMP, asOf: '2026-04-10' })
      .catch(() => undefined);
    expect(repos.memberships.findActiveByEmployee).toHaveBeenCalledWith(
      CID,
      EMP,
      new Date('2026-04-10T00:00:00.000Z'),
    );
  });

  it('a department transfer resolves the membership effective on each date', async () => {
    const DEPT2 = '00000000-0000-4000-8000-0000000000d2';
    const repos = makeRepos();
    vi.mocked(repos.memberships.findActiveByEmployee).mockImplementation(
      async (_c, _e, asOf?: Date) =>
        asOf !== undefined && asOf < new Date('2026-06-01T00:00:00Z')
          ? [{ departmentId: DEPT, isPrimary: true }]
          : [{ departmentId: DEPT2, isPrimary: true }],
    );
    vi.mocked(repos.departments.findById).mockImplementation(async (_c, id) => ({
      id,
      status: 'ACTIVE',
      scopeType: 'SITE',
      projectId: PROJ,
      siteId: SITE,
    }));
    vi.mocked(repos.schedules.findAtScope).mockImplementation((async (
      _c: string,
      t: { scopeType: string; departmentId?: string },
    ) =>
      t.scopeType === 'DEPARTMENT'
        ? { id: `sched-${t.departmentId}` }
        : null) as ScheduleRepos['schedules']['findAtScope']);
    withEffective(repos);
    const service = new ScheduleService(makeUow(repos), authorizer);

    const before = await service.resolveEffective(actor, CID, {
      employeeId: EMP,
      asOf: '2026-05-15',
    });
    expect(before.resolvedVia).toBe('DEPARTMENT');
    expect(before.schedule.id).toBe(`sched-${DEPT}`);

    const after = await service.resolveEffective(actor, CID, {
      employeeId: EMP,
      asOf: '2026-07-15',
    });
    expect(after.resolvedVia).toBe('DEPARTMENT');
    expect(after.schedule.id).toBe(`sched-${DEPT2}`);
  });

  it('a future membership does not apply before its startedAt', async () => {
    const repos = makeRepos();
    // The only membership starts in July — an asOf in May sees none.
    vi.mocked(repos.memberships.findActiveByEmployee).mockImplementation(
      async (_c, _e, asOf?: Date) =>
        asOf !== undefined && asOf >= new Date('2026-07-01T00:00:00Z')
          ? [{ departmentId: DEPT, isPrimary: true }]
          : [],
    );
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) => (t.scopeType === 'COMPANY' ? { id: 'company-sched' } : null)),
    );
    withEffective(repos);
    const service = new ScheduleService(makeUow(repos), authorizer);
    const result = await service.resolveEffective(actor, CID, {
      employeeId: EMP,
      asOf: '2026-05-15',
    });
    expect(result.resolvedVia).toBe('COMPANY');
  });

  it('an ended membership still applies to dates inside its window', async () => {
    const repos = makeRepos();
    // Membership ended 2026-06-30: effective in March, not in August.
    vi.mocked(repos.memberships.findActiveByEmployee).mockImplementation(
      async (_c, _e, asOf?: Date) =>
        asOf !== undefined && asOf < new Date('2026-06-30T00:00:00Z')
          ? [{ departmentId: DEPT, isPrimary: true }]
          : [],
    );
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) =>
        t.scopeType === 'DEPARTMENT'
          ? { id: 'dept-sched' }
          : t.scopeType === 'COMPANY'
            ? { id: 'company-sched' }
            : null,
      ),
    );
    withEffective(repos);
    const service = new ScheduleService(makeUow(repos), authorizer);

    const past = await service.resolveEffective(actor, CID, {
      employeeId: EMP,
      asOf: '2026-03-15',
    });
    expect(past.resolvedVia).toBe('DEPARTMENT');

    const after = await service.resolveEffective(actor, CID, {
      employeeId: EMP,
      asOf: '2026-08-15',
    });
    expect(after.resolvedVia).toBe('COMPANY');
  });

  it('an omitted asOf classifies on the schedule-timezone local date', async () => {
    const repos = makeRepos();
    vi.mocked(repos.schedules.findAtScope).mockImplementation(
      atScope((t) => (t.scopeType === 'COMPANY' ? { id: 'company-sched' } : null)),
    );
    // UTC+13 in March: 15:00Z on Mar 10 is already Mar 11 in Auckland.
    vi.mocked(repos.revisions.findEffective).mockImplementation(async () =>
      revisionRow({ timezone: 'Pacific/Auckland' }),
    );
    const service = new ScheduleService(makeUow(repos), authorizer);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-10T15:00:00Z'));
      const result = await service.resolveEffective(actor, CID, {});
      expect(result.resolvedVia).toBe('COMPANY');
      // The override lookup receives the work date — Auckland Mar 11, not
      // the UTC date Mar 10.
      expect(repos.overrides.findActiveForDate).toHaveBeenCalledWith(
        CID,
        'company-sched',
        new Date('2026-03-11T00:00:00Z'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ScheduleService.updateSchedule', () => {
  it('applies identity-level updates with version precondition', async () => {
    const repos = makeRepos();
    const service = new ScheduleService(makeUow(repos), authorizer);
    await service.updateSchedule(actor, CID, SCHED, {
      name: 'New Name',
      expectedVersion: 0,
    });
    expect(repos.schedules.update).toHaveBeenCalledWith(
      CID,
      SCHED,
      expect.objectContaining({ name: 'New Name' }),
      0,
    );
  });

  it('rejects any change to effectiveFrom (retroactive coverage change)', async () => {
    const repos = makeRepos();
    const service = new ScheduleService(makeUow(repos), authorizer);
    await expect(
      service.updateSchedule(actor, CID, SCHED, {
        effectiveFrom: '2026-02-01',
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
    await expect(
      service.updateSchedule(actor, CID, SCHED, {
        effectiveFrom: '2025-06-01', // earlier is still a retroactive change
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
    // Same value is a no-op and allowed.
    await service.updateSchedule(actor, CID, SCHED, {
      effectiveFrom: '2026-01-01',
      expectedVersion: 0,
    });
  });

  it('rejects a past effectiveTo (would reclassify already-past days)', async () => {
    const repos = makeRepos();
    const service = new ScheduleService(makeUow(repos), authorizer);
    await expect(
      service.updateSchedule(actor, CID, SCHED, {
        effectiveTo: '2020-01-01',
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
  });

  it('archive stamps archivedAt so past dates still resolve', async () => {
    const repos = makeRepos();
    const service = new ScheduleService(makeUow(repos), authorizer);
    await service.archiveSchedule(actor, CID, SCHED, 0);
    expect(repos.schedules.update).toHaveBeenCalledWith(
      CID,
      SCHED,
      expect.objectContaining({ status: 'ARCHIVED' }),
      0,
    );
    const updateData = vi.mocked(repos.schedules.update).mock.calls[0]?.[2] as
      Record<string, unknown> | undefined;
    expect(updateData?.archivedAt).toBeInstanceOf(Date);
  });

  it('rejects updates on archived schedules and unknown ids', async () => {
    const repos = makeRepos();
    vi.mocked(repos.schedules.findById)
      .mockResolvedValueOnce({ ...scheduleRow, status: 'ARCHIVED' })
      .mockResolvedValueOnce(null);
    const service = new ScheduleService(makeUow(repos), authorizer);
    await expect(
      service.updateSchedule(actor, CID, SCHED, { name: 'x', expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(InvalidScheduleStateError);
    await expect(
      service.updateSchedule(actor, CID, 'missing', { name: 'x', expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(WorkScheduleNotFoundError);
  });
});

describe('ScheduleService calendars / categories / holidays', () => {
  it('blocks archiving a calendar referenced by live revisions', async () => {
    const repos = makeRepos();
    vi.mocked(repos.calendars.findById).mockResolvedValue(calendarRow);
    vi.mocked(repos.revisions.countReferencingCalendar).mockResolvedValue(2);
    const service = new ScheduleService(makeUow(repos), authorizer);
    await expect(service.archiveCalendar(actor, CID, CAL, 0)).rejects.toBeInstanceOf(
      HolidayCalendarInUseError,
    );
  });

  it('creates an administrator-defined holiday category', async () => {
    const { service, repos } = makeService();
    await service.createCategory(actor, CID, { code: 'regional', name: 'Regional' });
    expect(repos.categories.create).toHaveBeenCalledWith(
      CID,
      expect.objectContaining({ name: 'Regional' }),
    );
    expect(repos.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'HOLIDAY_CATEGORY_CREATED' }),
    );
  });

  it('requires an ACTIVE category when adding a holiday', async () => {
    const repos = makeRepos();
    vi.mocked(repos.calendars.findById).mockResolvedValue(calendarRow);
    const service = new ScheduleService(makeUow(repos), authorizer);
    await expect(
      service.addHoliday(actor, CID, CAL, {
        date: '2026-01-26',
        name: 'Republic Day',
        categoryId: CAT,
      }),
    ).rejects.toBeInstanceOf(HolidayCategoryNotFoundError);
  });

  it('cancels (not deletes) a holiday and audits HOLIDAY_CANCELLED', async () => {
    const repos = makeRepos();
    vi.mocked(repos.calendars.findById).mockResolvedValue(calendarRow);
    vi.mocked(repos.holidays.findById).mockResolvedValue(holidayRow());
    const service = new ScheduleService(makeUow(repos), authorizer);
    await service.cancelHoliday(actor, CID, CAL, 'hol-1');
    expect(repos.holidays.cancel).toHaveBeenCalledWith(CID, 'hol-1');
    expect(repos.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'HOLIDAY_CANCELLED' }),
    );
  });

  it('rejects re-cancelling an already cancelled holiday', async () => {
    const repos = makeRepos();
    vi.mocked(repos.calendars.findById).mockResolvedValue(calendarRow);
    vi.mocked(repos.holidays.findById).mockResolvedValue(holidayRow({ status: 'ARCHIVED' }));
    const service = new ScheduleService(makeUow(repos), authorizer);
    await expect(service.cancelHoliday(actor, CID, CAL, 'hol-1')).rejects.toBeInstanceOf(
      InvalidScheduleStateError,
    );
  });
});
