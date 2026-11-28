import type { Employee, Prisma, PrismaClient } from '@prisma/client';
import { makeDepartmentRepos } from '../department/repository.js';
import type { DepartmentRepos } from '../department/repository.js';
import { scopedUpdate } from '../organization/repository.js';
import { mapOrgWriteError } from '../organization/errors.js';
import { FINANCE_ROLE_KEYS } from '../setup/role-templates.js';

type Tx = Prisma.TransactionClient;

export interface EmployeeWithPrincipal extends Employee {
  principal?: {
    id: string;
    loginId: string | null;
    status: string;
    sessions?: { createdAt: Date }[];
  } | null;
}

/** Department-scope reference for scoped team queries — trusted DB scope. */
export type TeamScopeRef = { projectId: string } | { siteId: string };

export interface EmployeeRowRepository {
  findById(companyId: string, id: string): Promise<EmployeeWithPrincipal | null>;
  findByCode(companyId: string, code: string): Promise<EmployeeWithPrincipal | null>;
  list(
    companyId: string,
    filter: {
      status?: string;
      q?: string;
      cursor?: { createdAt: Date; id: string };
      offset?: number;
      limit: number;
    },
  ): Promise<EmployeeWithPrincipal[]>;
  count(companyId: string, filter: { status?: string; q?: string }): Promise<number>;
  /**
   * Employees holding at least one CURRENT membership in the requested
   * department scope. Keyset-paginated on (createdAt, id); membership rows
   * are NOT loaded here — pair with memberships.currentInScope.
   */
  listScopedTeam(
    companyId: string,
    scope: TeamScopeRef,
    filter: {
      q?: string;
      status?: string;
      cursor?: { createdAt: Date; id: string };
      limit: number;
    },
    now: Date,
  ): Promise<Employee[]>;
  create(companyId: string, data: Record<string, unknown>): Promise<Employee>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Employee>;
  /** Deactivation support — same tx as the status change. */
  revokeAssignmentsForPrincipal(
    companyId: string,
    principalId: string,
    at: Date,
  ): Promise<string[]>;
  /**
   * Membership-end cascade — revokes only FINANCE_* role assignments,
   * same tx as the membership end. Returns revoked assignment ids for audit.
   */
  revokeFinanceRoleAssignments(companyId: string, principalId: string, at: Date): Promise<string[]>;
  clearHeadReferences(companyId: string, employeeId: string): Promise<{ id: string }[]>;
  /** Last-admin guard: distinct active principals holding any of the keys. */
  activeHoldersOfKeys(companyId: string, keys: string[], at: Date): Promise<string[]>;
  /** Deactivation cascade — end all ACTIVE memberships in the same tx. */
  endActiveMemberships(companyId: string, employeeId: string): Promise<{ id: string }[]>;
  /**
   * Row lock (SELECT … FOR UPDATE) serializing per-employee membership and
   * primary writes inside the transaction — the same pattern as the
   * project-lock used for leadership-role replacement.
   */
  lockForUpdate(companyId: string, id: string): Promise<void>;
}

export type DepartmentMembershipWithDepartment = import('@prisma/client').DepartmentMembership & {
  department?: import('@prisma/client').Department | null;
  employee?: import('@prisma/client').Employee | null;
};

/** Operational columns only — contact, emergency-contact, principal, and
 *  login fields are deliberately absent from scoped workforce responses. */
const SCOPED_EMPLOYEE_SELECT = {
  id: true,
  employeeCode: true,
  displayName: true,
  engagementType: true,
  designation: true,
  tradeCategory: true,
  status: true,
} satisfies Prisma.EmployeeSelect;

/** Trusted department-scope predicate: project scope covers departments
 *  pinned to the project itself and to its child sites; site scope covers
 *  that site only. Company/HO departments are never in scope. */
function departmentInScope(scope: TeamScopeRef): Prisma.DepartmentWhereInput {
  return 'projectId' in scope
    ? {
        OR: [{ projectId: scope.projectId }, { site: { is: { projectId: scope.projectId } } }],
      }
    : { siteId: scope.siteId };
}

/** "Current" membership at `now`: started, and not yet ended. */
function currentMembershipInScope(
  scope: TeamScopeRef,
  now: Date,
): Prisma.DepartmentMembershipWhereInput {
  return {
    startedAt: { lte: now },
    OR: [{ endedAt: null }, { endedAt: { gt: now } }],
    department: departmentInScope(scope),
  };
}

/** Safe employee projection for scoped workforce responses. */
export type ScopedEmployee = Pick<
  Employee,
  | 'id'
  | 'employeeCode'
  | 'displayName'
  | 'engagementType'
  | 'designation'
  | 'tradeCategory'
  | 'status'
>;

const DEPARTMENT_REF_SELECT = {
  id: true,
  code: true,
  name: true,
  scopeType: true,
  projectId: true,
  siteId: true,
} satisfies Prisma.DepartmentSelect;

export interface DepartmentRef {
  id: string;
  code: string;
  name: string;
  scopeType: string;
  projectId: string | null;
  siteId: string | null;
}

/** Department embed for lifecycle affected-set loads — includes the columns
 *  reinstatement eligibility and marker coverage need (status, head, and the
 *  site's parent projectId for project-scope exit markers). */
const LIFECYCLE_DEPT_SELECT = {
  id: true,
  code: true,
  name: true,
  scopeType: true,
  projectId: true,
  siteId: true,
  status: true,
  headEmployeeId: true,
  site: { select: { projectId: true } },
} satisfies Prisma.DepartmentSelect;

export type LifecycleMembership = import('@prisma/client').DepartmentMembership & {
  department: {
    id: string;
    code: string;
    name: string;
    scopeType: string;
    projectId: string | null;
    siteId: string | null;
    status: string;
    headEmployeeId: string | null;
    site: { projectId: string } | null;
  } | null;
};

export type DepartmentMembershipDetail = import('@prisma/client').DepartmentMembership & {
  department?: DepartmentRef | null;
  employee?: ScopedEmployee | null;
};

/** Pre-validated employee-document link row for the onboarding transaction. */
export interface EmployeeDocumentLinkInput {
  companyId: string;
  employeeId: string;
  documentId: string;
  documentType: import('@prisma/client').EmployeeDocumentType;
  title: string;
  documentNumber: string | null;
  issuingAuthority: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
}

export interface EmployeeRepos extends DepartmentRepos {
  employees: EmployeeRowRepository & {
    findById(companyId: string, id: string): Promise<Employee | null>;
  };
  documents: {
    /** Batch availability probe — returns the subset of `ids` that are
     *  company-owned and AVAILABLE. Batch: never probe per document. */
    availableIds(companyId: string, ids: string[]): Promise<string[]>;
  };
  employeeDocuments: {
    /** Bulk link writes inside the onboarding transaction — rows are
     *  pre-validated against availableIds, so a failure aborts the onboard. */
    createMany(rows: EmployeeDocumentLinkInput[]): Promise<{ count: number }>;
  };
  memberships: {
    list(companyId: string, employeeId: string): Promise<DepartmentMembershipWithDepartment[]>;
    findById(
      companyId: string,
      employeeId: string,
      id: string,
    ): Promise<DepartmentMembershipWithDepartment | null>;
    activeForEmployee(
      companyId: string,
      employeeId: string,
    ): Promise<import('@prisma/client').DepartmentMembership[]>;
    /**
     * Effective memberships in an ACTIVE FINANCE-category department —
     * the same predicate as role-grant eligibility (started, not ended,
     * department still active).
     */
    activeFinanceCount(companyId: string, employeeId: string, at: Date): Promise<number>;
    create(data: {
      companyId: string;
      employeeId: string;
      departmentId: string;
      isPrimary: boolean;
      startedAt?: Date;
    }): Promise<DepartmentMembershipWithDepartment>;
    setPrimary(
      companyId: string,
      employeeId: string,
      id: string,
      version: number,
    ): Promise<unknown>;
    demoteOthers(companyId: string, employeeId: string, exceptId: string): Promise<unknown>;
    end(
      companyId: string,
      employeeId: string,
      id: string,
      version: number,
      endReason?: import('@prisma/client').DepartmentMembershipEndReason,
    ): Promise<unknown>;
    /**
     * Fetch one membership bound to its department — scoped mutation paths
     * prove the row belongs to the authorized department before writing.
     */
    findInDepartment(
      companyId: string,
      departmentId: string,
      id: string,
    ): Promise<DepartmentMembershipWithDepartment | null>;
    /** The employee's ACTIVE primary (endedAt IS NULL), if any — the single
     *  row the global unique index permits. Includes the department ref so
     *  callers can authorize the demote target's scope. */
    activePrimary(
      companyId: string,
      employeeId: string,
    ): Promise<DepartmentMembershipWithDepartment | null>;
    /** Memberships effective at `at` (startedAt <= at, not ended) — used to
     *  evaluate the leave-ambiguity invariant before writes. */
    effectiveAt(
      companyId: string,
      employeeId: string,
      at: Date,
    ): Promise<import('@prisma/client').DepartmentMembership[]>;
    /** Department-scoped primary flip — sets isPrimary to the given boolean
     *  with a version guard. count=0 → stale version. */
    setPrimaryFlag(
      companyId: string,
      departmentId: string,
      id: string,
      isPrimary: boolean,
      version: number,
    ): Promise<{ count: number }>;
    /** Active (effective at `at`) membership of the employee in this
     *  department — head-eligibility probe. */
    hasActive(
      companyId: string,
      departmentId: string,
      employeeId: string,
      at: Date,
    ): Promise<boolean>;
    /**
     * CURRENT memberships (startedAt <= now, not ended) restricted to the
     * requested department scope, for the given employees. Batched — never
     * call per employee.
     */
    currentInScope(
      companyId: string,
      scope: TeamScopeRef,
      employeeIds: string[],
      now: Date,
    ): Promise<DepartmentMembershipWithDepartment[]>;
    /**
     * Membership history of one department. `includeEnded=false` returns
     * current rows only; future-dated memberships are never returned.
     * Keyset-paginated on (createdAt, id).
     */
    listForDepartment(
      companyId: string,
      departmentId: string,
      filter: {
        includeEnded: boolean;
        cursor?: { createdAt: Date; id: string };
        limit: number;
      },
      now: Date,
    ): Promise<DepartmentMembershipDetail[]>;
    /**
     * W4 lifecycle: ACTIVE (endedAt IS NULL) memberships of one employee
     * restricted to a site/project department scope — the suspend/exit
     * affected set. Loaded under the employee row lock.
     */
    activeInScope(
      companyId: string,
      employeeId: string,
      scope: TeamScopeRef,
    ): Promise<LifecycleMembership[]>;
    /**
     * W4 lifecycle: ended rows with endReason=SUSPENDED and supersededBy
     * IS NULL in scope — the restorable reinstatement set.
     */
    suspendedInScope(
      companyId: string,
      employeeId: string,
      scope: TeamScopeRef,
    ): Promise<LifecycleMembership[]>;
    /**
     * W4 lifecycle: bulk end of the affected set with a typed endReason.
     * endedAt is server-controlled; count < ids.length means a row was
     * ended concurrently and the caller must treat it as a conflict.
     */
    endAll(
      companyId: string,
      ids: string[],
      endReason: import('@prisma/client').DepartmentMembershipEndReason,
      fields: { endNote?: string | null; suspendUntil?: Date | null },
    ): Promise<{ count: number }>;
    /** Link an ended row to the new membership that reinstated it —
     *  same company + same employee enforced by the composite FK. */
    markSuperseded(
      companyId: string,
      employeeId: string,
      oldId: string,
      newId: string,
    ): Promise<unknown>;
  };
  /** W4 append-only exit markers — evaluated per affected department. */
  siteWorkforceExits: {
    /** All markers for the employee (small set) — the service matches each
     *  affected dept: a site marker blocks that site's rows, a project
     *  marker covers the project and its child sites. */
    listForEmployee(
      companyId: string,
      employeeId: string,
    ): Promise<{ id: string; siteId: string | null; projectId: string | null }[]>;
    create(entry: {
      companyId: string;
      employeeId: string;
      siteId?: string;
      projectId?: string;
      exitedByPrincipalId?: string;
      note?: string;
    }): Promise<{ id: string }>;
  };
  /** Transactional notification outbox — safe ids/statuses only. */
  outbox: {
    record(entry: {
      companyId: string;
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      eventKey: string;
      recipientPrincipalIds: string[];
      summary: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export function makeEmployeeRepos(tx: Tx): EmployeeRepos {
  const dept = makeDepartmentRepos(tx);
  const employees: EmployeeRowRepository = {
    findById: (companyId, id) =>
      tx.employee.findFirst({
        where: { id, companyId },
        include: {
          principal: {
            select: {
              id: true,
              loginId: true,
              status: true,
              sessions: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { createdAt: true },
              },
            },
          },
        },
      }),
    lockForUpdate: async (companyId, id) => {
      await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    },
    findByCode: (companyId, code) =>
      tx.employee.findFirst({
        where: { companyId, employeeCode: code },
        include: {
          principal: {
            select: {
              id: true,
              loginId: true,
              status: true,
              sessions: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { createdAt: true },
              },
            },
          },
        },
      }),
    list: (companyId, filter) => {
      const q = filter.q?.trim();
      return tx.employee.findMany({
        where: {
          companyId,
          ...(filter.status !== undefined ? { status: filter.status as never } : {}),
          ...(q !== undefined && q !== ''
            ? {
                OR: [
                  { employeeCode: { contains: q, mode: 'insensitive' as const } },
                  { displayName: { contains: q, mode: 'insensitive' as const } },
                  { designation: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
          ...(filter.offset === undefined && filter.cursor !== undefined
            ? {
                OR: [
                  { createdAt: { lt: filter.cursor.createdAt } },
                  { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
                ],
              }
            : {}),
        },
        include: {
          principal: {
            select: {
              id: true,
              loginId: true,
              status: true,
              sessions: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { createdAt: true },
              },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(filter.offset !== undefined ? { skip: filter.offset } : {}),
        take: filter.limit,
      });
    },
    count: (companyId, filter) => {
      const q = filter.q?.trim();
      return tx.employee.count({
        where: {
          companyId,
          ...(filter.status !== undefined ? { status: filter.status as never } : {}),
          ...(q !== undefined && q !== ''
            ? {
                OR: [
                  { employeeCode: { contains: q, mode: 'insensitive' as const } },
                  { displayName: { contains: q, mode: 'insensitive' as const } },
                  { designation: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
      });
    },
    listScopedTeam: (companyId, scope, filter, now) =>
      tx.employee.findMany({
        where: {
          companyId,
          ...(filter.status !== undefined ? { status: filter.status as never } : {}),
          ...(filter.q !== undefined && filter.q.trim() !== ''
            ? {
                OR: [
                  { employeeCode: { contains: filter.q.trim(), mode: 'insensitive' as const } },
                  { displayName: { contains: filter.q.trim(), mode: 'insensitive' as const } },
                ],
              }
            : {}),
          ...(filter.cursor !== undefined
            ? {
                OR: [
                  { createdAt: { lt: filter.cursor.createdAt } },
                  { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
                ],
              }
            : {}),
          memberships: { some: currentMembershipInScope(scope, now) },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter.limit,
      }),
    create: async (companyId, data) => {
      try {
        return await tx.employee.create({ data: { ...data, companyId } } as never);
      } catch (error) {
        mapOrgWriteError(error, 'EMPLOYEE');
      }
    },
    update: (companyId, id, data, expectedVersion) =>
      scopedUpdate(
        'EMPLOYEE',
        { id, companyId },
        data,
        expectedVersion,
        (args) => tx.employee.updateMany(args),
        () => tx.employee.findFirst({ where: { id, companyId } }),
      ),
    revokeAssignmentsForPrincipal: async (companyId, principalId, at) => {
      const rows = await tx.roleAssignment.findMany({
        where: { companyId, principalId, revokedAt: null },
        select: { id: true },
      });
      if (rows.length > 0) {
        await tx.roleAssignment.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { revokedAt: at },
        });
      }
      return rows.map((r) => r.id);
    },
    revokeFinanceRoleAssignments: async (companyId, principalId, at) => {
      const rows = await tx.roleAssignment.findMany({
        where: {
          companyId,
          principalId,
          revokedAt: null,
          role: { is: { key: { in: [...FINANCE_ROLE_KEYS] } } },
        },
        select: { id: true },
      });
      if (rows.length > 0) {
        await tx.roleAssignment.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { revokedAt: at },
        });
      }
      return rows.map((r) => r.id);
    },
    clearHeadReferences: async (companyId, employeeId) => {
      const rows = await tx.department.findMany({
        where: { companyId, headEmployeeId: employeeId },
        select: { id: true },
      });
      for (const r of rows) {
        await tx.department.updateMany({
          where: { id: r.id, companyId },
          data: { headEmployeeId: null, version: { increment: 1 } },
        });
      }
      return rows;
    },
    endActiveMemberships: async (companyId, employeeId) => {
      const rows = await tx.departmentMembership.findMany({
        where: { companyId, employeeId, endedAt: null },
        select: { id: true },
      });
      for (const r of rows) {
        await tx.departmentMembership.updateMany({
          where: { id: r.id, companyId },
          data: {
            endedAt: new Date(),
            endReason: 'DEACTIVATED',
            version: { increment: 1 },
          },
        });
      }
      return rows;
    },
    activeHoldersOfKeys: async (companyId, keys, at) => {
      const rows = await tx.roleAssignment.findMany({
        where: {
          companyId,
          revokedAt: null,
          OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: at } }],
          AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }],
          role: { permissions: { some: { permission: { key: { in: keys } } } } },
          principal: { status: 'ACTIVE' },
        },
        select: { principalId: true },
      });
      return [...new Set(rows.map((r) => r.principalId))];
    },
  };
  const memberships = {
    list: (companyId: string, employeeId: string) =>
      tx.departmentMembership.findMany({
        where: { companyId, employeeId },
        include: {
          department: true,
          employee: true,
        },
        orderBy: [{ endedAt: 'desc' as const }, { startedAt: 'desc' as const }],
      }),
    findById: (companyId: string, employeeId: string, id: string) =>
      tx.departmentMembership.findFirst({
        where: { id, companyId, employeeId },
        include: {
          department: true,
          employee: true,
        },
      }),
    activeForEmployee: (companyId: string, employeeId: string) =>
      tx.departmentMembership.findMany({ where: { companyId, employeeId, endedAt: null } }),
    activeFinanceCount: (companyId: string, employeeId: string, at: Date) =>
      tx.departmentMembership.count({
        where: {
          companyId,
          employeeId,
          startedAt: { lte: at },
          OR: [{ endedAt: null }, { endedAt: { gt: at } }],
          department: { is: { category: 'FINANCE', status: 'ACTIVE' } },
        },
      }),
    create: async (data: {
      companyId: string;
      employeeId: string;
      departmentId: string;
      isPrimary: boolean;
      startedAt?: Date;
    }) => {
      try {
        return await tx.departmentMembership.create({
          data,
          include: { department: true, employee: true },
        });
      } catch (error) {
        // Partial-unique violations (active dup / concurrent primary) -> 409.
        mapOrgWriteError(error, 'DEPARTMENT_MEMBERSHIP');
      }
    },
    setPrimary: (companyId: string, employeeId: string, id: string, version: number) =>
      tx.departmentMembership.updateMany({
        where: { id, companyId, employeeId, endedAt: null, version },
        data: { isPrimary: true, version: { increment: 1 } },
      }),
    demoteOthers: (companyId: string, employeeId: string, exceptId: string) =>
      tx.departmentMembership.updateMany({
        where: {
          companyId,
          employeeId,
          endedAt: null,
          isPrimary: true,
          NOT: { id: exceptId },
        },
        data: { isPrimary: false, version: { increment: 1 } },
      }),
    end: (
      companyId: string,
      employeeId: string,
      id: string,
      version: number,
      endReason?: import('@prisma/client').DepartmentMembershipEndReason,
    ) =>
      tx.departmentMembership.updateMany({
        where: { id, companyId, employeeId, endedAt: null, version },
        data: {
          endedAt: new Date(),
          ...(endReason !== undefined ? { endReason } : {}),
          version: { increment: 1 },
        },
      }),
    findInDepartment: (companyId: string, departmentId: string, id: string) =>
      tx.departmentMembership.findFirst({
        where: { id, companyId, departmentId },
        include: { department: true, employee: true },
      }),
    activePrimary: (companyId: string, employeeId: string) =>
      tx.departmentMembership.findFirst({
        where: { companyId, employeeId, endedAt: null, isPrimary: true },
        include: { department: true, employee: true },
      }),
    effectiveAt: (companyId: string, employeeId: string, at: Date) =>
      tx.departmentMembership.findMany({
        where: {
          companyId,
          employeeId,
          startedAt: { lte: at },
          OR: [{ endedAt: null }, { endedAt: { gt: at } }],
        },
      }),
    setPrimaryFlag: (
      companyId: string,
      departmentId: string,
      id: string,
      isPrimary: boolean,
      version: number,
    ) =>
      tx.departmentMembership.updateMany({
        where: { id, companyId, departmentId, endedAt: null, version },
        data: { isPrimary, version: { increment: 1 } },
      }),
    hasActive: async (companyId: string, departmentId: string, employeeId: string, at: Date) =>
      (await tx.departmentMembership.count({
        where: {
          companyId,
          departmentId,
          employeeId,
          startedAt: { lte: at },
          OR: [{ endedAt: null }, { endedAt: { gt: at } }],
        },
      })) > 0,
    currentInScope: (companyId: string, scope: TeamScopeRef, employeeIds: string[], now: Date) =>
      tx.departmentMembership.findMany({
        where: {
          companyId,
          employeeId: { in: employeeIds },
          ...currentMembershipInScope(scope, now),
        },
        include: { department: true },
      }),
    listForDepartment: (
      companyId: string,
      departmentId: string,
      filter: { includeEnded: boolean; cursor?: { createdAt: Date; id: string }; limit: number },
      now: Date,
    ) =>
      tx.departmentMembership.findMany({
        where: {
          companyId,
          departmentId,
          // Future-dated memberships are never returned — they are neither
          // current nor history.
          startedAt: { lte: now },
          ...(filter.includeEnded ? {} : { OR: [{ endedAt: null }, { endedAt: { gt: now } }] }),
          ...(filter.cursor !== undefined
            ? {
                OR: [
                  { createdAt: { lt: filter.cursor.createdAt } },
                  { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
                ],
              }
            : {}),
        },
        include: {
          department: { select: DEPARTMENT_REF_SELECT },
          employee: { select: SCOPED_EMPLOYEE_SELECT },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter.limit,
      }),
    activeInScope: (companyId: string, employeeId: string, scope: TeamScopeRef) =>
      tx.departmentMembership.findMany({
        where: {
          companyId,
          employeeId,
          endedAt: null,
          department: departmentInScope(scope),
        },
        include: { department: { select: LIFECYCLE_DEPT_SELECT } },
        orderBy: { id: 'asc' },
      }),
    suspendedInScope: (companyId: string, employeeId: string, scope: TeamScopeRef) =>
      tx.departmentMembership.findMany({
        where: {
          companyId,
          employeeId,
          endedAt: { not: null },
          endReason: 'SUSPENDED',
          supersededBy: null,
          department: departmentInScope(scope),
        },
        include: { department: { select: LIFECYCLE_DEPT_SELECT } },
        orderBy: { id: 'asc' },
      }),
    endAll: async (
      companyId: string,
      ids: string[],
      endReason: import('@prisma/client').DepartmentMembershipEndReason,
      fields: { endNote?: string | null; suspendUntil?: Date | null },
    ) => {
      const res = await tx.departmentMembership.updateMany({
        where: { id: { in: ids }, companyId, endedAt: null },
        data: {
          endedAt: new Date(),
          endReason,
          ...(fields.endNote !== undefined ? { endNote: fields.endNote } : {}),
          ...(fields.suspendUntil !== undefined ? { suspendUntil: fields.suspendUntil } : {}),
          version: { increment: 1 },
        },
      });
      return res;
    },
    markSuperseded: (companyId: string, employeeId: string, oldId: string, newId: string) =>
      tx.departmentMembership.updateMany({
        where: {
          id: oldId,
          companyId,
          employeeId,
          endReason: 'SUSPENDED',
          supersededBy: null,
        },
        data: { supersededBy: newId, version: { increment: 1 } },
      }),
  };
  const siteWorkforceExits = {
    listForEmployee: (companyId: string, employeeId: string) =>
      tx.siteWorkforceExit.findMany({
        where: { companyId, employeeId },
        select: { id: true, siteId: true, projectId: true },
      }),
    create: (entry: {
      companyId: string;
      employeeId: string;
      siteId?: string;
      projectId?: string;
      exitedByPrincipalId?: string;
      note?: string;
    }) =>
      tx.siteWorkforceExit.create({
        data: {
          companyId: entry.companyId,
          employeeId: entry.employeeId,
          ...(entry.siteId !== undefined ? { siteId: entry.siteId } : {}),
          ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}),
          ...(entry.exitedByPrincipalId !== undefined
            ? { exitedByPrincipalId: entry.exitedByPrincipalId }
            : {}),
          ...(entry.note !== undefined ? { note: entry.note } : {}),
        },
        select: { id: true },
      }),
  };
  const outbox = {
    record: (entry: {
      companyId: string;
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      eventKey: string;
      recipientPrincipalIds: string[];
      summary: Record<string, unknown>;
    }) =>
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
  };
  const documents = {
    availableIds: async (companyId: string, ids: string[]) => {
      if (ids.length === 0) return [];
      const rows = await tx.document.findMany({
        where: { companyId, id: { in: ids }, status: 'AVAILABLE' },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
  };
  const employeeDocuments = {
    createMany: (rows: EmployeeDocumentLinkInput[]) =>
      tx.employeeDocument.createMany({ data: rows }),
  };
  return {
    ...dept,
    employees,
    memberships,
    documents,
    employeeDocuments,
    siteWorkforceExits,
    outbox,
  };
}

export interface EmployeeUnitOfWork {
  run<T>(fn: (repos: EmployeeRepos) => Promise<T>): Promise<T>;
}

export class PrismaEmployeeUnitOfWork implements EmployeeUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}
  run<T>(fn: (repos: EmployeeRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeEmployeeRepos(tx)));
  }
}
