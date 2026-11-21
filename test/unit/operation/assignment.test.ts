import { describe, it, expect } from 'vitest';
import { OperationAssignmentService } from '../../../src/modules/operation/assignment.js';
import { OrgValidationError } from '../../../src/modules/organization/errors.js';

const OWNER = { actorId: 'a1', actorType: 'USER' as const };

function matchActiveAssignment(
  a: {
    companyId: string;
    principalId: string;
    revokedAt: Date | null;
    scopeType: string;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    roleKey?: string;
  },
  where: {
    companyId: string;
    principalId: string;
    revokedAt: Date | null;
    scopeType: string;
    role: { key: { in: string[] } };
  },
) {
  return (
    a.companyId === where.companyId &&
    a.principalId === where.principalId &&
    a.revokedAt === where.revokedAt &&
    a.scopeType === where.scopeType &&
    where.role.key.in.includes(a.roleKey ?? '') &&
    (a.effectiveFrom === null || a.effectiveFrom <= new Date()) &&
    (a.effectiveTo === null || a.effectiveTo >= new Date())
  );
}

function makeFakePrisma() {
  const state = {
    depts: [
      {
        id: 'd-fin',
        companyId: 'c1',
        status: 'ACTIVE',
        projectId: null as string | null,
        siteId: null as string | null,
      },
      {
        id: 'd-site',
        companyId: 'c1',
        status: 'ACTIVE',
        projectId: null as string | null,
        siteId: null as string | null,
      },
    ],
    employees: [
      { id: 'e1', companyId: 'c1', status: 'ACTIVE', principalId: null as string | null },
      { id: 'e2', companyId: 'c1', status: 'INACTIVE', principalId: null as string | null },
    ],
    sites: [] as { id: string; companyId: string; projectId: string }[],
    roleAssignments: [] as {
      companyId: string;
      principalId: string;
      roleId: string;
      scopeType: string;
      projectId: string | null;
      revokedAt: Date | null;
      effectiveFrom: Date | null;
      effectiveTo: Date | null;
      roleKey?: string;
    }[],
    memberships: [
      { companyId: 'c1', employeeId: 'e1', departmentId: 'd-fin', endedAt: null },
      { companyId: 'c1', employeeId: 'e1', departmentId: 'd-site', endedAt: new Date() },
    ] as { companyId: string; employeeId: string; departmentId: string; endedAt: Date | null }[],
    catalogue: [
      {
        key: 'PETTY_CASH_REQUEST_APPROVE',
        domain: 'WALLET',
        name: 'Petty Cash Request Approve',
        description: 'Approve petty cash',
        sensitive: false,
      },
      {
        key: 'SALARY_PAYMENT_APPROVE',
        domain: 'PAYROLL',
        name: 'Salary Payment Approve',
        description: 'Approve salary payment',
        sensitive: true,
      },
    ],
    deptOps: [
      {
        id: 'do1',
        companyId: 'c1',
        departmentId: 'd-fin',
        operationKey: 'PETTY_CASH_REQUEST_APPROVE',
        status: 'ACTIVE',
      },
      {
        id: 'do2',
        companyId: 'c1',
        departmentId: 'd-site',
        operationKey: 'SALARY_PAYMENT_APPROVE',
        status: 'ACTIVE',
      },
    ] as {
      id: string;
      companyId: string;
      departmentId: string;
      operationKey: string;
      status: string;
      createdAt?: Date | undefined;
    }[],
    empOps: [] as {
      id: string;
      companyId: string;
      employeeId: string;
      operationKey: string;
      status?: string | undefined;
      createdAt?: Date | undefined;
    }[],
    audits: [] as object[],
  };

  const prisma = {
    department: {
      findFirst: async ({ where }: { where: { id: string; companyId: string } }) =>
        state.depts.find((d) => d.id === where.id && d.companyId === where.companyId) ?? null,
    },
    employee: {
      findFirst: async ({ where }: { where: { id: string; companyId: string } }) =>
        state.employees.find((e) => e.id === where.id && e.companyId === where.companyId) ?? null,
    },
    site: {
      findMany: async ({ where }: { where: { companyId: string; projectId?: { in: string[] } } }) =>
        state.sites.filter(
          (s) =>
            s.companyId === where.companyId &&
            (where.projectId === undefined || where.projectId.in.includes(s.projectId)),
        ),
    },
    roleAssignment: {
      findMany: async ({
        where,
      }: {
        where: {
          companyId: string;
          principalId: string;
          revokedAt: Date | null;
          scopeType: string;
          role: { key: { in: string[] } };
        };
      }) => state.roleAssignments.filter((a) => matchActiveAssignment(a, where)),
      findFirst: async ({
        where,
      }: {
        where: {
          companyId: string;
          principalId: string;
          revokedAt: Date | null;
          scopeType: string;
          role: { key: { in: string[] } };
        };
      }) => state.roleAssignments.find((a) => matchActiveAssignment(a, where)) ?? null,
    },
    departmentMembership: {
      findMany: async ({
        where,
      }: {
        where: { companyId: string; employeeId: string; endedAt?: Date | null };
      }) =>
        state.memberships.filter(
          (m) =>
            m.companyId === where.companyId &&
            m.employeeId === where.employeeId &&
            (where.endedAt === undefined || m.endedAt === where.endedAt),
        ),
    },
    operationCatalogueEntry: {
      findMany: async () => state.catalogue,
      findUnique: async ({ where }: { where: { key: string } }) =>
        state.catalogue.find((c) => c.key === where.key) ?? null,
    },
    departmentOperation: {
      findMany: async ({
        where,
      }: {
        where: {
          companyId: string;
          departmentId?: unknown;
          status?: string;
          department?: {
            companyId?: string;
            status?: string;
            OR?: { projectId?: { in: string[] }; siteId?: { in: string[] } }[];
          };
          operation?: {
            sensitive?: boolean;
            OR?: { domain?: { in: string[] }; key?: string }[];
          };
        };
      }) =>
        state.deptOps
          .filter((d) => {
            if (d.companyId !== where.companyId) return false;
            if (where.status !== undefined && d.status !== where.status) return false;
            if (
              where.departmentId !== undefined &&
              (Array.isArray((where.departmentId as { in: string[] }).in)
                ? !(where.departmentId as { in: string[] }).in.includes(d.departmentId)
                : d.departmentId !== where.departmentId)
            )
              return false;
            if (where.department !== undefined) {
              const dept = state.depts.find((x) => x.id === d.departmentId);
              const df = where.department;
              if (dept === undefined) return false;
              if (df.companyId !== undefined && dept.companyId !== df.companyId) return false;
              if (df.status !== undefined && dept.status !== df.status) return false;
              if (df.OR !== undefined) {
                const anyMatch = df.OR.some((c) => {
                  if (c.projectId !== undefined)
                    return dept.projectId !== null && c.projectId.in.includes(dept.projectId);
                  if (c.siteId !== undefined)
                    return dept.siteId !== null && c.siteId.in.includes(dept.siteId);
                  return false;
                });
                if (!anyMatch) return false;
              }
            }
            if (where.operation !== undefined) {
              const cat = state.catalogue.find((c) => c.key === d.operationKey);
              if (
                where.operation.sensitive !== undefined &&
                (cat?.sensitive ?? false) !== where.operation.sensitive
              )
                return false;
              if (where.operation.OR !== undefined) {
                const anyMatch = where.operation.OR.some((c) => {
                  if (c.domain !== undefined) return c.domain.in.includes(cat?.domain ?? '');
                  if (c.key !== undefined) return cat?.key === c.key;
                  return false;
                });
                if (!anyMatch) return false;
              }
            }
            return true;
          })
          .map((d) => ({
            ...d,
            status: d.status,
            createdAt: d.createdAt ?? new Date(),
            operation: state.catalogue.find((c) => c.key === d.operationKey) ?? {
              key: d.operationKey,
              domain: 'OPERATIONS',
              name: d.operationKey,
              description: '',
              sensitive: false,
            },
          })),
      findUnique: async ({
        where,
      }: {
        where: {
          companyId_departmentId_operationKey: {
            companyId: string;
            departmentId: string;
            operationKey: string;
          };
        };
      }) => {
        const k = where.companyId_departmentId_operationKey;
        const found = state.deptOps.find(
          (d) =>
            d.companyId === k.companyId &&
            d.departmentId === k.departmentId &&
            d.operationKey === k.operationKey,
        );
        if (!found) return null;
        return {
          ...found,
          status: found.status,
          createdAt: found.createdAt ?? new Date(),
          operation: state.catalogue.find((c) => c.key === found.operationKey) ?? {
            key: found.operationKey,
            domain: 'OPERATIONS',
            name: found.operationKey,
            description: '',
            sensitive: false,
          },
        };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          companyId_departmentId_operationKey: {
            companyId: string;
            departmentId: string;
            operationKey: string;
          };
        };
        create: {
          companyId: string;
          departmentId: string;
          operationKey: string;
          status: string;
        };
        update: { status?: string };
      }) => {
        const k = where.companyId_departmentId_operationKey;
        const idx = state.deptOps.findIndex(
          (d) =>
            d.companyId === k.companyId &&
            d.departmentId === k.departmentId &&
            d.operationKey === k.operationKey,
        );
        const current = state.deptOps[idx];
        if (current) {
          const updated = {
            ...current,
            status: update.status ?? current.status,
          };
          state.deptOps[idx] = updated;
          return updated;
        }
        const row = { id: `do-${state.deptOps.length}`, ...create, createdAt: new Date() };
        state.deptOps.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { companyId: string; departmentId: string; operationKey: string };
        data: { status: string };
      }) => {
        let count = 0;
        for (let i = 0; i < state.deptOps.length; i++) {
          const d = state.deptOps[i];
          if (
            d?.companyId === where.companyId &&
            d.departmentId === where.departmentId &&
            d.operationKey === where.operationKey
          ) {
            state.deptOps[i] = { ...d, status: data.status };
            count++;
          }
        }
        return { count };
      },
      create: async ({
        data,
      }: {
        data: { companyId: string; departmentId: string; operationKey: string; status?: string };
      }) => {
        if (
          state.deptOps.some(
            (d) =>
              d.companyId === data.companyId &&
              d.departmentId === data.departmentId &&
              d.operationKey === data.operationKey,
          )
        ) {
          throw Object.assign(new Error('P2002'), { code: 'P2002' });
        }
        const row = {
          id: `do-${state.deptOps.length}`,
          ...data,
          status: data.status ?? 'ACTIVE',
          createdAt: new Date(),
        };
        state.deptOps.push(row);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { companyId: string; departmentId: string; operationKey: string };
      }) => {
        const before = state.deptOps.length;
        state.deptOps = state.deptOps.filter(
          (d) =>
            !(
              d.companyId === where.companyId &&
              d.departmentId === where.departmentId &&
              d.operationKey === where.operationKey
            ),
        );
        return { count: before - state.deptOps.length };
      },
    },
    employeeOperation: {
      findMany: async ({ where }: { where: { companyId: string; employeeId: string } }) =>
        state.empOps
          .filter((e) => e.companyId === where.companyId && e.employeeId === where.employeeId)
          .map((e) => ({
            ...e,
            status: e.status ?? 'ACTIVE',
            createdAt: e.createdAt ?? new Date(),
            operation: state.catalogue.find((c) => c.key === e.operationKey) ?? {
              key: e.operationKey,
              domain: 'OPERATIONS',
              name: e.operationKey,
              description: '',
              sensitive: false,
            },
          })),
      findUnique: async ({
        where,
      }: {
        where: {
          companyId_employeeId_operationKey: {
            companyId: string;
            employeeId: string;
            operationKey: string;
          };
        };
      }) => {
        const k = where.companyId_employeeId_operationKey;
        const found = state.empOps.find(
          (e) =>
            e.companyId === k.companyId &&
            e.employeeId === k.employeeId &&
            e.operationKey === k.operationKey,
        );
        if (!found) return null;
        return {
          ...found,
          status: found.status ?? 'ACTIVE',
          createdAt: found.createdAt ?? new Date(),
          operation: state.catalogue.find((c) => c.key === found.operationKey) ?? {
            key: found.operationKey,
            domain: 'OPERATIONS',
            name: found.operationKey,
            description: '',
            sensitive: false,
          },
        };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          companyId_employeeId_operationKey: {
            companyId: string;
            employeeId: string;
            operationKey: string;
          };
        };
        create: {
          companyId: string;
          employeeId: string;
          operationKey: string;
          status: string;
        };
        update: { status?: string };
      }) => {
        const k = where.companyId_employeeId_operationKey;
        const idx = state.empOps.findIndex(
          (e) =>
            e.companyId === k.companyId &&
            e.employeeId === k.employeeId &&
            e.operationKey === k.operationKey,
        );
        const current = state.empOps[idx];
        if (current) {
          const updated = {
            ...current,
            status: update.status ?? current.status ?? 'ACTIVE',
          };
          state.empOps[idx] = updated;
          return updated;
        }
        const row = { id: `eo-${state.empOps.length}`, ...create, createdAt: new Date() };
        state.empOps.push(row);
        return row;
      },
      create: async ({
        data,
      }: {
        data: { companyId: string; employeeId: string; operationKey: string; status?: string };
      }) => {
        if (
          state.empOps.some(
            (e) =>
              e.companyId === data.companyId &&
              e.employeeId === data.employeeId &&
              e.operationKey === data.operationKey,
          )
        ) {
          throw Object.assign(new Error('P2002'), { code: 'P2002' });
        }
        const row = {
          id: `eo-${state.empOps.length}`,
          ...data,
          status: data.status ?? 'ACTIVE',
          createdAt: new Date(),
        };
        state.empOps.push(row);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { companyId: string; employeeId: string; operationKey: string };
      }) => {
        const before = state.empOps.length;
        state.empOps = state.empOps.filter(
          (e) =>
            !(
              e.companyId === where.companyId &&
              e.employeeId === where.employeeId &&
              e.operationKey === where.operationKey
            ),
        );
        return { count: before - state.empOps.length };
      },
    },
    auditLog: { create: async ({ data }: { data: object }) => state.audits.push(data) },
    $transaction: null as null | ((fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>),
  };
  prisma.$transaction = async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma);
  return { state, prisma };
}

const svc = (p: unknown) =>
  new OperationAssignmentService(p as never, { assertPermission: async () => undefined });

describe('OperationAssignmentService', () => {
  it('assigns an op enabled on an ACTIVE member dept', async () => {
    const { state, prisma } = makeFakePrisma();
    const row = await svc(prisma).assignEmployeeOperation(
      OWNER,
      'c1',
      'e1',
      'PETTY_CASH_REQUEST_APPROVE',
    );
    expect(row?.operationKey).toBe('PETTY_CASH_REQUEST_APPROVE');
    expect(state.empOps).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });
  it('allows assigning an operation other than the employee active department (direct grant)', async () => {
    const { prisma } = makeFakePrisma();
    // SALARY_PAYMENT_APPROVE is not in e1's active department (d-fin).
    const row = await svc(prisma).assignEmployeeOperation(
      OWNER,
      'c1',
      'e1',
      'SALARY_PAYMENT_APPROVE',
    );
    expect(row?.operationKey).toBe('SALARY_PAYMENT_APPROVE');
    expect(row?.status).toBe('ACTIVE');

    // Appears in listEmployeeOperations as direct grant
    const ops = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
    const directOp = ops.find((o) => o.operationKey === 'SALARY_PAYMENT_APPROVE');
    expect(directOp).toMatchObject({
      operationKey: 'SALARY_PAYMENT_APPROVE',
      inherited: false,
      source: 'DIRECT',
      status: 'ACTIVE',
    });

    // Also included in getEffectiveOperations
    const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
    expect(effective).toContain('SALARY_PAYMENT_APPROVE');
  });
  it('effective ops = (inherited dept ops - revoked) ∪ direct active grants', async () => {
    const { state, prisma } = makeFakePrisma();
    state.empOps.push(
      {
        id: 'g1',
        companyId: 'c1',
        employeeId: 'e1',
        operationKey: 'PETTY_CASH_REQUEST_APPROVE',
        status: 'ACTIVE',
      },
      {
        id: 'g2',
        companyId: 'c1',
        employeeId: 'e1',
        operationKey: 'SALARY_PAYMENT_APPROVE',
        status: 'ACTIVE',
      },
    );
    const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
    expect(effective).toEqual(['PETTY_CASH_REQUEST_APPROVE', 'SALARY_PAYMENT_APPROVE']);
  });
  it('enable op on dept; re-enabling idempotently activates it', async () => {
    const { prisma } = makeFakePrisma();
    const row = await svc(prisma).enableDeptOperation(
      OWNER,
      'c1',
      'd-fin',
      'SALARY_PAYMENT_APPROVE',
    );
    expect(row?.status).toBe('ACTIVE');
    const row2 = await svc(prisma).enableDeptOperation(
      OWNER,
      'c1',
      'd-fin',
      'SALARY_PAYMENT_APPROVE',
    );
    expect(row2?.status).toBe('ACTIVE');
  });
  it('inactive/non-active employee cannot be assigned', async () => {
    const { prisma } = makeFakePrisma();
    await expect(
      svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e2', 'PETTY_CASH_REQUEST_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });
  it('listDeptOperations returns operations enriched with name, domain, status, and operation relation', async () => {
    const { prisma } = makeFakePrisma();
    const ops = await svc(prisma).listDeptOperations(OWNER, 'c1', 'd-fin');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      id: 'do1',
      companyId: 'c1',
      departmentId: 'd-fin',
      operationKey: 'PETTY_CASH_REQUEST_APPROVE',
      name: 'Petty Cash Request Approve',
      domain: 'WALLET',
      status: 'ACTIVE',
      operation: {
        key: 'PETTY_CASH_REQUEST_APPROVE',
        domain: 'WALLET',
        name: 'Petty Cash Request Approve',
      },
    });
  });
  it('automatically inherits operations from active department memberships without explicit grant', async () => {
    const { state, prisma } = makeFakePrisma();
    // e1 has active membership in d-fin (which has PETTY_CASH_REQUEST_APPROVE)
    // state.empOps is completely empty
    expect(state.empOps).toHaveLength(0);
    const ops = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      companyId: 'c1',
      employeeId: 'e1',
      operationKey: 'PETTY_CASH_REQUEST_APPROVE',
      name: 'Petty Cash Request Approve',
      domain: 'WALLET',
      status: 'ACTIVE',
      inherited: true,
      source: 'DEPARTMENT',
    });
  });
  it('revoking an inherited operation from employee excludes it without removing from department', async () => {
    const { state, prisma } = makeFakePrisma();
    // Initially inherited from d-fin
    const initialOps = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
    expect(initialOps).toHaveLength(1);

    // Revoke from employee
    const res = await svc(prisma).revokeEmployeeOperation(
      OWNER,
      'c1',
      'e1',
      'PETTY_CASH_REQUEST_APPROVE',
    );
    expect(res).toEqual({ revoked: true, status: 'INACTIVE' });

    // Department operation is UNTOUCHED!
    expect(state.deptOps.find((d) => d.operationKey === 'PETTY_CASH_REQUEST_APPROVE')).toBeTruthy();

    // Employee now has operation with status INACTIVE
    const afterOps = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
    expect(afterOps).toHaveLength(1);
    expect(afterOps[0]?.status).toBe('INACTIVE');

    // Effective operations excludes it
    const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
    expect(effective).toEqual([]);

    // Re-assigning restores it to ACTIVE
    await svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e1', 'PETTY_CASH_REQUEST_APPROVE');
    const restoredOps = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
    expect(restoredOps).toHaveLength(1);
    expect(restoredOps[0]?.status).toBe('ACTIVE');
  });
  it('disabling a department operation sets status to INACTIVE without deleting it', async () => {
    const { prisma } = makeFakePrisma();
    const res = await svc(prisma).disableDeptOperation(
      OWNER,
      'c1',
      'd-fin',
      'PETTY_CASH_REQUEST_APPROVE',
    );
    expect(res).toEqual({ disabled: true, status: 'INACTIVE' });

    // Still exists in department operations, with status INACTIVE
    const deptOps = await svc(prisma).listDeptOperations(OWNER, 'c1', 'd-fin');
    const op = deptOps.find((d) => d.operationKey === 'PETTY_CASH_REQUEST_APPROVE');
    expect(op?.status).toBe('INACTIVE');

    // And employee receives it as INACTIVE
    const empOps = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
    const empOp = empOps.find((e) => e.operationKey === 'PETTY_CASH_REQUEST_APPROVE');
    expect(empOp?.status).toBe('INACTIVE');

    const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
    expect(effective).not.toContain('PETTY_CASH_REQUEST_APPROVE');
  });
  it('toggleDeptOperationStatus toggles between ACTIVE and INACTIVE', async () => {
    const { prisma } = makeFakePrisma();
    // Initially ACTIVE on d-fin
    const toggled1 = await svc(prisma).toggleDeptOperationStatus(
      OWNER,
      'c1',
      'd-fin',
      'PETTY_CASH_REQUEST_APPROVE',
    );
    expect(toggled1.status).toBe('INACTIVE');

    // Toggle back to ACTIVE
    const toggled2 = await svc(prisma).toggleDeptOperationStatus(
      OWNER,
      'c1',
      'd-fin',
      'PETTY_CASH_REQUEST_APPROVE',
    );
    expect(toggled2.status).toBe('ACTIVE');

    // Explicit target status
    const explicit = await svc(prisma).toggleDeptOperationStatus(
      OWNER,
      'c1',
      'd-fin',
      'PETTY_CASH_REQUEST_APPROVE',
      'INACTIVE',
    );
    expect(explicit.status).toBe('INACTIVE');
  });
  it('toggleEmployeeOperationStatus toggles between ACTIVE and INACTIVE', async () => {
    const { prisma } = makeFakePrisma();
    // Inherited from d-fin (initially ACTIVE)
    const toggled1 = await svc(prisma).toggleEmployeeOperationStatus(
      OWNER,
      'c1',
      'e1',
      'PETTY_CASH_REQUEST_APPROVE',
    );
    expect(toggled1.status).toBe('INACTIVE');

    // Toggle back to ACTIVE
    const toggled2 = await svc(prisma).toggleEmployeeOperationStatus(
      OWNER,
      'c1',
      'e1',
      'PETTY_CASH_REQUEST_APPROVE',
    );
    expect(toggled2.status).toBe('ACTIVE');

    // Direct grant toggle
    const direct = await svc(prisma).toggleEmployeeOperationStatus(
      OWNER,
      'c1',
      'e1',
      'SALARY_PAYMENT_APPROVE',
      'ACTIVE',
    );
    expect(direct.status).toBe('ACTIVE');
    expect(direct.source).toBe('DIRECT');
  });

  describe('PD/PI project-role operation coverage', () => {
    function withLeadership(state: ReturnType<typeof makeFakePrisma>['state']) {
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      state.sites.push(
        { id: 's1', companyId: 'c1', projectId: 'proj-a' },
        { id: 's2', companyId: 'c1', projectId: 'proj-b' },
      );
      state.depts.push(
        {
          id: 'd-proj-a',
          companyId: 'c1',
          status: 'ACTIVE',
          projectId: 'proj-a',
          siteId: null,
        },
        { id: 'd-site-1', companyId: 'c1', status: 'ACTIVE', projectId: null, siteId: 's1' },
        {
          id: 'd-proj-b',
          companyId: 'c1',
          status: 'ACTIVE',
          projectId: 'proj-b',
          siteId: null,
        },
      );
      state.deptOps.push(
        {
          id: 'do-pa',
          companyId: 'c1',
          departmentId: 'd-proj-a',
          operationKey: 'PETTY_CASH_REQUEST_APPROVE',
          status: 'ACTIVE',
        },
        {
          id: 'do-s1',
          companyId: 'c1',
          departmentId: 'd-site-1',
          operationKey: 'SALARY_PAYMENT_APPROVE',
          status: 'ACTIVE',
        },
        {
          id: 'do-pb',
          companyId: 'c1',
          departmentId: 'd-proj-b',
          operationKey: 'PETTY_CASH_REQUEST_APPROVE',
          status: 'ACTIVE',
        },
      );
      state.roleAssignments.push({
        companyId: 'c1',
        principalId: 'p1',
        roleId: 'r-pd',
        scopeType: 'PROJECT',
        projectId: 'proj-a',
        revokedAt: null,
        effectiveFrom: null,
        effectiveTo: null,
        roleKey: 'PROJECT_DIRECTOR',
      });
    }

    it('covers ops enabled on the assigned project and its sites', async () => {
      const { state, prisma } = makeFakePrisma();
      withLeadership(state);
      state.catalogue.push({
        key: 'WORK_PROGRESS_SUBMIT',
        domain: 'OPERATIONS',
        name: 'Work Progress Submit',
        description: '',
        sensitive: false,
      });
      state.deptOps.push({
        id: 'do-wps',
        companyId: 'c1',
        departmentId: 'd-site-1',
        operationKey: 'WORK_PROGRESS_SUBMIT',
        status: 'ACTIVE',
      });
      const keys = await svc(prisma).getLeadershipScopedOperationKeys('c1', 'e1');
      // Non-sensitive proj-a + site-1 ops; SALARY_PAYMENT_APPROVE is sensitive.
      expect(keys).toEqual(expect.arrayContaining(['WORK_PROGRESS_SUBMIT']));
      expect(keys).toContain('PETTY_CASH_REQUEST_APPROVE');
    });

    it('excludes sensitive ops and ops enabled only on other projects', async () => {
      const { state, prisma } = makeFakePrisma();
      withLeadership(state);
      state.catalogue.push(
        {
          key: 'PROJ_B_ONLY_OP',
          domain: 'OPERATIONS',
          name: 'Proj B Only',
          description: '',
          sensitive: false,
        },
        {
          key: 'HO_ONLY_OP',
          domain: 'OPERATIONS',
          name: 'HO Only',
          description: '',
          sensitive: false,
        },
      );
      // Enabled ONLY on proj-b dept — PD of proj-a must not see it.
      state.deptOps.push({
        id: 'do-pb2',
        companyId: 'c1',
        departmentId: 'd-proj-b',
        operationKey: 'PROJ_B_ONLY_OP',
        status: 'ACTIVE',
      });
      // Enabled ONLY on a company-wide (HO) dept — never in project scope.
      state.deptOps.push({
        id: 'do-ho',
        companyId: 'c1',
        departmentId: 'd-fin',
        operationKey: 'HO_ONLY_OP',
        status: 'ACTIVE',
      });
      const keys = await svc(prisma).getLeadershipScopedOperationKeys('c1', 'e1');
      expect(keys).not.toContain('SALARY_PAYMENT_APPROVE');
      expect(keys).not.toContain('PROJ_B_ONLY_OP');
      expect(keys).not.toContain('HO_ONLY_OP');
      expect(keys).toContain('PETTY_CASH_REQUEST_APPROVE');
    });

    it('role coverage appears in getEffectiveOperations and listEmployeeOperations', async () => {
      const { state, prisma } = makeFakePrisma();
      withLeadership(state);
      state.catalogue.push({
        key: 'WORK_PROGRESS_SUBMIT',
        domain: 'OPERATIONS',
        name: 'Work Progress Submit',
        description: '',
        sensitive: false,
      });
      // Enabled only on site-1's dept — reachable solely through the PD role.
      state.deptOps.push({
        id: 'do-wps',
        companyId: 'c1',
        departmentId: 'd-site-1',
        operationKey: 'WORK_PROGRESS_SUBMIT',
        status: 'ACTIVE',
      });
      const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
      expect(effective).toContain('WORK_PROGRESS_SUBMIT');
      const ops = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
      const roleOp = ops.find((o) => o.source === 'ROLE');
      expect(roleOp).toBeTruthy();
      expect(roleOp?.operationKey).toBe('WORK_PROGRESS_SUBMIT');
    });

    it('a revoked employee override still wins over role coverage', async () => {
      const { state, prisma } = makeFakePrisma();
      withLeadership(state);
      state.empOps.push({
        id: 'eo1',
        companyId: 'c1',
        employeeId: 'e1',
        operationKey: 'PETTY_CASH_REQUEST_APPROVE',
        status: 'INACTIVE',
      });
      const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
      expect(effective).not.toContain('PETTY_CASH_REQUEST_APPROVE');
    });

    it('coverage ends when the role assignment is revoked', async () => {
      const { state, prisma } = makeFakePrisma();
      withLeadership(state);
      const [pdAssignment] = state.roleAssignments;
      if (pdAssignment !== undefined) pdAssignment.revokedAt = new Date();
      const keys = await svc(prisma).getLeadershipScopedOperationKeys('c1', 'e1');
      expect(keys).toEqual([]);
      const ops = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
      expect(ops.find((o) => o.source === 'ROLE')).toBeUndefined();
    });
  });

  describe('FINANCE company-role operation coverage', () => {
    function withFinanceRole(state: ReturnType<typeof makeFakePrisma>['state']) {
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      state.roleAssignments.push({
        companyId: 'c1',
        principalId: 'p1',
        roleId: 'r-fm',
        scopeType: 'COMPANY',
        projectId: null,
        revokedAt: null,
        effectiveFrom: null,
        effectiveTo: null,
        roleKey: 'FINANCE_MANAGER',
      });
    }

    it('covers finance-domain ops enabled on any active dept in the company', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      // Finance-domain op enabled on a dept e1 is NOT a member of.
      state.catalogue.push({
        key: 'CLIENT_INVOICE_ISSUE',
        domain: 'BILLING',
        name: 'Client Invoice Issue',
        description: '',
        sensitive: false,
      });
      state.deptOps.push({
        id: 'do-inv',
        companyId: 'c1',
        departmentId: 'd-site',
        operationKey: 'CLIENT_INVOICE_ISSUE',
        status: 'ACTIVE',
      });
      const keys = await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1');
      expect(keys).toContain('CLIENT_INVOICE_ISSUE');
      expect(keys).toContain('PETTY_CASH_REQUEST_APPROVE');
    });

    it('excludes sensitive, non-finance-domain, and disabled ops', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      state.catalogue.push(
        {
          key: 'WORK_PROGRESS_SUBMIT',
          domain: 'OPERATIONS',
          name: 'Work Progress Submit',
          description: '',
          sensitive: false,
        },
        {
          key: 'CLIENT_INVOICE_ISSUE',
          domain: 'BILLING',
          name: 'Client Invoice Issue',
          description: '',
          sensitive: false,
        },
      );
      state.deptOps.push(
        {
          id: 'do-wps',
          companyId: 'c1',
          departmentId: 'd-site',
          operationKey: 'WORK_PROGRESS_SUBMIT',
          status: 'ACTIVE',
        },
        {
          id: 'do-inv',
          companyId: 'c1',
          departmentId: 'd-site',
          operationKey: 'CLIENT_INVOICE_ISSUE',
          status: 'INACTIVE',
        },
      );
      const keys = await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1');
      expect(keys).not.toContain('WORK_PROGRESS_SUBMIT');
      expect(keys).not.toContain('CLIENT_INVOICE_ISSUE');
      expect(keys).not.toContain('SALARY_PAYMENT_APPROVE');
    });

    it('covers PROJECT_DASHBOARD_VIEW despite its PROJECT_REPORTS domain', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      state.catalogue.push({
        key: 'PROJECT_DASHBOARD_VIEW',
        domain: 'PROJECT_REPORTS',
        name: 'Project Dashboard View',
        description: '',
        sensitive: false,
      });
      state.deptOps.push({
        id: 'do-dash',
        companyId: 'c1',
        departmentId: 'd-site',
        operationKey: 'PROJECT_DASHBOARD_VIEW',
        status: 'ACTIVE',
      });
      const keys = await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1');
      expect(keys).toContain('PROJECT_DASHBOARD_VIEW');
    });

    it('coverage appears in getEffectiveOperations and listEmployeeOperations', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      state.catalogue.push({
        key: 'CLIENT_INVOICE_ISSUE',
        domain: 'BILLING',
        name: 'Client Invoice Issue',
        description: '',
        sensitive: false,
      });
      state.deptOps.push({
        id: 'do-inv',
        companyId: 'c1',
        departmentId: 'd-site',
        operationKey: 'CLIENT_INVOICE_ISSUE',
        status: 'ACTIVE',
      });
      const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
      expect(effective).toContain('CLIENT_INVOICE_ISSUE');
      const ops = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
      const roleOp = ops.find(
        (o) => o.source === 'ROLE' && o.operationKey === 'CLIENT_INVOICE_ISSUE',
      );
      expect(roleOp).toBeTruthy();
      expect(roleOp?.status).toBe('ACTIVE');
    });

    it('admin enable/disable on the dept updates coverage live', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      state.catalogue.push({
        key: 'CLIENT_INVOICE_ISSUE',
        domain: 'BILLING',
        name: 'Client Invoice Issue',
        description: '',
        sensitive: false,
      });
      const row = {
        id: 'do-inv',
        companyId: 'c1',
        departmentId: 'd-site',
        operationKey: 'CLIENT_INVOICE_ISSUE',
        status: 'ACTIVE',
      };
      state.deptOps.push(row);
      expect(await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1')).toContain(
        'CLIENT_INVOICE_ISSUE',
      );
      row.status = 'INACTIVE';
      const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
      expect(effective).not.toContain('CLIENT_INVOICE_ISSUE');
    });

    it('employee override subtracts a covered op', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      state.empOps.push({
        id: 'eo1',
        companyId: 'c1',
        employeeId: 'e1',
        operationKey: 'PETTY_CASH_REQUEST_APPROVE',
        status: 'INACTIVE',
      });
      const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
      expect(effective).not.toContain('PETTY_CASH_REQUEST_APPROVE');
    });

    it('no coverage without the role, when revoked, or not yet effective', async () => {
      const { state, prisma } = makeFakePrisma();
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      // No assignment at all.
      expect(await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1')).toEqual([]);
      state.roleAssignments.push(
        {
          companyId: 'c1',
          principalId: 'p1',
          roleId: 'r-fm1',
          scopeType: 'COMPANY',
          projectId: null,
          revokedAt: new Date(),
          effectiveFrom: null,
          effectiveTo: null,
          roleKey: 'FINANCE_MANAGER',
        },
        {
          companyId: 'c1',
          principalId: 'p1',
          roleId: 'r-fm2',
          scopeType: 'COMPANY',
          projectId: null,
          revokedAt: null,
          effectiveFrom: new Date(Date.now() + 86400000),
          effectiveTo: null,
          roleKey: 'FINANCE_STAFF',
        },
      );
      expect(await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1')).toEqual([]);
    });
  });
});
