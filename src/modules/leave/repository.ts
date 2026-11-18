import {
  Prisma,
  type Employee,
  type LeaveBalance,
  type LeavePolicy,
  type LeaveRequest,
  type LeaveRequestStatus,
  type LeaveType,
  type PrismaClient,
} from '@prisma/client';
import { scopedUpdate, type AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';
import type {
  ListLeaveBalancesFilter,
  ListLeavePoliciesFilter,
  ListLeaveRequestsFilter,
} from './types.js';

type Tx = Prisma.TransactionClient;

export type LeaveRequestWithDetails = LeaveRequest & {
  employee: Pick<
    Employee,
    'id' | 'employeeCode' | 'displayName' | 'designation' | 'principalId'
  >;
};

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
    resolveEffective(
      companyId: string,
      leaveType: LeaveType,
      criteria: { employeeId?: string; siteId?: string; projectId?: string },
    ): Promise<LeavePolicy>;
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
    findConflicting(
      companyId: string,
      employeeId: string,
      startDate: Date,
      endDate: Date,
      excludeId?: string,
    ): Promise<LeaveRequest | null>;
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
      criteria: { employeeId?: string; siteId?: string; projectId?: string },
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

      // 2. Site-specific override
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

      // 3. Project-specific override
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

      // 4. Company master default
      const compPolicy = await tx.leavePolicy.findFirst({
        where: {
          companyId,
          leaveType,
          scopeType: 'COMPANY',
          isActive: true,
        },
      });
      if (compPolicy) return compPolicy;

      // 5. Fallback in-memory default policy if none configured
      return {
        id: '00000000-0000-0000-0000-000000000000',
        companyId,
        scopeType: 'COMPANY',
        projectId: null,
        siteId: null,
        employeeId: null,
        leaveType,
        name: `Default ${leaveType} Policy`,
        description: 'Auto-generated fallback policy',
        annualAllowance: new Prisma.Decimal(12),
        accrualFrequency: 'ANNUAL',
        maxConsecutiveDays: leaveType === 'CASUAL' ? 3 : null,
        minNoticeDays: leaveType === 'PRIVILEGE' ? 15 : 0,
        allowHalfDay: true,
        sandwichRule: false,
        carryoverMaxDays: new Prisma.Decimal(0),
        encashable: false,
        requiresDocAboveDays: leaveType === 'SICK' ? 2 : null,
        isActive: true,
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
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
      return tx.leaveBalance.upsert({
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
          pendingDays: new Prisma.Decimal(days),
        },
        update: {
          pendingDays: { increment: days },
          version: { increment: 1 },
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
      return tx.leaveBalance.update({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
        data: {
          pendingDays: { decrement: days },
          usedDays: { increment: days },
          version: { increment: 1 },
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
      return tx.leaveBalance.update({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
        data: {
          pendingDays: { decrement: days },
          version: { increment: 1 },
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
      return tx.leaveBalance.update({
        where: {
          companyId_employeeId_leaveType_year: {
            companyId,
            employeeId,
            leaveType,
            year,
          },
        },
        data: {
          usedDays: { decrement: days },
          version: { increment: 1 },
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
            select: { id: true, employeeCode: true, displayName: true, designation: true, principalId: true },
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
            select: { id: true, employeeCode: true, displayName: true, designation: true, principalId: true },
          },
        },
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        take: filter?.limit ?? 50,
      }),
    create: (companyId: string, data: Omit<Prisma.LeaveRequestCreateInput, 'company'>) =>
      tx.leaveRequest.create({
        data: {
          ...data,
          company: { connect: { id: companyId } },
        },
        include: {
          employee: {
            select: { id: true, employeeCode: true, displayName: true, designation: true, principalId: true },
          },
        },
      }),
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
                select: { id: true, employeeCode: true, displayName: true, designation: true, principalId: true },
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

  return { policies, balances, requests, audit };
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
