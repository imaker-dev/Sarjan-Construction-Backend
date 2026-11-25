import { describe, expect, it, vi } from 'vitest';
import type { AttendanceSession, Site } from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import {
  BreakModeConflictError,
  NoActiveSessionError,
} from '../../../src/modules/attendance/errors.js';
import type {
  AttendanceRepos,
  AttendanceUnitOfWork,
} from '../../../src/modules/attendance/repository.js';
import { AttendanceService } from '../../../src/modules/attendance/service.js';
import {
  assertBreakModeConsistent,
  type PolicySnapshot,
  type ResolvedIntraday,
} from '../../../src/modules/attendance/types.js';

const companyId = 'c1';
const actor: ActorContext = { actorId: 'u1', actorType: 'USER' };
const authorizer = { assertPermission: vi.fn().mockResolvedValue(undefined) };
const MIN = 60_000;

function createMockUow(repos: Partial<AttendanceRepos>): AttendanceUnitOfWork {
  const dailyReports = repos.dailyReports ?? {
    findBySiteAndDate: vi.fn().mockResolvedValue(null),
  };
  const memberships = repos.memberships ?? {
    hasActiveAtHeadOffice: vi.fn().mockResolvedValue(false),
    hasActiveAtSite: vi.fn().mockResolvedValue(true),
  };
  return {
    run: async <T>(fn: (r: AttendanceRepos) => Promise<T>): Promise<T> =>
      fn({ dailyReports, memberships, ...repos } as AttendanceRepos),
  };
}

const sampleSite = {
  id: 's1',
  companyId,
  projectId: 'p1',
  code: 'SITE-1',
  name: 'Site 1',
  geoLatitude: 23.23 as unknown as never,
  geoLongitude: 72.57 as unknown as never,
  geoFenceRadiusM: 100,
  timezone: 'Asia/Kolkata',
  project: { timezone: 'Asia/Kolkata' },
} as unknown as Site & { project: { timezone: string } };

const intraday = (over: Partial<ResolvedIntraday> = {}): ResolvedIntraday => ({
  scheduledStartMins: 480,
  scheduledEndMins: 1020,
  graceInMins: 5,
  graceOutMins: 5,
  breakWindowMode: 'FIXED_WINDOW',
  breakWindowStartMins: 780,
  breakWindowEndMins: 840,
  breakDurationMins: 60,
  autoClockOutMode: 'AT_SCHEDULED_END',
  autoClockOutGraceMins: null,
  ...over,
});

const snapshot = (over: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  shiftDurationMins: 480,
  halfDayThresholdMins: 240,
  fullDayThresholdMins: 480,
  policyBreakMode: 'FIXED',
  fixedBreakMins: 60,
  minWorkForBreakMins: 0,
  maxDynamicBreakMins: 120,
  overtimeMode: 'HOURLY',
  minOvertimeMins: 30,
  otSlabMins: 60,
  dayStartHour: 8,
  dayStartMinute: 0,
  timezone: 'Asia/Kolkata',
  intraday: null,
  scheduleRevisionId: null,
  ...over,
});

describe('break-mode ownership — fail closed on contradiction', () => {
  it('accepts agreeing pairs', () => {
    expect(() => {
      assertBreakModeConsistent('FIXED', intraday({ breakWindowMode: 'FIXED_WINDOW' }));
    }).not.toThrow();
    expect(() => {
      assertBreakModeConsistent('DYNAMIC', intraday({ breakWindowMode: 'DYNAMIC' }));
    }).not.toThrow();
  });

  it('rejects FIXED policy + DYNAMIC schedule window', () => {
    expect(() => {
      assertBreakModeConsistent('FIXED', intraday({ breakWindowMode: 'DYNAMIC' }));
    }).toThrow(BreakModeConflictError);
  });

  it('rejects DYNAMIC policy + FIXED_WINDOW schedule', () => {
    expect(() => {
      assertBreakModeConsistent('DYNAMIC', intraday({ breakWindowMode: 'FIXED_WINDOW' }));
    }).toThrow(BreakModeConflictError);
  });

  it('no schedule break mode → policy governs alone (legacy)', () => {
    expect(() => {
      assertBreakModeConsistent('FIXED', intraday({ breakWindowMode: null }));
    }).not.toThrow();
    expect(() => {
      assertBreakModeConsistent('DYNAMIC', null);
    }).not.toThrow();
  });

  it('punch-in fails closed when resolved policy and schedule disagree', async () => {
    const revision = {
      id: 'rev-1',
      timezone: 'Asia/Kolkata',
      scheduledStartMins: 480,
      scheduledEndMins: 1020,
      graceInMins: 5,
      graceOutMins: 5,
      breakWindowMode: 'DYNAMIC', // schedule says dynamic…
      breakWindowStartMins: 720,
      breakWindowEndMins: 900,
      breakDurationMins: 60,
      autoClockOutMode: 'AT_SCHEDULED_END',
      autoClockOutGraceMins: null,
    };
    const scheduleResolver = {
      resolveForEmployee: vi.fn().mockResolvedValue({ revision }),
    };
    const mockRepos: Partial<AttendanceRepos> = {
      employees: {
        findByPrincipal: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
        findById: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
      },
      sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
      sessions: {
        findActive: vi.fn().mockResolvedValue(null),
      } as unknown as AttendanceRepos['sessions'],
      policies: {
        findEffective: vi.fn().mockResolvedValue({
          id: 'pol-1',
          allowMobilePunch: true,
          geofenceStrict: true,
          breakMode: 'FIXED', // …but the policy says fixed — contradictory
        }),
      } as unknown as AttendanceRepos['policies'],
      audit: { record: vi.fn().mockResolvedValue(undefined) },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer, {
      scheduleResolver,
    });
    await expect(
      service.punchIn(actor, companyId, {
        siteId: 's1',
        latitude: 23.23,
        longitude: 72.57,
        source: 'MOBILE_SELF',
      }),
    ).rejects.toThrow(BreakModeConflictError);
  });
});

describe('punch-out after system auto-close (audited correction)', () => {
  const autoClosed = {
    id: 'sess-ac',
    companyId,
    employeeId: 'e1',
    siteId: 's1',
    headOfficeId: null,
    status: 'AUTO_CLOSED' as const,
    autoClosedBy: 'SCHEDULED_END',
    punchInAt: new Date(Date.now() - 9 * 60 * MIN),
    punchOutAt: new Date(Date.now() - 30 * MIN), // system-generated close instant
    punchOutRemarks: 'System auto clock-out at scheduled end',
    flagReason: 'Auto-closed at scheduled shift end',
    isFlagged: true,
  } as unknown as AttendanceSession;

  it('keeps the system close, appends correction, writes audit', async () => {
    const updates: Record<string, unknown>[] = [];
    const audits: { action?: string }[] = [];
    const mockRepos: Partial<AttendanceRepos> = {
      employees: {
        findByPrincipal: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
        findById: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
      },
      sessions: {
        findActive: vi.fn().mockResolvedValue(null),
        findById: vi.fn().mockResolvedValue(null),
        findLatestAutoClosed: vi.fn().mockResolvedValue(autoClosed),
        update: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => {
          updates.push(data);
          return { ...autoClosed, ...data };
        }),
      } as unknown as AttendanceRepos['sessions'],
      audit: {
        record: vi.fn(async (e: { action?: string }) => {
          audits.push(e);
        }),
      },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    const result = await service.punchOut(actor, companyId, {
      employeeId: 'e1',
      latitude: 23.23,
      longitude: 72.57,
      remarks: 'actually left at 19:20',
    });

    expect(result.status).toBe('AUTO_CLOSED');
    // The system punchOutAt is never overwritten.
    expect(updates[0]).not.toHaveProperty('punchOutAt');
    expect(updates[0]).not.toHaveProperty('status');
    expect(updates[0]?.flagReason as string).toContain('PUNCH_OUT_AFTER_AUTO_CLOSE');
    expect(updates[0]?.punchOutRemarks as string).toContain('PUNCH_OUT_AFTER_AUTO_CLOSE');
    expect(audits[0]?.action).toBe('ATTENDANCE_PUNCH_OUT_AFTER_AUTO_CLOSE');
  });

  it('a COMPLETED session still rejects a second punch-out', async () => {
    const mockRepos: Partial<AttendanceRepos> = {
      employees: {
        findByPrincipal: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
        findById: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
      },
      sessions: {
        findActive: vi.fn().mockResolvedValue(null),
        findById: vi.fn().mockResolvedValue({ ...autoClosed, status: 'COMPLETED' }),
        findLatestAutoClosed: vi.fn().mockResolvedValue(null),
      } as unknown as AttendanceRepos['sessions'],
      audit: { record: vi.fn() },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    await expect(
      service.punchOut(actor, companyId, {
        employeeId: 'e1',
        latitude: 23.23,
        longitude: 72.57,
      }),
    ).rejects.toThrow(NoActiveSessionError);
  });
});

describe('scheduled-end auto close (worker entrypoint)', () => {
  const dueSession = (over: Record<string, unknown> = {}) => ({
    id: 'sess-due',
    companyId,
    employeeId: 'e1',
    siteId: 's1',
    autoClockOutMode: 'AT_SCHEDULED_END',
    autoClockOutGraceMins: null,
    scheduledEndAt: new Date(Date.now() - 5 * MIN),
    punchInAt: new Date(Date.now() - 9 * 60 * MIN),
    breaks: [],
    policySnapshot: null,
    flagReason: null,
    ...over,
  });

  it('closes a due session at exactly its pinned scheduled end', async () => {
    const closeCalls: Record<string, unknown>[] = [];
    const audits: { action?: string }[] = [];
    const end = new Date(Date.now() - 5 * MIN);
    const mockRepos: Partial<AttendanceRepos> = {
      sessions: {
        findDueForScheduledClose: vi.fn().mockResolvedValue([dueSession({ scheduledEndAt: end })]),
        autoCloseSession: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => {
          closeCalls.push(data);
          return { ...dueSession(), ...data };
        }),
      } as unknown as AttendanceRepos['sessions'],
      breaks: { update: vi.fn() } as unknown as AttendanceRepos['breaks'],
      audit: {
        record: vi.fn(async (e: { action?: string }) => {
          audits.push(e);
        }),
      },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    const res = await service.closeSessionsAtScheduledEnd(companyId);

    expect(res.closed).toBe(1);
    expect(closeCalls[0]?.status).toBe('AUTO_CLOSED');
    expect(closeCalls[0]?.autoClosedBy).toBe('SCHEDULED_END');
    expect((closeCalls[0]?.punchOutAt as Date).getTime()).toBe(end.getTime());
    expect(audits[0]?.action).toBe('ATTENDANCE_AUTO_CLOCK_OUT');
  });

  it('a lost race (already closed) counts zero — concurrent runs stay idempotent', async () => {
    const mockRepos: Partial<AttendanceRepos> = {
      sessions: {
        findDueForScheduledClose: vi.fn().mockResolvedValue([dueSession()]),
        autoCloseSession: vi.fn().mockResolvedValue(null), // another run won
      } as unknown as AttendanceRepos['sessions'],
      breaks: { update: vi.fn() } as unknown as AttendanceRepos['breaks'],
      audit: { record: vi.fn() },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    const res = await service.closeSessionsAtScheduledEnd(companyId);
    expect(res.closed).toBe(0);
  });

  it('AFTER_GRACE waits for the grace, then closes at end + grace', async () => {
    const end = new Date(Date.now() - 20 * MIN);
    const graceSession = dueSession({
      autoClockOutMode: 'AFTER_GRACE',
      autoClockOutGraceMins: 15, // 15m grace ended 5m ago
      scheduledEndAt: end,
    });
    const notYet = dueSession({
      id: 'sess-grace-pending',
      autoClockOutMode: 'AFTER_GRACE',
      autoClockOutGraceMins: 60,
      scheduledEndAt: new Date(Date.now() - 5 * MIN),
    });
    const closeCalls: Record<string, unknown>[] = [];
    const mockRepos: Partial<AttendanceRepos> = {
      sessions: {
        findDueForScheduledClose: vi.fn().mockResolvedValue([graceSession, notYet]),
        autoCloseSession: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => {
          closeCalls.push(data);
          return { ...graceSession, ...data };
        }),
      } as unknown as AttendanceRepos['sessions'],
      breaks: { update: vi.fn() } as unknown as AttendanceRepos['breaks'],
      audit: { record: vi.fn() },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    const res = await service.closeSessionsAtScheduledEnd(companyId);

    expect(res.closed).toBe(1);
    expect((closeCalls[0]?.punchOutAt as Date).getTime()).toBe(end.getTime() + 15 * MIN);
  });

  it('an open dynamic break is closed at the same instant as the session', async () => {
    const end = new Date(Date.now() - 5 * MIN);
    const breakUpdates: Record<string, unknown>[] = [];
    const mockRepos: Partial<AttendanceRepos> = {
      sessions: {
        findDueForScheduledClose: vi.fn().mockResolvedValue([
          dueSession({
            scheduledEndAt: end,
            breaks: [{ id: 'b1', endedAt: null, startedAt: new Date(Date.now() - 60 * MIN) }],
          }),
        ]),
        autoCloseSession: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => ({
          ...dueSession(),
          ...data,
        })),
      } as unknown as AttendanceRepos['sessions'],
      breaks: {
        update: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => {
          breakUpdates.push(data);
        }),
      } as unknown as AttendanceRepos['breaks'],
      audit: { record: vi.fn() },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    await service.closeSessionsAtScheduledEnd(companyId);
    expect((breakUpdates[0]?.endedAt as Date).getTime()).toBe(end.getTime());
  });
});

describe('EOD settlement — pinned scheduled end is authoritative', () => {
  const mkService = (sessions: Record<string, unknown>, stale: Record<string, unknown>[]) => {
    const updates: { id: string; data: Record<string, unknown> }[] = [];
    const mockRepos: Partial<AttendanceRepos> = {
      dailyReports: {
        findBySiteAndDate: vi.fn().mockResolvedValue(null),
        getActiveSitesForSettlement: vi
          .fn()
          .mockResolvedValue([{ id: 's1', companyId, projectId: 'p1' }]),
        upsert: vi.fn(async (_c: string, data: unknown) => ({ id: 'dsr-1', ...(data as object) })),
        addAuditLog: vi.fn().mockResolvedValue(undefined),
      } as unknown as AttendanceRepos['dailyReports'],
      sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
      sessions: {
        getDailySummary: vi.fn().mockResolvedValue(sessions),
        findOpenBeforeBusinessDate: vi.fn().mockResolvedValue(stale),
        update: vi.fn(async (_c: string, id: string, data: Record<string, unknown>) => {
          updates.push({ id, data });
          return { id, ...data };
        }),
      } as unknown as AttendanceRepos['sessions'],
      audit: { record: vi.fn() },
    };
    return { service: new AttendanceService(createMockUow(mockRepos), authorizer), updates };
  };

  const emp = { id: 'e1', employeeCode: 'E1', displayName: 'W', tradeCategory: 'MASON' };
  const summaryFor = (rows: Record<string, unknown>[]) => ({
    siteId: 's1',
    businessDate: '',
    totalWorkers: rows.length,
    totalSessions: rows.length,
    completedSessions: 0,
    inProgressSessions: rows.length,
    autoClosedSessions: 0,
    totalPresentUnits: 0,
    totalOvertimePUnits: 0,
    totalTotalPUnits: 0,
    totalOvertimeHours: 0,
    sessions: rows,
  });

  it('same-day session closes only once its scheduled end has arrived', async () => {
    const past = new Date(Date.now() - 10 * MIN);
    const future = new Date(Date.now() + 2 * 60 * MIN);
    const { service, updates } = mkService(
      summaryFor([
        {
          id: 'due-today',
          status: 'IN_PROGRESS',
          businessDate: '9999-01-01',
          scheduledEndAt: past,
          autoClockOutMode: 'AT_SCHEDULED_END',
          autoClockOutGraceMins: null,
          employee: emp,
          presentUnits: 0,
          overtimeHours: 0,
          isFlagged: false,
        },
        {
          id: 'not-due-today',
          status: 'IN_PROGRESS',
          businessDate: '9999-01-01',
          scheduledEndAt: future,
          autoClockOutMode: 'AT_SCHEDULED_END',
          autoClockOutGraceMins: null,
          employee: emp,
          presentUnits: 0,
          overtimeHours: 0,
          isFlagged: false,
        },
        {
          id: 'unscheduled-today',
          status: 'IN_PROGRESS',
          businessDate: '9999-01-01',
          scheduledEndAt: null,
          autoClockOutMode: null,
          autoClockOutGraceMins: null,
          employee: emp,
          presentUnits: 0,
          overtimeHours: 0,
          isFlagged: false,
        },
      ]),
      [],
    );
    await service.settleAllActiveSites(companyId);
    // businessDate '9999-01-01' > any current business date → only the
    // scheduled-end row may close; the others keep working.
    const closedIds = updates.map((u) => u.id);
    expect(closedIds).toContain('due-today');
    expect(closedIds).not.toContain('not-due-today');
    expect(closedIds).not.toContain('unscheduled-today');
    expect(updates.find((u) => u.id === 'due-today')?.data.autoClosedBy).toBe('EOD_SETTLEMENT');
  });

  it('overnight strays: a pinned end after the day boundary is never closed early', async () => {
    const past = new Date(Date.now() - 10 * MIN);
    const future = new Date(Date.now() + 90 * MIN);
    const { service, updates } = mkService(summaryFor([]), [
      // Overnight shift punched yesterday, still inside its scheduled window
      // (e.g. 20:00→10:00 — business date rolled over but the shift has not).
      {
        id: 'overnight-running',
        scheduledEndAt: future,
        autoClockOutMode: 'AT_SCHEDULED_END',
        autoClockOutGraceMins: null,
      },
      {
        id: 'overnight-due',
        scheduledEndAt: past,
        autoClockOutMode: 'AT_SCHEDULED_END',
        autoClockOutGraceMins: null,
      },
      {
        id: 'unscheduled-stray',
        scheduledEndAt: null,
        autoClockOutMode: null,
        autoClockOutGraceMins: null,
      },
      {
        id: 'disabled-future',
        scheduledEndAt: future,
        autoClockOutMode: 'DISABLED',
        autoClockOutGraceMins: null,
      },
      {
        id: 'grace-running',
        scheduledEndAt: past,
        autoClockOutMode: 'AFTER_GRACE',
        autoClockOutGraceMins: 120, // end passed but grace has not
      },
    ]);
    await service.settleAllActiveSites(companyId);
    const closedIds = updates.map((u) => u.id);
    expect(closedIds).toEqual(expect.arrayContaining(['overnight-due', 'unscheduled-stray']));
    expect(closedIds).not.toContain('overnight-running');
    expect(closedIds).not.toContain('disabled-future');
    expect(closedIds).not.toContain('grace-running');
  });
});

describe('snapshot pinning — later config changes never reclassify a session', () => {
  it('punch-out uses the pinned snapshot and never touches the live policy', async () => {
    const now = Date.now();
    const session = {
      id: 'sess-snap',
      companyId,
      employeeId: 'e1',
      siteId: 's1',
      headOfficeId: null,
      policyId: 'pol-1',
      status: 'IN_PROGRESS' as const,
      autoClosedBy: null,
      punchInAt: new Date(now - 9 * 60 * MIN), // 540 gross minutes
      punchInRemarks: null,
      flagReason: null,
      isFlagged: false,
      policySnapshot: snapshot({
        policyBreakMode: 'FIXED',
        fixedBreakMins: 60,
        minWorkForBreakMins: 0,
      }),
      scheduledEndAt: new Date(now + 2 * 60 * MIN),
    } as unknown as AttendanceSession;

    const policiesFindById = vi.fn();
    const updates: Record<string, unknown>[] = [];
    const mockRepos: Partial<AttendanceRepos> = {
      employees: {
        findByPrincipal: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
        findById: vi
          .fn()
          .mockResolvedValue({ id: 'e1', companyId, displayName: 'W', status: 'ACTIVE' }),
      },
      sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
      sessions: {
        findActive: vi.fn().mockResolvedValue(session),
        findById: vi.fn().mockResolvedValue(null),
        update: vi.fn(async (_c: string, _id: string, data: Record<string, unknown>) => {
          updates.push(data);
          return { ...session, ...data };
        }),
      } as unknown as AttendanceRepos['sessions'],
      breaks: {
        findActive: vi.fn().mockResolvedValue(null),
        listForSession: vi.fn().mockResolvedValue([]),
      } as unknown as AttendanceRepos['breaks'],
      policies: { findById: policiesFindById } as unknown as AttendanceRepos['policies'],
      audit: { record: vi.fn() },
    };
    const service = new AttendanceService(createMockUow(mockRepos), authorizer, {
      scheduleResolver: {
        resolveForEmployee: vi.fn().mockResolvedValue(null), // membership moved
      },
    });
    await service.punchOut(actor, companyId, {
      employeeId: 'e1',
      latitude: 23.23,
      longitude: 72.57,
    });

    expect(policiesFindById).not.toHaveBeenCalled();
    // 540 gross − 60 pinned fixed break = 480 net → 1.0P.
    expect(updates[0]?.netDurationMins).toBe(480);
    expect(updates[0]?.status).toBe('COMPLETED');
  });
});
