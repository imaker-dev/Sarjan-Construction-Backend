import type { Employee, Prisma, PrismaClient } from '@prisma/client';
import { makeDepartmentRepos } from '../department/repository.js';
import type { DepartmentRepos } from '../department/repository.js';
import { scopedUpdate } from '../organization/repository.js';
import { mapOrgWriteError } from '../organization/errors.js';

type Tx = Prisma.TransactionClient;

export interface EmployeeRowRepository {
  findById(companyId: string, id: string): Promise<Employee | null>;
  findByCode(companyId: string, code: string): Promise<Employee | null>;
  list(
    companyId: string,
    filter: { status?: string; cursor?: { createdAt: Date; id: string }; limit: number },
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
  clearHeadReferences(companyId: string, employeeId: string): Promise<{ id: string }[]>;
  /** Last-admin guard: distinct active principals holding any of the keys. */
  activeHoldersOfKeys(companyId: string, keys: string[], at: Date): Promise<string[]>;
  /** Deactivation cascade — end all ACTIVE memberships in the same tx. */
  endActiveMemberships(companyId: string, employeeId: string): Promise<{ id: string }[]>;
}

export interface EmployeeRepos extends DepartmentRepos {
  employees: EmployeeRowRepository & {
    findById(companyId: string, id: string): Promise<Employee | null>;
  };
  memberships: {
    list(
      companyId: string,
      employeeId: string,
    ): Promise<import('@prisma/client').DepartmentMembership[]>;
    findById(
      companyId: string,
      employeeId: string,
      id: string,
    ): Promise<import('@prisma/client').DepartmentMembership | null>;
    activeForEmployee(
      companyId: string,
      employeeId: string,
    ): Promise<import('@prisma/client').DepartmentMembership[]>;
    create(data: {
      companyId: string;
      employeeId: string;
      departmentId: string;
      isPrimary: boolean;
      startedAt?: Date;
    }): Promise<import('@prisma/client').DepartmentMembership>;
    setPrimary(
      companyId: string,
      employeeId: string,
      id: string,
      version: number,
    ): Promise<unknown>;
    demoteOthers(companyId: string, employeeId: string, exceptId: string): Promise<unknown>;
    end(companyId: string, employeeId: string, id: string, version: number): Promise<unknown>;
  };
}

export function makeEmployeeRepos(tx: Tx): EmployeeRepos {
  const dept = makeDepartmentRepos(tx);
  const employees: EmployeeRowRepository = {
    findById: (companyId, id) => tx.employee.findFirst({ where: { id, companyId } }),
    findByCode: (companyId, code) =>
      tx.employee.findFirst({ where: { companyId, employeeCode: code } }),
    list: (companyId, filter) =>
      tx.employee.findMany({
        where: {
          companyId,
          ...(filter.status !== undefined ? { status: filter.status as never } : {}),
          ...(filter.cursor !== undefined
            ? {
                OR: [
                  { createdAt: { lt: filter.cursor.createdAt } },
                  { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
                ],
              }
            : {}),
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
          data: { endedAt: new Date(), version: { increment: 1 } },
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
        orderBy: [{ endedAt: 'desc' as const }, { startedAt: 'desc' as const }],
      }),
    findById: (companyId: string, employeeId: string, id: string) =>
      tx.departmentMembership.findFirst({ where: { id, companyId, employeeId } }),
    activeForEmployee: (companyId: string, employeeId: string) =>
      tx.departmentMembership.findMany({ where: { companyId, employeeId, endedAt: null } }),
    create: async (data: {
      companyId: string;
      employeeId: string;
      departmentId: string;
      isPrimary: boolean;
      startedAt?: Date;
    }) => {
      try {
        return await tx.departmentMembership.create({ data });
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
    end: (companyId: string, employeeId: string, id: string, version: number) =>
      tx.departmentMembership.updateMany({
        where: { id, companyId, employeeId, endedAt: null, version },
        data: { endedAt: new Date(), version: { increment: 1 } },
      }),
  };
  return { ...dept, employees, memberships };
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
