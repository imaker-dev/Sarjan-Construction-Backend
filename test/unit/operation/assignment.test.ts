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
      { key: 'PETTY_CASH_REQUEST_APPROVE', domain: 'WALLET' },
      { key: 'SALARY_PAYMENT_APPROVE', domain: 'PAYROLL' },
    ],
    deptOps: [
      {
        id: 'do1',
        companyId: 'c1',
        departmentId: 'd-fin',
        operationKey: 'PETTY_CASH_REQUEST_APPROVE',
      },
      {
        id: 'do2',
        companyId: 'c1',
        departmentId: 'd-site',
        operationKey: 'SALARY_PAYMENT_APPROVE',
      },
    ] as { id: string; companyId: string; departmentId: string; operationKey: string }[],
    empOps: [] as { id: string; companyId: string; employeeId: string; operationKey: string }[],
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
      findMany: async ({ where }: { where: { companyId: string; departmentId?: unknown } }) =>
        state.deptOps.filter(
          (d) =>
            d.companyId === where.companyId &&
            (where.departmentId === undefined ||
              (Array.isArray((where.departmentId as { in: string[] }).in)
                ? (where.departmentId as { in: string[] }).in.includes(d.departmentId)
                : d.departmentId === where.departmentId)),
        ),
      create: async ({
        data,
      }: {
        data: { companyId: string; departmentId: string; operationKey: string };
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
        const row = { id: `do-${state.deptOps.length}`, ...data };
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
        state.empOps.filter(
          (e) => e.companyId === where.companyId && e.employeeId === where.employeeId,
        ),
      create: async ({
        data,
      }: {
        data: { companyId: string; employeeId: string; operationKey: string };
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
        const row = { id: `eo-${state.empOps.length}`, ...data };
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
  it('rejects op not enabled on any ACTIVE member dept (subset rule)', async () => {
    const { prisma } = makeFakePrisma();
    // SALARY_PAYMENT_APPROVE is enabled on d-site, but e1's site membership is ENDED.
    await expect(
      svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e1', 'SALARY_PAYMENT_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });
  it('effective ops = grants ∩ enabled-on-active-depts', async () => {
    const { state, prisma } = makeFakePrisma();
    state.empOps.push(
      { id: 'g1', companyId: 'c1', employeeId: 'e1', operationKey: 'PETTY_CASH_REQUEST_APPROVE' },
      { id: 'g2', companyId: 'c1', employeeId: 'e1', operationKey: 'SALARY_PAYMENT_APPROVE' },
    );
    const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
    expect(effective).toEqual(['PETTY_CASH_REQUEST_APPROVE']);
  });
  it('enable op on dept; duplicate conflicts', async () => {
    const { prisma } = makeFakePrisma();
    await expect(
      svc(prisma).enableDeptOperation(OWNER, 'c1', 'd-fin', 'SALARY_PAYMENT_APPROVE'),
    ).resolves.toBeTruthy();
    await expect(
      svc(prisma).enableDeptOperation(OWNER, 'c1', 'd-fin', 'PETTY_CASH_REQUEST_APPROVE'),
    ).rejects.toBeInstanceOf(Error); // P2002 → 409 class
  });
  it('inactive/non-active employee cannot be assigned', async () => {
    const { prisma } = makeFakePrisma();
    await expect(
      svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e2', 'PETTY_CASH_REQUEST_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });
});
