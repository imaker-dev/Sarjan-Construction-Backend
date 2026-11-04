import { randomUUID } from 'node:crypto';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import type { Authorizer } from '../department/service.js';
import type { Prisma, PrismaClient } from '@prisma/client';

const auditEntry = (
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord => ({
  eventKey: randomUUID(),
  actorId: actor.actorId,
  actorType: actor.actorType,
  ...base,
});

type Tx = Prisma.TransactionClient;
const CATALOGUE_READ = 'OPERATION_READ';
const DEPT_ENABLE = 'OPERATION_CONFIGURE';
const EMP_ASSIGN = 'OPERATION_EMPLOYEE_ASSIGN';

export function makeAssignmentRepos(tx: Tx) {
  return {
    catalogue: {
      list: () =>
        tx.operationCatalogueEntry.findMany({ orderBy: [{ domain: 'asc' }, { key: 'asc' }] }),
      find: (key: string) => tx.operationCatalogueEntry.findUnique({ where: { key } }),
    },
    deptOps: {
      list: (companyId: string, departmentId: string) =>
        tx.departmentOperation.findMany({
          where: { companyId, departmentId },
          orderBy: { operationKey: 'asc' },
        }),
      enabledKeys: (companyId: string, departmentIds: string[]) =>
        tx.departmentOperation.findMany({
          where: { companyId, departmentId: { in: departmentIds } },
          select: { departmentId: true, operationKey: true },
        }),
      create: (data: { companyId: string; departmentId: string; operationKey: string }) =>
        tx.departmentOperation.create({ data }),
      delete: (companyId: string, departmentId: string, operationKey: string) =>
        tx.departmentOperation.deleteMany({
          where: { companyId, departmentId, operationKey },
        }),
    },
    empOps: {
      list: (companyId: string, employeeId: string) =>
        tx.employeeOperation.findMany({
          where: { companyId, employeeId },
          orderBy: { operationKey: 'asc' },
        }),
      create: (data: { companyId: string; employeeId: string; operationKey: string }) =>
        tx.employeeOperation.create({ data }),
      delete: (companyId: string, employeeId: string, operationKey: string) =>
        tx.employeeOperation.deleteMany({ where: { companyId, employeeId, operationKey } }),
    },
    audit: {
      record: (entry: AuditRecord) => tx.auditLog.create({ data: entry as never }),
    },
  };
}
export type AssignmentRepos = ReturnType<typeof makeAssignmentRepos>;

export class OperationAssignmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authorizer: Authorizer,
  ) {}

  private run<T>(fn: (r: AssignmentRepos) => Promise<T>) {
    return this.prisma.$transaction((tx) => fn(makeAssignmentRepos(tx)));
  }

  async listCatalogue(actor: ActorContext, companyId: string) {
    await this.authorizer.assertPermission(actor.actorId, CATALOGUE_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.run((r) => r.catalogue.list());
  }

  async listDeptOperations(actor: ActorContext, companyId: string, departmentId: string) {
    await this.authorizer.assertPermission(actor.actorId, 'DEPARTMENT_READ', {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.run(async (r) => {
      await this.assertActiveDept(companyId, departmentId);
      return r.deptOps.list(companyId, departmentId);
    });
  }

  async enableDeptOperation(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    operationKey: string,
  ) {
    await this.authorizer.assertPermission(actor.actorId, DEPT_ENABLE, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.run(async (r) => {
      await this.assertActiveDept(companyId, departmentId);
      const op = await r.catalogue.find(operationKey);
      if (!op) throw new OrgEntityNotFoundError('OPERATION');
      try {
        const row = await r.deptOps.create({ companyId, departmentId, operationKey });
        await r.audit.record(
          auditEntry(actor, {
            action: 'OPERATION_ENABLED_ON_DEPT',
            entityType: 'DEPARTMENT_OPERATION',
            entityId: row.id,
            companyId,
            changedFields: { operationKey: { before: null, after: operationKey } },
          }),
        );
        return row;
      } catch (error) {
        const { mapOrgWriteError } = await import('../organization/errors.js');
        mapOrgWriteError(error, 'DEPARTMENT_OPERATION');
      }
    });
  }

  async disableDeptOperation(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    operationKey: string,
  ) {
    await this.authorizer.assertPermission(actor.actorId, DEPT_ENABLE, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.run(async (r) => {
      await this.assertActiveDept(companyId, departmentId);
      const { count } = await r.deptOps.delete(companyId, departmentId, operationKey);
      if (count === 0) throw new OrgEntityNotFoundError('DEPARTMENT_OPERATION');
      await r.audit.record(
        auditEntry(actor, {
          action: 'OPERATION_DISABLED_ON_DEPT',
          entityType: 'DEPARTMENT_OPERATION',
          entityId: departmentId,
          companyId,
          changedFields: { operationKey: { before: operationKey, after: null } },
        }),
      );
      return { disabled: true };
    });
  }

  async listEmployeeOperations(actor: ActorContext, companyId: string, employeeId: string) {
    await this.authorizer.assertPermission(actor.actorId, 'EMPLOYEE_READ', {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.run(async (r) => {
      await this.assertActiveEmployee(companyId, employeeId);
      return r.empOps.list(companyId, employeeId);
    });
  }

  async assignEmployeeOperation(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    operationKey: string,
  ) {
    await this.authorizer.assertPermission(actor.actorId, EMP_ASSIGN, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.run(async (r) => {
      await this.assertActiveEmployee(companyId, employeeId);
      const op = await r.catalogue.find(operationKey);
      if (!op) throw new OrgEntityNotFoundError('OPERATION');
      // Subset rule: the op must be enabled on at least one ACTIVE dept the
      // employee belongs to. Member-of-dept is the work boundary.
      const memberships = await this.prisma.departmentMembership.findMany({
        where: { companyId, employeeId, endedAt: null },
        select: { departmentId: true },
      });
      const deptIds = memberships.map((m) => m.departmentId);
      const enabled = deptIds.length === 0 ? [] : await r.deptOps.enabledKeys(companyId, deptIds);
      if (!enabled.some((e) => e.operationKey === operationKey)) {
        throw new OrgValidationError(
          'operationKey',
          'operation is not enabled on any active department of this employee',
        );
      }
      try {
        const row = await r.empOps.create({ companyId, employeeId, operationKey });
        await r.audit.record(
          auditEntry(actor, {
            action: 'OPERATION_ASSIGNED_TO_EMPLOYEE',
            entityType: 'EMPLOYEE_OPERATION',
            entityId: row.id,
            companyId,
            changedFields: { operationKey: { before: null, after: operationKey } },
          }),
        );
        return row;
      } catch (error) {
        const { mapOrgWriteError } = await import('../organization/errors.js');
        mapOrgWriteError(error, 'EMPLOYEE_OPERATION');
      }
    });
  }

  async revokeEmployeeOperation(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    operationKey: string,
  ) {
    await this.authorizer.assertPermission(actor.actorId, EMP_ASSIGN, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.run(async (r) => {
      await this.assertActiveEmployee(companyId, employeeId);
      const { count } = await r.empOps.delete(companyId, employeeId, operationKey);
      if (count === 0) throw new OrgEntityNotFoundError('EMPLOYEE_OPERATION');
      await r.audit.record(
        auditEntry(actor, {
          action: 'OPERATION_REVOKED_FROM_EMPLOYEE',
          entityType: 'EMPLOYEE_OPERATION',
          entityId: employeeId,
          companyId,
          changedFields: { operationKey: { before: operationKey, after: null } },
        }),
      );
      return { revoked: true };
    });
  }

  /** Effective ops = grants ∩ enabled ops on active-membership depts. */
  async getEffectiveOperations(companyId: string, employeeId: string): Promise<string[]> {
    const memberships = await this.prisma.departmentMembership.findMany({
      where: { companyId, employeeId, endedAt: null },
      select: { departmentId: true },
    });
    const deptIds = memberships.map((m) => m.departmentId);
    if (deptIds.length === 0) return [];
    const [grants, enabled] = await Promise.all([
      this.prisma.employeeOperation.findMany({
        where: { companyId, employeeId },
        select: { operationKey: true },
      }),
      this.prisma.departmentOperation.findMany({
        where: { companyId, departmentId: { in: deptIds } },
        select: { operationKey: true },
      }),
    ]);
    const enabledSet = new Set(enabled.map((e) => e.operationKey));
    return grants.map((g) => g.operationKey).filter((k) => enabledSet.has(k));
  }

  private async assertActiveDept(companyId: string, departmentId: string) {
    const dept = await this.prisma.department.findFirst({ where: { id: departmentId, companyId } });
    if (!dept) throw new OrgEntityNotFoundError('DEPARTMENT');
    if (dept.status !== 'ACTIVE') {
      throw new OrgValidationError('departmentId', 'department must be active');
    }
  }

  private async assertActiveEmployee(companyId: string, employeeId: string) {
    const emp = await this.prisma.employee.findFirst({ where: { id: employeeId, companyId } });
    if (!emp) throw new OrgEntityNotFoundError('EMPLOYEE');
    if (emp.status !== 'ACTIVE') {
      throw new OrgValidationError('employeeId', 'employee must be active');
    }
  }
}
