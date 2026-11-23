import { Prisma } from '@prisma/client';
import type {
  AttendanceSession,
  BudgetRevision,
  BudgetRevisionLine,
  BudgetReviewDecision,
  CashFlowForecast,
  CashFlowForecastLine,
  Department,
  DepartmentMembership,
  Employee,
  HeadOffice,
  LeaveBalance,
  LeaveRequest,
  Project,
  ProjectBudget,
  Site,
} from '@prisma/client';
import type {
  BudgetDetail,
  BudgetRevisionWithLines,
  FinanceMembership,
  FinanceRepos,
  FinanceUnitOfWork,
  OutboxRecord,
} from '../../../src/modules/finance/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';
import type {
  BudgetListFilter,
  CreateForecastInput,
  ForecastListFilter,
} from '../../../src/modules/finance/types.js';
import { DuplicateCodeError } from '../../../src/modules/organization/errors.js';

export interface FinStore {
  projects: Project[];
  headOffices: Pick<HeadOffice, 'id' | 'companyId' | 'code' | 'name'>[];
  sites: Site[];
  departments: Department[];
  memberships: DepartmentMembership[];
  employees: Employee[];
  attendanceSessions: AttendanceSession[];
  leaveBalances: LeaveBalance[];
  leaveRequests: LeaveRequest[];
  roleAssignments: {
    companyId: string;
    principalId: string;
    roleKey: string;
    revokedAt: Date | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
  }[];
  budgets: ProjectBudget[];
  revisions: BudgetRevision[];
  revisionLines: BudgetRevisionLine[];
  decisions: BudgetReviewDecision[];
  forecasts: CashFlowForecast[];
  forecastLines: CashFlowForecastLine[];
  auditLog: AuditRecord[];
  outbox: OutboxRecord[];
}

export function emptyFinStore(): FinStore {
  return {
    projects: [],
    headOffices: [],
    sites: [],
    departments: [],
    memberships: [],
    employees: [],
    attendanceSessions: [],
    leaveBalances: [],
    leaveRequests: [],
    roleAssignments: [],
    budgets: [],
    revisions: [],
    revisionLines: [],
    decisions: [],
    forecasts: [],
    forecastLines: [],
    auditLog: [],
    outbox: [],
  };
}

let nextId = 0;
const genId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;

export function fakeProject(over: Partial<Project> = {}): Project {
  return {
    id: genId(),
    companyId: 'c1',
    headOfficeId: genId(),
    code: 'P1',
    name: 'Project One',
    description: null,
    projectType: 'OTHER',
    clientName: null,
    contractRef: null,
    locationCity: null,
    locationDistrict: null,
    locationState: null,
    locationPin: null,
    projectSubtype: null,
    contractType: null,
    clientContactName: null,
    clientContactPhone: null,
    clientContactEmail: null,
    workOrderRef: null,
    tenderRef: null,
    contractValue: null,
    contractCurrency: null,
    contractDate: null,
    workOrderDate: null,
    locationAddressLine: null,
    locationLocality: null,
    locationCountry: null,
    geoLatitude: null,
    geoLongitude: null,
    scopeSummary: null,
    landArea: null,
    landAreaUnit: null,
    builtUpArea: null,
    numBuildings: null,
    numFloorsMax: null,
    numUnits: null,
    linearLengthKm: null,
    carriagewayWidthM: null,
    timezone: 'Asia/Kolkata',
    status: 'ACTIVE',
    startDate: null,
    endDate: null,
    ntpDate: null,
    revisedEndDate: null,
    actualStartDate: null,
    actualEndDate: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeEmployee(over: Partial<Employee> = {}): Employee {
  return {
    id: genId(),
    companyId: 'c1',
    employeeCode: 'E1',
    displayName: 'Fin User',
    principalId: 'p-fin',
    status: 'ACTIVE',
    engagementType: 'DIRECT_EMPLOYEE',
    designation: 'Engineer',
    tradeCategory: null,
    joiningDate: new Date('2024-01-15'),
    contactPhone: '9000000001',
    contactEmail: 'fin@example.com',
    emergencyContactName: 'EC',
    emergencyContactPhone: '9000000002',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as Employee;
}

export function fakeBudget(over: Partial<ProjectBudget> = {}): ProjectBudget {
  return {
    id: genId(),
    companyId: 'c1',
    projectId: 'pr-1',
    code: 'B1',
    name: 'Base Budget',
    description: null,
    currency: 'INR',
    status: 'ACTIVE',
    latestApprovedRevisionId: null,
    idempotencyKey: null,
    requestFingerprint: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeHeadOffice(over: Partial<HeadOffice> = {}) {
  return {
    id: genId(),
    companyId: 'c1',
    code: 'HQ',
    name: 'Head Office',
    ...over,
  };
}

export function fakeSite(over: Partial<Site> = {}): Site {
  return {
    id: genId(),
    companyId: 'c1',
    projectId: 'pr-1',
    code: 'S1',
    name: 'Site One',
    address: null,
    addressLine1: null,
    addressLine2: null,
    locality: null,
    city: null,
    district: null,
    state: null,
    pinCode: null,
    country: null,
    geoLatitude: null,
    geoLongitude: null,
    geoFenceRadiusM: null,
    description: null,
    siteType: null,
    landParcelId: null,
    plotArea: null,
    areaUnit: null,
    surveyNo: null,
    possessionDate: null,
    handoverDate: null,
    scopeSummary: null,
    mobilizationDate: null,
    accessArrangements: null,
    facilities: null,
    siteContactName: null,
    siteContactPhone: null,
    siteContactEmail: null,
    accessInstructions: null,
    emergencyDetails: null,
    timezone: null,
    status: 'ACTIVE',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeDepartment(over: Partial<Department> = {}): Department {
  return {
    id: genId(),
    companyId: 'c1',
    scopeType: 'COMPANY',
    projectId: null,
    siteId: null,
    baseHeadOfficeId: null,
    code: 'FIN',
    name: 'Finance',
    category: 'FINANCE',
    categoryLabel: null,
    headEmployeeId: null,
    capabilityKey: null,
    status: 'ACTIVE',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeMembership(over: Partial<DepartmentMembership> = {}): DepartmentMembership {
  return {
    id: genId(),
    companyId: 'c1',
    employeeId: 'e-1',
    departmentId: 'd-1',
    isPrimary: false,
    startedAt: new Date('2026-01-01'),
    endedAt: null,
    endReason: null,
    endNote: null,
    suspendUntil: null,
    supersededBy: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeSession(over: Partial<AttendanceSession> = {}): AttendanceSession {
  return {
    id: genId(),
    companyId: 'c1',
    employeeId: 'e-1',
    siteId: 'site-1',
    headOfficeId: null,
    policyId: 'pol-1',
    businessDate: '2026-11-01',
    status: 'COMPLETED',
    source: 'MOBILE_SELF',
    punchInAt: new Date('2026-11-01T08:00:00Z'),
    punchInLat: '25.5941' as never,
    punchInLng: '85.1376' as never,
    punchInDistanceM: null,
    punchInWithinGeofence: true,
    punchInRemarks: null,
    punchInSupervisorId: null,
    punchOutAt: new Date('2026-11-01T17:00:00Z'),
    punchOutLat: null,
    punchOutLng: null,
    punchOutDistanceM: null,
    punchOutWithinGeofence: null,
    punchOutRemarks: null,
    punchOutSupervisorId: null,
    grossDurationMins: 540,
    breakDurationMins: 60,
    netDurationMins: 480,
    presentUnits: '1.0' as never,
    overtimePUnits: '0.0' as never,
    totalPUnits: '1.0' as never,
    overtimeHours: '0.00' as never,
    isFlagged: false,
    flagReason: null,
    approvedBy: null,
    approvedAt: null,
    clientSessionId: null,
    syncBatchId: null,
    isSyncedOffline: false,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeLeaveBalance(over: Partial<LeaveBalance> = {}): LeaveBalance {
  return {
    id: genId(),
    companyId: 'c1',
    employeeId: 'e-1',
    leaveType: 'CASUAL',
    year: 2026,
    allocatedDays: '12' as never,
    usedDays: '3' as never,
    pendingDays: '1' as never,
    carriedOverDays: '2' as never,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeLeaveRequest(over: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: genId(),
    companyId: 'c1',
    employeeId: 'e-1',
    leaveType: 'CASUAL',
    startDate: new Date('2026-03-10'),
    endDate: new Date('2026-03-12'),
    isHalfDay: false,
    halfDayPortion: null,
    totalDays: '3' as never,
    reason: 'family function',
    documentId: null,
    status: 'APPROVED',
    reviewedBy: null,
    reviewedAt: null,
    reviewRemarks: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const dupCheck = (cond: boolean) => {
  if (cond) throw new DuplicateCodeError('DUP');
};

export function makeFinanceTestRepos(store: FinStore): FinanceRepos {
  const findRevision = (companyId: string, budgetId: string, id: string) =>
    store.revisions.find(
      (r) => r.id === id && r.companyId === companyId && r.budgetId === budgetId,
    ) ?? null;
  const deptOf = (companyId: string, departmentId: string) =>
    store.departments.find((d) => d.id === departmentId && d.companyId === companyId) ?? null;
  const withDept = (m: DepartmentMembership): FinanceMembership | null => {
    const department = deptOf(m.companyId, m.departmentId);
    return department === null ? null : { ...m, department };
  };
  const activeMembership = (m: DepartmentMembership, at: Date) =>
    m.endedAt === null || m.endedAt > at;
  const groupCounts = <T extends { status: string }>(rows: T[]) => {
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.status, (out.get(r.status) ?? 0) + 1);
    return [...out.entries()].map(([status, count]) => ({ status, count })) as {
      status: T['status'];
      count: number;
    }[];
  };
  return {
    projects: {
      findById: async (companyId, id) =>
        store.projects.find((p) => p.id === id && p.companyId === companyId) ?? null,
      list: async (companyId, filter) => {
        const search = filter.search?.toLowerCase();
        return store.projects
          .filter(
            (p) =>
              p.companyId === companyId &&
              (filter.status === undefined || p.status === filter.status) &&
              (search === undefined ||
                [p.code, p.name, p.locationCity ?? ''].some((v) =>
                  v.toLowerCase().includes(search),
                )) &&
              (filter.cursor === undefined || p.id > filter.cursor),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, filter.limit + 1)
          .map((p) => ({
            ...p,
            headOffice: store.headOffices.find(
              (h) => h.id === p.headOfficeId && h.companyId === companyId,
            ) ?? { id: p.headOfficeId, code: '?', name: '?' },
          }));
      },
      statusCounts: async (companyId) =>
        groupCounts(store.projects.filter((p) => p.companyId === companyId)),
    },
    sites: {
      list: async (companyId, projectId, filter) =>
        store.sites
          .filter(
            (s) =>
              s.companyId === companyId &&
              s.projectId === projectId &&
              (filter.status === undefined || s.status === filter.status) &&
              (filter.cursor === undefined || s.id > filter.cursor),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, filter.limit + 1),
      statusCounts: async (companyId) =>
        groupCounts(store.sites.filter((s) => s.companyId === companyId)),
    },
    employees: {
      findByPrincipal: async (companyId, principalId) =>
        store.employees.find((e) => e.companyId === companyId && e.principalId === principalId) ??
        null,
      findById: async (companyId, id) =>
        store.employees.find((e) => e.id === id && e.companyId === companyId) ?? null,
      list: async (companyId, filter, at) => {
        const search = filter.search?.toLowerCase();
        const placed = (e: Employee) => {
          if (
            filter.departmentId === undefined &&
            filter.projectId === undefined &&
            filter.siteId === undefined
          )
            return true;
          return store.memberships.some(
            (m) =>
              m.companyId === companyId &&
              m.employeeId === e.id &&
              activeMembership(m, at) &&
              (() => {
                const d = deptOf(companyId, m.departmentId);
                return (
                  d !== null &&
                  (filter.departmentId === undefined || d.id === filter.departmentId) &&
                  // Mirror repo: PROJECT depts match directly; SITE depts via site.projectId.
                  (filter.projectId === undefined ||
                    d.projectId === filter.projectId ||
                    store.sites.some(
                      (s) => s.id === d.siteId && s.projectId === filter.projectId,
                    )) &&
                  (filter.siteId === undefined || d.siteId === filter.siteId)
                );
              })(),
          );
        };
        return store.employees
          .filter(
            (e) =>
              e.companyId === companyId &&
              (filter.status === undefined || e.status === filter.status) &&
              (search === undefined ||
                [e.displayName, e.employeeCode].some((v) => v.toLowerCase().includes(search))) &&
              placed(e) &&
              (filter.cursor === undefined || e.id > filter.cursor),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, filter.limit + 1)
          .map((e) => ({
            ...e,
            memberships: store.memberships
              .filter(
                (m) =>
                  m.companyId === companyId &&
                  m.employeeId === e.id &&
                  m.isPrimary &&
                  activeMembership(m, at),
              )
              .map(withDept)
              .filter((m): m is FinanceMembership => m !== null)
              .slice(0, 1),
          }));
      },
      activeMemberships: async (companyId, employeeId, at) =>
        store.memberships
          .filter(
            (m) =>
              m.companyId === companyId && m.employeeId === employeeId && activeMembership(m, at),
          )
          .map(withDept)
          .filter((m): m is FinanceMembership => m !== null)
          .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.id.localeCompare(b.id)),
      statusCounts: async (companyId) =>
        groupCounts(store.employees.filter((e) => e.companyId === companyId)),
    },
    attendance: {
      summarize: async (companyId, employeeId, from, to) => {
        const rows = store.attendanceSessions.filter(
          (s) =>
            s.companyId === companyId &&
            s.employeeId === employeeId &&
            s.businessDate >= from &&
            s.businessDate <= to,
        );
        const sum = (f: (s: AttendanceSession) => Prisma.Decimal | number) =>
          rows.reduce<Prisma.Decimal>((acc, s) => acc.plus(f(s)), new Prisma.Decimal(0));
        return {
          sessions: rows.length,
          presentUnits: sum((s) => s.presentUnits).toFixed(1),
          overtimeUnits: sum((s) => s.overtimePUnits).toFixed(1),
          totalUnits: sum((s) => s.totalPUnits).toFixed(1),
          overtimeHours: sum((s) => s.overtimeHours).toFixed(2),
          grossMinutes: rows.reduce((a, s) => a + s.grossDurationMins, 0),
          netMinutes: rows.reduce((a, s) => a + s.netDurationMins, 0),
          flaggedSessions: rows.filter((s) => s.isFlagged).length,
          sitesWorked: new Set(rows.map((s) => s.siteId)).size,
        };
      },
    },
    leave: {
      balances: async (companyId, employeeId, year) =>
        store.leaveBalances
          .filter(
            (b) => b.companyId === companyId && b.employeeId === employeeId && b.year === year,
          )
          .sort((a, b) => a.leaveType.localeCompare(b.leaveType))
          .map((b) => ({
            ...b,
            allocatedDays: new Prisma.Decimal(b.allocatedDays as unknown as string),
            usedDays: new Prisma.Decimal(b.usedDays as unknown as string),
            pendingDays: new Prisma.Decimal(b.pendingDays as unknown as string),
            carriedOverDays: new Prisma.Decimal(b.carriedOverDays as unknown as string),
          })),
      requestStats: async (companyId, employeeId, yearStart, yearEnd) => {
        const groups = new Map<string, { count: number; days: Prisma.Decimal }>();
        for (const r of store.leaveRequests.filter(
          (r) =>
            r.companyId === companyId &&
            r.employeeId === employeeId &&
            r.startDate >= yearStart &&
            r.startDate <= yearEnd,
        )) {
          const g = groups.get(r.status) ?? { count: 0, days: new Prisma.Decimal(0) };
          g.count += 1;
          g.days = g.days.plus(r.totalDays);
          groups.set(r.status, g);
        }
        return [...groups.entries()].map(([status, g]) => ({
          status: status as LeaveRequest['status'],
          count: g.count,
          totalDays: g.days.toFixed(1),
        }));
      },
    },
    access: {
      hasRoleAssignment: async (companyId, principalId, roleKeys, at) =>
        store.roleAssignments.some(
          (a) =>
            a.companyId === companyId &&
            a.principalId === principalId &&
            a.revokedAt === null &&
            roleKeys.includes(a.roleKey) &&
            (a.effectiveFrom === null || a.effectiveFrom <= at) &&
            (a.effectiveTo === null || a.effectiveTo > at),
        ),
    },
    budgets: {
      create: async (companyId, data) => {
        dupCheck(
          store.budgets.some(
            (b) =>
              b.companyId === companyId && b.projectId === data.projectId && b.code === data.code,
          ),
        );
        if (data.idempotencyKey !== undefined) {
          dupCheck(
            store.budgets.some(
              (b) =>
                b.companyId === companyId &&
                b.projectId === data.projectId &&
                b.idempotencyKey === data.idempotencyKey,
            ),
          );
        }
        const row = fakeBudget({
          companyId,
          projectId: data.projectId,
          code: data.code,
          name: data.name,
          description: data.description ?? null,
          currency: data.currency,
          idempotencyKey: data.idempotencyKey ?? null,
          requestFingerprint: data.requestFingerprint ?? null,
        });
        store.budgets.push(row);
        return row;
      },
      findById: async (companyId, id) =>
        store.budgets.find((b) => b.id === id && b.companyId === companyId) ?? null,
      findDetail: async (companyId, id): Promise<BudgetDetail | null> => {
        const budget = store.budgets.find((b) => b.id === id && b.companyId === companyId);
        if (!budget) return null;
        const latestApprovedRevision =
          budget.latestApprovedRevisionId === null
            ? null
            : findRevision(companyId, budget.id, budget.latestApprovedRevisionId);
        return { ...budget, latestApprovedRevision };
      },
      findByIdempotencyKey: async (companyId, projectId, key) =>
        store.budgets.find(
          (b) => b.companyId === companyId && b.projectId === projectId && b.idempotencyKey === key,
        ) ?? null,
      list: async (companyId, projectId, filter: BudgetListFilter) =>
        store.budgets
          .filter(
            (b) =>
              b.companyId === companyId &&
              b.projectId === projectId &&
              (filter.status === undefined || b.status === filter.status) &&
              (filter.cursor === undefined || b.id > filter.cursor),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, filter.limit),
      update: async (companyId, id, data, expectedVersion) => {
        const b = store.budgets.find((x) => x.id === id && x.companyId === companyId);
        if (!b || (expectedVersion !== undefined && b.version !== expectedVersion)) {
          return { count: 0 };
        }
        Object.assign(b, data);
        b.version += 1;
        return { count: 1 };
      },
      openRevisionCount: async (companyId, budgetId) =>
        store.revisions.filter(
          (r) =>
            r.companyId === companyId &&
            r.budgetId === budgetId &&
            (r.status === 'DRAFT' || r.status === 'SUBMITTED'),
        ).length,
      maxRevisionNumber: async (companyId, budgetId) =>
        store.revisions
          .filter((r) => r.companyId === companyId && r.budgetId === budgetId)
          .reduce((m, r) => Math.max(m, r.revision), 0),
      statusCounts: async (companyId) =>
        groupCounts(store.budgets.filter((b) => b.companyId === companyId)),
      approvedTotals: async (companyId) => {
        const byCurrency = new Map<string, Prisma.Decimal>();
        for (const b of store.budgets.filter(
          (x) => x.companyId === companyId && x.latestApprovedRevisionId !== null,
        )) {
          const rev = store.revisions.find(
            (r) => r.id === b.latestApprovedRevisionId && r.companyId === companyId,
          );
          if (rev === undefined) continue;
          byCurrency.set(
            b.currency,
            (byCurrency.get(b.currency) ?? new Prisma.Decimal(0)).plus(rev.totalAmount),
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
        dupCheck(
          store.revisions.some(
            (r) => r.companyId === companyId && r.budgetId === budgetId && r.revision === revision,
          ),
        );
        const row = {
          id: genId(),
          companyId,
          budgetId,
          revision,
          status: 'DRAFT',
          totalAmount,
          notes: input.notes ?? null,
          submittedByPrincipalId: null,
          submittedAt: null,
          decidedByPrincipalId: null,
          decidedAt: null,
          idempotencyKey: input.idempotencyKey ?? null,
          requestFingerprint: requestFingerprint ?? null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as BudgetRevision;
        store.revisions.push(row);
        input.lines.forEach((line, i) =>
          store.revisionLines.push({
            id: genId(),
            companyId,
            revisionId: row.id,
            category: line.category,
            description: line.description,
            amount: line.amount,
            sortOrder: i,
            createdAt: new Date(),
          } as unknown as BudgetRevisionLine),
        );
        return row;
      },
      findById: async (companyId, budgetId, id) => findRevision(companyId, budgetId, id),
      findDetail: async (companyId, budgetId, id): Promise<BudgetRevisionWithLines | null> => {
        const r = findRevision(companyId, budgetId, id);
        if (!r) return null;
        return {
          ...r,
          lines: store.revisionLines
            .filter((l) => l.companyId === companyId && l.revisionId === r.id)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
          decisions: store.decisions
            .filter((d) => d.companyId === companyId && d.revisionId === r.id)
            .sort(
              (a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.id.localeCompare(b.id),
            ),
        };
      },
      findByIdempotencyKey: async (companyId, budgetId, key) =>
        store.revisions.find(
          (r) => r.companyId === companyId && r.budgetId === budgetId && r.idempotencyKey === key,
        ) ?? null,
      list: async (companyId, budgetId, status) =>
        store.revisions
          .filter(
            (r) =>
              r.companyId === companyId &&
              r.budgetId === budgetId &&
              (status === undefined || r.status === status),
          )
          .sort((a, b) => a.revision - b.revision)
          .map((r) => ({
            ...r,
            lines: store.revisionLines
              .filter((l) => l.companyId === companyId && l.revisionId === r.id)
              .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
          })),
      transition: async (companyId, id, fromStatus, data, expectedVersion) => {
        const r = store.revisions.find((x) => x.id === id && x.companyId === companyId);
        if (
          r?.status !== fromStatus ||
          (expectedVersion !== undefined && r.version !== expectedVersion)
        ) {
          return { count: 0 };
        }
        Object.assign(r, data);
        r.version += 1;
        return { count: 1 };
      },
      pendingReviewCount: async (companyId) =>
        store.revisions.filter((r) => r.companyId === companyId && r.status === 'SUBMITTED').length,
    },
    decisions: {
      create: async (companyId, data) => {
        if (data.idempotencyKey !== undefined) {
          dupCheck(
            store.decisions.some(
              (d) => d.revisionId === data.revisionId && d.idempotencyKey === data.idempotencyKey,
            ),
          );
        }
        const row = {
          id: genId(),
          companyId,
          ...data,
          actorPrincipalId: data.actorPrincipalId ?? null,
          reason: data.reason ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
          requestFingerprint: data.requestFingerprint ?? null,
          decidedAt: new Date(),
          createdAt: new Date(),
        } as unknown as BudgetReviewDecision;
        store.decisions.push(row);
        return row;
      },
      findByIdempotencyKey: async (companyId, revisionId, key) =>
        store.decisions.find(
          (d) =>
            d.companyId === companyId && d.revisionId === revisionId && d.idempotencyKey === key,
        ) ?? null,
      list: async (companyId, revisionId) =>
        store.decisions
          .filter((d) => d.companyId === companyId && d.revisionId === revisionId)
          .sort(
            (a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.id.localeCompare(b.id),
          ),
    },
    forecasts: {
      create: async (companyId, data: CreateForecastInput & { projectId: string }) => {
        if (data.idempotencyKey !== undefined) {
          dupCheck(
            store.forecasts.some(
              (f) =>
                f.companyId === companyId &&
                f.projectId === data.projectId &&
                f.idempotencyKey === data.idempotencyKey,
            ),
          );
        }
        const row = {
          id: genId(),
          companyId,
          projectId: data.projectId,
          name: data.name,
          description: data.description ?? null,
          currency: data.currency,
          periodStart: new Date(`${data.periodStart}T00:00:00.000Z`),
          periodEnd: new Date(`${data.periodEnd}T00:00:00.000Z`),
          status: 'ACTIVE',
          revision: 1,
          idempotencyKey: data.idempotencyKey ?? null,
          requestFingerprint: (data as { requestFingerprint?: string }).requestFingerprint ?? null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as CashFlowForecast;
        store.forecasts.push(row);
        data.lines.forEach((line, i) =>
          store.forecastLines.push({
            id: genId(),
            companyId,
            forecastId: row.id,
            direction: line.direction,
            category: line.category,
            amount: line.amount,
            expectedDate:
              line.expectedDate !== undefined
                ? new Date(`${line.expectedDate}T00:00:00.000Z`)
                : null,
            description: line.description ?? null,
            sortOrder: i,
            createdAt: new Date(),
          } as unknown as CashFlowForecastLine),
        );
        return row;
      },
      findById: async (companyId, id) =>
        store.forecasts.find((f) => f.id === id && f.companyId === companyId) ?? null,
      findDetail: async (companyId, id) => {
        const f = store.forecasts.find((x) => x.id === id && x.companyId === companyId);
        if (!f) return null;
        return {
          ...f,
          lines: store.forecastLines
            .filter((l) => l.companyId === companyId && l.forecastId === f.id)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
        };
      },
      findByIdempotencyKey: async (companyId, projectId, key) =>
        store.forecasts.find(
          (f) => f.companyId === companyId && f.projectId === projectId && f.idempotencyKey === key,
        ) ?? null,
      list: async (companyId, projectId, filter: ForecastListFilter) =>
        store.forecasts
          .filter(
            (f) =>
              f.companyId === companyId &&
              f.projectId === projectId &&
              (filter.status === undefined || f.status === filter.status) &&
              (filter.cursor === undefined || f.id > filter.cursor),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, filter.limit),
      revise: async (companyId, id, data, expectedVersion) => {
        const f = store.forecasts.find((x) => x.id === id && x.companyId === companyId);
        if (f?.version !== expectedVersion) return { count: 0 };
        Object.assign(f, data.header);
        f.version += 1;
        if (data.bumpRevision) f.revision += 1;
        if (data.lines !== undefined) {
          store.forecastLines = store.forecastLines.filter(
            (l) => !(l.companyId === companyId && l.forecastId === id),
          );
          data.lines.forEach((line, i) =>
            store.forecastLines.push({
              id: genId(),
              companyId,
              forecastId: id,
              direction: line.direction,
              category: line.category,
              amount: line.amount,
              expectedDate:
                line.expectedDate !== undefined
                  ? new Date(`${line.expectedDate}T00:00:00.000Z`)
                  : null,
              description: line.description ?? null,
              sortOrder: i,
              createdAt: new Date(),
            } as unknown as CashFlowForecastLine),
          );
        }
        return { count: 1 };
      },
      activeLines: async (companyId) =>
        store.forecasts
          .filter((f) => f.companyId === companyId && f.status === 'ACTIVE')
          .map((f) => ({
            currency: f.currency,
            lines: store.forecastLines
              .filter((l) => l.companyId === companyId && l.forecastId === f.id)
              .map((l) => ({ direction: l.direction, amount: l.amount })),
          })),
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
    outbox: {
      record: async (entry) => {
        store.outbox.push(entry);
      },
    },
  };
}

export class FakeFinanceUoW implements FinanceUnitOfWork {
  constructor(public readonly store: FinStore) {}

  async run<T>(fn: (repos: FinanceRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeFinanceTestRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}
