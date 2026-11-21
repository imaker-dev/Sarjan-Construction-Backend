import { describe, expect, it, vi } from 'vitest';
import type { AttendanceSession, Site } from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import {
  ActiveSessionExistsError,
  AttendanceValidationError,
  BreakAlreadyActiveError,
  GeofenceBreachError,
  InvalidDateRangeError,
  NoActiveBreakError,
  NoActiveSessionError,
  TvtSafetyBriefingRequiredError,
} from '../../../src/modules/attendance/errors.js';
import type {
  AttendanceRepos,
  AttendanceUnitOfWork,
} from '../../../src/modules/attendance/repository.js';
import { AttendanceService } from '../../../src/modules/attendance/service.js';

function createMockUow(repos: Partial<AttendanceRepos>): AttendanceUnitOfWork {
  const dailyReports = repos.dailyReports ?? {
    findBySiteAndDate: vi.fn().mockResolvedValue(null),
  };
  return {
    run: async <T>(fn: (r: AttendanceRepos) => Promise<T>): Promise<T> => {
      return fn({ dailyReports, ...repos } as AttendanceRepos);
    },
  };
}

describe('AttendanceService', () => {
  const actor: ActorContext = { actorId: 'u1', actorType: 'USER' };
  const companyId = 'c1';
  const authorizer = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
  };

  const sampleSite = {
    id: 's1',
    companyId,
    projectId: 'p1',
    code: 'SITE-1',
    name: 'Sector 150 Hub',
    geoLatitude: 23.23 as unknown as never,
    geoLongitude: 72.57 as unknown as never,
    geoFenceRadiusM: 100,
    timezone: 'Asia/Kolkata',
    project: { timezone: 'Asia/Kolkata' },
  } as unknown as Site & { project: { timezone: string } };

  const sampleEmployee = {
    id: 'e1',
    companyId,
    displayName: 'Ramesh Patel',
    status: 'ACTIVE',
  };

  it('creates an attendance policy with custom thresholds', async () => {
    let recordedAudit = false;
    const mockRepos: Partial<AttendanceRepos> = {
      policies: {
        create: vi.fn().mockResolvedValue({
          id: 'pol-1',
          companyId,
          scope: 'COMPANY',
          name: 'Sarjan Standard Policy',
          shiftDurationMins: 480,
          status: 'ACTIVE',
        }),
      } as unknown as AttendanceRepos['policies'],
      audit: {
        record: vi.fn().mockImplementation(async () => {
          recordedAudit = true;
        }),
      },
    };

    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    const policy = await service.createPolicy(actor, companyId, {
      name: 'Sarjan Standard Policy',
      shiftDurationMins: 480,
      overtimeMode: 'P_MULTIPLIER',
      pMultiplierSlabs: [
        { minExtraMins: 120, pUnit: 0.5 },
        { minExtraMins: 240, pUnit: 1.0 },
      ],
    });

    expect(policy.name).toBe('Sarjan Standard Policy');
    expect(recordedAudit).toBe(true);
  });

  describe('4-Tier Policy Resolution Hierarchy', () => {
    it('resolves employee override if available (Tier 1)', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sites: {
          findById: vi.fn().mockResolvedValue(sampleSite),
        },
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-emp',
            name: 'Special Worker Policy',
            scope: 'EMPLOYEE',
          }),
        } as unknown as AttendanceRepos['policies'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.resolveEffectivePolicy(actor, companyId, {
        employeeId: 'e1',
        siteId: 's1',
      });
      expect(res.name).toBe('Special Worker Policy');
      expect(res.scope).toBe('EMPLOYEE');
    });

    it('falls back to default fallback policy when no DB policies exist (Tier 5)', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sites: {
          findById: vi.fn().mockResolvedValue(sampleSite),
        },
        policies: {
          findEffective: vi.fn().mockResolvedValue(null),
        } as unknown as AttendanceRepos['policies'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.resolveEffectivePolicy(actor, companyId, { siteId: 's1' });
      expect(res.name).toBe('Default Construction Policy');
      expect(res.dayStartHour).toBe(8);
      expect(res.shiftDurationMins).toBe(480);
    });
  });

  describe('Punch In & Geofencing', () => {
    it('successfully punches in when within site geofence', async () => {
      let createdSession: unknown = null;
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          findById: vi.fn().mockResolvedValue(sampleEmployee),
        },
        sites: {
          findById: vi.fn().mockResolvedValue(sampleSite),
        },
        sessions: {
          findActive: vi.fn().mockResolvedValue(null), // No active session
          create: vi.fn().mockImplementation(async (_, data) => {
            createdSession = { id: 'sess-1', ...data };
            return createdSession as AttendanceSession;
          }),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-1',
            dayStartHour: 8,
            dayStartMinute: 0,
            allowMobilePunch: true,
            geofenceStrict: true,
          }),
        } as unknown as AttendanceRepos['policies'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const session = await service.punchIn(actor, companyId, {
        siteId: 's1',
        latitude: 23.23, // exact site lat
        longitude: 72.57, // exact site lng
        source: 'MOBILE_SELF',
      });

      expect(session.id).toBe('sess-1');
      expect(createdSession).toBeDefined();
    });

    it('throws GeofenceBreachError when outside radius and geofenceStrict is true', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          findById: vi.fn().mockResolvedValue(sampleEmployee),
        },
        sites: {
          findById: vi.fn().mockResolvedValue(sampleSite),
        },
        sessions: {
          findActive: vi.fn().mockResolvedValue(null),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-1',
            allowMobilePunch: true,
            geofenceStrict: true, // STRICT
          }),
        } as unknown as AttendanceRepos['policies'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      // Coordinates ~1.1km away from site
      await expect(
        service.punchIn(actor, companyId, {
          siteId: 's1',
          latitude: 23.24, // ~1.1km away
          longitude: 72.57,
          source: 'MOBILE_SELF',
        }),
      ).rejects.toThrow(GeofenceBreachError);
    });

    it('throws ActiveSessionExistsError when user already has an IN_PROGRESS session', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          findById: vi.fn().mockResolvedValue(sampleEmployee),
        },
        sites: {
          findById: vi.fn().mockResolvedValue(sampleSite),
        },
        sessions: {
          findActive: vi.fn().mockResolvedValue({
            id: 'existing-sess-1',
            status: 'IN_PROGRESS',
          }),
        } as unknown as AttendanceRepos['sessions'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      await expect(
        service.punchIn(actor, companyId, {
          siteId: 's1',
          latitude: 23.23,
          longitude: 72.57,
        }),
      ).rejects.toThrow(ActiveSessionExistsError);
    });
  });

  describe('Punch Out & Work Unit Calculation', () => {
    it('calculates 1.0P and completes session on punch out', async () => {
      const punchInTime = new Date(Date.now() - 9 * 60 * 60 * 1000); // 9 hours ago
      let updatedSession: unknown = null;

      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findById: vi.fn().mockResolvedValue({
            id: 'sess-1',
            siteId: 's1',
            policyId: 'pol-1',
            status: 'IN_PROGRESS',
            punchInAt: punchInTime,
          }),
          findActive: vi.fn().mockResolvedValue({
            id: 'sess-1',
            siteId: 's1',
            policyId: 'pol-1',
            status: 'IN_PROGRESS',
            punchInAt: punchInTime,
          }),
          update: vi.fn().mockImplementation(async (_, __, data) => {
            updatedSession = { id: 'sess-1', ...data };
            return updatedSession as AttendanceSession;
          }),
        } as unknown as AttendanceRepos['sessions'],
        sites: {
          findById: vi.fn().mockResolvedValue(sampleSite),
        },
        breaks: {
          findActive: vi.fn().mockResolvedValue(null),
          listForSession: vi.fn().mockResolvedValue([]),
        } as unknown as AttendanceRepos['breaks'],
        policies: {
          findById: vi.fn().mockResolvedValue({
            id: 'pol-1',
            shiftDurationMins: 480,
            halfDayThresholdMins: 240,
            fullDayThresholdMins: 480,
            breakMode: 'FIXED',
            fixedBreakMins: 60,
            minWorkForBreakMins: 240,
            overtimeMode: 'HOURLY',
            minOvertimeMins: 30,
            otSlabMins: 30,
          }),
        } as unknown as AttendanceRepos['policies'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.punchOut(actor, companyId, {
        sessionId: 'sess-1',
        latitude: 23.23,
        longitude: 72.57,
      });

      expect(res.status).toBe('COMPLETED');
      expect(Number((updatedSession as Record<string, unknown>).presentUnits)).toBe(1.0);
    });

    it('throws NoActiveSessionError if punch out is called with no active session', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findActive: vi.fn().mockResolvedValue(null),
        } as unknown as AttendanceRepos['sessions'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      await expect(
        service.punchOut(actor, companyId, {
          latitude: 23.23,
          longitude: 72.57,
        }),
      ).rejects.toThrow(NoActiveSessionError);
    });
  });

  describe('Dynamic Break Management', () => {
    it('starts and ends a dynamic break during an active session', async () => {
      let activeBreak: unknown = null;
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findActive: vi.fn().mockResolvedValue({
            id: 'sess-1',
            siteId: 's1',
            employeeId: sampleEmployee.id,
            status: 'IN_PROGRESS',
          }),
          findById: vi.fn().mockResolvedValue({
            id: 'sess-1',
            siteId: 's1',
            employeeId: sampleEmployee.id,
            status: 'IN_PROGRESS',
          }),
        } as unknown as AttendanceRepos['sessions'],
        breaks: {
          findActive: vi.fn().mockImplementation(async () => activeBreak as never),
          create: vi.fn().mockImplementation(async (_, data) => {
            activeBreak = { id: 'brk-1', sessionId: 'sess-1', startedAt: new Date(), ...data };
            return activeBreak as never;
          }),
          update: vi.fn().mockImplementation(async (_, __, data) => {
            activeBreak = { ...(activeBreak as object), ...data };
            return activeBreak as never;
          }),
        } as unknown as AttendanceRepos['breaks'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const brk = await service.startBreak(actor, companyId, { breakType: 'TEA' });
      expect(brk.breakType).toBe('TEA');

      // Attempting to start another break when one is active throws BreakAlreadyActiveError
      await expect(service.startBreak(actor, companyId, {})).rejects.toThrow(
        BreakAlreadyActiveError,
      );

      const ended = await service.endBreak(actor, companyId, { remarks: 'Break over' });
      expect(ended.durationMins).toBeGreaterThanOrEqual(1);
    });

    it('throws NoActiveBreakError if ending a break when none is active', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findActive: vi.fn().mockResolvedValue({
            id: 'sess-1',
            siteId: 's1',
            employeeId: sampleEmployee.id,
            status: 'IN_PROGRESS',
          }),
          findById: vi.fn().mockResolvedValue({
            id: 'sess-1',
            siteId: 's1',
            employeeId: sampleEmployee.id,
            status: 'IN_PROGRESS',
          }),
        } as unknown as AttendanceRepos['sessions'],
        breaks: {
          findActive: vi.fn().mockResolvedValue(null),
        } as unknown as AttendanceRepos['breaks'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      await expect(service.endBreak(actor, companyId, {})).rejects.toThrow(NoActiveBreakError);
    });
  });

  describe('Supervisor Regularization', () => {
    it('allows supervisor to manually regularize attendance with audit trace', async () => {
      let regularizedData: unknown = null;
      const mockRepos: Partial<AttendanceRepos> = {
        sessions: {
          findById: vi.fn().mockResolvedValue({
            id: 'sess-1',
            siteId: 's1',
            punchInAt: new Date('2026-11-18T08:00:00.000Z'),
            punchOutAt: new Date('2026-11-18T17:00:00.000Z'),
            status: 'IN_PROGRESS',
            presentUnits: 0,
            overtimePUnits: 0,
            breaks: [],
          }),
          update: vi.fn().mockImplementation(async (_, __, data) => {
            regularizedData = data;
            return { id: 'sess-1', ...data } as AttendanceSession;
          }),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findById: vi.fn().mockResolvedValue(null),
        } as unknown as AttendanceRepos['policies'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.regularizeSession(actor, companyId, 'sess-1', {
        presentUnits: 1.0,
        overtimePUnits: 0.5,
        remarks: 'Biometric device failed on site; supervisor approved hazri',
      });

      expect(res.status).toBe('COMPLETED');
      expect((regularizedData as Record<string, unknown>).source).toBe('MANUAL_CORRECTION');
      expect(Number((regularizedData as Record<string, unknown>).totalPUnits)).toBe(1.5);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3 Tests: TVT Gate, Kiosk Batch, Offline Sync, Muster Roll
  // -------------------------------------------------------------------------

  describe('Phase 3: Safety TVT Gate Enforcement', () => {
    it('blocks punch in when TVT gate is required with BLOCK action and employee missed briefing', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          findById: vi.fn().mockResolvedValue(sampleEmployee),
        },
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        sessions: {
          findActive: vi.fn().mockResolvedValue(null),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-tvt-block',
            requireTvtGate: true,
            tvtGateAction: 'BLOCK',
            geofenceStrict: false,
            dayStartHour: 8,
            dayStartMinute: 0,
            allowMobilePunch: true,
          }),
        } as unknown as AttendanceRepos['policies'],
        tvt: {
          hasAttended: vi.fn().mockResolvedValue(false),
        } as unknown as AttendanceRepos['tvt'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      await expect(
        service.punchIn(actor, companyId, {
          siteId: 's1',
          latitude: 23.23,
          longitude: 72.57,
        }),
      ).rejects.toThrow(TvtSafetyBriefingRequiredError);
    });

    it('allows punch in but flags session when TVT gate action is FLAG', async () => {
      let createdSessionData: unknown = null;
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          findById: vi.fn().mockResolvedValue(sampleEmployee),
        },
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        sessions: {
          findActive: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async (_, data) => {
            createdSessionData = data;
            return { id: 'sess-flagged', status: 'IN_PROGRESS', ...data } as AttendanceSession;
          }),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-tvt-flag',
            requireTvtGate: true,
            tvtGateAction: 'FLAG',
            geofenceStrict: false,
            dayStartHour: 8,
            dayStartMinute: 0,
            allowMobilePunch: true,
          }),
        } as unknown as AttendanceRepos['policies'],
        tvt: {
          hasAttended: vi.fn().mockResolvedValue(false),
        } as unknown as AttendanceRepos['tvt'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.punchIn(actor, companyId, {
        siteId: 's1',
        latitude: 23.23,
        longitude: 72.57,
      });

      expect(res.id).toBe('sess-flagged');
      expect((createdSessionData as Record<string, unknown>).isFlagged).toBe(true);
      expect((createdSessionData as Record<string, unknown>).flagReason).toContain(
        'Safety TVT briefing missed',
      );
    });

    it('allows clean punch in without flags when employee has attended TVT', async () => {
      let createdSessionData: unknown = null;
      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          findById: vi.fn().mockResolvedValue(sampleEmployee),
        },
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        sessions: {
          findActive: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async (_, data) => {
            createdSessionData = data;
            return { id: 'sess-clean', status: 'IN_PROGRESS', ...data } as AttendanceSession;
          }),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-tvt-attended',
            requireTvtGate: true,
            tvtGateAction: 'BLOCK',
            geofenceStrict: false,
            dayStartHour: 8,
            dayStartMinute: 0,
            allowMobilePunch: true,
          }),
        } as unknown as AttendanceRepos['policies'],
        tvt: {
          hasAttended: vi.fn().mockResolvedValue(true),
        } as unknown as AttendanceRepos['tvt'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.punchIn(actor, companyId, {
        siteId: 's1',
        latitude: 23.23,
        longitude: 72.57,
      });

      expect(res.id).toBe('sess-clean');
      expect((createdSessionData as Record<string, unknown>).isFlagged).toBe(false);
    });
  });

  describe('Phase 3: Kiosk Batch Punch In & Punch Out', () => {
    it('batch punches in multiple workers with mixed active/inactive status', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        employees: {
          findById: vi.fn().mockImplementation(async (_: string, id: string) => {
            if (id === 'e-inactive')
              return { id: 'e-inactive', displayName: 'Inactive', status: 'SUSPENDED' };
            return { id, displayName: id, status: 'ACTIVE' };
          }),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findActive: vi.fn().mockImplementation(async (_: string, id: string) => {
            if (id === 'e-active') return { id: 'sess-already-in' };
            return null;
          }),
          create: vi
            .fn()
            .mockImplementation(
              async (_: string, data: { employee: { connect: { id: string } } }) => {
                return { id: `sess-${data.employee.connect.id}`, ...data };
              },
            ),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-kiosk',
            dayStartHour: 8,
            dayStartMinute: 0,
            geofenceStrict: false,
            requireTvtGate: false,
          }),
        } as unknown as AttendanceRepos['policies'],
        tvt: { hasAttended: vi.fn().mockResolvedValue(true) } as unknown as AttendanceRepos['tvt'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.kioskBatchPunchIn(actor, companyId, {
        siteId: 's1',
        employeeIds: ['e-1', 'e-active', 'e-inactive'],
        latitude: 23.23,
        longitude: 72.57,
      });

      expect(res.totalSubmitted).toBe(3);
      expect(res.successCount).toBe(1);
      expect(res.failureCount).toBe(2);
      expect(res.results.find((r) => r.employeeId === 'e-1')?.success).toBe(true);
      expect(res.results.find((r) => r.employeeId === 'e-active')?.error).toBe(
        'ACTIVE_SESSION_EXISTS',
      );
      expect(res.results.find((r) => r.employeeId === 'e-inactive')?.error).toBe(
        'EMPLOYEE_NOT_ACTIVE',
      );
    });

    it('batch punches out multiple workers and calculates P-units and durations', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        employees: {
          findManyByIds: vi.fn().mockResolvedValue([{ id: 'e-1', status: 'ACTIVE' }]),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findActive: vi.fn().mockImplementation(async (_, id) => {
            if (id === 'e-none') return null;
            return {
              id: `sess-${id}`,
              policyId: 'pol-1',
              punchInAt: new Date(Date.now() - 9 * 60 * 60 * 1000), // 9 hours ago
              breaks: [],
            };
          }),
          update: vi
            .fn()
            .mockImplementation(async (_: string, id: string, data: Record<string, unknown>) => ({
              id,
              ...data,
            })),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findById: vi.fn().mockResolvedValue({
            id: 'pol-1',
            shiftDurationMins: 480,
            halfDayThresholdMins: 240,
            fullDayThresholdMins: 480,
            breakMode: 'FIXED',
            fixedBreakMins: 60,
            minWorkForBreakMins: 240,
            overtimeMode: 'HOURLY',
            minOvertimeMins: 30,
            otSlabMins: 30,
            pMultiplierSlabs: null,
          }),
        } as unknown as AttendanceRepos['policies'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.kioskBatchPunchOut(actor, companyId, {
        siteId: 's1',
        employeeIds: ['e-1', 'e-none'],
        latitude: 23.23,
        longitude: 72.57,
      });

      expect(res.totalSubmitted).toBe(2);
      expect(res.successCount).toBe(1);
      expect(res.failureCount).toBe(1);
      const successItem = res.results.find((r) => r.employeeId === 'e-1');
      expect(successItem?.success).toBe(true);
      expect(successItem?.presentUnits).toBe(1.0);
    });
  });

  describe('Phase 3: Offline Kiosk Batch Sync', () => {
    it('idempotently syncs offline sessions, skipping existing clientSessionIds', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        employees: {
          findManyByIds: vi.fn().mockResolvedValue([{ id: 'e-1', status: 'ACTIVE' }]),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findActive: vi.fn().mockResolvedValue(null),
          findByClientSessionId: vi
            .fn()
            .mockImplementation(async (_: string, clientSessionId: string) => {
              if (clientSessionId === 'cs-already-synced') {
                return { id: 'sess-already', clientSessionId };
              }
              return null;
            }),
          create: vi
            .fn()
            .mockImplementation(async (_: string, data: { clientSessionId?: string }) => ({
              id: `sess-synced-${data.clientSessionId ?? ''}`,
              ...data,
            })),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-offline',
            dayStartHour: 8,
            dayStartMinute: 0,
            breakMode: 'FIXED',
            fixedBreakMins: 60,
            minWorkForBreakMins: 240,
            shiftDurationMins: 480,
            halfDayThresholdMins: 240,
            fullDayThresholdMins: 480,
            overtimeMode: 'HOURLY',
            minOvertimeMins: 30,
            otSlabMins: 30,
            pMultiplierSlabs: null,
            requireTvtGate: false,
          }),
        } as unknown as AttendanceRepos['policies'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.kioskOfflineSync(actor, companyId, {
        siteId: 's1',
        syncBatchId: 'batch-001',
        sessions: [
          {
            clientSessionId: 'cs-new-1',
            employeeId: 'e-1',
            punchInAt: '2026-11-17T08:30:00.000Z',
            punchOutAt: '2026-11-17T17:30:00.000Z',
          },
          {
            clientSessionId: 'cs-already-synced',
            employeeId: 'e-2',
            punchInAt: '2026-11-17T08:30:00.000Z',
          },
        ],
      });

      expect(res.totalSubmitted).toBe(2);
      expect(res.syncedCount).toBe(1);
      expect(res.alreadySyncedCount).toBe(1);
      expect(res.results.find((r) => r.clientSessionId === 'cs-new-1')?.status).toBe('SYNCED');
      expect(res.results.find((r) => r.clientSessionId === 'cs-already-synced')?.status).toBe(
        'ALREADY_SYNCED',
      );
    });
  });

  describe('Phase 3: Safety TVT Sessions & Attendee Management', () => {
    it('creates a TVT session with attendees and audit log', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue({ id: 'emp-supervisor', status: 'ACTIVE' }),
        } as unknown as AttendanceRepos['employees'],
        tvt: {
          create: vi.fn().mockResolvedValue({
            id: 'tvt-1',
            siteId: 's1',
            businessDate: '2026-11-17',
            topic: 'Scaffolding & Fall Protection Briefing',
            attendees: [
              { id: 'att-1', employeeId: 'e-1' },
              { id: 'att-2', employeeId: 'e-2' },
            ],
          }),
        } as unknown as AttendanceRepos['tvt'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.createTvtSession(actor, companyId, {
        siteId: 's1',
        topic: 'Scaffolding & Fall Protection Briefing',
        attendeeEmployeeIds: ['e-1', 'e-2'],
      });

      expect(res.id).toBe('tvt-1');
      expect(res.topic).toBe('Scaffolding & Fall Protection Briefing');
      expect(res.attendees).toHaveLength(2);
    });

    it('adds attendees to an existing TVT session', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        tvt: {
          findById: vi.fn().mockResolvedValue({
            id: 'tvt-1',
            siteId: 's1',
            attendees: [{ id: 'att-1', employeeId: 'e-1' }],
          }),
          addAttendees: vi.fn().mockResolvedValue(2),
        } as unknown as AttendanceRepos['tvt'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.addTvtAttendees(actor, companyId, 'tvt-1', {
        employeeIds: ['e-2', 'e-3'],
      });

      expect(res.sessionId).toBe('tvt-1');
      expect(res.addedCount).toBe(2);
      expect(res.totalAttendees).toBe(3);
    });
  });

  describe('Phase 3: Multi-Date Muster Roll Range Export', () => {
    it('aggregates muster roll over a date range for contractor settlement', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sessions: {
          getMusterRollRange: vi.fn().mockResolvedValue({
            siteId: 's1',
            from: '2026-11-01',
            to: '2026-11-07',
            totalSessions: 14,
            totalMandays: 14,
            totalPresentUnits: 14.0,
            totalOvertimePUnits: 4.5,
            totalTotalPUnits: 18.5,
            totalOvertimeHours: 9.0,
            workerSummaries: [
              {
                employeeId: 'e-1',
                employeeCode: 'EMP-001',
                displayName: 'Suresh Kumar',
                tradeCategory: 'MASON',
                presentUnits: 7.0,
                overtimePUnits: 2.5,
                totalPUnits: 9.5,
                overtimeHours: 5.0,
                sessionsCount: 7,
                daysPresent: 7,
                leaveDays: 0,
              },
            ],
            sessions: [],
            leaves: [],
          }),
        } as unknown as AttendanceRepos['sessions'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.getMusterRollRange(actor, companyId, {
        siteId: 's1',
        from: '2026-11-01',
        to: '2026-11-07',
      });

      expect(res.totalSessions).toBe(14);
      expect(res.totalPresentUnits).toBe(14.0);
      expect(res.totalOvertimePUnits).toBe(4.5);
      expect(res.totalTotalPUnits).toBe(18.5);
      expect(res.workerSummaries).toHaveLength(1);
      expect(res.workerSummaries[0]?.tradeCategory).toBe('MASON');
    });

    it('rejects date range exceeding 31 days with InvalidDateRangeError', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sessions: {
          getMusterRollRange: vi.fn(),
        } as unknown as AttendanceRepos['sessions'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      await expect(
        service.getMusterRollRange(actor, companyId, {
          siteId: 's1',
          from: '2026-01-01',
          to: '2026-02-15', // 46 days
        }),
      ).rejects.toThrow(InvalidDateRangeError);
    });

    it('rejects when from date is after to date', async () => {
      const mockRepos: Partial<AttendanceRepos> = {
        sessions: {
          getMusterRollRange: vi.fn(),
        } as unknown as AttendanceRepos['sessions'],
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      await expect(
        service.getMusterRollRange(actor, companyId, {
          siteId: 's1',
          from: '2026-11-15',
          to: '2026-11-01',
        }),
      ).rejects.toThrow(InvalidDateRangeError);
    });
  });

  describe('Pre-batching & Default Policy Fallback Optimizations', () => {
    it('uses batch findManyByIds, findActiveMany, and pre-batches TVT in kioskBatchPunchIn', async () => {
      const findManyByIdsSpy = vi.fn().mockResolvedValue([
        { id: 'emp-1', displayName: 'Worker 1', status: 'ACTIVE' },
        { id: 'emp-2', displayName: 'Worker 2', status: 'ACTIVE' },
      ]);
      const findActiveManySpy = vi.fn().mockResolvedValue([]);
      const findEmployeePoliciesSpy = vi.fn().mockResolvedValue([]);
      const findAttendeesForSiteAndDateSpy = vi.fn().mockResolvedValue(['emp-1', 'emp-2']);
      const createSessionSpy = vi
        .fn<
          (_: string, data: { employee: { connect: { id: string } } }) => Promise<AttendanceSession>
        >()
        .mockImplementation(async (_: string, data: { employee: { connect: { id: string } } }) =>
          Promise.resolve({
            id: `sess-${data.employee.connect.id}`,
            ...data,
          } as unknown as AttendanceSession),
        );

      const mockRepos: Partial<AttendanceRepos> = {
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        employees: {
          findManyByIds: findManyByIdsSpy,
          findById: vi.fn(),
          findByPrincipal: vi.fn(),
        },
        sessions: {
          findActiveMany: findActiveManySpy,
          create: createSessionSpy,
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue({
            id: 'pol-tvt',
            dayStartHour: 8,
            dayStartMinute: 0,
            geofenceStrict: false,
            requireTvtGate: true,
            tvtGateAction: 'BLOCK',
          }),
          findEmployeePolicies: findEmployeePoliciesSpy,
        } as unknown as AttendanceRepos['policies'],
        tvt: {
          findAttendeesForSiteAndDate: findAttendeesForSiteAndDateSpy,
        } as unknown as AttendanceRepos['tvt'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.kioskBatchPunchIn(actor, companyId, {
        siteId: 's1',
        employeeIds: ['emp-1', 'emp-2'],
        latitude: 23.23,
        longitude: 72.57,
      });

      expect(res.totalSubmitted).toBe(2);
      expect(res.successCount).toBe(2);
      expect(findManyByIdsSpy).toHaveBeenCalledTimes(1);
      expect(findActiveManySpy).toHaveBeenCalledTimes(1);
      expect(findEmployeePoliciesSpy).toHaveBeenCalledTimes(1);
      expect(findAttendeesForSiteAndDateSpy).toHaveBeenCalledTimes(1);
      expect(createSessionSpy).toHaveBeenCalledTimes(2);
    });

    it('safely ensures default company policy without duplicate creation on fallback punch', async () => {
      const ensureDefaultPolicySpy = vi.fn().mockResolvedValue({
        id: 'pol-ensured-default',
        name: 'Company Default Policy',
        scope: 'COMPANY',
        dayStartHour: 8,
        dayStartMinute: 0,
        shiftDurationMins: 480,
        geofenceStrict: false,
        allowMobilePunch: true,
      });

      const mockRepos: Partial<AttendanceRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          findById: vi.fn().mockResolvedValue(sampleEmployee),
        },
        sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
        sessions: {
          findActive: vi.fn().mockResolvedValue(null),
          create: vi
            .fn<(_: string, data: Record<string, unknown>) => Promise<AttendanceSession>>()
            .mockImplementation(async (_: string, data: Record<string, unknown>) =>
              Promise.resolve({ id: 'sess-new', ...data } as unknown as AttendanceSession),
            ),
        } as unknown as AttendanceRepos['sessions'],
        policies: {
          findEffective: vi.fn().mockResolvedValue(null), // Triggers fallback
          ensureDefaultPolicy: ensureDefaultPolicySpy,
        } as unknown as AttendanceRepos['policies'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new AttendanceService(createMockUow(mockRepos), authorizer);
      const res = await service.punchIn(actor, companyId, {
        siteId: 's1',
        latitude: 23.23,
        longitude: 72.57,
      });

      expect(res.id).toBe('sess-new');
      expect(ensureDefaultPolicySpy).toHaveBeenCalledTimes(1);
    });

    describe('Attendance 11-Issue Remediation Verification', () => {
      const samplePolicy = {
        id: 'pol-1',
        companyId,
        name: 'Standard Policy',
        shiftDurationMins: 480,
        halfDayThresholdMins: 240,
        fullDayThresholdMins: 480,
        dayStartHour: 8,
        dayStartMinute: 0,
        breakMode: 'FIXED',
        fixedBreakMins: 60,
        minWorkForBreakMins: 240,
        overtimeMode: 'HOURLY',
        minOvertimeMins: 30,
        otSlabMins: 30,
        pMultiplierSlabs: null,
        requireTvtGate: false,
        allowMobilePunch: true,
        allowKioskPunch: true,
        allowBiometric: true,
        geofenceStrict: false,
      };

      it('Issue 1: endBreak successfully finds break by breakId directly', async () => {
        const updateBreakSpy = vi
          .fn<
            (
              _: string,
              id: string,
              data: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>
          >()
          .mockImplementation(async (_: string, id: string, data: Record<string, unknown>) =>
            Promise.resolve({
              id,
              sessionId: 'sess-1',
              endedAt: new Date(),
              durationMins: 30,
              ...data,
            }),
          );

        const mockRepos: Partial<AttendanceRepos> = {
          employees: {
            findByPrincipal: vi.fn().mockResolvedValue({ id: 'emp-1', displayName: 'Worker' }),
          } as unknown as AttendanceRepos['employees'],
          sessions: {
            findById: vi.fn().mockResolvedValue({
              id: 'sess-1',
              employeeId: 'emp-1',
              siteId: 's1',
            }),
          } as unknown as AttendanceRepos['sessions'],
          breaks: {
            findById: vi.fn().mockResolvedValue({
              id: 'brk-target',
              sessionId: 'sess-1',
              startedAt: new Date(Date.now() - 30 * 60 * 1000),
              endedAt: null,
            }),
            update: updateBreakSpy,
          } as unknown as AttendanceRepos['breaks'],
          audit: { record: vi.fn().mockResolvedValue(undefined) },
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);
        const res = await service.endBreak(actor, companyId, {
          breakId: 'brk-target',
          remarks: 'Ended on time',
        });

        expect(res.id).toBe('brk-target');
        expect(updateBreakSpy).toHaveBeenCalledWith(
          companyId,
          'brk-target',
          expect.objectContaining({ remarks: 'Ended on time' }),
        );
      });

      it('Issue 1: endBreak throws NoActiveBreakError if breakId is already ended', async () => {
        const mockRepos: Partial<AttendanceRepos> = {
          breaks: {
            findById: vi.fn().mockResolvedValue({
              id: 'brk-ended',
              sessionId: 'sess-1',
              startedAt: new Date(Date.now() - 60 * 60 * 1000),
              endedAt: new Date(Date.now() - 30 * 60 * 1000),
            }),
          } as unknown as AttendanceRepos['breaks'],
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);
        await expect(service.endBreak(actor, companyId, { breakId: 'brk-ended' })).rejects.toThrow(
          NoActiveBreakError,
        );
      });

      it('Issue 2: kioskBatchPunchOut flags SESSION_SITE_MISMATCH if session belongs to another site', async () => {
        const mockRepos: Partial<AttendanceRepos> = {
          sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
          sessions: {
            findActive: vi.fn().mockResolvedValue({
              id: 'sess-wrong-site',
              siteId: 'site-other',
              employeeId: 'emp-1',
              status: 'IN_PROGRESS',
              punchInAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
            }),
          } as unknown as AttendanceRepos['sessions'],
          audit: { record: vi.fn().mockResolvedValue(undefined) },
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);
        const res = await service.kioskBatchPunchOut(actor, companyId, {
          siteId: 's1',
          employeeIds: ['emp-1'],
          latitude: 23.23,
          longitude: 72.57,
        });

        expect(res.failureCount).toBe(1);
        expect(res.results[0]?.error).toBe('SESSION_SITE_MISMATCH');
      });

      it('Issue 3: punchOut outside geofence marks isFlagged and sets flagReason', async () => {
        let updatedData: unknown = null;
        const mockRepos: Partial<AttendanceRepos> = {
          employees: {
            findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          } as unknown as AttendanceRepos['employees'],
          sites: {
            findById: vi.fn().mockResolvedValue({
              ...sampleSite,
              geoLatitude: 23.0,
              geoLongitude: 72.0,
              geoFenceRadiusM: 100,
            }),
          },
          sessions: {
            findActive: vi.fn().mockResolvedValue({
              id: 'sess-1',
              siteId: 's1',
              employeeId: sampleEmployee.id,
              status: 'IN_PROGRESS',
              punchInAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
              isFlagged: false,
              flagReason: null,
            }),
            update: vi.fn().mockImplementation(async (_, __, data) => {
              updatedData = data;
              return { id: 'sess-1', ...data } as AttendanceSession;
            }),
          } as unknown as AttendanceRepos['sessions'],
          policies: {
            findById: vi.fn().mockResolvedValue(samplePolicy),
          } as unknown as AttendanceRepos['policies'],
          breaks: {
            findActive: vi.fn().mockResolvedValue(null),
            listForSession: vi.fn().mockResolvedValue([]),
          } as unknown as AttendanceRepos['breaks'],
          audit: { record: vi.fn().mockResolvedValue(undefined) },
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);
        // Punch out far from geofence
        await service.punchOut(actor, companyId, {
          latitude: 28.61, // Delhi coordinates vs site at 23.0, 72.0
          longitude: 77.2,
        });

        const record = updatedData as Record<string, unknown>;
        expect(record.isFlagged).toBe(true);
        expect(record.flagReason).toContain('Punch-out outside geofence');
        expect(record.punchOutWithinGeofence).toBe(false);
      });

      it('Issue 4: regularizeSession validates punchOutAt presence, order, and recalculates durations', async () => {
        let updatedData: unknown = null;
        const mockRepos: Partial<AttendanceRepos> = {
          sessions: {
            findById: vi.fn().mockResolvedValue({
              id: 'sess-1',
              siteId: 's1',
              status: 'IN_PROGRESS',
              punchInAt: new Date('2026-11-18T08:00:00.000Z'),
              punchOutAt: null,
            }),
            update: vi.fn().mockImplementation(async (_, __, data) => {
              updatedData = data;
              return { id: 'sess-1', ...data } as AttendanceSession;
            }),
          } as unknown as AttendanceRepos['sessions'],
          policies: {
            findById: vi.fn().mockResolvedValue(samplePolicy),
          } as unknown as AttendanceRepos['policies'],
          breaks: {
            listForSession: vi.fn().mockResolvedValue([]),
          } as unknown as AttendanceRepos['breaks'],
          audit: { record: vi.fn().mockResolvedValue(undefined) },
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);

        // Attempting to regularize without punchOutAt on in-progress session throws
        await expect(
          service.regularizeSession(actor, companyId, 'sess-1', { remarks: 'Missing out' }),
        ).rejects.toThrow(AttendanceValidationError);

        // Attempting out <= in throws
        await expect(
          service.regularizeSession(actor, companyId, 'sess-1', {
            punchOutAt: '2026-11-18T07:00:00.000Z',
            remarks: 'Invalid time order',
          }),
        ).rejects.toThrow(AttendanceValidationError);

        // Valid regularization recalculates durations (08:00 to 18:00 = 10h = 600m)
        await service.regularizeSession(actor, companyId, 'sess-1', {
          punchOutAt: '2026-11-18T18:00:00.000Z',
          remarks: 'Valid regularization',
        });

        const rec = updatedData as Record<string, unknown>;
        expect(rec.grossDurationMins).toBe(600);
        expect(rec.status).toBe('COMPLETED');
      });

      it('Issue 5: sweepStaleSessions auto-closes sessions exceeding cutoff', async () => {
        const autoCloseSpy = vi.fn().mockResolvedValue(3);
        const mockRepos: Partial<AttendanceRepos> = {
          sessions: {
            autoCloseStaleSessions: autoCloseSpy,
          } as unknown as AttendanceRepos['sessions'],
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);
        const count = await service.sweepStaleSessions(companyId, 24);

        expect(count).toBe(3);
        expect(autoCloseSpy).toHaveBeenCalledWith(expect.any(Date), companyId);
      });

      it('Issue 7 & 8: punchIn for another employee or privileged source asserts ATTENDANCE_MANAGE', async () => {
        const authSpy = vi.fn().mockResolvedValue(undefined);
        const mockAuthorizer = { assertPermission: authSpy };

        const mockRepos: Partial<AttendanceRepos> = {
          employees: {
            findByPrincipal: vi
              .fn()
              .mockResolvedValue({ id: 'emp-caller', displayName: 'Caller', status: 'ACTIVE' }),
            findById: vi
              .fn()
              .mockResolvedValue({ id: 'emp-target', displayName: 'Target', status: 'ACTIVE' }),
          },
          sites: { findById: vi.fn().mockResolvedValue(sampleSite) },
          sessions: {
            findActive: vi.fn().mockResolvedValue(null),
            create: vi
              .fn<(_: string, data: Record<string, unknown>) => Promise<AttendanceSession>>()
              .mockResolvedValue({ id: 'sess-new' } as AttendanceSession),
          } as unknown as AttendanceRepos['sessions'],
          policies: {
            findEffective: vi.fn().mockResolvedValue({
              ...samplePolicy,
              allowKioskPunch: true,
              allowBiometric: true,
            }),
          } as unknown as AttendanceRepos['policies'],
          tvt: {
            hasAttended: vi.fn().mockResolvedValue(true),
          } as unknown as AttendanceRepos['tvt'],
          audit: { record: vi.fn().mockResolvedValue(undefined) },
        };

        const service = new AttendanceService(createMockUow(mockRepos), mockAuthorizer);

        // Punching for another employee requires ATTENDANCE_MANAGE
        await service.punchIn(actor, companyId, {
          siteId: 's1',
          employeeId: 'emp-target',
          latitude: 23.23,
          longitude: 72.57,
        });

        expect(authSpy).toHaveBeenCalledWith('u1', 'ATTENDANCE_MANAGE', expect.anything());
      });

      it('Issue 9: getActiveSession targeting another employee asserts ATTENDANCE_READ', async () => {
        const authSpy = vi.fn().mockResolvedValue(undefined);
        const mockAuthorizer = { assertPermission: authSpy };

        const mockRepos: Partial<AttendanceRepos> = {
          employees: {
            findByPrincipal: vi.fn().mockResolvedValue({ id: 'emp-caller' }),
          } as unknown as AttendanceRepos['employees'],
          sessions: {
            findActive: vi.fn().mockResolvedValue({
              id: 'sess-target',
              siteId: 's1',
              employeeId: 'emp-other',
            }),
          } as unknown as AttendanceRepos['sessions'],
        };

        const service = new AttendanceService(createMockUow(mockRepos), mockAuthorizer);
        const session = await service.getActiveSession(actor, companyId, 'emp-other');

        expect(session?.id).toBe('sess-target');
        expect(authSpy).toHaveBeenCalledWith('u1', 'ATTENDANCE_READ', expect.anything());
      });

      it('enriches active session with delayed clock in and proper 8-hour clock out time', async () => {
        // Scheduled: 08:00 AM Kolkata (02:30 UTC); punched in: 08:35 AM Kolkata (03:05 UTC)
        const punchInAt = new Date('2026-11-21T03:05:00.000Z');
        const mockRepos: Partial<AttendanceRepos> = {
          employees: {
            findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
          } as unknown as AttendanceRepos['employees'],
          sessions: {
            findActive: vi.fn().mockResolvedValue({
              id: 'sess-active-timing',
              siteId: 's1',
              employeeId: sampleEmployee.id,
              policyId: 'pol-1',
              businessDate: '2026-11-21',
              status: 'IN_PROGRESS',
              punchInAt,
              breaks: [],
            }),
            findByEmployeeAndDate: vi.fn().mockResolvedValue([
              {
                id: 'sess-active-timing',
                siteId: 's1',
                employeeId: sampleEmployee.id,
                businessDate: '2026-11-21',
                status: 'IN_PROGRESS',
                punchInAt,
                breaks: [],
              },
            ]),
          } as unknown as AttendanceRepos['sessions'],
          policies: {
            findById: vi.fn().mockResolvedValue({
              id: 'pol-1',
              dayStartHour: 8,
              dayStartMinute: 0,
              shiftDurationMins: 480,
            }),
          } as unknown as AttendanceRepos['policies'],
          sites: {
            findById: vi.fn().mockResolvedValue(sampleSite),
          },
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);
        const session = await service.getActiveSession(actor, companyId);

        expect(session).not.toBeNull();
        expect(session?.id).toBe('sess-active-timing');
        const s = session as unknown as {
          isDelayedClockIn: boolean;
          delayedClockInMinutes: number;
          delayedClockInTime: string;
          clockOutTimeProper8Hours: string;
          totalCheckInsToday: number;
          totalCheckOutsToday: number;
          currentlyCheckedIn: boolean;
          activityLog: unknown[];
        };
        expect(s.isDelayedClockIn).toBe(true);
        expect(s.delayedClockInMinutes).toBe(35);
        expect(s.delayedClockInTime).toBe('00:35');
        // Proper 8 working hours = 03:05 UTC + 8h = 11:05 UTC
        expect(s.clockOutTimeProper8Hours).toBe('2026-11-21T11:05:00.000Z');
        expect(s.totalCheckInsToday).toBe(1);
        expect(s.totalCheckOutsToday).toBe(0);
        expect(s.currentlyCheckedIn).toBe(true);
        expect(s.activityLog).toHaveLength(1);
      });

      it('Issue 10: kioskOfflineSync rejects inactive employee, duplicate active, and TVT BLOCK', async () => {
        const mockRepos: Partial<AttendanceRepos> = {
          sites: {
            findById: vi.fn().mockResolvedValue({
              ...sampleSite,
              geoLatitude: 23.0,
              geoLongitude: 72.0,
              geoFenceRadiusM: 100,
            }),
          },
          employees: {
            findManyByIds: vi.fn().mockResolvedValue([
              { id: 'emp-active', status: 'ACTIVE' },
              { id: 'emp-inactive', status: 'INACTIVE' },
              { id: 'emp-has-active', status: 'ACTIVE' },
            ]),
          } as unknown as AttendanceRepos['employees'],
          sessions: {
            findByClientSessionId: vi.fn().mockResolvedValue(null),
            findActiveMany: vi
              .fn()
              .mockResolvedValue([
                { id: 'sess-act', employeeId: 'emp-has-active', status: 'IN_PROGRESS' },
              ]),
            create: vi
              .fn<(_: string, data: { clientSessionId?: string }) => Promise<AttendanceSession>>()
              .mockImplementation(async (_, data) =>
                Promise.resolve({
                  id: `sess-${data.clientSessionId ?? ''}`,
                  ...data,
                } as unknown as AttendanceSession),
              ),
          } as unknown as AttendanceRepos['sessions'],
          policies: {
            findEffective: vi.fn().mockResolvedValue({
              ...samplePolicy,
              requireTvtGate: true,
              tvtGateAction: 'BLOCK',
            }),
          } as unknown as AttendanceRepos['policies'],
          tvt: {
            hasAttended: vi.fn().mockResolvedValue(false), // missed TVT
          } as unknown as AttendanceRepos['tvt'],
          audit: { record: vi.fn().mockResolvedValue(undefined) },
        };

        const service = new AttendanceService(createMockUow(mockRepos), authorizer);
        const res = await service.kioskOfflineSync(actor, companyId, {
          siteId: 's1',
          syncBatchId: 'batch-test-10',
          sessions: [
            {
              clientSessionId: 'cs-inactive',
              employeeId: 'emp-inactive',
              punchInAt: '2026-11-18T08:00:00.000Z',
            },
            {
              clientSessionId: 'cs-dup-active',
              employeeId: 'emp-has-active',
              punchInAt: '2026-11-18T08:00:00.000Z',
            },
            {
              clientSessionId: 'cs-tvt-block',
              employeeId: 'emp-active',
              punchInAt: '2026-11-18T08:00:00.000Z',
            },
          ],
        });

        expect(res.failedCount).toBe(3);
        expect(res.results.find((r) => r.clientSessionId === 'cs-inactive')?.error).toBe(
          'EMPLOYEE_NOT_ACTIVE',
        );
        expect(res.results.find((r) => r.clientSessionId === 'cs-dup-active')?.error).toBe(
          'ACTIVE_SESSION_EXISTS',
        );
        expect(res.results.find((r) => r.clientSessionId === 'cs-tvt-block')?.error).toBe(
          'TVT_SAFETY_BRIEFING_REQUIRED',
        );
      });
    });
  });
});

describe('Head-office punch anchoring', () => {
  const companyId = 'c1';
  const actor = { actorId: 'a1', actorType: 'USER' as const };
  const authorizer = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
  };
  const sampleEmployee = { id: 'e1', companyId, displayName: 'Fin Head', status: 'ACTIVE' };
  const sampleHeadOffice = {
    id: 'ho-1',
    companyId,
    status: 'ACTIVE',
    geoLatitude: 25.5941 as unknown as never,
    geoLongitude: 85.1376 as unknown as never,
    geoFenceRadiusM: 150,
    timezone: 'Asia/Kolkata',
  };
  const basePolicy = {
    id: 'pol-1',
    dayStartHour: 8,
    dayStartMinute: 0,
    allowMobilePunch: true,
    geofenceStrict: true,
    requireTvtGate: false,
  };

  function hoRepos(overrides: Partial<AttendanceRepos> = {}) {
    let created: unknown = null;
    const hoFindById = vi.fn().mockResolvedValue(sampleHeadOffice);
    const mockRepos: Partial<AttendanceRepos> = {
      employees: {
        findByPrincipal: vi.fn().mockResolvedValue(sampleEmployee),
        findById: vi.fn().mockResolvedValue(sampleEmployee),
      },
      headOffices: { findById: hoFindById },
      memberships: { hasActiveAtHeadOffice: vi.fn().mockResolvedValue(true) },
      sessions: {
        findActive: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async (_c: string, data: unknown) => {
          created = { id: 'sess-ho', ...(data as object) };
          return created;
        }),
      } as unknown as AttendanceRepos['sessions'],
      policies: {
        findEffective: vi.fn().mockResolvedValue(basePolicy),
      } as unknown as AttendanceRepos['policies'],
      audit: { record: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
    };
    return { mockRepos, hoFindById, getCreated: () => created };
  }

  it('requires exactly one of siteId/headOfficeId', async () => {
    const { mockRepos } = hoRepos();
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    await expect(
      service.punchIn(actor, companyId, { latitude: 25.5, longitude: 85.1 }),
    ).rejects.toThrow('exactly one');
    await expect(
      service.punchIn(actor, companyId, {
        siteId: 's1',
        headOfficeId: 'ho-1',
        latitude: 25.5,
        longitude: 85.1,
      }),
    ).rejects.toThrow('exactly one');
  });

  it('punches in at the head office for an HO-department employee', async () => {
    const { mockRepos, hoFindById, getCreated } = hoRepos();
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    const session = await service.punchIn(actor, companyId, {
      headOfficeId: 'ho-1',
      latitude: 25.5941,
      longitude: 85.1376,
    });
    expect(session.id).toBe('sess-ho');
    expect(getCreated()).toMatchObject({
      headOffice: { connect: { id: 'ho-1' } },
    });
    expect(hoFindById).toHaveBeenCalledWith('c1', 'ho-1');
  });

  it('rejects when the employee has no active membership at that head office', async () => {
    const { mockRepos } = hoRepos({
      memberships: { hasActiveAtHeadOffice: vi.fn().mockResolvedValue(false) },
    });
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    await expect(
      service.punchIn(actor, companyId, {
        headOfficeId: 'ho-1',
        latitude: 25.5941,
        longitude: 85.1376,
      }),
    ).rejects.toThrow('no active membership');
  });

  it('enforces the head-office geofence under a strict policy', async () => {
    const { mockRepos } = hoRepos();
    const service = new AttendanceService(createMockUow(mockRepos), authorizer);
    await expect(
      service.punchIn(actor, companyId, {
        headOfficeId: 'ho-1',
        latitude: 26.0, // ~45km away
        longitude: 85.6,
      }),
    ).rejects.toThrow();
  });
});
