import { randomUUID } from 'node:crypto';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import {
  FINANCE_OPERATION_DOMAINS,
  FINANCE_ROLE_KEYS,
  PROJECT_LEADERSHIP_KEYS,
} from '../setup/role-templates.js';
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
          include: { operation: true },
          orderBy: { operationKey: 'asc' },
        }),
      findByKey: (companyId: string, departmentId: string, operationKey: string) =>
        tx.departmentOperation.findUnique({
          where: {
            companyId_departmentId_operationKey: { companyId, departmentId, operationKey },
          },
          include: { operation: true },
        }),
      enabledKeys: (companyId: string, departmentIds: string[]) =>
        tx.departmentOperation.findMany({
          where: { companyId, departmentId: { in: departmentIds }, status: 'ACTIVE' },
          select: { departmentId: true, operationKey: true },
        }),
      upsert: (data: {
        companyId: string;
        departmentId: string;
        operationKey: string;
        status: string;
      }) =>
        tx.departmentOperation.upsert({
          where: {
            companyId_departmentId_operationKey: {
              companyId: data.companyId,
              departmentId: data.departmentId,
              operationKey: data.operationKey,
            },
          },
          create: data,
          update: { status: data.status },
        }),
      create: (data: {
        companyId: string;
        departmentId: string;
        operationKey: string;
        status?: string;
      }) =>
        tx.departmentOperation.create({
          data: {
            companyId: data.companyId,
            departmentId: data.departmentId,
            operationKey: data.operationKey,
            status: data.status ?? 'ACTIVE',
          },
        }),
      setStatus: (companyId: string, departmentId: string, operationKey: string, status: string) =>
        tx.departmentOperation.updateMany({
          where: { companyId, departmentId, operationKey },
          data: { status },
        }),
      delete: (companyId: string, departmentId: string, operationKey: string) =>
        tx.departmentOperation.deleteMany({
          where: { companyId, departmentId, operationKey },
        }),
    },
    empOps: {
      list: (companyId: string, employeeId: string) =>
        tx.employeeOperation.findMany({
          where: { companyId, employeeId },
          include: { operation: true },
          orderBy: { operationKey: 'asc' },
        }),
      findByKey: (companyId: string, employeeId: string, operationKey: string) =>
        tx.employeeOperation.findUnique({
          where: {
            companyId_employeeId_operationKey: { companyId, employeeId, operationKey },
          },
          include: { operation: true },
        }),
      upsert: (data: {
        companyId: string;
        employeeId: string;
        operationKey: string;
        status: string;
      }) =>
        tx.employeeOperation.upsert({
          where: {
            companyId_employeeId_operationKey: {
              companyId: data.companyId,
              employeeId: data.employeeId,
              operationKey: data.operationKey,
            },
          },
          create: data,
          update: { status: data.status },
        }),
      create: (data: {
        companyId: string;
        employeeId: string;
        operationKey: string;
        status?: string;
      }) =>
        tx.employeeOperation.create({
          data: {
            companyId: data.companyId,
            employeeId: data.employeeId,
            operationKey: data.operationKey,
            status: data.status ?? 'ACTIVE',
          },
        }),
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
      const rows = await r.deptOps.list(companyId, departmentId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        departmentId: row.departmentId,
        operationKey: row.operationKey,
        name: row.operation.name,
        domain: row.operation.domain,
        status: row.status,
        createdAt: row.createdAt,
        operation: row.operation,
      }));
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
        const row = await r.deptOps.upsert({
          companyId,
          departmentId,
          operationKey,
          status: 'ACTIVE',
        });
        await r.audit.record(
          auditEntry(actor, {
            action: 'OPERATION_ENABLED_ON_DEPT',
            entityType: 'DEPARTMENT_OPERATION',
            entityId: row.id,
            companyId,
            changedFields: {
              operationKey: { before: null, after: operationKey },
              status: { before: null, after: 'ACTIVE' },
            },
          }),
        );
        return {
          id: row.id,
          companyId: row.companyId,
          departmentId: row.departmentId,
          operationKey: row.operationKey,
          name: op.name,
          domain: op.domain,
          status: 'ACTIVE',
          createdAt: row.createdAt,
          operation: op,
        };
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
      const existing = await r.deptOps.findByKey(companyId, departmentId, operationKey);
      if (!existing) throw new OrgEntityNotFoundError('DEPARTMENT_OPERATION');

      await r.deptOps.setStatus(companyId, departmentId, operationKey, 'INACTIVE');
      await r.audit.record(
        auditEntry(actor, {
          action: 'OPERATION_DISABLED_ON_DEPT',
          entityType: 'DEPARTMENT_OPERATION',
          entityId: departmentId,
          companyId,
          changedFields: {
            operationKey: { before: operationKey, after: null },
            status: { before: existing.status, after: 'INACTIVE' },
          },
        }),
      );
      return { disabled: true, status: 'INACTIVE' };
    });
  }

  async toggleDeptOperationStatus(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    operationKey: string,
    targetStatus?: 'ACTIVE' | 'INACTIVE',
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

      const existing = await r.deptOps.findByKey(companyId, departmentId, operationKey);
      const nextStatus = targetStatus ?? (existing?.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');

      const row = await r.deptOps.upsert({
        companyId,
        departmentId,
        operationKey,
        status: nextStatus,
      });

      await r.audit.record(
        auditEntry(actor, {
          action:
            nextStatus === 'ACTIVE' ? 'OPERATION_ENABLED_ON_DEPT' : 'OPERATION_DISABLED_ON_DEPT',
          entityType: 'DEPARTMENT_OPERATION',
          entityId: row.id,
          companyId,
          changedFields: {
            operationKey: { before: existing ? operationKey : null, after: operationKey },
            status: { before: existing?.status ?? null, after: nextStatus },
          },
        }),
      );

      return {
        id: row.id,
        companyId: row.companyId,
        departmentId: row.departmentId,
        operationKey: row.operationKey,
        name: op.name,
        domain: op.domain,
        status: nextStatus,
        createdAt: row.createdAt,
        operation: op,
      };
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

      // Find active department memberships for this employee
      const memberships = await this.prisma.departmentMembership.findMany({
        where: { companyId, employeeId, endedAt: null },
        select: { departmentId: true },
      });
      const deptIds = memberships.map((m) => m.departmentId);

      const [deptOperations, empOperations] = await Promise.all([
        deptIds.length === 0
          ? []
          : this.prisma.departmentOperation.findMany({
              where: { companyId, departmentId: { in: deptIds } },
              include: { operation: true },
              orderBy: { operationKey: 'asc' },
            }),
        r.empOps.list(companyId, employeeId),
      ]);

      const empOpMap = new Map(empOperations.map((e) => [e.operationKey, e]));
      const results: {
        id: string;
        companyId: string;
        employeeId: string;
        departmentId: string | null;
        operationKey: string;
        name: string;
        domain: string;
        status: string;
        inherited: boolean;
        source: 'DEPARTMENT' | 'DIRECT' | 'ROLE';
        createdAt: Date;
        operation: {
          key: string;
          domain: string;
          name: string;
          description: string;
          sensitive: boolean;
        };
      }[] = [];

      const processedKeys = new Set<string>();

      // 1. Process department operations (inherited)
      for (const dOp of deptOperations) {
        if (processedKeys.has(dOp.operationKey)) continue;
        processedKeys.add(dOp.operationKey);

        const override = empOpMap.get(dOp.operationKey);
        // If department operation itself is INACTIVE -> INACTIVE
        // If employee override is INACTIVE or REVOKED -> INACTIVE
        // Otherwise -> ACTIVE
        let status = dOp.status;
        if (override) {
          status =
            override.status === 'REVOKED' || override.status === 'INACTIVE'
              ? 'INACTIVE'
              : override.status;
        }

        results.push({
          id: override?.id ?? dOp.id,
          companyId,
          employeeId,
          departmentId: dOp.departmentId,
          operationKey: dOp.operationKey,
          name: dOp.operation.name,
          domain: dOp.operation.domain,
          status,
          inherited: true,
          source: 'DEPARTMENT',
          createdAt: override?.createdAt ?? dOp.createdAt,
          operation: dOp.operation,
        });
      }

      // 2. Process direct grants that might not be on the department
      for (const eOp of empOperations) {
        if (processedKeys.has(eOp.operationKey)) continue;
        processedKeys.add(eOp.operationKey);

        const status = eOp.status === 'REVOKED' ? 'INACTIVE' : eOp.status;

        results.push({
          id: eOp.id,
          companyId,
          employeeId,
          departmentId: null,
          operationKey: eOp.operationKey,
          name: eOp.operation.name,
          domain: eOp.operation.domain,
          status,
          inherited: false,
          source: 'DIRECT',
          createdAt: eOp.createdAt,
          operation: eOp.operation,
        });
      }

      // 3. Role coverage (PD/PI project leadership + FINANCE company roles) —
      // derived live from active role assignments; no EmployeeOperation row
      // exists for these.
      const roleKeys = await this.getRoleScopedOperationKeys(companyId, employeeId);
      if (roleKeys.length > 0) {
        const catalogue = await r.catalogue.list();
        const byKey = new Map(catalogue.map((c) => [c.key, c]));
        for (const key of roleKeys) {
          if (processedKeys.has(key)) continue;
          processedKeys.add(key);
          const op = byKey.get(key);
          const override = empOpMap.get(key);
          const status =
            override?.status === 'INACTIVE' || override?.status === 'REVOKED'
              ? 'INACTIVE'
              : 'ACTIVE';
          results.push({
            id: override?.id ?? `role:${key}`,
            companyId,
            employeeId,
            departmentId: null,
            operationKey: key,
            name: op?.name ?? key,
            domain: op?.domain ?? 'OPERATIONS',
            status,
            inherited: true,
            source: 'ROLE',
            createdAt: override?.createdAt ?? new Date(0),
            operation: {
              key,
              domain: op?.domain ?? 'OPERATIONS',
              name: op?.name ?? key,
              description: op?.description ?? '',
              sensitive: op?.sensitive ?? false,
            },
          });
        }
      }

      return results.sort((a, b) => a.operationKey.localeCompare(b.operationKey));
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

      try {
        const row = await r.empOps.upsert({
          companyId,
          employeeId,
          operationKey,
          status: 'ACTIVE',
        });
        await r.audit.record(
          auditEntry(actor, {
            action: 'OPERATION_ASSIGNED_TO_EMPLOYEE',
            entityType: 'EMPLOYEE_OPERATION',
            entityId: row.id,
            companyId,
            changedFields: {
              operationKey: { before: null, after: operationKey },
              status: { before: null, after: 'ACTIVE' },
            },
          }),
        );
        return {
          id: row.id,
          companyId: row.companyId,
          employeeId: row.employeeId,
          operationKey: row.operationKey,
          name: op.name,
          domain: op.domain,
          status: 'ACTIVE',
          createdAt: row.createdAt,
          operation: op,
        };
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

      // Check if employee has this operation either via active department membership or direct grant
      const memberships = await this.prisma.departmentMembership.findMany({
        where: { companyId, employeeId, endedAt: null },
        select: { departmentId: true },
      });
      const deptIds = memberships.map((m) => m.departmentId);

      const [deptOps, directOp] = await Promise.all([
        deptIds.length === 0 ? [] : r.deptOps.enabledKeys(companyId, deptIds),
        r.empOps.findByKey(companyId, employeeId, operationKey),
      ]);

      const isDeptEnabled = deptOps.some((d) => d.operationKey === operationKey);
      const isDirectActive = directOp?.status === 'ACTIVE';

      // If already inactive or not enabled on either department or direct grant, throw
      if (
        (!isDeptEnabled && !isDirectActive) ||
        directOp?.status === 'INACTIVE' ||
        directOp?.status === 'REVOKED'
      ) {
        throw new OrgEntityNotFoundError('EMPLOYEE_OPERATION');
      }

      // Mark as INACTIVE so the employee has it inactive. DepartmentOperation is untouched.
      await r.empOps.upsert({
        companyId,
        employeeId,
        operationKey,
        status: 'INACTIVE',
      });

      await r.audit.record(
        auditEntry(actor, {
          action: 'OPERATION_REVOKED_FROM_EMPLOYEE',
          entityType: 'EMPLOYEE_OPERATION',
          entityId: employeeId,
          companyId,
          changedFields: {
            operationKey: { before: operationKey, after: null },
            status: { before: 'ACTIVE', after: 'INACTIVE' },
          },
        }),
      );
      return { revoked: true, status: 'INACTIVE' };
    });
  }

  async toggleEmployeeOperationStatus(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    operationKey: string,
    targetStatus?: 'ACTIVE' | 'INACTIVE',
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

      const memberships = await this.prisma.departmentMembership.findMany({
        where: { companyId, employeeId, endedAt: null },
        select: { departmentId: true },
      });
      const deptIds = memberships.map((m) => m.departmentId);

      const [deptOps, directOp] = await Promise.all([
        deptIds.length === 0 ? [] : r.deptOps.enabledKeys(companyId, deptIds),
        r.empOps.findByKey(companyId, employeeId, operationKey),
      ]);

      const isDeptEnabled = deptOps.some((d) => d.operationKey === operationKey);
      let currentStatus = 'INACTIVE';
      if (directOp) {
        currentStatus = directOp.status === 'REVOKED' ? 'INACTIVE' : directOp.status;
      } else if (isDeptEnabled) {
        currentStatus = 'ACTIVE';
      }

      const nextStatus = targetStatus ?? (currentStatus === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');

      const row = await r.empOps.upsert({
        companyId,
        employeeId,
        operationKey,
        status: nextStatus,
      });

      await r.audit.record(
        auditEntry(actor, {
          action:
            nextStatus === 'ACTIVE'
              ? 'OPERATION_ASSIGNED_TO_EMPLOYEE'
              : 'OPERATION_REVOKED_FROM_EMPLOYEE',
          entityType: 'EMPLOYEE_OPERATION',
          entityId: row.id,
          companyId,
          changedFields: {
            operationKey: { before: directOp ? operationKey : null, after: operationKey },
            status: { before: currentStatus, after: nextStatus },
          },
        }),
      );

      return {
        id: row.id,
        companyId: row.companyId,
        employeeId: row.employeeId,
        departmentId: null,
        operationKey: row.operationKey,
        name: op.name,
        domain: op.domain,
        status: nextStatus,
        inherited: directOp ? false : isDeptEnabled,
        source: directOp ? 'DIRECT' : isDeptEnabled ? 'DEPARTMENT' : 'DIRECT',
        createdAt: row.createdAt,
        operation: op,
      };
    });
  }

  /**
   * Effective ops =
   *   (ops enabled on active-membership departments − employee overrides)
   *   ∪ active direct grants
   *   ∪ PD/PI role coverage: every ACTIVE op enabled on departments scoped to
   *     the employee's assigned projects (or their sites) — no per-op grant
   *     needed. Sensitive ops are excluded from role coverage; they still
   *     require an explicit per-employee grant (the distinct policy).
   * Coverage ends the moment the role assignment is revoked — it is resolved
   * from live rows on every call.
   */
  async getEffectiveOperations(companyId: string, employeeId: string): Promise<string[]> {
    const memberships = await this.prisma.departmentMembership.findMany({
      where: { companyId, employeeId, endedAt: null },
      select: { departmentId: true },
    });
    const deptIds = memberships.map((m) => m.departmentId);
    const [empOps, enabled, roleScopedKeys] = await Promise.all([
      this.prisma.employeeOperation.findMany({
        where: { companyId, employeeId },
        select: { operationKey: true, status: true },
      }),
      deptIds.length === 0
        ? []
        : this.prisma.departmentOperation.findMany({
            where: { companyId, departmentId: { in: deptIds }, status: 'ACTIVE' },
            select: { operationKey: true },
          }),
      this.getRoleScopedOperationKeys(companyId, employeeId),
    ]);
    const inactiveKeys = new Set(
      empOps
        .filter((e) => e.status === 'INACTIVE' || e.status === 'REVOKED')
        .map((e) => e.operationKey),
    );
    const directActiveKeys = empOps.filter((e) => e.status === 'ACTIVE').map((e) => e.operationKey);

    const enabledSet = new Set(enabled.map((e) => e.operationKey));
    const inheritedActive = Array.from(enabledSet).filter((k) => !inactiveKeys.has(k));
    const roleActive = roleScopedKeys.filter((k) => !inactiveKeys.has(k));
    return Array.from(new Set([...inheritedActive, ...directActiveKeys, ...roleActive])).sort();
  }

  /**
   * Project-leadership coverage: resolve the employee's active PD/PI
   * RoleAssignments (PROJECT scope), then collect ACTIVE operations enabled
   * on departments scoped to those projects or to sites beneath them.
   * Company-wide (Head Office) departments are structurally out of scope —
   * only projectId/siteId-scoped departments match. Sensitive operations are
   * never covered by role access.
   */
  async getLeadershipScopedOperationKeys(companyId: string, employeeId: string): Promise<string[]> {
    const emp = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId },
      select: { principalId: true },
    });
    if (emp?.principalId === null || emp?.principalId === undefined) return [];
    const now = new Date();
    const assignments = await this.prisma.roleAssignment.findMany({
      where: {
        companyId,
        principalId: emp.principalId,
        revokedAt: null,
        scopeType: 'PROJECT',
        role: { key: { in: [...PROJECT_LEADERSHIP_KEYS] } },
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
        AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] }],
      },
      select: { projectId: true },
    });
    const projectIds = [
      ...new Set(assignments.map((a) => a.projectId).filter((p): p is string => p !== null)),
    ];
    if (projectIds.length === 0) return [];
    const sites = await this.prisma.site.findMany({
      where: { companyId, projectId: { in: projectIds } },
      select: { id: true },
    });
    const siteIds = sites.map((s) => s.id);
    const deptOps = await this.prisma.departmentOperation.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        department: {
          companyId,
          status: 'ACTIVE',
          OR: [{ projectId: { in: projectIds } }, { siteId: { in: siteIds } }],
        },
        operation: { sensitive: false },
      },
      select: { operationKey: true },
    });
    return deptOps.map((d) => d.operationKey);
  }

  /** Union of every role-derived coverage source (PD/PI projects + Finance roles). */
  async getRoleScopedOperationKeys(companyId: string, employeeId: string): Promise<string[]> {
    const [leadership, finance] = await Promise.all([
      this.getLeadershipScopedOperationKeys(companyId, employeeId),
      this.getFinanceScopedOperationKeys(companyId, employeeId),
    ]);
    return Array.from(new Set([...leadership, ...finance]));
  }

  /**
   * Finance-role coverage: an active COMPANY-scope FINANCE_MANAGER/FINANCE_STAFF
   * assignment covers every ACTIVE non-sensitive op in a finance domain
   * (FINANCE_OPERATION_DOMAINS, plus PROJECT_DASHBOARD_VIEW which the finance
   * read APIs require) enabled on any ACTIVE department in the company.
   * Resolved live, so enabling/disabling an op on a department updates the
   * holder's effective ops immediately; revoking the role ends coverage.
   * Sensitive operations are never covered — they require an explicit
   * per-employee grant (the distinct restricted policy).
   */
  async getFinanceScopedOperationKeys(companyId: string, employeeId: string): Promise<string[]> {
    const emp = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId },
      select: { principalId: true },
    });
    if (emp?.principalId === null || emp?.principalId === undefined) return [];
    const now = new Date();
    const assignment = await this.prisma.roleAssignment.findFirst({
      where: {
        companyId,
        principalId: emp.principalId,
        revokedAt: null,
        scopeType: 'COMPANY',
        role: { key: { in: [...FINANCE_ROLE_KEYS] } },
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
        AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] }],
      },
      select: { id: true },
    });
    if (assignment === null) return [];
    const deptOps = await this.prisma.departmentOperation.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        department: { companyId, status: 'ACTIVE' },
        operation: {
          sensitive: false,
          OR: [
            { domain: { in: [...FINANCE_OPERATION_DOMAINS] } },
            { key: 'PROJECT_DASHBOARD_VIEW' },
          ],
        },
      },
      select: { operationKey: true },
    });
    return deptOps.map((d) => d.operationKey);
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
