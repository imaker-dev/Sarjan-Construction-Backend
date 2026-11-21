import type {
  AttendanceBreak,
  AttendancePolicy,
  AttendancePolicyScope,
  AttendanceSession,
  Employee,
  HeadOffice,
  Prisma,
  PrismaClient,
  SafetyTvtAttendee,
  SafetyTvtSession,
  Site,
} from '@prisma/client';
import { scopedUpdate, type AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';
import { ActiveSessionExistsError } from './errors.js';
import {
  DEFAULT_ATTENDANCE_POLICY,
  type ListSessionsFilter,
  type MusterRollRangeFilter,
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
    autoCloseStaleSessions?(cutoffDate: Date, companyId?: string): Promise<number>;
    getMusterRollRange(
      companyId: string,
      filter: MusterRollRangeFilter,
    ): Promise<{
      siteId: string;
      from: string;
      to: string;
      totalSessions: number;
      totalMandays: number;
      totalPresentUnits: number;
      totalOvertimePUnits: number;
      totalTotalPUnits: number;
      totalOvertimeHours: number;
      workerSummaries: {
        employeeId: string;
        employeeCode: string;
        displayName: string;
        tradeCategory: string | null;
        presentUnits: number;
        overtimePUnits: number;
        totalPUnits: number;
        overtimeHours: number;
        sessionsCount: number;
        daysPresent: number;
        leaveDays: number;
      }[];
      sessions: AttendanceSessionWithDetails[];
      leaves: unknown[];
    }>;
    getDailySummary(
      companyId: string,
      siteId: string,
      businessDate: string,
    ): Promise<{
      siteId: string;
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
  memberships: {
    hasActiveAtHeadOffice(
      companyId: string,
      employeeId: string,
      headOfficeId: string,
    ): Promise<boolean>;
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
      autoCloseStaleSessions: async (cutoffDate: Date, companyId?: string) => {
        const res = await tx.attendanceSession.updateMany({
          where: {
            ...(companyId ? { companyId } : {}),
            status: 'IN_PROGRESS',
            punchInAt: { lt: cutoffDate },
          },
          data: {
            status: 'AUTO_CLOSED',
            punchOutRemarks: 'Auto-closed by background worker sweep (>24h shift)',
          },
        });
        return res.count;
      },
      getMusterRollRange: async (companyId, filter) => {
        const where: Prisma.AttendanceSessionWhereInput = {
          companyId,
          siteId: filter.siteId,
          businessDate: { gte: filter.from, lte: filter.to },
          ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        };

        const fromDate = new Date(`${filter.from}T00:00:00.000Z`);
        const toDate = new Date(`${filter.to}T23:59:59.999Z`);

        const [sessions, totalsAgg, leaves] = await Promise.all([
          tx.attendanceSession.findMany({
            where,
            include: {
              employee: {
                select: { id: true, employeeCode: true, displayName: true, tradeCategory: true },
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
            presentUnits: number;
            overtimePUnits: number;
            totalPUnits: number;
            overtimeHours: number;
            sessionsCount: number;
            daysSet: Set<string>;
            leaveDays: number;
          }
        >();

        for (const s of sessions) {
          const pu = Number(s.presentUnits);
          const otP = Number(s.overtimePUnits);
          const totP = Number(s.totalPUnits);
          const otH = Number(s.overtimeHours);

          let w = workerMap.get(s.employeeId);
          if (!w) {
            w = {
              employeeId: s.employeeId,
              employeeCode: s.employee.employeeCode,
              displayName: s.employee.displayName,
              tradeCategory: s.employee.tradeCategory,
              presentUnits: 0,
              overtimePUnits: 0,
              totalPUnits: 0,
              overtimeHours: 0,
              sessionsCount: 0,
              daysSet: new Set<string>(),
              leaveDays: 0,
            };
            workerMap.set(s.employeeId, w);
          }
          w.presentUnits += pu;
          w.overtimePUnits += otP;
          w.totalPUnits += totP;
          w.overtimeHours += otH;
          w.sessionsCount += 1;
          w.daysSet.add(s.businessDate);
        }

        for (const l of leaves) {
          const w = workerMap.get(l.employeeId);
          if (w) {
            w.leaveDays += Number(l.totalDays);
          }
        }

        const workerSummaries = Array.from(workerMap.values()).map((w) => ({
          employeeId: w.employeeId,
          employeeCode: w.employeeCode,
          displayName: w.displayName,
          tradeCategory: w.tradeCategory,
          presentUnits: Number(w.presentUnits.toFixed(1)),
          overtimePUnits: Number(w.overtimePUnits.toFixed(1)),
          totalPUnits: Number(w.totalPUnits.toFixed(1)),
          overtimeHours: Number(w.overtimeHours.toFixed(2)),
          sessionsCount: w.sessionsCount,
          daysPresent: w.daysSet.size,
          leaveDays: w.leaveDays,
        }));

        return {
          siteId: filter.siteId,
          from: filter.from,
          to: filter.to,
          totalSessions: totalsAgg._count._all,
          totalMandays: workerSummaries.reduce((sum, w) => sum + w.daysPresent, 0),
          totalPresentUnits: Number(Number(totalsAgg._sum.presentUnits ?? 0).toFixed(1)),
          totalOvertimePUnits: Number(Number(totalsAgg._sum.overtimePUnits ?? 0).toFixed(1)),
          totalTotalPUnits: Number(Number(totalsAgg._sum.totalPUnits ?? 0).toFixed(1)),
          totalOvertimeHours: Number(Number(totalsAgg._sum.overtimeHours ?? 0).toFixed(2)),
          workerSummaries,
          sessions,
          leaves,
        };
      },
      getDailySummary: async (companyId, siteId, businessDate) => {
        const businessDateObj = new Date(`${businessDate}T00:00:00.000Z`);

        const [sessions, statusGroups, totalsAgg, siteRoleAssignments, siteSessions] =
          await Promise.all([
            tx.attendanceSession.findMany({
              where: {
                companyId,
                siteId,
                businessDate,
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
                breaks: true,
              },
              orderBy: { punchInAt: 'asc' },
            }),
            tx.attendanceSession.groupBy({
              by: ['status'],
              where: { companyId, siteId, businessDate },
              _count: { _all: true },
            }),
            tx.attendanceSession.aggregate({
              where: { companyId, siteId, businessDate },
              _sum: {
                presentUnits: true,
                overtimePUnits: true,
                totalPUnits: true,
                overtimeHours: true,
              },
              _count: { _all: true },
            }),
            tx.roleAssignment.findMany({
              where: { companyId, siteId, revokedAt: null },
              select: { principalId: true },
            }),
            tx.attendanceSession.findMany({
              where: { companyId, siteId },
              select: { employeeId: true },
              distinct: ['employeeId'],
            }),
          ]);

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

        return {
          siteId,
          businessDate,
          totalWorkers: distinctEmployees.size,
          totalSessions: totalsAgg._count._all,
          completedSessions,
          inProgressSessions,
          autoClosedSessions,
          totalApprovedLeaves: leaves.length,
          totalPresentUnits: Number(Number(totalsAgg._sum.presentUnits ?? 0).toFixed(1)),
          totalOvertimePUnits: Number(Number(totalsAgg._sum.overtimePUnits ?? 0).toFixed(1)),
          totalTotalPUnits: Number(Number(totalsAgg._sum.totalPUnits ?? 0).toFixed(1)),
          totalOvertimeHours: Number(Number(totalsAgg._sum.overtimeHours ?? 0).toFixed(2)),
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
  };
}

export interface AttendanceUnitOfWork {
  run<T>(fn: (repos: AttendanceRepos) => Promise<T>): Promise<T>;
}

export class PrismaAttendanceUnitOfWork implements AttendanceUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: AttendanceRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeAttendanceRepos(tx)));
  }
}
