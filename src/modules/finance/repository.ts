import { Prisma } from '@prisma/client';
import type {
  BudgetRevision,
  BudgetRevisionLine,
  BudgetReviewDecision,
  CashFlowDirection,
  CashFlowForecast,
  CashFlowForecastLine,
  Department,
  DepartmentMembership,
  Employee,
  EmployeeStatus,
  LeaveBalance,
  LeaveRequestStatus,
  OrgNodeStatus,
  PrismaClient,
  Project,
  ProjectBudget,
  ProjectStatus,
  Site,
} from '@prisma/client';
import type { AuditRecord } from '../organization/types.js';
import { mapOrgWriteError } from '../organization/errors.js';
import type {
  BudgetListFilter,
  CreateBudgetRevisionInput,
  CreateForecastInput,
  EmployeeListFilter,
  ForecastListFilter,
  PortfolioProjectFilter,
  SiteListFilter,
} from './types.js';

type Tx = Prisma.TransactionClient;

export interface BudgetRevisionWithLines extends BudgetRevision {
  lines: BudgetRevisionLine[];
  decisions?: BudgetReviewDecision[];
}

export interface BudgetDetail extends ProjectBudget {
  latestApprovedRevision: BudgetRevision | null;
}

export interface OutboxRecord {
  companyId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  eventKey: string;
  recipientPrincipalIds: string[];
  summary: Record<string, unknown>;
}

export type PortfolioProject = Project & {
  headOffice: { id: string; code: string; name: string };
};

export type FinanceMembership = DepartmentMembership & {
  department: Pick<
    Department,
    'id' | 'code' | 'name' | 'scopeType' | 'projectId' | 'siteId' | 'baseHeadOfficeId'
  >;
};

export interface AttendanceTotals {
  sessions: number;
  presentUnits: string;
  overtimeUnits: string;
  totalUnits: string;
  overtimeHours: string;
  grossMinutes: number;
  netMinutes: number;
  flaggedSessions: number;
  sitesWorked: number;
}

export interface LeaveRequestStat {
  status: LeaveRequestStatus;
  count: number;
  totalDays: string;
}

export interface FinanceRepos {
  projects: {
    findById(companyId: string, id: string): Promise<Project | null>;
    list(companyId: string, filter: PortfolioProjectFilter): Promise<PortfolioProject[]>;
    statusCounts(companyId: string): Promise<{ status: ProjectStatus; count: number }[]>;
  };
  sites: {
    list(companyId: string, projectId: string, filter: SiteListFilter): Promise<Site[]>;
    statusCounts(companyId: string): Promise<{ status: OrgNodeStatus; count: number }[]>;
  };
  employees: {
    findByPrincipal(companyId: string, principalId: string): Promise<Employee | null>;
    findById(companyId: string, id: string): Promise<Employee | null>;
    list(
      companyId: string,
      filter: EmployeeListFilter,
      at: Date,
    ): Promise<(Employee & { memberships: FinanceMembership[] })[]>;
    activeMemberships(
      companyId: string,
      employeeId: string,
      at: Date,
    ): Promise<FinanceMembership[]>;
    statusCounts(companyId: string): Promise<{ status: EmployeeStatus; count: number }[]>;
  };
  attendance: {
    summarize(
      companyId: string,
      employeeId: string,
      from: string,
      to: string,
    ): Promise<AttendanceTotals>;
  };
  leave: {
    balances(companyId: string, employeeId: string, year: number): Promise<LeaveBalance[]>;
    requestStats(
      companyId: string,
      employeeId: string,
      yearStart: Date,
      yearEnd: Date,
    ): Promise<LeaveRequestStat[]>;
  };
  access: {
    /** Active, unrevoked assignment of one of the given role keys. */
    hasRoleAssignment(
      companyId: string,
      principalId: string,
      roleKeys: string[],
      at: Date,
    ): Promise<boolean>;
  };
  budgets: {
    create(
      companyId: string,
      data: {
        projectId: string;
        code: string;
        name: string;
        description?: string;
        currency: string;
        idempotencyKey?: string;
        requestFingerprint?: string;
      },
    ): Promise<ProjectBudget>;
    findById(companyId: string, id: string): Promise<ProjectBudget | null>;
    findDetail(companyId: string, id: string): Promise<BudgetDetail | null>;
    findByIdempotencyKey(
      companyId: string,
      projectId: string,
      key: string,
    ): Promise<ProjectBudget | null>;
    list(companyId: string, projectId: string, filter: BudgetListFilter): Promise<ProjectBudget[]>;
    update(
      companyId: string,
      id: string,
      data: Record<string, unknown>,
      expectedVersion?: number,
    ): Promise<{ count: number }>;
    openRevisionCount(companyId: string, budgetId: string): Promise<number>;
    maxRevisionNumber(companyId: string, budgetId: string): Promise<number>;
    statusCounts(companyId: string): Promise<{ status: OrgNodeStatus; count: number }[]>;
    /** Sum of each budget's latest APPROVED revision total, grouped by currency. */
    approvedTotals(companyId: string): Promise<{ currency: string; totalAmount: string }[]>;
  };
  revisions: {
    create(
      companyId: string,
      budgetId: string,
      revision: number,
      totalAmount: string,
      input: CreateBudgetRevisionInput,
      requestFingerprint?: string,
    ): Promise<BudgetRevision>;
    findById(companyId: string, budgetId: string, id: string): Promise<BudgetRevision | null>;
    findDetail(
      companyId: string,
      budgetId: string,
      id: string,
    ): Promise<BudgetRevisionWithLines | null>;
    findByIdempotencyKey(
      companyId: string,
      budgetId: string,
      key: string,
    ): Promise<BudgetRevision | null>;
    list(companyId: string, budgetId: string, status?: string): Promise<BudgetRevision[]>;
    transition(
      companyId: string,
      id: string,
      fromStatus: string,
      data: Record<string, unknown>,
      expectedVersion?: number,
    ): Promise<{ count: number }>;
    /** Revisions awaiting a decision — the finance review inbox depth. */
    pendingReviewCount(companyId: string): Promise<number>;
  };
  decisions: {
    create(
      companyId: string,
      data: {
        revisionId: string;
        action: string;
        actorPrincipalId?: string;
        actorType: string;
        reason?: string;
        idempotencyKey?: string;
        requestFingerprint?: string;
        eventKey: string;
      },
    ): Promise<BudgetReviewDecision>;
    findByIdempotencyKey(
      companyId: string,
      revisionId: string,
      key: string,
    ): Promise<BudgetReviewDecision | null>;
    list(companyId: string, revisionId: string): Promise<BudgetReviewDecision[]>;
  };
  forecasts: {
    create(
      companyId: string,
      data: CreateForecastInput & { projectId: string; requestFingerprint?: string },
    ): Promise<CashFlowForecast>;
    findById(companyId: string, id: string): Promise<CashFlowForecast | null>;
    findDetail(
      companyId: string,
      id: string,
    ): Promise<(CashFlowForecast & { lines: CashFlowForecastLine[] }) | null>;
    findByIdempotencyKey(
      companyId: string,
      projectId: string,
      key: string,
    ): Promise<CashFlowForecast | null>;
    list(
      companyId: string,
      projectId: string,
      filter: ForecastListFilter,
    ): Promise<CashFlowForecast[]>;
    revise(
      companyId: string,
      id: string,
      data: {
        header: Record<string, unknown>;
        lines?: CreateForecastInput['lines'];
        bumpRevision: boolean;
      },
      expectedVersion: number,
    ): Promise<{ count: number }>;
    /** ACTIVE forecasts with their lines — one bounded query for dashboard sums. */
    activeLines(
      companyId: string,
    ): Promise<
      { currency: string; lines: { direction: CashFlowDirection; amount: Prisma.Decimal }[] }[]
    >;
  };
  audit: { record(entry: AuditRecord): Promise<unknown> };
  outbox: { record(entry: OutboxRecord): Promise<unknown> };
}

const MEMBERSHIP_DEPT_SELECT = {
  id: true,
  code: true,
  name: true,
  scopeType: true,
  projectId: true,
  siteId: true,
  baseHeadOfficeId: true,
} as const;

export function makeFinanceRepos(tx: Tx): FinanceRepos {
  const activeMembershipWhere = (at: Date) => ({
    OR: [{ endedAt: null }, { endedAt: { gt: at } }],
  });
  return {
    projects: {
      findById: (companyId, id) => tx.project.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.project.findMany({
          where: {
            companyId,
            ...(filter.status !== undefined ? { status: filter.status } : {}),
            ...(filter.search !== undefined
              ? {
                  OR: [
                    { code: { contains: filter.search, mode: 'insensitive' } },
                    { name: { contains: filter.search, mode: 'insensitive' } },
                    { locationCity: { contains: filter.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
            ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
          },
          include: { headOffice: { select: { id: true, code: true, name: true } } },
          orderBy: { id: 'asc' },
          take: filter.limit + 1,
        }),
      statusCounts: async (companyId) =>
        (
          await tx.project.groupBy({
            by: ['status'],
            where: { companyId },
            _count: { _all: true },
          })
        ).map((g) => ({ status: g.status, count: g._count._all })),
    },
    sites: {
      list: (companyId, projectId, filter) =>
        tx.site.findMany({
          where: {
            companyId,
            projectId,
            ...(filter.status !== undefined ? { status: filter.status } : {}),
            ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: filter.limit + 1,
        }),
      statusCounts: async (companyId) =>
        (
          await tx.site.groupBy({
            by: ['status'],
            where: { companyId },
            _count: { _all: true },
          })
        ).map((g) => ({ status: g.status, count: g._count._all })),
    },
    employees: {
      findByPrincipal: (companyId, principalId) =>
        tx.employee.findFirst({ where: { companyId, principalId } }),
      findById: (companyId, id) => tx.employee.findFirst({ where: { id, companyId } }),
      list: (companyId, filter, at) =>
        tx.employee.findMany({
          where: {
            companyId,
            ...(filter.status !== undefined ? { status: filter.status } : {}),
            ...(filter.search !== undefined
              ? {
                  OR: [
                    { displayName: { contains: filter.search, mode: 'insensitive' } },
                    { employeeCode: { contains: filter.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
            ...(filter.departmentId !== undefined ||
            filter.projectId !== undefined ||
            filter.siteId !== undefined
              ? {
                  memberships: {
                    some: {
                      ...activeMembershipWhere(at),
                      department: {
                        companyId,
                        ...(filter.departmentId !== undefined ? { id: filter.departmentId } : {}),
                        ...(filter.projectId !== undefined
                          ? // PROJECT-scoped depts carry projectId directly;
                            // SITE-scoped depts reach the project via their site.
                            {
                              OR: [
                                { projectId: filter.projectId },
                                { site: { projectId: filter.projectId } },
                              ],
                            }
                          : {}),
                        ...(filter.siteId !== undefined ? { siteId: filter.siteId } : {}),
                      },
                    },
                  },
                }
              : {}),
            ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
          },
          include: {
            memberships: {
              where: { isPrimary: true, ...activeMembershipWhere(at) },
              include: { department: { select: MEMBERSHIP_DEPT_SELECT } },
              take: 1,
            },
          },
          orderBy: { id: 'asc' },
          take: filter.limit + 1,
        }),
      activeMemberships: (companyId, employeeId, at) =>
        tx.departmentMembership.findMany({
          where: { companyId, employeeId, ...activeMembershipWhere(at) },
          include: { department: { select: MEMBERSHIP_DEPT_SELECT } },
          orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
        }),
      statusCounts: async (companyId) =>
        (
          await tx.employee.groupBy({
            by: ['status'],
            where: { companyId },
            _count: { _all: true },
          })
        ).map((g) => ({ status: g.status, count: g._count._all })),
    },
    attendance: {
      summarize: async (companyId, employeeId, from, to) => {
        const where = { companyId, employeeId, businessDate: { gte: from, lte: to } };
        const [agg, flagged, sites] = await Promise.all([
          tx.attendanceSession.aggregate({
            where,
            _count: { _all: true },
            _sum: {
              presentUnits: true,
              overtimePUnits: true,
              totalPUnits: true,
              overtimeHours: true,
              grossDurationMins: true,
              netDurationMins: true,
            },
          }),
          tx.attendanceSession.count({ where: { ...where, isFlagged: true } }),
          tx.attendanceSession.groupBy({ by: ['siteId'], where }),
        ]);
        return {
          sessions: agg._count._all,
          presentUnits: (agg._sum.presentUnits ?? new Prisma.Decimal(0)).toFixed(1),
          overtimeUnits: (agg._sum.overtimePUnits ?? new Prisma.Decimal(0)).toFixed(1),
          totalUnits: (agg._sum.totalPUnits ?? new Prisma.Decimal(0)).toFixed(1),
          overtimeHours: (agg._sum.overtimeHours ?? new Prisma.Decimal(0)).toFixed(2),
          grossMinutes: agg._sum.grossDurationMins ?? 0,
          netMinutes: agg._sum.netDurationMins ?? 0,
          flaggedSessions: flagged,
          sitesWorked: sites.length,
        };
      },
    },
    leave: {
      balances: (companyId, employeeId, year) =>
        tx.leaveBalance.findMany({
          where: { companyId, employeeId, year },
          orderBy: { leaveType: 'asc' },
        }),
      requestStats: async (companyId, employeeId, yearStart, yearEnd) =>
        (
          await tx.leaveRequest.groupBy({
            by: ['status'],
            where: {
              companyId,
              employeeId,
              startDate: { gte: yearStart, lte: yearEnd },
            },
            _count: { _all: true },
            _sum: { totalDays: true },
          })
        ).map((g) => ({
          status: g.status,
          count: g._count._all,
          totalDays: (g._sum.totalDays ?? new Prisma.Decimal(0)).toFixed(1),
        })),
    },
    access: {
      hasRoleAssignment: async (companyId, principalId, roleKeys, at) =>
        (await tx.roleAssignment.count({
          where: {
            companyId,
            principalId,
            revokedAt: null,
            OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: at } }],
            AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }],
            role: { is: { key: { in: roleKeys } } },
          },
        })) > 0,
    },
    budgets: {
      create: async (companyId, data) => {
        try {
          return await tx.projectBudget.create({ data: { ...data, companyId } });
        } catch (error) {
          mapOrgWriteError(error, 'PROJECT_BUDGET');
        }
      },
      findById: (companyId, id) => tx.projectBudget.findFirst({ where: { id, companyId } }),
      findDetail: async (companyId, id) => {
        const budget = await tx.projectBudget.findFirst({ where: { id, companyId } });
        if (budget === null) return null;
        const latestApprovedRevision =
          budget.latestApprovedRevisionId === null
            ? null
            : await tx.budgetRevision.findFirst({
                where: { id: budget.latestApprovedRevisionId, companyId, budgetId: id },
              });
        return { ...budget, latestApprovedRevision };
      },
      findByIdempotencyKey: (companyId, projectId, key) =>
        tx.projectBudget.findFirst({ where: { companyId, projectId, idempotencyKey: key } }),
      list: (companyId, projectId, filter) =>
        tx.projectBudget.findMany({
          where: {
            companyId,
            projectId,
            ...(filter.status !== undefined ? { status: filter.status } : {}),
            ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: filter.limit,
        }),
      update: (companyId, id, data, expectedVersion) =>
        tx.projectBudget.updateMany({
          where: {
            id,
            companyId,
            ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
          },
          data: { ...data, version: { increment: 1 } },
        }),
      openRevisionCount: (companyId, budgetId) =>
        tx.budgetRevision.count({
          where: { companyId, budgetId, status: { in: ['DRAFT', 'SUBMITTED'] } },
        }),
      maxRevisionNumber: async (companyId, budgetId) => {
        const row = await tx.budgetRevision.aggregate({
          where: { companyId, budgetId },
          _max: { revision: true },
        });
        return row._max.revision ?? 0;
      },
      statusCounts: async (companyId) =>
        (
          await tx.projectBudget.groupBy({
            by: ['status'],
            where: { companyId },
            _count: { _all: true },
          })
        ).map((g) => ({ status: g.status, count: g._count._all })),
      approvedTotals: async (companyId) => {
        const budgets = await tx.projectBudget.findMany({
          where: { companyId, latestApprovedRevisionId: { not: null } },
          select: { id: true, currency: true, latestApprovedRevisionId: true },
        });
        const revIds = budgets
          .map((b) => b.latestApprovedRevisionId)
          .filter((id): id is string => id !== null);
        if (revIds.length === 0) return [];
        const revisions = await tx.budgetRevision.findMany({
          where: { companyId, id: { in: revIds } },
          select: { id: true, totalAmount: true },
        });
        const totals = new Map(revisions.map((r) => [r.id, r.totalAmount]));
        const byCurrency = new Map<string, Prisma.Decimal>();
        for (const b of budgets) {
          if (b.latestApprovedRevisionId === null) continue;
          const amount = totals.get(b.latestApprovedRevisionId);
          if (amount === undefined) continue;
          byCurrency.set(
            b.currency,
            (byCurrency.get(b.currency) ?? new Prisma.Decimal(0)).plus(amount),
          );
        }
        return [...byCurrency.entries()].map(([currency, totalAmount]) => ({
          currency,
          totalAmount: totalAmount.toFixed(2),
        }));
      },
    },
    revisions: {
      create: async (companyId, budgetId, revision, totalAmount, input, requestFingerprint) => {
        try {
          return await tx.budgetRevision.create({
            data: {
              companyId,
              budgetId,
              revision,
              totalAmount,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              ...(input.idempotencyKey !== undefined
                ? { idempotencyKey: input.idempotencyKey }
                : {}),
              ...(requestFingerprint !== undefined ? { requestFingerprint } : {}),
              lines: {
                create: input.lines.map((line, i) => ({
                  category: line.category,
                  description: line.description,
                  amount: line.amount,
                  sortOrder: i,
                })),
              },
            },
          });
        } catch (error) {
          mapOrgWriteError(error, 'BUDGET_REVISION');
        }
      },
      findById: (companyId, budgetId, id) =>
        tx.budgetRevision.findFirst({ where: { id, companyId, budgetId } }),
      findDetail: (companyId, budgetId, id) =>
        tx.budgetRevision.findFirst({
          where: { id, companyId, budgetId },
          include: {
            lines: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
            decisions: { orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }] },
          },
        }),
      findByIdempotencyKey: (companyId, budgetId, key) =>
        tx.budgetRevision.findFirst({ where: { companyId, budgetId, idempotencyKey: key } }),
      list: (companyId, budgetId, status) =>
        tx.budgetRevision.findMany({
          where: {
            companyId,
            budgetId,
            ...(status !== undefined ? { status: status as BudgetRevision['status'] } : {}),
          },
          include: { lines: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
          orderBy: { revision: 'asc' },
        }),
      transition: (companyId, id, fromStatus, data, expectedVersion) =>
        tx.budgetRevision.updateMany({
          where: {
            id,
            companyId,
            status: fromStatus as never,
            ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
          },
          data: { ...data, version: { increment: 1 } },
        }),
      pendingReviewCount: (companyId) =>
        tx.budgetRevision.count({ where: { companyId, status: 'SUBMITTED' } }),
    },
    decisions: {
      create: async (companyId, data) => {
        try {
          return await tx.budgetReviewDecision.create({ data: { ...data, companyId } as never });
        } catch (error) {
          mapOrgWriteError(error, 'BUDGET_REVIEW_DECISION');
        }
      },
      findByIdempotencyKey: (companyId, revisionId, key) =>
        tx.budgetReviewDecision.findFirst({
          where: { companyId, revisionId, idempotencyKey: key },
        }),
      list: (companyId, revisionId) =>
        tx.budgetReviewDecision.findMany({
          where: { companyId, revisionId },
          orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
        }),
    },
    forecasts: {
      create: async (companyId, data) => {
        try {
          return await tx.cashFlowForecast.create({
            data: {
              companyId,
              projectId: data.projectId,
              name: data.name,
              ...(data.description !== undefined ? { description: data.description } : {}),
              currency: data.currency,
              periodStart: new Date(`${data.periodStart}T00:00:00.000Z`),
              periodEnd: new Date(`${data.periodEnd}T00:00:00.000Z`),
              ...(data.idempotencyKey !== undefined ? { idempotencyKey: data.idempotencyKey } : {}),
              ...(data.requestFingerprint !== undefined
                ? { requestFingerprint: data.requestFingerprint }
                : {}),
              lines: {
                create: data.lines.map((line, i) => ({
                  direction: line.direction,
                  category: line.category,
                  amount: line.amount,
                  ...(line.expectedDate !== undefined
                    ? { expectedDate: new Date(`${line.expectedDate}T00:00:00.000Z`) }
                    : {}),
                  ...(line.description !== undefined ? { description: line.description } : {}),
                  sortOrder: i,
                })),
              },
            },
          });
        } catch (error) {
          mapOrgWriteError(error, 'CASH_FLOW_FORECAST');
        }
      },
      findById: (companyId, id) => tx.cashFlowForecast.findFirst({ where: { id, companyId } }),
      findDetail: (companyId, id) =>
        tx.cashFlowForecast.findFirst({
          where: { id, companyId },
          include: { lines: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
        }),
      findByIdempotencyKey: (companyId, projectId, key) =>
        tx.cashFlowForecast.findFirst({ where: { companyId, projectId, idempotencyKey: key } }),
      list: (companyId, projectId, filter) =>
        tx.cashFlowForecast.findMany({
          where: {
            companyId,
            projectId,
            ...(filter.status !== undefined ? { status: filter.status } : {}),
            ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: filter.limit,
        }),
      revise: async (companyId, id, data, expectedVersion) => {
        const result = await tx.cashFlowForecast.updateMany({
          where: { id, companyId, version: expectedVersion },
          data: {
            ...data.header,
            version: { increment: 1 },
            ...(data.bumpRevision ? { revision: { increment: 1 } } : {}),
          },
        });
        if (result.count === 0 || data.lines === undefined) return result;
        await tx.cashFlowForecastLine.deleteMany({ where: { forecastId: id, companyId } });
        await tx.cashFlowForecastLine.createMany({
          data: data.lines.map((line, i) => ({
            companyId,
            forecastId: id,
            direction: line.direction,
            category: line.category,
            amount: line.amount,
            ...(line.expectedDate !== undefined
              ? { expectedDate: new Date(`${line.expectedDate}T00:00:00.000Z`) }
              : {}),
            ...(line.description !== undefined ? { description: line.description } : {}),
            sortOrder: i,
          })),
        });
        return result;
      },
      activeLines: (companyId) =>
        tx.cashFlowForecast.findMany({
          where: { companyId, status: 'ACTIVE' },
          select: {
            currency: true,
            lines: { select: { direction: true, amount: true } },
          },
        }),
    },
    audit: {
      record: (entry) => tx.auditLog.create({ data: entry as never }),
    },
    outbox: {
      record: (entry) =>
        tx.outboxEvent.create({
          data: {
            companyId: entry.companyId,
            eventType: entry.eventType,
            aggregateType: entry.aggregateType,
            aggregateId: entry.aggregateId,
            eventKey: entry.eventKey,
            payload: {
              recipientPrincipalIds: entry.recipientPrincipalIds,
              summary: entry.summary,
            } as never,
          },
        }),
    },
  };
}

export interface FinanceUnitOfWork {
  run<T>(fn: (repos: FinanceRepos) => Promise<T>): Promise<T>;
}

export class PrismaFinanceUnitOfWork implements FinanceUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: FinanceRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeFinanceRepos(tx)));
  }
}
