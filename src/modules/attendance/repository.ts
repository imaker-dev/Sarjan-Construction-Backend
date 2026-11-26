import type {
  AttendanceBreak,
  AttendancePolicy,
  AttendancePolicyScope,
  AttendanceSession,
  DailyReportAuditLog,
  DailyReportStatus,
  DailySiteReport,
  DailySiteReportLabour,
  Employee,
  LabourCategory,
  HeadOffice,
  Prisma,
  PrismaClient,
  SafetyTvtAttendee,
  SafetyTvtSession,
  Site,
  WeatherCondition,
} from '@prisma/client';
import { scopedUpdate, type AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';
import { ActiveSessionExistsError, AttendanceEntityNotFoundError } from './errors.js';
import {
  DEFAULT_ATTENDANCE_POLICY,
  calculateWeeklyWorkHoursProgress,
  resolveDateRangeForPeriod,
  type DailySummaryFilter,
  type DepartmentMusterSummary,
  type ListDailyReportsFilter,
  type ListSessionsFilter,
  type MusterRollRangeFilter,
  type WeeklyWorkHoursProgress,
} from './types.js';

type Tx = Prisma.TransactionClient;

export type AttendanceSessionWithDetails = AttendanceSession & {
  employee: Pick<Employee, 'id' | 'employeeCode' | 'displayName' | 'tradeCategory'>;
  site: Pick<Site, 'id' | 'code' | 'name'> | null;
  headOffice: Pick<HeadOffice, 'id' | 'code' | 'name'> | null;
  breaks: AttendanceBreak[];
  policy?: Pick<AttendancePolicy, 'id' | 'name' | 'overtimeMode' | 'breakMode'> | null;
};

export interface AttendanceRepos {
  policies: {
    findById(companyId: string, id: string): Promise<AttendancePolicy | null>;
    findEffective(
      companyId: string,
      criteria: { employeeId?: string; siteId?: string; projectId?: string },
    ): Promise<AttendancePolicy | null>;
    findEmployeePolicies?(companyId: string, employeeIds: string[]): Promise<AttendancePolicy[]>;
    ensureDefaultPolicy?(companyId: string): Promise<AttendancePolicy>;
    list(
      companyId: string,
      filter?: { scope?: AttendancePolicyScope },
    ): Promise<AttendancePolicy[]>;
    create(
      companyId: string,
      data: Omit<Prisma.AttendancePolicyCreateInput, 'company'>,
    ): Promise<AttendancePolicy>;
    update(
      companyId: string,
      id: string,
      data: Prisma.AttendancePolicyUpdateInput,
      expectedVersion?: number,
    ): Promise<AttendancePolicy>;
  };
  sessions: {
    findById(companyId: string, id: string): Promise<AttendanceSessionWithDetails | null>;
    findActive(
      companyId: string,
      employeeId: string,
    ): Promise<(AttendanceSession & { breaks: AttendanceBreak[] }) | null>;
    findByEmployeeAndDate?(
      companyId: string,
      employeeId: string,
      businessDate: string,
    ): Promise<(AttendanceSession & { breaks: AttendanceBreak[] })[]>;
    findActiveMany?(
      companyId: string,
      employeeIds: string[],
    ): Promise<
      (AttendanceSession & {
        breaks: AttendanceBreak[];
        policy: AttendancePolicy | null;
      })[]
    >;
    findManyByClientSessionIds?(
      companyId: string,
      clientSessionIds: string[],
    ): Promise<AttendanceSession[]>;
    list(companyId: string, filter: ListSessionsFilter): Promise<AttendanceSessionWithDetails[]>;
    create(
      companyId: string,
      data: Omit<Prisma.AttendanceSessionCreateInput, 'company'>,
    ): Promise<AttendanceSession>;
    update(
      companyId: string,
      id: string,
      data: Prisma.AttendanceSessionUpdateInput,
      expectedVersion?: number,
    ): Promise<AttendanceSession>;
    findByClientSessionId(
      companyId: string,
      clientSessionId: string,
    ): Promise<AttendanceSession | null>;
    findSessionsForDateRange?(
      companyId: string,
      employeeId: string,
      from: string,
      to: string,
    ): Promise<AttendanceSession[]>;
    autoCloseStaleSessions?(cutoffDate: Date, companyId?: string): Promise<number>;
    /** IN_PROGRESS sessions whose resolved scheduled end is due (mode set,
     *  scheduledEndAt <= now). Grace is applied per-row by the caller. */
    findDueForScheduledClose?(
      companyId: string | undefined,
      now: Date,
    ): Promise<(AttendanceSession & { breaks: AttendanceBreak[] })[]>;
    /** Conditional close — only transitions while still IN_PROGRESS, so
     *  repeated/concurrent runs are idempotent. Returns the closed row or
     *  null when another run already closed it. */
    autoCloseSession?(
      companyId: string,
      id: string,
      data: Prisma.AttendanceSessionUpdateInput,
    ): Promise<AttendanceSession | null>;
    /** Latest AUTO_CLOSED session for an employee (for post-close punch-out
     *  correction handling). */
    findLatestAutoClosed?(
      companyId: string,
      employeeId: string,
      since: Date,
    ): Promise<(AttendanceSession & { breaks: AttendanceBreak[] }) | null>;
    /** IN_PROGRESS sessions at an anchor whose business date has already
     *  ended — settlement closes these; same-day sessions wait for their
     *  scheduled end (or the 24h sweep when no schedule is pinned). The
     *  auto-close fields let settlement skip overnight shifts still inside
     *  their pinned window. */
    findOpenBeforeBusinessDate?(
      companyId: string,
      anchor: { siteId?: string; headOfficeId?: string },
      currentBusinessDate: string,
    ): Promise<
      {
        id: string;
        scheduledEndAt: Date | null;
        autoClockOutMode: string | null;
        autoClockOutGraceMins: number | null;
      }[]
    >;
    getMusterRollRange(
      companyId: string,
      filter: MusterRollRangeFilter,
    ): Promise<{
      siteId?: string;
      headOfficeId?: string;
      departmentId?: string;
      period?: string;
      from: string;
      to: string;
      totalSessions: number;
      totalMandays: number;
      totalPresentUnits: number;
      totalOvertimePUnits: number;
      totalTotalPUnits: number;
      totalOvertimeHours: number;
      departmentSummaries?: DepartmentMusterSummary[];
      workerSummaries: {
        employeeId: string;
        employeeCode: string;
        displayName: string;
        tradeCategory: string | null;
        designation?: string | null;
        department?: { id: string; code: string; name: string } | null;
        presentUnits: number;
        overtimePUnits: number;
        totalPUnits: number;
        overtimeHours: number;
        sessionsCount: number;
        daysPresent: number;
        leaveDays: number;
        weeklyProgress?: WeeklyWorkHoursProgress;
      }[];
      sessions: AttendanceSessionWithDetails[];
      leaves: unknown[];
    }>;
    getDailySummary(
      companyId: string,
      siteIdOrFilter: string | DailySummaryFilter,
      businessDate?: string,
    ): Promise<{
      siteId?: string;
      headOfficeId?: string;
      departmentId?: string;
      businessDate: string;
      totalWorkers: number;
      totalSessions: number;
      completedSessions: number;
      inProgressSessions: number;
      autoClosedSessions: number;
      totalPresentUnits: number;
      totalOvertimePUnits: number;
      totalTotalPUnits: number;
      totalOvertimeHours: number;
      departmentSummaries?: DepartmentMusterSummary[];
      sessions: AttendanceSessionWithDetails[];
      totalApprovedLeaves?: number;
      leaves?: unknown[];
    }>;
  };
  tvt: {
    create(
      companyId: string,
      data: {
        siteId: string;
        businessDate: string;
        topic: string;
        conductedAt?: Date;
        conductedBy: string;
        remarks?: string | null;
        attendeeEmployeeIds?: string[];
      },
    ): Promise<SafetyTvtSession & { attendees: SafetyTvtAttendee[] }>;
    findById(
      companyId: string,
      id: string,
    ): Promise<
      | (SafetyTvtSession & {
        attendees: (SafetyTvtAttendee & {
          employee: Pick<Employee, 'id' | 'employeeCode' | 'displayName' | 'tradeCategory'>;
        })[];
      })
      | null
    >;
    list(
      companyId: string,
      filter: { siteId?: string; businessDate?: string; limit?: number; cursor?: string },
    ): Promise<(SafetyTvtSession & { _count: { attendees: number } })[]>;
    addAttendees(companyId: string, sessionId: string, employeeIds: string[]): Promise<number>;
    hasAttended(
      companyId: string,
      siteId: string,
      employeeId: string,
      businessDate: string,
    ): Promise<boolean>;
    findAttendeesForSiteAndDate?(
      companyId: string,
      siteId: string,
      businessDate: string,
      employeeIds: string[],
    ): Promise<string[]>;
  };
  breaks: {
    findById(companyId: string, id: string): Promise<AttendanceBreak | null>;
    create(
      companyId: string,
      data: Omit<Prisma.AttendanceBreakCreateInput, 'company'>,
    ): Promise<AttendanceBreak>;
    update(
      companyId: string,
      id: string,
      data: Prisma.AttendanceBreakUpdateInput,
    ): Promise<AttendanceBreak>;
    findActive(companyId: string, sessionId: string): Promise<AttendanceBreak | null>;
    listForSession(companyId: string, sessionId: string): Promise<AttendanceBreak[]>;
  };
  sites: {
    findById(
      companyId: string,
      id: string,
    ): Promise<
      | (Site & {
        project: { timezone: string };
      })
      | null
    >;
  };
  headOffices: {
    findById(companyId: string, id: string): Promise<HeadOffice | null>;
  };
  departments: {
    /** Scope fields only — for authorization target resolution. */
    findById(
      companyId: string,
      id: string,
    ): Promise<{
      id: string;
      scopeType: string;
      siteId: string | null;
      projectId: string | null;
      baseHeadOfficeId: string | null;
    } | null>;
  };
  memberships: {
    hasActiveAtHeadOffice(
      companyId: string,
      employeeId: string,
      headOfficeId: string,
    ): Promise<boolean>;
    /** W4: effective membership in a department scoped to THIS EXACT site —
     *  project-only memberships do not authorize punching at child sites. */
    hasActiveAtSite(companyId: string, employeeId: string, siteId: string): Promise<boolean>;
    /** Effective membership in a PROJECT-scoped department (e.g. Project Incharge / Director). */
    hasActiveAtProject?(companyId: string, employeeId: string, projectId: string): Promise<boolean>;
    /** Active membership anchors for scope resolution — the employee's
     *  departments with their location fields. */
    findActiveByEmployee?(
      companyId: string,
      employeeId: string,
    ): Promise<
      {
        department: {
          scopeType: string;
          siteId: string | null;
          projectId: string | null;
          baseHeadOfficeId: string | null;
        };
      }[]
    >;
  };
  employees: {
    findByPrincipal(
      companyId: string,
      principalId: string,
    ): Promise<{ id: string; displayName: string; status: string } | null>;
    findById(
      companyId: string,
      id: string,
    ): Promise<{ id: string; displayName: string; status: string } | null>;
    findManyByIds?(
      companyId: string,
      ids: string[],
    ): Promise<{ id: string; displayName: string; status: string }[]>;
  };
  dailyReports: {
    findById(
      companyId: string,
      id: string,
    ): Promise<
      | (DailySiteReport & {
        labourSummaries: DailySiteReportLabour[];
        auditLogs: DailyReportAuditLog[];
        site: Pick<Site, 'id' | 'code' | 'name'>;
        project: { id: string; code: string; name: string };
        submittedBy?: { id: string; employeeCode: string; displayName: string } | null;
        approvedBy?: { id: string; employeeCode: string; displayName: string } | null;
        lockedBy?: { id: string; employeeCode: string; displayName: string } | null;
      })
      | null
    >;
    findBySiteAndDate(
      companyId: string,
      siteId: string,
      businessDate: string,
    ): Promise<
      | (DailySiteReport & {
        labourSummaries: DailySiteReportLabour[];
      })
      | null
    >;
    list(
      companyId: string,
      filter: ListDailyReportsFilter & {
        scopeFilter?: { projectIds: string[]; siteIds: string[]; headOfficeIds: string[] };
      },
    ): Promise<{
      items: (DailySiteReport & {
        site: Pick<Site, 'id' | 'code' | 'name'>;
        project: { id: string; code: string; name: string };
      })[];
      total: number;
    }>;
    upsert(
      companyId: string,
      data: {
        siteId: string;
        projectId: string;
        businessDate: string;
        status?: DailyReportStatus;
        weather?: WeatherCondition;
        weatherStoppageHours?: number | Prisma.Decimal;
        workProgressNotes?: string | null;
        siteObstaclesRemarks?: string | null;
        safetyIncidentReported?: boolean;
        safetyNotes?: string | null;
        totalWorkersHeadcount: number;
        totalPresentUnits: number | Prisma.Decimal;
        totalOvertimeHours: number | Prisma.Decimal;
        totalOvertimePUnits: number | Prisma.Decimal;
        totalFlaggedSessions: number;
        catAStaffCount: number;
        catAStaffUnits: number | Prisma.Decimal;
        catBDirectCount: number;
        catBDirectUnits: number | Prisma.Decimal;
        catCSubconCount: number;
        catCSubconUnits: number | Prisma.Decimal;
        labourSummaries?: {
          category: LabourCategory;
          subcontractorId?: string | null;
          subcontractorName?: string | null;
          tradeCategory: string;
          headcount: number;
          presentUnits: number | Prisma.Decimal;
          overtimeHours: number | Prisma.Decimal;
          remarks?: string | null;
        }[];
      },
    ): Promise<DailySiteReport & { labourSummaries: DailySiteReportLabour[] }>;
    update(
      companyId: string,
      id: string,
      data: Prisma.DailySiteReportUpdateInput,
      expectedVersion?: number,
    ): Promise<DailySiteReport>;
    updateLabourSummary(
      companyId: string,
      reportId: string,
      summaryId: string,
      data: Prisma.DailySiteReportLabourUpdateInput,
    ): Promise<DailySiteReportLabour>;
    addAuditLog(
      companyId: string,
      reportId: string,
      data: {
        actorId: string;
        action: string;
        fieldName?: string;
        oldValue?: string;
        newValue?: string;
        reason: string;
      },
    ): Promise<DailyReportAuditLog>;
    getAuditLogs(companyId: string, reportId: string): Promise<DailyReportAuditLog[]>;
    getActiveSitesForSettlement(
      companyId?: string,
    ): Promise<{ id: string; companyId: string; projectId: string }[]>;
  };
  audit: AuditRepository;
}

export function makeAttendanceRepos(tx: Tx): AttendanceRepos {
  return {
    policies: {
      findById: (companyId, id) =>
        tx.attendancePolicy.findFirst({
          where: { id, companyId },
        }),
      findEffective: async (companyId, { employeeId, siteId, projectId }) => {
        // Tier 1: Employee-level override
        if (employeeId) {
          const empPolicy = await tx.attendancePolicy.findFirst({
            where: { companyId, scope: 'EMPLOYEE', employeeId, status: 'ACTIVE' },
          });
          if (empPolicy) return empPolicy;
        }

        // Tier 2: Site-level policy
        if (siteId) {
          const sitePolicy = await tx.attendancePolicy.findFirst({
            where: { companyId, scope: 'SITE', siteId, status: 'ACTIVE' },
          });
          if (sitePolicy) return sitePolicy;
        }

        // Tier 3: Project-level policy
        if (projectId) {
          const projPolicy = await tx.attendancePolicy.findFirst({
            where: { companyId, scope: 'PROJECT', projectId, status: 'ACTIVE' },
          });
          if (projPolicy) return projPolicy;
        }

        // Tier 4: Company-level default policy
        return tx.attendancePolicy.findFirst({
          where: { companyId, scope: 'COMPANY', status: 'ACTIVE' },
        });
      },
      findEmployeePolicies: (companyId, employeeIds) =>
        tx.attendancePolicy.findMany({
          where: {
            companyId,
            scope: 'EMPLOYEE',
            employeeId: { in: employeeIds },
            status: 'ACTIVE',
          },
        }),
      ensureDefaultPolicy: async (companyId) => {
        const existing = await tx.attendancePolicy.findFirst({
          where: { companyId, scope: 'COMPANY', status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
        });
        if (existing) return existing;

        const byName = await tx.attendancePolicy.findFirst({
          where: { companyId, name: 'Company Default Policy' },
        });
        if (byName) return byName;

        return tx.attendancePolicy.create({
          data: {
            company: { connect: { id: companyId } },
            name: 'Company Default Policy',
            description: 'Default company attendance policy (8:00 AM to 8:00 AM cycle)',
            scope: 'COMPANY',
            dayStartHour: DEFAULT_ATTENDANCE_POLICY.dayStartHour,
            dayStartMinute: DEFAULT_ATTENDANCE_POLICY.dayStartMinute,
            shiftDurationMins: DEFAULT_ATTENDANCE_POLICY.shiftDurationMins,
            halfDayThresholdMins: DEFAULT_ATTENDANCE_POLICY.halfDayThresholdMins,
            fullDayThresholdMins: DEFAULT_ATTENDANCE_POLICY.fullDayThresholdMins,
            breakMode: DEFAULT_ATTENDANCE_POLICY.breakMode,
            fixedBreakMins: DEFAULT_ATTENDANCE_POLICY.fixedBreakMins,
            minWorkForBreakMins: DEFAULT_ATTENDANCE_POLICY.minWorkForBreakMins,
            maxDynamicBreakMins: DEFAULT_ATTENDANCE_POLICY.maxDynamicBreakMins,
            overtimeMode: DEFAULT_ATTENDANCE_POLICY.overtimeMode,
            minOvertimeMins: DEFAULT_ATTENDANCE_POLICY.minOvertimeMins,
            otSlabMins: DEFAULT_ATTENDANCE_POLICY.otSlabMins,
            geofenceStrict: DEFAULT_ATTENDANCE_POLICY.geofenceStrict,
            allowMobilePunch: DEFAULT_ATTENDANCE_POLICY.allowMobilePunch,
            allowKioskPunch: DEFAULT_ATTENDANCE_POLICY.allowKioskPunch,
            allowBiometric: DEFAULT_ATTENDANCE_POLICY.allowBiometric,
            requireTvtGate: DEFAULT_ATTENDANCE_POLICY.requireTvtGate,
            tvtGateAction: DEFAULT_ATTENDANCE_POLICY.tvtGateAction,
          },
        });
      },
      list: (companyId, filter) =>
        tx.attendancePolicy.findMany({
          where: {
            companyId,
            ...(filter?.scope ? { scope: filter.scope } : {}),
          },
          orderBy: { createdAt: 'desc' },
        }),
      create: (companyId, data) =>
        tx.attendancePolicy.create({
          data: {
            ...data,
            company: { connect: { id: companyId } },
          },
        }),
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'ATTENDANCE_POLICY',
          { id, companyId },
          data as Record<string, unknown>,
          expectedVersion,
          (args) => tx.attendancePolicy.updateMany(args),
          () => tx.attendancePolicy.findFirst({ where: { id, companyId } }),
        ),
    },
    sessions: {
      findById: (companyId, id) =>
        tx.attendanceSession.findFirst({
          where: { id, companyId },
          include: {
            employee: {
              select: { id: true, employeeCode: true, displayName: true, tradeCategory: true },
            },
            site: {
              select: { id: true, code: true, name: true },
            },
            headOffice: {
              select: { id: true, code: true, name: true },
            },
            policy: {
              select: { id: true, name: true, overtimeMode: true, breakMode: true },
            },
            breaks: {
              orderBy: { startedAt: 'asc' },
            },
          },
        }),
      findActive: async (companyId, employeeId) => {
        const session = await tx.attendanceSession.findFirst({
          where: {
            companyId,
            employeeId,
            status: 'IN_PROGRESS',
          },
          include: {
            breaks: true,
          },
          orderBy: { punchInAt: 'desc' },
        });
        if (!session) return null;
        // Auto-close stale sessions older than 24h
        const ageMs = Date.now() - session.punchInAt.getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
          await tx.attendanceSession.update({
            where: { id: session.id },
            data: {
              status: 'AUTO_CLOSED',
              punchOutRemarks: 'Auto-closed by system due to missing punch out (>24h)',
            },
          });
          return null;
        }
        return session;
      },
      findByEmployeeAndDate: (companyId, employeeId, businessDate) =>
        tx.attendanceSession.findMany({
          where: { companyId, employeeId, businessDate },
          include: {
            breaks: {
              orderBy: { startedAt: 'asc' },
            },
          },
          orderBy: { punchInAt: 'asc' },
        }),
      findActiveMany: (companyId, employeeIds) =>
        tx.attendanceSession.findMany({
          where: {
            companyId,
            employeeId: { in: employeeIds },
            status: 'IN_PROGRESS',
          },
          include: {
            breaks: true,
            policy: true,
          },
          orderBy: { punchInAt: 'desc' },
        }),
      findManyByClientSessionIds: (companyId, clientSessionIds) =>
        tx.attendanceSession.findMany({
          where: {
            companyId,
            clientSessionId: { in: clientSessionIds },
          },
        }),
      list: async (companyId, filter) => {
        return tx.attendanceSession.findMany({
          where: {
            companyId,
            ...(filter.siteId ? { siteId: filter.siteId } : {}),
            ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
            ...(filter.businessDate ? { businessDate: filter.businessDate } : {}),
            ...(filter.status ? { status: filter.status } : {}),
          },
          include: {
            employee: {
              select: { id: true, employeeCode: true, displayName: true, tradeCategory: true },
            },
            site: {
              select: { id: true, code: true, name: true },
            },
            headOffice: {
              select: { id: true, code: true, name: true },
            },
            policy: {
              select: { id: true, name: true, overtimeMode: true, breakMode: true },
            },
            breaks: {
              orderBy: { startedAt: 'asc' },
            },
          },
          orderBy: [{ punchInAt: 'desc' }, { id: 'desc' }],
          take: filter.limit ?? 50,
          ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
        });
      },
      create: async (companyId, data) => {
        try {
          return await tx.attendanceSession.create({
            data: {
              ...data,
              company: { connect: { id: companyId } },
            },
          });
        } catch (err: unknown) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: string }).code === 'P2002'
          ) {
            const empId =
              'connect' in data.employee && data.employee.connect.id
                ? data.employee.connect.id
                : 'unknown';
            throw new ActiveSessionExistsError(empId);
          }
          throw err;
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'ATTENDANCE_SESSION',
          { id, companyId },
          data as Record<string, unknown>,
          expectedVersion,
          (args) => tx.attendanceSession.updateMany(args),
          () => tx.attendanceSession.findFirst({ where: { id, companyId } }),
        ),
      findByClientSessionId: (companyId, clientSessionId) =>
        tx.attendanceSession.findFirst({
          where: { companyId, clientSessionId },
        }),
      findSessionsForDateRange: (companyId, employeeId, from, to) =>
        tx.attendanceSession.findMany({
          where: {
            companyId,
            employeeId,
            businessDate: { gte: from, lte: to },
          },
          include: {
            breaks: true,
          },
          orderBy: { punchInAt: 'asc' },
        }),
      autoCloseStaleSessions: async (cutoffDate: Date, companyId?: string) => {
        const res = await tx.attendanceSession.updateMany({
          where: {
            ...(companyId ? { companyId } : {}),
            status: 'IN_PROGRESS',
            punchInAt: { lt: cutoffDate },
          },
          data: {
            status: 'AUTO_CLOSED',
            autoClosedBy: 'STALE_SWEEP',
            punchOutRemarks: 'Auto-closed by background worker sweep (>24h shift)',
          },
        });
        return res.count;
      },
      findDueForScheduledClose: (companyId: string | undefined, now: Date) =>
        tx.attendanceSession.findMany({
          where: {
            ...(companyId ? { companyId } : {}),
            status: 'IN_PROGRESS',
            autoClockOutMode: { in: ['AT_SCHEDULED_END', 'AFTER_GRACE'] },
            scheduledEndAt: { not: null, lte: now },
          },
          include: { breaks: { orderBy: { startedAt: 'asc' } } },
          // Bounded: at most one IN_PROGRESS session per employee; companies
          // on this system are small-to-mid sized. Ordered for determinism.
          orderBy: { scheduledEndAt: 'asc' },
          take: 500,
        }),
      autoCloseSession: async (
        companyId: string,
        id: string,
        data: Prisma.AttendanceSessionUpdateInput,
      ) => {
        const res = await tx.attendanceSession.updateMany({
          where: { id, companyId, status: 'IN_PROGRESS' },
          data: {
            ...data,
            version: { increment: 1 },
          },
        });
        if (res.count === 0) return null;
        return tx.attendanceSession.findFirst({ where: { id, companyId } });
      },
      findLatestAutoClosed: (companyId: string, employeeId: string, since: Date) =>
        tx.attendanceSession.findFirst({
          where: {
            companyId,
            employeeId,
            status: 'AUTO_CLOSED',
            autoClosedBy: { not: null },
            punchInAt: { gte: since },
          },
          orderBy: { punchInAt: 'desc' },
          include: { breaks: { orderBy: { startedAt: 'asc' } } },
        }),
      findOpenBeforeBusinessDate: (
        companyId: string,
        anchor: { siteId?: string; headOfficeId?: string },
        currentBusinessDate: string,
      ) =>
        tx.attendanceSession.findMany({
          where: {
            companyId,
            status: 'IN_PROGRESS',
            businessDate: { lt: currentBusinessDate },
            ...(anchor.siteId !== undefined
              ? { siteId: anchor.siteId }
              : anchor.headOfficeId !== undefined
                ? { headOfficeId: anchor.headOfficeId }
                : {}),
          },
          select: {
            id: true,
            scheduledEndAt: true,
            autoClockOutMode: true,
            autoClockOutGraceMins: true,
          },
          take: 500,
        }),
      getMusterRollRange: async (companyId, filter) => {
        const { from: resolvedFrom, to: resolvedTo } = resolveDateRangeForPeriod(
          filter.period,
          filter.date,
          filter.from,
          filter.to,
        );

        const where: Prisma.AttendanceSessionWhereInput = {
          companyId,
          businessDate: { gte: resolvedFrom, lte: resolvedTo },
          ...(filter.siteId ? { siteId: filter.siteId } : {}),
          ...(filter.headOfficeId ? { headOfficeId: filter.headOfficeId } : {}),
          ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.departmentId
            ? {
              employee: {
                memberships: {
                  some: {
                    departmentId: filter.departmentId,
                    endedAt: null,
                  },
                },
              },
            }
            : {}),
        };

        const fromDate = new Date(`${resolvedFrom}T00:00:00.000Z`);
        const toDate = new Date(`${resolvedTo}T23:59:59.999Z`);

        const [sessions, totalsAgg, leaves] = await Promise.all([
          tx.attendanceSession.findMany({
            where,
            include: {
              employee: {
                select: {
                  id: true,
                  employeeCode: true,
                  displayName: true,
                  tradeCategory: true,
                  designation: true,
                  memberships: {
                    where: { endedAt: null },
                    select: {
                      isPrimary: true,
                      department: {
                        select: { id: true, code: true, name: true, category: true },
                      },
                    },
                  },
                },
              },
              site: { select: { id: true, code: true, name: true } },
              headOffice: { select: { id: true, code: true, name: true } },
              breaks: { orderBy: { startedAt: 'asc' } },
              policy: { select: { id: true, name: true, overtimeMode: true, breakMode: true } },
            },
            orderBy: [{ businessDate: 'asc' }, { punchInAt: 'asc' }],
          }),
          tx.attendanceSession.aggregate({
            where,
            _sum: {
              presentUnits: true,
              overtimePUnits: true,
              totalPUnits: true,
              overtimeHours: true,
            },
            _count: {
              _all: true,
            },
          }),
          tx.leaveRequest.findMany({
            where: {
              companyId,
              status: 'APPROVED',
              startDate: { lte: toDate },
              endDate: { gte: fromDate },
              ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
              ...(filter.departmentId
                ? {
                  employee: {
                    memberships: {
                      some: {
                        departmentId: filter.departmentId,
                        endedAt: null,
                      },
                    },
                  },
                }
                : {}),
            },
            include: {
              employee: {
                select: { id: true, employeeCode: true, displayName: true, designation: true },
              },
            },
          }),
        ]);

        const workerMap = new Map<
          string,
          {
            employeeId: string;
            employeeCode: string;
            displayName: string;
            tradeCategory: string | null;
            designation: string | null;
            department: { id: string; code: string; name: string } | null;
            presentUnits: number;
            overtimePUnits: number;
            totalPUnits: number;
            overtimeHours: number;
            sessionsCount: number;
            daysSet: Set<string>;
            leaveDays: number;
            sessionsList: Parameters<typeof calculateWeeklyWorkHoursProgress>[0]['weeklySessions'];
          }
        >();

        const deptMap = new Map<
          string,
          {
            departmentId: string;
            departmentCode: string;
            departmentName: string;
            category?: string | null;
            employeeIds: Set<string>;
            presentEmployeeIds: Set<string>;
            totalPresentUnits: number;
            totalOvertimeHours: number;
          }
        >();

        for (const s of sessions) {
          const pu = Number(s.presentUnits);
          const otP = Number(s.overtimePUnits);
          const totP = Number(s.totalPUnits);
          const otH = Number(s.overtimeHours);

          const emp = s.employee as typeof s.employee & {
            designation?: string | null;
            memberships: {
              isPrimary: boolean;
              department: { id: string; code: string; name: string; category: string };
            }[];
          };

          const primaryMembership = emp.memberships.find((m) => m.isPrimary) ?? emp.memberships[0];
          const dept = primaryMembership?.department
            ? {
              id: primaryMembership.department.id,
              code: primaryMembership.department.code,
              name: primaryMembership.department.name,
            }
            : null;

          if (primaryMembership?.department) {
            const d = primaryMembership.department;
            let dm = deptMap.get(d.id);
            if (!dm) {
              dm = {
                departmentId: d.id,
                departmentCode: d.code,
                departmentName: d.name,
                category: d.category,
                employeeIds: new Set<string>(),
                presentEmployeeIds: new Set<string>(),
                totalPresentUnits: 0,
                totalOvertimeHours: 0,
              };
              deptMap.set(d.id, dm);
            }
            dm.employeeIds.add(s.employeeId);
            dm.presentEmployeeIds.add(s.employeeId);
            dm.totalPresentUnits += pu;
            dm.totalOvertimeHours += otH;
          }

          let w = workerMap.get(s.employeeId);
          if (!w) {
            w = {
              employeeId: s.employeeId,
              employeeCode: emp.employeeCode,
              displayName: emp.displayName,
              tradeCategory: emp.tradeCategory,
              designation: emp.designation ?? null,
              department: dept,
              presentUnits: 0,
              overtimePUnits: 0,
              totalPUnits: 0,
              overtimeHours: 0,
              sessionsCount: 0,
              daysSet: new Set<string>(),
              leaveDays: 0,
              sessionsList: [],
            };
            workerMap.set(s.employeeId, w);
          }
          w.presentUnits += pu;
          w.overtimePUnits += otP;
          w.totalPUnits += totP;
          w.overtimeHours += otH;
          w.sessionsCount += 1;
          w.daysSet.add(s.businessDate);
          w.sessionsList.push({
            netDurationMins: s.netDurationMins,
            grossDurationMins: s.grossDurationMins,
            businessDate: s.businessDate,
            status: s.status,
            punchInAt: s.punchInAt,
            punchOutAt: s.punchOutAt,
            breaks: s.breaks,
          });
        }

        for (const l of leaves) {
          const w = workerMap.get(l.employeeId);
          if (w) {
            w.leaveDays += Number(l.totalDays);
          }
        }

        const todayStr = new Date().toISOString().slice(0, 10);
        const refDate = filter.date ?? (todayStr >= resolvedFrom && todayStr <= resolvedTo ? todayStr : resolvedTo);

        const workerSummaries = Array.from(workerMap.values()).map((w) => ({
          employeeId: w.employeeId,
          employeeCode: w.employeeCode,
          displayName: w.displayName,
          tradeCategory: w.tradeCategory,
          designation: w.designation,
          department: w.department,
          presentUnits: Number(w.presentUnits.toFixed(1)),
          overtimePUnits: Number(w.overtimePUnits.toFixed(1)),
          totalPUnits: Number(w.totalPUnits.toFixed(1)),
          overtimeHours: Number(w.overtimeHours.toFixed(2)),
          sessionsCount: w.sessionsCount,
          daysPresent: w.daysSet.size,
          leaveDays: w.leaveDays,
          weeklyProgress: calculateWeeklyWorkHoursProgress({
            businessDate: refDate,
            weeklySessions: w.sessionsList,
            targetWeeklyHours: 48.0,
          }),
        }));

        const departmentSummaries: DepartmentMusterSummary[] = Array.from(deptMap.values()).map(
          (d) => ({
            departmentId: d.departmentId,
            departmentCode: d.departmentCode,
            departmentName: d.departmentName,
            category: d.category ?? null,
            totalEmployees: d.employeeIds.size,
            presentCount: d.presentEmployeeIds.size,
            absentCount: Math.max(0, d.employeeIds.size - d.presentEmployeeIds.size),
            totalPresentUnits: Number(d.totalPresentUnits.toFixed(1)),
            totalOvertimeHours: Number(d.totalOvertimeHours.toFixed(2)),
          }),
        );

        return {
          ...(filter.siteId ? { siteId: filter.siteId } : {}),
          ...(filter.headOfficeId ? { headOfficeId: filter.headOfficeId } : {}),
          ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
          ...(filter.period ? { period: filter.period } : {}),
          from: resolvedFrom,
          to: resolvedTo,
          totalSessions: totalsAgg._count._all,
          totalMandays: workerSummaries.reduce((sum, w) => sum + w.daysPresent, 0),
          totalPresentUnits: Number(Number(totalsAgg._sum.presentUnits ?? 0).toFixed(1)),
          totalOvertimePUnits: Number(Number(totalsAgg._sum.overtimePUnits ?? 0).toFixed(1)),
          totalTotalPUnits: Number(Number(totalsAgg._sum.totalPUnits ?? 0).toFixed(1)),
          totalOvertimeHours: Number(Number(totalsAgg._sum.overtimeHours ?? 0).toFixed(2)),
          ...(departmentSummaries.length > 0 ? { departmentSummaries } : {}),
          workerSummaries,
          sessions,
          leaves,
        };
      },
      getDailySummary: async (companyId, siteIdOrFilter, bDate) => {
        let siteId: string | undefined;
        let headOfficeId: string | undefined;
        let departmentId: string | undefined;
        let businessDate: string;

        if (typeof siteIdOrFilter === 'string') {
          siteId = siteIdOrFilter;
          businessDate = bDate ?? new Date().toISOString().slice(0, 10);
        } else {
          siteId = siteIdOrFilter.siteId;
          headOfficeId = siteIdOrFilter.headOfficeId;
          departmentId = siteIdOrFilter.departmentId;
          businessDate = siteIdOrFilter.businessDate;
        }

        const where: Prisma.AttendanceSessionWhereInput = {
          companyId,
          businessDate,
          ...(siteId ? { siteId } : {}),
          ...(headOfficeId ? { headOfficeId } : {}),
          ...(departmentId
            ? {
              employee: {
                memberships: {
                  some: {
                    departmentId,
                    endedAt: null,
                  },
                },
              },
            }
            : {}),
        };

        const [sessions, statusGroups, totalsAgg, siteRoleAssignments, siteSessions] =
          await Promise.all([
            tx.attendanceSession.findMany({
              where,
              include: {
                employee: {
                  select: {
                    id: true,
                    employeeCode: true,
                    displayName: true,
                    tradeCategory: true,
                    designation: true,
                    memberships: {
                      where: { endedAt: null },
                      select: {
                        isPrimary: true,
                        department: {
                          select: { id: true, code: true, name: true, category: true },
                        },
                      },
                    },
                  },
                },
                site: {
                  select: { id: true, code: true, name: true },
                },
                headOffice: {
                  select: { id: true, code: true, name: true },
                },
                breaks: true,
              },
              orderBy: { punchInAt: 'asc' },
            }),
            tx.attendanceSession.groupBy({
              by: ['status'],
              where,
              _count: { _all: true },
            }),
            tx.attendanceSession.aggregate({
              where,
              _sum: {
                presentUnits: true,
                overtimePUnits: true,
                totalPUnits: true,
                overtimeHours: true,
              },
              _count: { _all: true },
            }),
            siteId
              ? tx.roleAssignment.findMany({
                where: { companyId, siteId, revokedAt: null },
                select: { principalId: true },
              })
              : Promise.resolve([]),
            siteId
              ? tx.attendanceSession.findMany({
                where: { companyId, siteId },
                select: { employeeId: true },
                distinct: ['employeeId'],
              })
              : Promise.resolve([]),
          ]);

        const businessDateObj = new Date(`${businessDate}T00:00:00.000Z`);

        const sitePrincipalIds = siteRoleAssignments
          .map((r) => r.principalId)
          .filter((pid): pid is string => Boolean(pid));

        const siteRoleEmployees =
          sitePrincipalIds.length > 0
            ? await tx.employee.findMany({
              where: { companyId, principalId: { in: sitePrincipalIds } },
              select: { id: true },
            })
            : [];

        const siteWorkerIds = new Set<string>([
          ...siteSessions.map((s) => s.employeeId),
          ...siteRoleEmployees.map((e) => e.id),
        ]);

        const leaves =
          siteWorkerIds.size > 0
            ? await tx.leaveRequest.findMany({
              where: {
                companyId,
                employeeId: { in: Array.from(siteWorkerIds) },
                status: 'APPROVED',
                startDate: { lte: businessDateObj },
                endDate: { gte: businessDateObj },
              },
              include: {
                employee: {
                  select: { id: true, employeeCode: true, displayName: true, designation: true },
                },
              },
            })
            : [];

        const distinctEmployees = new Set(sessions.map((s) => s.employeeId));
        let completedSessions = 0;
        let inProgressSessions = 0;
        let autoClosedSessions = 0;

        for (const g of statusGroups) {
          if (g.status === 'COMPLETED') completedSessions = g._count._all;
          else if (g.status === 'IN_PROGRESS') inProgressSessions = g._count._all;
          else if (g.status === 'AUTO_CLOSED') autoClosedSessions = g._count._all;
        }

        const deptMap = new Map<string, DepartmentMusterSummary>();
        for (const s of sessions) {
          const emp = s.employee as typeof s.employee & {
            memberships: {
              isPrimary: boolean;
              department: { id: string; code: string; name: string; category: string };
            }[];
          };
          const primaryMembership = emp.memberships.find((m) => m.isPrimary) ?? emp.memberships[0];
          if (primaryMembership?.department) {
            const d = primaryMembership.department;
            let dm = deptMap.get(d.id);
            if (!dm) {
              dm = {
                departmentId: d.id,
                departmentCode: d.code,
                departmentName: d.name,
                category: d.category,
                totalEmployees: 0,
                presentCount: 0,
                absentCount: 0,
                totalPresentUnits: 0,
                totalOvertimeHours: 0,
              };
              deptMap.set(d.id, dm);
            }
            dm.presentCount += 1;
            dm.totalEmployees += 1;
            dm.totalPresentUnits = Number(
              (dm.totalPresentUnits + Number(s.presentUnits)).toFixed(1),
            );
            dm.totalOvertimeHours = Number(
              (dm.totalOvertimeHours + Number(s.overtimeHours)).toFixed(2),
            );
          }
        }

        return {
          ...(siteId ? { siteId } : {}),
          ...(headOfficeId ? { headOfficeId } : {}),
          ...(departmentId ? { departmentId } : {}),
          businessDate,
          totalWorkers: distinctEmployees.size,
          totalSessions: totalsAgg._count._all,
          completedSessions,
          inProgressSessions,
          autoClosedSessions,
          totalPresentUnits: Number(Number(totalsAgg._sum.presentUnits ?? 0).toFixed(1)),
          totalOvertimePUnits: Number(Number(totalsAgg._sum.overtimePUnits ?? 0).toFixed(1)),
          totalTotalPUnits: Number(Number(totalsAgg._sum.totalPUnits ?? 0).toFixed(1)),
          totalOvertimeHours: Number(Number(totalsAgg._sum.overtimeHours ?? 0).toFixed(2)),
          ...(deptMap.size > 0 ? { departmentSummaries: Array.from(deptMap.values()) } : {}),
          totalApprovedLeaves: leaves.length,
          sessions,
          leaves,
        };
      },
    },
    breaks: {
      findById: (companyId, id) =>
        tx.attendanceBreak.findFirst({
          where: { id, companyId },
        }),
      create: (companyId, data) =>
        tx.attendanceBreak.create({
          data: {
            ...data,
            company: { connect: { id: companyId } },
          },
        }),
      update: (companyId, id, data) =>
        tx.attendanceBreak.update({
          where: { id, companyId },
          data,
        }),
      findActive: (companyId, sessionId) =>
        tx.attendanceBreak.findFirst({
          where: {
            companyId,
            sessionId,
            endedAt: null,
          },
          orderBy: { startedAt: 'desc' },
        }),
      listForSession: (companyId, sessionId) =>
        tx.attendanceBreak.findMany({
          where: { companyId, sessionId },
          orderBy: { startedAt: 'asc' },
        }),
    },
    sites: {
      findById: (companyId, id) =>
        tx.site.findFirst({
          where: { id, companyId },
          include: {
            project: { select: { timezone: true } },
          },
        }),
    },
    headOffices: {
      findById: (companyId, id) => tx.headOffice.findFirst({ where: { id, companyId } }),
    },
    departments: {
      findById: (companyId, id) =>
        tx.department.findFirst({
          where: { id, companyId },
          select: {
            id: true,
            scopeType: true,
            siteId: true,
            projectId: true,
            baseHeadOfficeId: true,
          },
        }),
    },
    memberships: {
      hasActiveAtHeadOffice: async (companyId, employeeId, headOfficeId) =>
        (await tx.departmentMembership.count({
          where: {
            companyId,
            employeeId,
            endedAt: null,
            department: { baseHeadOfficeId: headOfficeId, status: 'ACTIVE' },
          },
        })) > 0,
      hasActiveAtSite: async (companyId, employeeId, siteId) =>
        (await tx.departmentMembership.count({
          where: {
            companyId,
            employeeId,
            endedAt: null,
            department: { siteId, status: 'ACTIVE' },
          },
        })) > 0,
      hasActiveAtProject: async (companyId, employeeId, projectId) =>
        (await tx.departmentMembership.count({
          where: {
            companyId,
            employeeId,
            endedAt: null,
            department: { scopeType: 'PROJECT', projectId, status: 'ACTIVE' },
          },
        })) > 0,
      findActiveByEmployee: (companyId, employeeId) =>
        tx.departmentMembership.findMany({
          where: { companyId, employeeId, endedAt: null },
          select: {
            department: {
              select: {
                scopeType: true,
                siteId: true,
                projectId: true,
                baseHeadOfficeId: true,
              },
            },
          },
          take: 20,
        }),
    },
    employees: {
      findByPrincipal: (companyId, principalId) =>
        tx.employee.findFirst({
          where: { companyId, principalId },
          select: { id: true, displayName: true, status: true },
        }),
      findById: (companyId, id) =>
        tx.employee.findFirst({
          where: { id, companyId },
          select: { id: true, displayName: true, status: true },
        }),
      findManyByIds: (companyId, ids) =>
        tx.employee.findMany({
          where: { id: { in: ids }, companyId },
          select: { id: true, displayName: true, status: true },
        }),
    },
    audit: {
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
    },
    tvt: {
      create: async (companyId, data) => {
        const session = await tx.safetyTvtSession.create({
          data: {
            company: { connect: { id: companyId } },
            site: { connect: { id_companyId: { id: data.siteId, companyId } } },
            businessDate: data.businessDate,
            topic: data.topic,
            conductedBy: data.conductedBy,
            ...(data.conductedAt ? { conductedAt: data.conductedAt } : {}),
            ...(data.remarks !== undefined ? { remarks: data.remarks } : {}),
            ...(data.attendeeEmployeeIds && data.attendeeEmployeeIds.length > 0
              ? {
                attendees: {
                  create: data.attendeeEmployeeIds.map((empId) => ({
                    company: { connect: { id: companyId } },
                    employee: { connect: { id_companyId: { id: empId, companyId } } },
                  })),
                },
              }
              : {}),
          },
          include: {
            attendees: true,
          },
        });
        return session;
      },
      findById: (companyId, id) =>
        tx.safetyTvtSession.findFirst({
          where: { id, companyId },
          include: {
            attendees: {
              include: {
                employee: {
                  select: { id: true, employeeCode: true, displayName: true, tradeCategory: true },
                },
              },
              orderBy: { attendedAt: 'asc' },
            },
          },
        }),
      list: (companyId, filter) => {
        return tx.safetyTvtSession.findMany({
          where: {
            companyId,
            ...(filter.siteId ? { siteId: filter.siteId } : {}),
            ...(filter.businessDate ? { businessDate: filter.businessDate } : {}),
          },
          include: {
            _count: { select: { attendees: true } },
          },
          orderBy: { conductedAt: 'desc' },
          take: filter.limit ?? 50,
          ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
        });
      },
      addAttendees: async (companyId, sessionId, employeeIds) => {
        if (employeeIds.length === 0) return 0;
        const res = await tx.safetyTvtAttendee.createMany({
          data: employeeIds.map((empId) => ({
            companyId,
            sessionId,
            employeeId: empId,
          })),
          skipDuplicates: true,
        });
        return res.count;
      },
      hasAttended: async (companyId, siteId, employeeId, businessDate) => {
        const attendee = await tx.safetyTvtAttendee.findFirst({
          where: {
            companyId,
            employeeId,
            session: {
              siteId,
              businessDate,
            },
          },
          select: { id: true },
        });
        return attendee !== null;
      },
      findAttendeesForSiteAndDate: async (companyId, siteId, businessDate, employeeIds) => {
        const rows = await tx.safetyTvtAttendee.findMany({
          where: {
            companyId,
            employeeId: { in: employeeIds },
            session: {
              siteId,
              businessDate,
            },
          },
          select: { employeeId: true },
        });
        return rows.map((r) => r.employeeId);
      },
    },
    dailyReports: {
      findById: (companyId, id) =>
        tx.dailySiteReport.findFirst({
          where: { id, companyId },
          include: {
            labourSummaries: { orderBy: { category: 'asc' } },
            auditLogs: { orderBy: { createdAt: 'desc' } },
            site: { select: { id: true, code: true, name: true } },
            project: { select: { id: true, code: true, name: true } },
            submittedBy: { select: { id: true, employeeCode: true, displayName: true } },
            approvedBy: { select: { id: true, employeeCode: true, displayName: true } },
            lockedBy: { select: { id: true, employeeCode: true, displayName: true } },
          },
        }),

      findBySiteAndDate: (companyId, siteId, businessDate) =>
        tx.dailySiteReport.findFirst({
          where: { companyId, siteId, businessDate },
          include: {
            labourSummaries: { orderBy: { category: 'asc' } },
          },
        }),

      list: async (companyId, filter) => {
        const sf = filter.scopeFilter;
        const scopeOr = sf
          ? [
              ...(sf.siteIds.length > 0 ? [{ siteId: { in: sf.siteIds } }] : []),
              ...(sf.projectIds.length > 0 ? [{ projectId: { in: sf.projectIds } }] : []),
              ...(sf.headOfficeIds.length > 0
                ? [{ project: { headOfficeId: { in: sf.headOfficeIds } } }]
                : []),
            ]
          : null;
        const where: Prisma.DailySiteReportWhereInput = {
          companyId,
          ...(filter.projectId ? { projectId: filter.projectId } : {}),
          ...(filter.siteId ? { siteId: filter.siteId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(scopeOr !== null ? { OR: scopeOr } : {}),
          ...(filter.fromDate || filter.toDate
            ? {
              businessDate: {
                ...(filter.fromDate ? { gte: filter.fromDate } : {}),
                ...(filter.toDate ? { lte: filter.toDate } : {}),
              },
            }
            : {}),
        };

        const [items, total] = await Promise.all([
          tx.dailySiteReport.findMany({
            where,
            include: {
              site: { select: { id: true, code: true, name: true } },
              project: { select: { id: true, code: true, name: true } },
            },
            orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
            take: filter.limit ?? 20,
            skip: filter.offset ?? 0,
          }),
          tx.dailySiteReport.count({ where }),
        ]);

        return { items, total };
      },

      upsert: async (companyId, data) => {
        const existing = await tx.dailySiteReport.findFirst({
          where: {
            companyId,
            siteId: data.siteId,
            businessDate: data.businessDate,
          },
        });

        let report: DailySiteReport;

        if (existing) {
          report = await tx.dailySiteReport.update({
            where: { id: existing.id },
            data: {
              totalWorkersHeadcount: data.totalWorkersHeadcount,
              totalPresentUnits: data.totalPresentUnits,
              totalOvertimeHours: data.totalOvertimeHours,
              totalOvertimePUnits: data.totalOvertimePUnits,
              totalFlaggedSessions: data.totalFlaggedSessions,
              catAStaffCount: data.catAStaffCount,
              catAStaffUnits: data.catAStaffUnits,
              catBDirectCount: data.catBDirectCount,
              catBDirectUnits: data.catBDirectUnits,
              catCSubconCount: data.catCSubconCount,
              catCSubconUnits: data.catCSubconUnits,
              ...(data.weather ? { weather: data.weather } : {}),
              ...(data.weatherStoppageHours !== undefined
                ? { weatherStoppageHours: data.weatherStoppageHours }
                : {}),
              ...(data.workProgressNotes !== undefined
                ? { workProgressNotes: data.workProgressNotes }
                : {}),
              ...(data.siteObstaclesRemarks !== undefined
                ? { siteObstaclesRemarks: data.siteObstaclesRemarks }
                : {}),
              ...(data.safetyIncidentReported !== undefined
                ? { safetyIncidentReported: data.safetyIncidentReported }
                : {}),
              ...(data.safetyNotes !== undefined ? { safetyNotes: data.safetyNotes } : {}),
              ...(data.status ? { status: data.status } : {}),
              version: { increment: 1 },
            },
          });
        } else {
          report = await tx.dailySiteReport.create({
            data: {
              company: { connect: { id: companyId } },
              project: { connect: { id_companyId: { id: data.projectId, companyId } } },
              site: { connect: { id_companyId: { id: data.siteId, companyId } } },
              businessDate: data.businessDate,
              status: data.status ?? 'DRAFT',
              weather: data.weather ?? 'CLEAR',
              weatherStoppageHours: data.weatherStoppageHours ?? 0,
              workProgressNotes: data.workProgressNotes ?? null,
              siteObstaclesRemarks: data.siteObstaclesRemarks ?? null,
              safetyIncidentReported: data.safetyIncidentReported ?? false,
              safetyNotes: data.safetyNotes ?? null,
              totalWorkersHeadcount: data.totalWorkersHeadcount,
              totalPresentUnits: data.totalPresentUnits,
              totalOvertimeHours: data.totalOvertimeHours,
              totalOvertimePUnits: data.totalOvertimePUnits,
              totalFlaggedSessions: data.totalFlaggedSessions,
              catAStaffCount: data.catAStaffCount,
              catAStaffUnits: data.catAStaffUnits,
              catBDirectCount: data.catBDirectCount,
              catBDirectUnits: data.catBDirectUnits,
              catCSubconCount: data.catCSubconCount,
              catCSubconUnits: data.catCSubconUnits,
            },
          });
        }

        if (data.labourSummaries && data.labourSummaries.length > 0) {
          await tx.dailySiteReportLabour.deleteMany({
            where: { reportId: report.id, companyId },
          });

          await tx.dailySiteReportLabour.createMany({
            data: data.labourSummaries.map((s) => ({
              companyId,
              reportId: report.id,
              category: s.category,
              subcontractorId: s.subcontractorId ?? null,
              subcontractorName: s.subcontractorName ?? null,
              tradeCategory: s.tradeCategory,
              headcount: s.headcount,
              presentUnits: s.presentUnits,
              overtimeHours: s.overtimeHours,
              remarks: s.remarks ?? null,
            })),
          });
        }

        const labourSummaries = await tx.dailySiteReportLabour.findMany({
          where: { reportId: report.id, companyId },
          orderBy: { category: 'asc' },
        });

        return { ...report, labourSummaries };
      },

      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'DAILY_SITE_REPORT',
          { id, companyId },
          data as Record<string, unknown>,
          expectedVersion,
          (args) => tx.dailySiteReport.updateMany(args),
          () => tx.dailySiteReport.findFirst({ where: { id, companyId } }),
        ),

      updateLabourSummary: async (companyId, reportId, summaryId, data) => {
        await tx.dailySiteReportLabour.updateMany({
          where: { id: summaryId, reportId, companyId },
          data,
        });
        const updated = await tx.dailySiteReportLabour.findFirst({
          where: { id: summaryId, reportId, companyId },
        });
        if (!updated) {
          throw new AttendanceEntityNotFoundError('DailySiteReportLabour', summaryId);
        }
        return updated;
      },

      addAuditLog: (companyId, reportId, data) =>
        tx.dailyReportAuditLog.create({
          data: {
            company: { connect: { id: companyId } },
            report: { connect: { id_companyId: { id: reportId, companyId } } },
            actorId: data.actorId,
            action: data.action,
            fieldName: data.fieldName ?? null,
            oldValue: data.oldValue ?? null,
            newValue: data.newValue ?? null,
            reason: data.reason,
          },
        }),

      getAuditLogs: (companyId, reportId) =>
        tx.dailyReportAuditLog.findMany({
          where: { companyId, reportId },
          orderBy: { createdAt: 'desc' },
        }),

      getActiveSitesForSettlement: (companyId) =>
        tx.site.findMany({
          where: {
            status: 'ACTIVE',
            ...(companyId ? { companyId } : {}),
          },
          select: { id: true, companyId: true, projectId: true },
        }),
    },
  };
}

export interface AttendanceUnitOfWork {
  run<T>(fn: (repos: AttendanceRepos) => Promise<T>): Promise<T>;
}

export class PrismaAttendanceUnitOfWork implements AttendanceUnitOfWork {
  constructor(private readonly prisma: PrismaClient) { }

  run<T>(fn: (repos: AttendanceRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeAttendanceRepos(tx)));
  }
}
