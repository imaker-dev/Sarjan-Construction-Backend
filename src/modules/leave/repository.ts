import {
  Prisma,
  type Employee,
  type LeaveBalance,
  type LeavePolicy,
  type LeavePolicyVersion,
  type LeaveRequest,
  type LeaveRequestStatus,
  type LeaveType,
  type LeaveTypeDef,
  type PrismaClient,
} from '@prisma/client';
import { scopedUpdate, type AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';
import type { OutboxEmitInput } from '../notification/types.js';
import {
  InsufficientLeaveBalanceError,
  LeaveDateConflictError,
  LeavePolicyNotFoundError,
  LeaveRequestStateError,
} from './errors.js';
import type {
  ListLeaveBalancesFilter,
  ListLeavePoliciesFilter,
  ListLeaveRequestsFilter,
  ListLeaveTypeDefsFilter,
} from './types.js';

type Tx = Prisma.TransactionClient;

export type LeaveRequestWithDetails = LeaveRequest & {
  employee: Pick<Employee, 'id' | 'employeeCode' | 'displayName' | 'designation' | 'principalId'>;
};

export type LeavePolicyWithTypeDef = LeavePolicy & {
  typeDef: Pick<LeaveTypeDef, 'id' | 'code' | 'name' | 'leaveType'> | null;
};

/** New-style resolution target: company, an actual Department record, or an
 *  individual employee. PROJECT/SITE remain only on pre-existing rows. */
export interface LeavePolicyScopeTarget {
  scopeType: 'COMPANY' | 'DEPARTMENT' | 'EMPLOYEE';
  departmentId?: string;
  employeeId?: string;
}

/** Department columns needed to map a department to a permission scope
 *  target (site → SITE, project → PROJECT, base HO → HEAD_OFFICE) and the
 *  parent project for scoped notification fanout. */
export interface DepartmentScopeColumns {
  id: string;
  status: string;
  siteId: string | null;
  projectId: string | null;
  baseHeadOfficeId: string | null;
  site: { projectId: string } | null;
}

export interface MembershipWithScope {
  departmentId: string;
  isPrimary: boolean;
  /** Present on window-batch lookups (findByEmployeesInWindow); absent on
   *  single-employee effective-date queries that pre-filter by the DB. */
  startedAt?: Date;
  endedAt?: Date | null;
  /** Department scope columns — populated by the real repository; treated
   *  as unresolvable (company target, fail closed) when absent. */
  department?: DepartmentScopeColumns;
}

export interface LeaveRepos {
  policies: {
    findById(companyId: string, id: string): Promise<LeavePolicy | null>;
    list(companyId: string, filter?: ListLeavePoliciesFilter): Promise<LeavePolicy[]>;
    create(
      companyId: string,
      data: Omit<Prisma.LeavePolicyCreateInput, 'company'>,
    ): Promise<LeavePolicy>;
    update(
      companyId: string,
      id: string,
      data: Prisma.LeavePolicyUpdateInput,
      expectedVersion?: number,
    ): Promise<LeavePolicy>;
    /** Active policy of a type at an exact scope target. */
    findAtScope(
      companyId: string,
      target: LeavePolicyScopeTarget,
      typeDefId: string,
    ): Promise<LeavePolicy | null>;
    countActiveReferencingTypeDef(companyId: string, typeDefId: string): Promise<number>;
    resolveEffective(
      companyId: string,
      leaveType: LeaveType,
      criteria: {
        employeeId?: string;
        departmentId?: string;
        siteId?: string;
        projectId?: string;
      },
    ): Promise<LeavePolicy>;
  };
  typeDefs: {
    findById(companyId: string, id: string): Promise<LeaveTypeDef | null>;
    findByLeaveType(companyId: string, leaveType: LeaveType): Promise<LeaveTypeDef | null>;
    list(companyId: string, filter?: ListLeaveTypeDefsFilter): Promise<LeaveTypeDef[]>;
    create(
      companyId: string,
      data: Omit<Prisma.LeaveTypeDefCreateInput, 'company'>,
    ): Promise<LeaveTypeDef>;
    update(
      companyId: string,
      id: string,
      data: Prisma.LeaveTypeDefUpdateInput,
      expectedVersion?: number,
    ): Promise<LeaveTypeDef>;
  };
  versions: {
    create(
      companyId: string,
      data: Omit<Prisma.LeavePolicyVersionCreateInput, 'company' | 'policy'> & {
        policyId: string;
      },
    ): Promise<LeavePolicyVersion>;
    findById(
      companyId: string,
      policyId: string,
      versionId: string,
    ): Promise<LeavePolicyVersion | null>;
    list(companyId: string, policyId: string): Promise<LeavePolicyVersion[]>;
    nextVersionNumber(companyId: string, policyId: string): Promise<number>;
    countActive(companyId: string, policyId: string): Promise<number>;
    /** Highest-version ACTIVE row with effectiveFrom <= asOf. */
    findEffective(
      companyId: string,
      policyId: string,
      asOf: Date,
    ): Promise<LeavePolicyVersion | null>;
    /** Earliest ACTIVE row with effectiveFrom strictly after `after` — used to
     *  detect a version boundary inside a leave window. */
    findNextEffective(
      companyId: string,
      policyId: string,
      after: Date,
    ): Promise<LeavePolicyVersion | null>;
    /** ACTIVE row at an exact effectiveFrom — duplicate-date detection. */
    findActiveAtDate(
      companyId: string,
      policyId: string,
      effectiveFrom: Date,
    ): Promise<LeavePolicyVersion | null>;
    cancel(companyId: string, versionId: string): Promise<LeavePolicyVersion>;
  };
  departments: {
    findById(companyId: string, id: string): Promise<DepartmentScopeColumns | null>;
  };
  memberships: {
    /** Memberships effective at `asOf` (startedAt <= asOf, not yet ended).
     *  Omitting `asOf` returns currently-open memberships (endedAt IS NULL). */
    findActiveByEmployee(
      companyId: string,
      employeeId: string,
      asOf?: Date,
    ): Promise<MembershipWithScope[]>;
    /** Memberships covering the whole [start, end] window — started on or
     *  before `start` and not ended on or before `end`. */
    findCoveringByEmployee(
      companyId: string,
      employeeId: string,
      start: Date,
      end: Date,
    ): Promise<MembershipWithScope[]>;
    /** Batch lookup for scoped list filtering — memberships of many
     *  employees overlapping a window, with department scope columns.
     *  Optional so lightweight repo fakes can omit it (treated as empty →
     *  scoped filters match nothing, fail closed). */
    findByEmployeesInWindow?(
      companyId: string,
      employeeIds: string[],
      minStart: Date,
      maxEnd: Date,
    ): Promise<
      (MembershipWithScope & { employeeId: string; startedAt: Date; endedAt: Date | null })[]
    >;
  };
  balances: {
    find(
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
    ): Promise<LeaveBalance | null>;
    list(companyId: string, filter?: ListLeaveBalancesFilter): Promise<LeaveBalance[]>;
    upsertAllocation(
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      allocatedDays: number,
      carriedOverDays?: number,
    ): Promise<LeaveBalance>;
    reservePending(
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ): Promise<LeaveBalance>;
    commitApproved(
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ): Promise<LeaveBalance>;
    rejectPending(
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ): Promise<LeaveBalance>;
    refundApproved(
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ): Promise<LeaveBalance>;
  };
  requests: {
    findById(companyId: string, id: string): Promise<LeaveRequestWithDetails | null>;
    list(companyId: string, filter?: ListLeaveRequestsFilter): Promise<LeaveRequestWithDetails[]>;
    create(
      companyId: string,
      data: Omit<Prisma.LeaveRequestCreateInput, 'company'>,
    ): Promise<LeaveRequestWithDetails>;
    updateStatus(
      companyId: string,
      id: string,
      status: LeaveRequestStatus,
      reviewedBy?: string,
      reviewRemarks?: string,
      expectedVersion?: number,
    ): Promise<LeaveRequestWithDetails>;
    /** RETURNED → PENDING owner resubmission: applies corrected fields,
     *  clears the prior review columns, bumps version. */
    resubmit(
      companyId: string,
      id: string,
      data: {
        startDate: Date;
        endDate: Date;
        totalDays: number;
        reason?: string;
        documentId?: string | null;
      },
      expectedVersion: number,
    ): Promise<LeaveRequestWithDetails>;
    findConflicting(
      companyId: string,
      employeeId: string,
      startDate: Date,
      endDate: Date,
      excludeId?: string,
    ): Promise<LeaveRequest | null>;
  };
  employees: {
    findByPrincipal(
      companyId: string,
      principalId: string,
    ): Promise<{
      id: string;
      displayName: string;
      status: string;
      principalId?: string | null;
    } | null>;
    findById(
      companyId: string,
      id: string,
    ): Promise<{
      id: string;
      displayName: string;
      status: string;
      principalId?: string | null;
    } | null>;
    lockForUpdate?(companyId: string, id: string): Promise<void>;
  };
  /** Principals holding any of the role keys at the given scope — the same
   *  membership/scope rule the leave decision API uses. Omitted scope =
   *  company-wide (HO Admin / Company Owner / Finance authority). */
  assignments: {
    findActivePrincipals(
      companyId: string,
      roleKeys: string[],
      scope?: { scopeType: 'HEAD_OFFICE' | 'PROJECT' | 'SITE'; scopeId: string },
    ): Promise<string[]>;
  };
  /** Durable notification event — recorded inside the source transaction so
   *  a committed leave change can never lose its notification intent. */
  outbox: {
    record(entry: OutboxEmitInput): Promise<void>;
  };
  audit: AuditRepository;
}

export function makeLeaveRepos(tx: Tx): LeaveRepos {
  const audit: AuditRepository = {
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
  };

  const policies = {
    findById: (companyId: string, id: string) =>
      tx.leavePolicy.findFirst({ where: { id, companyId } }),
    list: (companyId: string, filter?: ListLeavePoliciesFilter) =>
      tx.leavePolicy.findMany({
        where: {
          companyId,
          ...(filter?.scopeType ? { scopeType: filter.scopeType } : {}),
          ...(filter?.leaveType ? { leaveType: filter.leaveType } : {}),
          ...(filter?.typeDefId ? { typeDefId: filter.typeDefId } : {}),
          ...(filter?.departmentId ? { departmentId: filter.departmentId } : {}),
          ...(filter?.projectId ? { projectId: filter.projectId } : {}),
          ...(filter?.siteId ? { siteId: filter.siteId } : {}),
          ...(filter?.employeeId ? { employeeId: filter.employeeId } : {}),
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    create: (companyId: string, data: Omit<Prisma.LeavePolicyCreateInput, 'company'>) =>
      tx.leavePolicy.create({
        data: {
          ...data,
          company: { connect: { id: companyId } },
        },
      }),
    update: (
      companyId: string,
      id: string,
      data: Prisma.LeavePolicyUpdateInput,
      expectedVersion?: number,
    ) =>
      scopedUpdate(
        'LEAVE_POLICY',
        { id, companyId },
        data as Record<string, unknown>,
        expectedVersion,
        (args) => tx.leavePolicy.updateMany(args),
        () => tx.leavePolicy.findFirst({ where: { id, companyId } }),
      ),
    resolveEffective: async (
      companyId: string,
      leaveType: LeaveType,
      criteria: {
        employeeId?: string;
        departmentId?: string;
        siteId?: string;
        projectId?: string;
      },
    ): Promise<LeavePolicy> => {
      // 1. Employee-specific override
      if (criteria.employeeId) {
        const empPolicy = await tx.leavePolicy.findFirst({
          where: {
            companyId,
            leaveType,
            scopeType: 'EMPLOYEE',
            employeeId: criteria.employeeId,
            isActive: true,
          },
        });
        if (empPolicy) return empPolicy;
      }

      // 2. Department override — via the caller-resolved primary membership.
      // DEPARTMENT is checked before SITE/PROJECT: department policies are
      // the explicit admin intent in the new model; site/project tiers only
      // remain for legacy rows.
      if (criteria.departmentId) {
        const deptPolicy = await tx.leavePolicy.findFirst({
          where: {
            companyId,
            leaveType,
            scopeType: 'DEPARTMENT',
            departmentId: criteria.departmentId,
            isActive: true,
          },
        });
        if (deptPolicy) return deptPolicy;
      }

      // 3. Site-specific override
      if (criteria.siteId) {
        const sitePolicy = await tx.leavePolicy.findFirst({
          where: {
            companyId,
            leaveType,
            scopeType: 'SITE',
            siteId: criteria.siteId,
            isActive: true,
          },
        });
        if (sitePolicy) return sitePolicy;
      }

      // 4. Project-specific override
      if (criteria.projectId) {
        const projPolicy = await tx.leavePolicy.findFirst({
          where: {
            companyId,
            leaveType,
            scopeType: 'PROJECT',
            projectId: criteria.projectId,
            isActive: true,
          },
        });
        if (projPolicy) return projPolicy;
      }

      // 5. Company master default
      const compPolicy = await tx.leavePolicy.findFirst({
        where: {
          companyId,
          leaveType,
          scopeType: 'COMPANY',
          isActive: true,
        },
      });
      if (compPolicy) return compPolicy;

      // Fail closed — no fabricated defaults. Entitlement/compliance values
      // must come from administrator-configured policies, never invented.
      throw new LeavePolicyNotFoundError(
        `No active ${leaveType} leave policy configured for this context`,
      );
    },
    findAtScope: (companyId: string, target: LeavePolicyScopeTarget, typeDefId: string) =>
      tx.leavePolicy.findFirst({
        where: {
          companyId,
          scopeType: target.scopeType,
          typeDefId,
          isActive: true,
          ...(target.departmentId !== undefined ? { departmentId: target.departmentId } : {}),
          ...(target.employeeId !== undefined ? { employeeId: target.employeeId } : {}),
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    countActiveReferencingTypeDef: (companyId: string, typeDefId: string) =>
      tx.leavePolicy.count({ where: { companyId, typeDefId, isActive: true } }),
  };

  const balances = {
    find: (companyId: string, employeeId: string, leaveType: LeaveType, year: number) =>
      tx.leaveBalance.findFirst({
        where: { companyId, employeeId, leaveType, year },
      }),
    list: (companyId: string, filter?: ListLeaveBalancesFilter) =>
      tx.leaveBalance.findMany({
        where: {
          companyId,
          ...(filter?.employeeId ? { employeeId: filter.employeeId } : {}),
          ...(filter?.leaveType ? { leaveType: filter.leaveType } : {}),
          ...(filter?.year ? { year: filter.year } : {}),
        },
        orderBy: [{ year: 'desc' }, { leaveType: 'asc' }],
      }),
    upsertAllocation: (
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      allocatedDays: number,
      carriedOverDays = 0,
    ) =>
      tx.leaveBalance.upsert({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
        create: {
          company: { connect: { id: companyId } },
          employee: { connect: { id_companyId: { id: employeeId, companyId } } },
          leaveType,
          year,
          allocatedDays: new Prisma.Decimal(allocatedDays),
          carriedOverDays: new Prisma.Decimal(carriedOverDays),
        },
        update: {
          allocatedDays: new Prisma.Decimal(allocatedDays),
          carriedOverDays: new Prisma.Decimal(carriedOverDays),
          version: { increment: 1 },
        },
      }),
    reservePending: async (
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ) => {
      const result = await tx.$executeRaw`
        UPDATE "LeaveBalance"
        SET "pendingDays" = "pendingDays" + ${days},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "companyId" = ${companyId}::uuid
          AND "employeeId" = ${employeeId}::uuid
          AND "leaveType" = ${leaveType}::"LeaveType"
          AND "year" = ${year}
          AND ("allocatedDays" + "carriedOverDays" - "usedDays" - "pendingDays") >= ${days}
      `;
      if (result === 0) {
        throw new InsufficientLeaveBalanceError(0, days);
      }
      return tx.leaveBalance.findUniqueOrThrow({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
      });
    },
    commitApproved: async (
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ) => {
      const result = await tx.$executeRaw`
        UPDATE "LeaveBalance"
        SET "pendingDays" = GREATEST("pendingDays" - ${days}, 0),
            "usedDays" = "usedDays" + ${days},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "companyId" = ${companyId}::uuid
          AND "employeeId" = ${employeeId}::uuid
          AND "leaveType" = ${leaveType}::"LeaveType"
          AND "year" = ${year}
      `;
      if (result === 0) {
        throw new LeaveRequestStateError(
          `Leave balance record not found for employee ${employeeId}`,
        );
      }
      return tx.leaveBalance.findUniqueOrThrow({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
      });
    },
    rejectPending: async (
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ) => {
      const result = await tx.$executeRaw`
        UPDATE "LeaveBalance"
        SET "pendingDays" = GREATEST("pendingDays" - ${days}, 0),
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "companyId" = ${companyId}::uuid
          AND "employeeId" = ${employeeId}::uuid
          AND "leaveType" = ${leaveType}::"LeaveType"
          AND "year" = ${year}
      `;
      if (result === 0) {
        throw new LeaveRequestStateError(
          `Leave balance record not found for employee ${employeeId}`,
        );
      }
      return tx.leaveBalance.findUniqueOrThrow({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
      });
    },
    refundApproved: async (
      companyId: string,
      employeeId: string,
      leaveType: LeaveType,
      year: number,
      days: number,
    ) => {
      const result = await tx.$executeRaw`
        UPDATE "LeaveBalance"
        SET "usedDays" = GREATEST("usedDays" - ${days}, 0),
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "companyId" = ${companyId}::uuid
          AND "employeeId" = ${employeeId}::uuid
          AND "leaveType" = ${leaveType}::"LeaveType"
          AND "year" = ${year}
      `;
      if (result === 0) {
        throw new LeaveRequestStateError(
          `Leave balance record not found for employee ${employeeId}`,
        );
      }
      return tx.leaveBalance.findUniqueOrThrow({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
      });
    },
  };

  const requests = {
    findById: (companyId: string, id: string) =>
      tx.leaveRequest.findFirst({
        where: { id, companyId },
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              displayName: true,
              designation: true,
              principalId: true,
            },
          },
        },
      }),
    list: (companyId: string, filter?: ListLeaveRequestsFilter) =>
      tx.leaveRequest.findMany({
        where: {
          companyId,
          ...(filter?.employeeId ? { employeeId: filter.employeeId } : {}),
          ...(filter?.leaveType ? { leaveType: filter.leaveType } : {}),
          ...(filter?.status ? { status: filter.status } : {}),
          ...(filter?.from ? { startDate: { gte: new Date(`${filter.from}T00:00:00.000Z`) } } : {}),
          ...(filter?.to ? { endDate: { lte: new Date(`${filter.to}T00:00:00.000Z`) } } : {}),
        },
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              displayName: true,
              designation: true,
              principalId: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter?.limit ?? 50,
      }),
    create: async (companyId: string, data: Omit<Prisma.LeaveRequestCreateInput, 'company'>) => {
      try {
        return await tx.leaveRequest.create({
          data: {
            ...data,
            company: { connect: { id: companyId } },
          },
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                displayName: true,
                designation: true,
                principalId: true,
              },
            },
          },
        });
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          ((err as { code: string }).code === 'P2002' ||
            (err as { code: string }).code === 'P2010' ||
            (err as { message?: string }).message?.includes('leave_request_no_overlap'))
        ) {
          throw new LeaveDateConflictError('overlapping-request');
        }
        throw err;
      }
    },
    updateStatus: (
      companyId: string,
      id: string,
      status: LeaveRequestStatus,
      reviewedBy?: string,
      reviewRemarks?: string,
      expectedVersion?: number,
    ) =>
      scopedUpdate(
        'LEAVE_REQUEST',
        { id, companyId },
        {
          status,
          ...(reviewedBy !== undefined ? { reviewedBy } : {}),
          reviewedAt: new Date(),
          ...(reviewRemarks !== undefined ? { reviewRemarks } : {}),
        },
        expectedVersion,
        (args) => tx.leaveRequest.updateMany(args),
        () =>
          tx.leaveRequest.findFirst({
            where: { id, companyId },
            include: {
              employee: {
                select: {
                  id: true,
                  employeeCode: true,
                  displayName: true,
                  designation: true,
                  principalId: true,
                },
              },
            },
          }),
      ) as Promise<LeaveRequestWithDetails>,
    resubmit: (
      companyId: string,
      id: string,
      data: {
        startDate: Date;
        endDate: Date;
        totalDays: number;
        reason?: string;
        documentId?: string | null;
      },
      expectedVersion: number,
    ) =>
      scopedUpdate(
        'LEAVE_REQUEST',
        { id, companyId },
        {
          status: 'PENDING',
          startDate: data.startDate,
          endDate: data.endDate,
          totalDays: data.totalDays,
          ...(data.reason !== undefined ? { reason: data.reason } : {}),
          ...(data.documentId !== undefined ? { documentId: data.documentId } : {}),
          reviewedBy: null,
          reviewedAt: null,
          reviewRemarks: null,
        },
        expectedVersion,
        (args) => tx.leaveRequest.updateMany(args),
        () =>
          tx.leaveRequest.findFirst({
            where: { id, companyId },
            include: {
              employee: {
                select: {
                  id: true,
                  employeeCode: true,
                  displayName: true,
                  designation: true,
                  principalId: true,
                },
              },
            },
          }),
      ) as Promise<LeaveRequestWithDetails>,
    findConflicting: (
      companyId: string,
      employeeId: string,
      startDate: Date,
      endDate: Date,
      excludeId?: string,
    ) =>
      tx.leaveRequest.findFirst({
        where: {
          companyId,
          employeeId,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: endDate },
          endDate: { gte: startDate },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      }),
  };

  const employees = {
    findByPrincipal: (companyId: string, principalId: string) =>
      tx.employee.findFirst({
        where: { companyId, principalId },
        select: { id: true, displayName: true, status: true, principalId: true },
      }),
    findById: (companyId: string, id: string) =>
      tx.employee.findFirst({
        where: { id, companyId },
        select: { id: true, displayName: true, status: true, principalId: true },
      }),
    lockForUpdate: async (companyId: string, id: string) => {
      await tx.$executeRaw`SELECT id FROM "Employee" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    },
  };

  const typeDefs = {
    findById: (companyId: string, id: string) =>
      tx.leaveTypeDef.findFirst({ where: { id, companyId } }),
    findByLeaveType: (companyId: string, leaveType: LeaveType) =>
      tx.leaveTypeDef.findFirst({ where: { companyId, leaveType } }),
    list: (companyId: string, filter?: ListLeaveTypeDefsFilter) =>
      tx.leaveTypeDef.findMany({
        where: {
          companyId,
          ...(filter?.status ? { status: filter.status } : {}),
        },
        orderBy: [{ code: 'asc' }],
      }),
    create: (companyId: string, data: Omit<Prisma.LeaveTypeDefCreateInput, 'company'>) =>
      tx.leaveTypeDef.create({
        data: { ...data, company: { connect: { id: companyId } } },
      }),
    update: (
      companyId: string,
      id: string,
      data: Prisma.LeaveTypeDefUpdateInput,
      expectedVersion?: number,
    ) =>
      scopedUpdate(
        'LEAVE_TYPE_DEF',
        { id, companyId },
        data as Record<string, unknown>,
        expectedVersion,
        (args) => tx.leaveTypeDef.updateMany(args),
        () => tx.leaveTypeDef.findFirst({ where: { id, companyId } }),
      ),
  };

  const versions = {
    create: (
      companyId: string,
      data: Omit<Prisma.LeavePolicyVersionCreateInput, 'company' | 'policy'> & {
        policyId: string;
      },
    ) => {
      const { policyId, ...rest } = data;
      return tx.leavePolicyVersion.create({
        data: {
          ...rest,
          company: { connect: { id: companyId } },
          policy: { connect: { id_companyId: { id: policyId, companyId } } },
        },
      });
    },
    findById: (companyId: string, policyId: string, versionId: string) =>
      tx.leavePolicyVersion.findFirst({ where: { id: versionId, policyId, companyId } }),
    list: (companyId: string, policyId: string) =>
      tx.leavePolicyVersion.findMany({
        where: { policyId, companyId },
        orderBy: [{ version: 'asc' }],
      }),
    nextVersionNumber: async (companyId: string, policyId: string) => {
      const latest = await tx.leavePolicyVersion.findFirst({
        where: { policyId, companyId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      return (latest?.version ?? 0) + 1;
    },
    countActive: (companyId: string, policyId: string) =>
      tx.leavePolicyVersion.count({
        where: { policyId, companyId, status: 'ACTIVE' },
      }),
    findEffective: (companyId: string, policyId: string, asOf: Date) =>
      tx.leavePolicyVersion.findFirst({
        where: {
          policyId,
          companyId,
          status: 'ACTIVE',
          effectiveFrom: { lte: asOf },
        },
        orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      }),
    findNextEffective: (companyId: string, policyId: string, after: Date) =>
      tx.leavePolicyVersion.findFirst({
        where: {
          policyId,
          companyId,
          status: 'ACTIVE',
          effectiveFrom: { gt: after },
        },
        orderBy: [{ effectiveFrom: 'asc' }, { version: 'asc' }],
      }),
    findActiveAtDate: (companyId: string, policyId: string, effectiveFrom: Date) =>
      tx.leavePolicyVersion.findFirst({
        where: {
          policyId,
          companyId,
          status: 'ACTIVE',
          effectiveFrom,
        },
      }),
    cancel: async (companyId: string, versionId: string) => {
      await tx.leavePolicyVersion.updateMany({
        where: { id: versionId, companyId },
        data: { status: 'ARCHIVED' },
      });
      const row = await tx.leavePolicyVersion.findFirst({
        where: { id: versionId, companyId },
      });
      if (row === null) throw new Error('leave policy version vanished during cancel');
      return row;
    },
  };

  const departmentScopeSelect = {
    id: true,
    status: true,
    siteId: true,
    projectId: true,
    baseHeadOfficeId: true,
    site: { select: { projectId: true } },
  } as const;

  const departments = {
    findById: (companyId: string, id: string) =>
      tx.department.findFirst({
        where: { id, companyId },
        select: departmentScopeSelect,
      }),
  };

  const memberships = {
    findActiveByEmployee: (companyId: string, employeeId: string, asOf?: Date) =>
      tx.departmentMembership.findMany({
        where:
          asOf === undefined
            ? { companyId, employeeId, endedAt: null }
            : {
                companyId,
                employeeId,
                startedAt: { lte: asOf },
                OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
              },
        select: {
          departmentId: true,
          isPrimary: true,
          department: { select: departmentScopeSelect },
        },
      }),
    findCoveringByEmployee: (companyId: string, employeeId: string, start: Date, end: Date) =>
      tx.departmentMembership.findMany({
        where: {
          companyId,
          employeeId,
          startedAt: { lte: start },
          OR: [{ endedAt: null }, { endedAt: { gt: end } }],
        },
        select: {
          departmentId: true,
          isPrimary: true,
          department: { select: departmentScopeSelect },
        },
      }),
    findByEmployeesInWindow: (
      companyId: string,
      employeeIds: string[],
      minStart: Date,
      maxEnd: Date,
    ) =>
      tx.departmentMembership.findMany({
        where: {
          companyId,
          employeeId: { in: employeeIds },
          startedAt: { lte: maxEnd },
          OR: [{ endedAt: null }, { endedAt: { gt: minStart } }],
        },
        select: {
          employeeId: true,
          departmentId: true,
          isPrimary: true,
          startedAt: true,
          endedAt: true,
          department: { select: departmentScopeSelect },
        },
      }),
  };

  return {
    policies,
    typeDefs,
    versions,
    balances,
    requests,
    employees,
    departments,
    memberships,
    assignments: {
      findActivePrincipals: async (companyId, roleKeys, scope) => {
        if (roleKeys.length === 0) return [];
        const rows = await tx.roleAssignment.findMany({
          where: {
            companyId,
            role: { key: { in: roleKeys } },
            revokedAt: null,
            ...(scope?.scopeType === 'HEAD_OFFICE' && scope.scopeId
              ? { headOfficeId: scope.scopeId }
              : {}),
            ...(scope?.scopeType === 'PROJECT' && scope.scopeId
              ? { projectId: scope.scopeId }
              : {}),
            ...(scope?.scopeType === 'SITE' && scope.scopeId ? { siteId: scope.scopeId } : {}),
          },
          select: { principalId: true },
          distinct: ['principalId'],
        });
        return rows.map((r) => r.principalId);
      },
    },
    outbox: {
      record: async (entry) => {
        await tx.outboxEvent.create({
          data: {
            companyId: entry.companyId,
            eventType: entry.eventType,
            aggregateType: entry.aggregateType,
            aggregateId: entry.aggregateId,
            eventKey: entry.eventKey,
            payload: {
              recipientPrincipalIds: entry.recipientPrincipalIds,
              summary: entry.summary,
              ...(entry.titles !== undefined ? { titles: entry.titles } : {}),
              ...(entry.emails !== undefined ? { emails: entry.emails } : {}),
            },
          },
        });
      },
    },
    audit,
  };
}

export interface LeaveUnitOfWork {
  run<T>(fn: (repos: LeaveRepos) => Promise<T>): Promise<T>;
}

export class PrismaLeaveUnitOfWork implements LeaveUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: LeaveRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeLeaveRepos(tx)));
  }
}
