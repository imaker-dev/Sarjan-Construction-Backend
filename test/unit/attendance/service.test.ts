import { describe, expect, it, vi } from 'vitest';
import type { AttendanceSession, Site } from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import {
  ActiveSessionExistsError,
  BreakAlreadyActiveError,
  GeofenceBreachError,
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
  return {
    run: async <T>(fn: (r: AttendanceRepos) => Promise<T>): Promise<T> => {
      return fn(repos as AttendanceRepos);
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
            if (id === 'e-inactive') return { id: 'e-inactive', displayName: 'Inactive', status: 'SUSPENDED' };
            return { id, displayName: id, status: 'ACTIVE' };
          }),
        } as unknown as AttendanceRepos['employees'],
        sessions: {
          findActive: vi.fn().mockImplementation(async (_: string, id: string) => {
            if (id === 'e-active') return { id: 'sess-already-in' };
            return null;
          }),
          create: vi.fn().mockImplementation(async (_: string, data: { employee: { connect: { id: string } } }) => {
            return { id: `sess-${data.employee.connect.id}`, ...data };
          }),
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
          update: vi.fn().mockImplementation(async (_: string, id: string, data: Record<string, unknown>) => ({
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
        sessions: {
          findByClientSessionId: vi.fn().mockImplementation(async (_: string, clientSessionId: string) => {
            if (clientSessionId === 'cs-already-synced') {
              return { id: 'sess-already', clientSessionId };
            }
            return null;
          }),
          create: vi.fn().mockImplementation(async (_: string, data: { clientSessionId?: string }) => ({
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
            attendees: [{ id: 'att-1', employeeId: 'e-1' }, { id: 'att-2', employeeId: 'e-2' }],
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
  });
});
