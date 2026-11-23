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
      const dept = await this.assertActiveDept(companyId, departmentId);
      const op = await r.catalogue.find(operationKey);
      if (!op) throw new OrgEntityNotFoundError('OPERATION');
      this.assertScopeApplicability(op, dept.scopeType);
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
      const dept = await this.assertActiveDept(companyId, departmentId);
      const op = await r.catalogue.find(operationKey);
      if (!op) throw new OrgEntityNotFoundError('OPERATION');

      const existing = await r.deptOps.findByKey(companyId, departmentId, operationKey);
      const nextStatus = targetStatus ?? (existing?.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');
      if (nextStatus === 'ACTIVE') this.assertScopeApplicability(op, dept.scopeType);

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
      await this.assertDirectGrantEligible(companyId, employeeId, op);

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
      if (nextStatus === 'ACTIVE') {
        await this.assertDirectGrantEligible(companyId, employeeId, op);
      }

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
            where: {
              companyId,
              departmentId: { in: deptIds },
              status: 'ACTIVE',
              department: { status: 'ACTIVE' },
            },
            select: { operationKey: true },
          }),
      this.getRoleScopedOperationKeys(companyId, employeeId),
    ]);
    const inactiveKeys = new Set(
      empOps
        .filter((e) => e.status === 'INACTIVE' || e.status === 'REVOKED')
        .map((e) => e.operationKey),
    );
    const enabledSet = new Set(enabled.map((e) => e.operationKey));
    // Direct grants are only effective while backed by an eligible department:
    // the op must still be ACTIVE on an ACTIVE department the employee holds
    // an open membership in. Disabling the op everywhere, ending the
    // membership, or deactivating the department removes access on the next
    // authorization check — the row alone never grants coverage.
    const directActiveKeys = empOps
      .filter((e) => e.status === 'ACTIVE' && enabledSet.has(e.operationKey))
      .map((e) => e.operationKey);

    const inheritedActive = Array.from(enabledSet).filter((k) => !inactiveKeys.has(k));
    const roleActive = roleScopedKeys.filter((k) => !inactiveKeys.has(k));
    return Array.from(new Set([...inheritedActive, ...directActiveKeys, ...roleActive])).sort();
  }

  /**
   * Project-leadership coverage: resolve the employee's active PD/PI
   * RoleAssignments (PROJECT scope), then collect ACTIVE operations enabled
   * on departments scoped to those projects or to sites beneath them.
   * Company-wide (Head Office) departments are structurally out of scope —
   * only projectId/siteId-scoped departments match. Only catalogue entries
   * explicitly marked leadershipInheritable (and non-sensitive) are covered;
   * approval/payment/payroll and other high-impact ops are never inherited —
   * they require department membership plus an explicit per-employee grant.
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
        operation: { sensitive: false, leadershipInheritable: true },
      },
      select: {
        operationKey: true,
        department: { select: { scopeType: true } },
        operation: { select: { appliesTo: true } },
      },
    });
    // Belt-and-suspenders: the op must also be valid for the department's
    // scope under catalogue metadata, in case it was enabled before the
    // appliesTo rule existed.
    return deptOps
      .filter((d) => d.operation.appliesTo.includes(d.department.scopeType))
      .map((d) => d.operationKey);
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
   * assignment automatically covers every non-sensitive catalogue op in a
   * finance domain (FINANCE_OPERATION_DOMAINS, plus PROJECT_DASHBOARD_VIEW
   * which the finance read APIs require) — no department enablement required.
   * Admin control still applies per employee: an INACTIVE/REVOKED
   * EmployeeOperation override subtracts a covered key everywhere
   * (effective ops, /auth/me, op gates), and re-activating it restores it.
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
    const entries = await this.prisma.operationCatalogueEntry.findMany({
      where: {
        sensitive: false,
        OR: [{ domain: { in: [...FINANCE_OPERATION_DOMAINS] } }, { key: 'PROJECT_DASHBOARD_VIEW' }],
      },
      select: { key: true },
    });
    return entries.map((e) => e.key);
  }

  /**
   * Effective-operation inspection for a project or site: which employees can
   * perform which catalogue operations inside that scope, with source
   * attribution. Keyset-paginated on (employeeId, operationKey).
   *
   * - PROJECT: departments scoped to the project or any of its sites, plus
   *   leadership coverage from active PD/PI assignments on the project.
   * - SITE: departments scoped to the site, plus leadership coverage from
   *   active PD/PI assignments on the site's parent project.
   * Only ACTIVE rows contribute — revoked grants, ended memberships, disabled
   * department ops, and inactive departments never appear. Sensitive employee
   * fields are never selected; only id/employeeCode/displayName are returned.
   */
  async listEffectiveOperationsForScope(
    actor: ActorContext,
    companyId: string,
    target: { scopeType: 'PROJECT' | 'SITE'; scopeId: string },
    options: { cursor?: string | undefined; limit?: number | undefined } = {},
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      target.scopeType === 'PROJECT' ? 'ORG_PROJECT_READ' : 'ORG_SITE_READ',
      { companyId, scopeType: target.scopeType, scopeId: target.scopeId },
    );
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    // Same-company parent check + resolve the dept set for the scope.
    let projectId: string;
    let siteId: string | null = null;
    if (target.scopeType === 'PROJECT') {
      const project = await this.prisma.project.findFirst({
        where: { id: target.scopeId, companyId },
        select: { id: true },
      });
      if (!project) throw new OrgEntityNotFoundError('PROJECT');
      projectId = project.id;
    } else {
      const site = await this.prisma.site.findFirst({
        where: { id: target.scopeId, companyId },
        select: { id: true, projectId: true },
      });
      if (!site) throw new OrgEntityNotFoundError('SITE');
      projectId = site.projectId;
      siteId = site.id;
    }

    const departments = await this.prisma.department.findMany({
      where:
        target.scopeType === 'PROJECT'
          ? {
              companyId,
              status: 'ACTIVE',
              OR: [{ projectId }, { site: { is: { projectId, companyId } } }],
            }
          : { companyId, status: 'ACTIVE', siteId: siteId ?? '' },
      select: {
        id: true,
        code: true,
        name: true,
        scopeType: true,
        projectId: true,
        siteId: true,
      },
    });
    const deptById = new Map(departments.map((d) => [d.id, d]));
    const deptIds = departments.map((d) => d.id);

    const [deptOps, memberships, catalogue] = await Promise.all([
      deptIds.length === 0
        ? []
        : this.prisma.departmentOperation.findMany({
            where: { companyId, departmentId: { in: deptIds }, status: 'ACTIVE' },
            select: { departmentId: true, operationKey: true },
          }),
      deptIds.length === 0
        ? []
        : this.prisma.departmentMembership.findMany({
            where: { companyId, departmentId: { in: deptIds }, endedAt: null },
            select: { employeeId: true, departmentId: true },
          }),
      this.prisma.operationCatalogueEntry.findMany({
        select: {
          key: true,
          domain: true,
          name: true,
          sensitive: true,
          appliesTo: true,
          leadershipInheritable: true,
        },
      }),
    ]);
    const opByKey = new Map(catalogue.map((c) => [c.key, c]));

    // Dept ops valid for their dept's scope only.
    const validDeptOps = deptOps.filter((d) => {
      const dept = deptById.get(d.departmentId);
      const op = opByKey.get(d.operationKey);
      return dept !== undefined && (op?.appliesTo.includes(dept.scopeType) ?? false);
    });

    // Active PD/PI assignments on the (parent) project → leadership coverage.
    const now = new Date();
    const leadershipAssignments = await this.prisma.roleAssignment.findMany({
      where: {
        companyId,
        revokedAt: null,
        scopeType: 'PROJECT',
        projectId,
        role: { key: { in: [...PROJECT_LEADERSHIP_KEYS] } },
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
        AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] }],
      },
      select: { id: true, principalId: true, projectId: true, role: { select: { key: true } } },
    });
    const leaderPrincipalIds = leadershipAssignments.map((a) => a.principalId);

    const allEmployeeIds = [...new Set(memberships.map((m) => m.employeeId))];
    const employees = await this.prisma.employee.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        OR: [{ id: { in: allEmployeeIds } }, { principalId: { in: leaderPrincipalIds } }],
      },
      select: { id: true, employeeCode: true, displayName: true, principalId: true },
    });
    const empById = new Map(employees.map((e) => [e.id, e]));
    const empByPrincipal = new Map<string, (typeof employees)[number]>();
    for (const e of employees) {
      if (e.principalId !== null) empByPrincipal.set(e.principalId, e);
    }

    const empOps = await this.prisma.employeeOperation.findMany({
      where: { companyId, employeeId: { in: employees.map((e) => e.id) } },
      select: { employeeId: true, operationKey: true, status: true },
    });
    const empOpStatus = new Map(empOps.map((e) => [`${e.employeeId}|${e.operationKey}`, e.status]));

    interface Row {
      employeeId: string;
      operationKey: string;
      source: 'DEPARTMENT' | 'DIRECT' | 'ROLE';
      inherited: boolean;
      departmentId: string | null;
      roleAssignmentId: string | null;
      roleKey: string | null;
    }
    const rows = new Map<string, Row>();
    const suppressed = (employeeId: string, key: string) => {
      const s = empOpStatus.get(`${employeeId}|${key}`);
      return s === 'INACTIVE' || s === 'REVOKED';
    };

    // Department coverage — a DIRECT row exists but stays dept-backed.
    for (const m of memberships) {
      if (!empById.has(m.employeeId)) continue; // inactive employee
      for (const dOp of validDeptOps) {
        if (dOp.departmentId !== m.departmentId) continue;
        if (suppressed(m.employeeId, dOp.operationKey)) continue;
        const key = `${m.employeeId}|${dOp.operationKey}`;
        const explicit = empOpStatus.get(key) === 'ACTIVE';
        const existing = rows.get(key);
        // Prefer DIRECT attribution; keep the explaining department.
        if (existing === undefined || (explicit && existing.source !== 'DIRECT')) {
          rows.set(key, {
            employeeId: m.employeeId,
            operationKey: dOp.operationKey,
            source: explicit ? 'DIRECT' : 'DEPARTMENT',
            inherited: !explicit,
            departmentId: dOp.departmentId,
            roleAssignmentId: null,
            roleKey: null,
          });
        }
      }
    }

    // Leadership coverage — inheritable ops enabled on this scope's depts.
    const leadershipKeys = new Set(
      validDeptOps
        .filter((d) => {
          const op = opByKey.get(d.operationKey);
          return op !== undefined && !op.sensitive && op.leadershipInheritable;
        })
        .map((d) => d.operationKey),
    );
    const leaderDeptByKey = new Map<string, string>();
    for (const d of validDeptOps) {
      if (leadershipKeys.has(d.operationKey) && !leaderDeptByKey.has(d.operationKey)) {
        leaderDeptByKey.set(d.operationKey, d.departmentId);
      }
    }
    for (const a of leadershipAssignments) {
      const emp = empByPrincipal.get(a.principalId);
      if (emp === undefined) continue; // no active employee row for this principal
      for (const key of leadershipKeys) {
        if (suppressed(emp.id, key)) continue;
        const rowKey = `${emp.id}|${key}`;
        if (rows.has(rowKey)) continue; // already covered by dept/direct
        rows.set(rowKey, {
          employeeId: emp.id,
          operationKey: key,
          source: 'ROLE',
          inherited: true,
          departmentId: leaderDeptByKey.get(key) ?? null,
          roleAssignmentId: a.id,
          roleKey: a.role.key,
        });
      }
    }

    const sorted = [...rows.values()].sort((a, b) =>
      `${a.employeeId}|${a.operationKey}`.localeCompare(`${b.employeeId}|${b.operationKey}`),
    );
    let start = 0;
    const cursor = options.cursor;
    if (cursor !== undefined && cursor.length > 0) {
      const idx = sorted.findIndex((r) => `${r.employeeId}|${r.operationKey}` > cursor);
      start = idx === -1 ? sorted.length : idx;
    }
    const page = sorted.slice(start, start + limit);
    const next = sorted[start + limit];
    const items = page.map((r) => {
      const emp = empById.get(r.employeeId);
      const op = opByKey.get(r.operationKey);
      const dept = r.departmentId !== null ? deptById.get(r.departmentId) : undefined;
      return {
        employeeId: r.employeeId,
        employeeCode: emp?.employeeCode ?? '',
        displayName: emp?.displayName ?? '',
        operationKey: r.operationKey,
        name: op?.name ?? r.operationKey,
        domain: op?.domain ?? 'OPERATIONS',
        sensitive: op?.sensitive ?? false,
        leadershipInheritable: op?.leadershipInheritable ?? false,
        source: r.source,
        inherited: r.inherited,
        department:
          dept === undefined
            ? null
            : {
                id: dept.id,
                code: dept.code,
                name: dept.name,
                scopeType: dept.scopeType,
              },
        roleAssignment:
          r.roleAssignmentId === null
            ? null
            : { id: r.roleAssignmentId, roleKey: r.roleKey, scopeType: 'PROJECT', projectId },
      };
    });
    return {
      items,
      nextCursor: next === undefined ? null : `${next.employeeId}|${next.operationKey}`,
    };
  }

  private async assertActiveDept(companyId: string, departmentId: string) {
    const dept = await this.prisma.department.findFirst({ where: { id: departmentId, companyId } });
    if (!dept) throw new OrgEntityNotFoundError('DEPARTMENT');
    if (dept.status !== 'ACTIVE') {
      throw new OrgValidationError('departmentId', 'department must be active');
    }
    return dept;
  }

  /** The op must be valid for the department's scope under catalogue metadata. */
  private assertScopeApplicability(op: { appliesTo: string[] }, scopeType: string) {
    if (!op.appliesTo.includes(scopeType)) {
      throw new OrgValidationError(
        'operationKey',
        `operation is not applicable to ${scopeType}-scoped departments`,
      );
    }
  }

  /**
   * Direct-grant eligibility: the employee must hold an effective open
   * membership in an ACTIVE department that has the operation enabled and
   * ACTIVE, and the operation must be valid for that department's scope.
   * No direct-override bypass exists — leadership coverage is the separate
   * approved path for PD/PI.
   */
  private async assertDirectGrantEligible(
    companyId: string,
    employeeId: string,
    op: { key: string; appliesTo: string[] },
  ) {
    const memberships = await this.prisma.departmentMembership.findMany({
      where: { companyId, employeeId, endedAt: null },
      select: { departmentId: true },
    });
    const deptIds = memberships.map((m) => m.departmentId);
    if (deptIds.length === 0) {
      throw new OrgValidationError(
        'operationKey',
        'operation must be enabled on an active department the employee belongs to',
      );
    }
    const deptOps = await this.prisma.departmentOperation.findMany({
      where: {
        companyId,
        departmentId: { in: deptIds },
        operationKey: op.key,
        status: 'ACTIVE',
        department: { status: 'ACTIVE' },
      },
      select: { department: { select: { scopeType: true } } },
    });
    if (!deptOps.some((d) => op.appliesTo.includes(d.department.scopeType))) {
      throw new OrgValidationError(
        'operationKey',
        'operation must be enabled on an active department the employee belongs to',
      );
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
