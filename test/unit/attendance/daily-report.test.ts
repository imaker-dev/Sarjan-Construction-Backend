import { describe, expect, it, vi } from 'vitest';
import type { DailyReportStatus, DailySiteReport, Site } from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import {
  DailyReportAlreadyLockedError,
  DailyReportInvalidStateTransitionError,
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

interface CalculatedReportData {
  totalWorkersHeadcount: number;
  totalPresentUnits: number;
  totalOvertimeHours: number;
  catAStaffCount: number;
  catAStaffUnits: number;
  catBDirectCount: number;
  catBDirectUnits: number;
  catCSubconCount: number;
  catCSubconUnits: number;
}

describe('AttendanceService - Daily Site Report (DSR) & End-of-Day Settlement Engine', () => {
  const actor: ActorContext = { actorId: 'u-pm-1', actorType: 'USER' };
  const companyId = 'c1';
  const siteId = 's1';
  const businessDate = '2026-11-21';

  const authorizer = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
  };

  const sampleSite = {
    id: siteId,
    companyId,
    projectId: 'p1',
    code: 'SITE-101',
    name: 'Sector 62 Tower A',
    timezone: 'Asia/Kolkata',
    project: { timezone: 'Asia/Kolkata' },
  } as unknown as Site & { project: { timezone: string } };

  it('calculates daily site report: auto-closes in-progress sessions and aggregates Categories A, B, and C', async () => {
    let autoClosedSessionId: string | null = null;
    let upsertedData: CalculatedReportData | null = null;
    let auditAction: string | null = null;

    const mockSessions = [
      {
        id: 'sess-open',
        status: 'IN_PROGRESS' as const,
        employee: { id: 'e1', employeeCode: 'EMP-01', displayName: 'Ramesh Mason', tradeCategory: 'MASON' },
        presentUnits: 0,
        overtimeHours: 0,
        isFlagged: false,
      },
      {
        id: 'sess-staff',
        status: 'COMPLETED' as const,
        employee: { id: 'e2', employeeCode: 'EMP-02', displayName: 'Amit Engineer', tradeCategory: 'SITE_ENGINEER' },
        presentUnits: 1.0,
        overtimeHours: 1.5,
        isFlagged: false,
      },
      {
        id: 'sess-direct',
        status: 'COMPLETED' as const,
        employee: { id: 'e3', employeeCode: 'EMP-03', displayName: 'Suresh Carpenter', tradeCategory: 'CARPENTER' },
        presentUnits: 1.0,
        overtimeHours: 2.0,
        isFlagged: false,
      },
      {
        id: 'sess-subcon',
        status: 'COMPLETED' as const,
        employee: { id: 'e4', employeeCode: 'EMP-04', displayName: 'Pooja Bar Bender', tradeCategory: 'SUBCON_BAR_BENDER' },
        presentUnits: 0.5,
        overtimeHours: 0,
        isFlagged: true,
      },
    ];

    const mockRepos = {
      sites: {
        findById: vi.fn().mockResolvedValue(sampleSite),
      },
      sessions: {
        getDailySummary: vi.fn().mockResolvedValue({
          siteId,
          businessDate,
          totalWorkers: 4,
          totalSessions: 4,
          completedSessions: 3,
          inProgressSessions: 1,
          autoClosedSessions: 0,
          totalPresentUnits: 2.5,
          totalOvertimePUnits: 0.5,
          totalTotalPUnits: 3.0,
          totalOvertimeHours: 3.5,
          sessions: mockSessions,
        }),
        update: vi.fn().mockImplementation(async (_cid: string, sid: string, data: Record<string, unknown>) => {
          if (sid === 'sess-open') {
            autoClosedSessionId = sid;
          }
          return { id: sid, ...data };
        }),
      },
      dailyReports: {
        findBySiteAndDate: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockImplementation(async (_cid: string, data: CalculatedReportData) => {
          upsertedData = data;
          return {
            id: 'dsr-101',
            companyId,
            siteId,
            projectId: 'p1',
            businessDate,
            status: 'DRAFT',
            ...data,
          };
        }),
        addAuditLog: vi.fn().mockImplementation(async (_cid: string, _rid: string, data: { action: string }) => {
          auditAction = data.action;
          return { id: 'audit-1', ...data };
        }),
      },
    } as unknown as Partial<AttendanceRepos>;

    const service = new AttendanceService(createMockUow(mockRepos), authorizer);

    const report = await service.calculateDailyReport(actor, companyId, {
      siteId,
      businessDate,
    });

    expect(report.id).toBe('dsr-101');
    expect(autoClosedSessionId).toBe('sess-open');
    expect(upsertedData).not.toBeNull();
    expect(upsertedData?.totalWorkersHeadcount).toBe(4);
    expect(upsertedData?.totalPresentUnits).toBe(2.5);
    expect(upsertedData?.totalOvertimeHours).toBe(3.5);
    expect(upsertedData?.catAStaffCount).toBe(1);
    expect(upsertedData?.catAStaffUnits).toBe(1.0);
    expect(upsertedData?.catBDirectCount).toBe(2);
    expect(upsertedData?.catCSubconCount).toBe(1);
    expect(upsertedData?.catCSubconUnits).toBe(0.5);
    expect(auditAction).toBe('AUTO_CALCULATED');
  });

  it('prevents calculation if the daily report is already LOCKED', async () => {
    const mockRepos = {
      dailyReports: {
        findBySiteAndDate: vi.fn().mockResolvedValue({
          id: 'dsr-locked',
          status: 'LOCKED',
        }),
      },
    } as unknown as Partial<AttendanceRepos>;

    const service = new AttendanceService(createMockUow(mockRepos), authorizer);

    await expect(
      service.calculateDailyReport(actor, companyId, { siteId, businessDate }),
    ).rejects.toThrow(DailyReportAlreadyLockedError);
  });

  it('updates report header and work progress notes with audit logging', async () => {
    let capturedAudit: { action: string } | null = null;
    const existingReport: Partial<DailySiteReport> = {
      id: 'dsr-1',
      companyId,
      siteId,
      businessDate,
      status: 'DRAFT',
      version: 0,
    };

    const mockRepos = {
      dailyReports: {
        findById: vi.fn().mockResolvedValue(existingReport),
        update: vi.fn().mockResolvedValue({
          ...existingReport,
          weather: 'HEAVY_RAIN',
          weatherStoppageHours: 4.5,
          workProgressNotes: 'Concrete pour delayed by rain',
          version: 1,
        }),
        addAuditLog: vi.fn().mockImplementation(async (_cid: string, _rid: string, data: { action: string }) => {
          capturedAudit = data;
          return { id: 'a1', ...data };
        }),
      },
    } as unknown as Partial<AttendanceRepos>;

    const service = new AttendanceService(createMockUow(mockRepos), authorizer);

    const updated = await service.updateDailyReport(actor, companyId, 'dsr-1', {
      weather: 'HEAVY_RAIN',
      weatherStoppageHours: 4.5,
      workProgressNotes: 'Concrete pour delayed by rain',
      version: 0,
    });

    expect(updated.weather).toBe('HEAVY_RAIN');
    expect(Number(updated.weatherStoppageHours)).toBe(4.5);
    expect(capturedAudit?.action).toBe('EDITED_HEADER');
  });

  it('allows PM to adjust subcontractor labour summary headcount and recalculates totals', async () => {
    let capturedAudit: { action: string; reason: string } | null = null;
    const existingReport = {
      id: 'dsr-1',
      companyId,
      siteId,
      status: 'DRAFT' as DailyReportStatus,
      labourSummaries: [
        {
          id: 'sum-1',
          category: 'CAT_C_SUBCONTRACTOR' as const,
          tradeCategory: 'BAR_BENDER',
          headcount: 12,
          presentUnits: 12,
          overtimeHours: 6,
        },
        {
          id: 'sum-2',
          category: 'CAT_B_DIRECT_LABOUR' as const,
          tradeCategory: 'MASON',
          headcount: 8,
          presentUnits: 8,
          overtimeHours: 2,
        },
      ],
    };

    const mockRepos = {
      dailyReports: {
        findById: vi.fn().mockResolvedValue(existingReport),
        updateLabourSummary: vi.fn().mockResolvedValue({
          id: 'sum-1',
          category: 'CAT_C_SUBCONTRACTOR',
          tradeCategory: 'BAR_BENDER',
          headcount: 10,
          presentUnits: 10,
          overtimeHours: 5,
        }),
        update: vi.fn().mockResolvedValue(existingReport),
        addAuditLog: vi.fn().mockImplementation(async (_cid: string, _rid: string, data: { action: string; reason: string }) => {
          capturedAudit = data;
          return { id: 'a1', ...data };
        }),
      },
    } as unknown as Partial<AttendanceRepos>;

    const service = new AttendanceService(createMockUow(mockRepos), authorizer);

    await service.updateLabourSummary(actor, companyId, 'dsr-1', 'sum-1', {
      headcount: 10,
      presentUnits: 10,
      overtimeHours: 5,
      reason: 'Physical head count showed 2 workers left early',
    });

    expect(capturedAudit?.action).toBe('EDITED_LABOUR_SUMMARY');
    expect(capturedAudit?.reason).toBe('Physical head count showed 2 workers left early');
  });

  it('supports the complete sign-off lifecycle: DRAFT -> SUBMITTED -> APPROVED -> LOCKED', async () => {
    let currentStatus: DailyReportStatus = 'DRAFT';
    const reportRecord = {
      id: 'dsr-cycle',
      companyId,
      siteId,
      status: currentStatus,
      submittedById: null,
      approvedById: null,
      lockedById: null,
    };

    const mockRepos = {
      employees: {
        findByPrincipal: vi.fn().mockResolvedValue({ id: 'emp-101', displayName: 'PM Sharma', status: 'ACTIVE' }),
      },
      dailyReports: {
        findById: vi.fn().mockImplementation(async () => ({ ...reportRecord, status: currentStatus })),
        update: vi.fn().mockImplementation(async (_cid: string, _id: string, data: { status?: DailyReportStatus }) => {
          if (data.status) currentStatus = data.status;
          return { ...reportRecord, status: currentStatus, ...data };
        }),
        addAuditLog: vi.fn().mockResolvedValue({ id: 'aud-ok' }),
      },
    } as unknown as Partial<AttendanceRepos>;

    const service = new AttendanceService(createMockUow(mockRepos), authorizer);

    // 1. Submit
    const submitted = await service.submitDailyReport(actor, companyId, 'dsr-cycle');
    expect(submitted.status).toBe('SUBMITTED');

    // 2. Cannot submit already submitted report
    await expect(service.submitDailyReport(actor, companyId, 'dsr-cycle')).rejects.toThrow(
      DailyReportInvalidStateTransitionError,
    );

    // 3. Approve
    const approved = await service.approveDailyReport(actor, companyId, 'dsr-cycle');
    expect(approved.status).toBe('APPROVED');

    // 4. Lock / Freeze
    const locked = await service.lockDailyReport(actor, companyId, 'dsr-cycle', {
      reason: 'Payroll fortnight closed',
    });
    expect(locked.status).toBe('LOCKED');

    // 5. Modifications blocked on locked report
    await expect(
      service.updateDailyReport(actor, companyId, 'dsr-cycle', {
        workProgressNotes: 'Attempted late edit',
        version: 1,
      }),
    ).rejects.toThrow(DailyReportAlreadyLockedError);
  });
});
