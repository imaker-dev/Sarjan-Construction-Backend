import { describe, it, expect } from 'vitest';
import { OperationAssignmentService } from '../../../src/modules/operation/assignment.js';
import { OrgValidationError } from '../../../src/modules/organization/errors.js';

const OWNER = { actorId: 'a1', actorType: 'USER' as const };

function makeFakePrisma() {
  const state = {
    depts: [
      { id: 'd-fin', companyId: 'c1', status: 'ACTIVE' },
      { id: 'd-site', companyId: 'c1', status: 'ACTIVE' },
    ],
    employees: [
      { id: 'e1', companyId: 'c1', status: 'ACTIVE' },
      { id: 'e2', companyId: 'c1', status: 'INACTIVE' },
    ],
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
        where: { companyId: string; departmentId?: unknown; status?: string };
      }) =>
        state.deptOps
          .filter(
            (d) =>
              d.companyId === where.companyId &&
              (where.status === undefined || d.status === where.status) &&
              (where.departmentId === undefined ||
                (Array.isArray((where.departmentId as { in: string[] }).in)
                  ? (where.departmentId as { in: string[] }).in.includes(d.departmentId)
                  : d.departmentId === where.departmentId)),
          )
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
});
