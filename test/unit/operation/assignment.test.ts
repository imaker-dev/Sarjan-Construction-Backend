import { describe, it, expect } from 'vitest';
import { OperationAssignmentService } from '../../../src/modules/operation/assignment.js';
import {
  HO_ADMIN_PERMISSIONS,
  TENANT_ROLE_TEMPLATES,
} from '../../../src/modules/setup/role-templates.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';

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
    principalId?: string;
    revokedAt: Date | null;
    scopeType: string;
    role: { key: { in: string[] } };
  },
) {
  return (
    a.companyId === where.companyId &&
    (where.principalId === undefined || a.principalId === where.principalId) &&
    a.revokedAt === where.revokedAt &&
    a.scopeType === where.scopeType &&
    where.role.key.in.includes(a.roleKey ?? '') &&
    (a.effectiveFrom === null || a.effectiveFrom <= new Date()) &&
    (a.effectiveTo === null || a.effectiveTo >= new Date())
  );
}

const ALL_SCOPES = ['COMPANY', 'HEAD_OFFICE', 'PROJECT', 'SITE'];

function makeFakePrisma() {
  const state = {
    depts: [
      {
        id: 'd-fin',
        companyId: 'c1',
        status: 'ACTIVE',
        scopeType: 'COMPANY',
        code: 'FIN',
        name: 'Finance',
        projectId: null as string | null,
        siteId: null as string | null,
      },
      {
        id: 'd-site',
        companyId: 'c1',
        status: 'ACTIVE',
        scopeType: 'SITE',
        code: 'SITE',
        name: 'Site Dept',
        projectId: null as string | null,
        siteId: null as string | null,
      },
    ],
    employees: [
      {
        id: 'e1',
        companyId: 'c1',
        status: 'ACTIVE',
        principalId: null as string | null,
        employeeCode: 'EMP-1',
        displayName: 'Emp One',
      },
      {
        id: 'e2',
        companyId: 'c1',
        status: 'INACTIVE',
        principalId: null as string | null,
        employeeCode: 'EMP-2',
        displayName: 'Emp Two',
      },
    ],
    projects: [] as { id: string; companyId: string }[],
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
        appliesTo: [...ALL_SCOPES],
        leadershipInheritable: true,
      },
      {
        key: 'SALARY_PAYMENT_APPROVE',
        domain: 'PAYROLL',
        name: 'Salary Payment Approve',
        description: 'Approve salary payment',
        sensitive: true,
        appliesTo: ['COMPANY', 'HEAD_OFFICE'],
        leadershipInheritable: false,
      },
    ] as {
      key: string;
      domain: string;
      name: string;
      description: string;
      sensitive: boolean;
      appliesTo: string[];
      leadershipInheritable: boolean;
    }[],
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
      findMany: async ({
        where,
      }: {
        where: {
          companyId: string;
          status?: string;
          siteId?: string;
          OR?: ({ projectId?: string; site?: { is?: { projectId?: string } } } | object)[];
        };
      }) =>
        state.depts.filter((d) => {
          if (d.companyId !== where.companyId) return false;
          if (where.status !== undefined && d.status !== where.status) return false;
          if (where.siteId !== undefined && d.siteId !== where.siteId) return false;
          if (where.OR !== undefined) {
            const anyMatch = where.OR.some((c) => {
              const cond = c as {
                projectId?: string;
                site?: { is?: { projectId?: string; companyId?: string } };
              };
              if (cond.projectId !== undefined) return d.projectId === cond.projectId;
              const siteProjectId = cond.site?.is?.projectId;
              if (siteProjectId !== undefined) {
                const site = state.sites.find((s) => s.id === d.siteId);
                return site?.projectId === siteProjectId;
              }
              return false;
            });
            if (!anyMatch) return false;
          }
          return true;
        }),
    },
    employee: {
      findFirst: async ({ where }: { where: { id: string; companyId: string } }) =>
        state.employees.find((e) => e.id === where.id && e.companyId === where.companyId) ?? null,
      findMany: async ({
        where,
      }: {
        where: {
          companyId: string;
          status?: string;
          OR?: { id?: { in: string[] }; principalId?: { in: string[] } }[];
        };
      }) =>
        state.employees.filter((e) => {
          if (e.companyId !== where.companyId) return false;
          if (where.status !== undefined && e.status !== where.status) return false;
          if (where.OR !== undefined) {
            const anyMatch = where.OR.some((c) => {
              if (c.id !== undefined) return c.id.in.includes(e.id);
              if (c.principalId !== undefined)
                return e.principalId !== null && c.principalId.in.includes(e.principalId);
              return false;
            });
            if (!anyMatch) return false;
          }
          return true;
        }),
    },
    project: {
      findFirst: async ({ where }: { where: { id: string; companyId: string } }) =>
        state.projects.find((p) => p.id === where.id && p.companyId === where.companyId) ?? null,
    },
    site: {
      findFirst: async ({ where }: { where: { id: string; companyId: string } }) =>
        state.sites.find((s) => s.id === where.id && s.companyId === where.companyId) ?? null,
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
          principalId?: string;
          projectId?: string;
          revokedAt: Date | null;
          scopeType: string;
          role: { key: { in: string[] } };
        };
      }) =>
        state.roleAssignments
          .filter(
            (a) =>
              matchActiveAssignment(a, where as Parameters<typeof matchActiveAssignment>[1]) &&
              (where.projectId === undefined || a.projectId === where.projectId),
          )
          .map((a) => ({ ...a, role: { key: a.roleKey ?? '' } })),
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
        where: {
          companyId: string;
          employeeId?: string;
          departmentId?: { in: string[] };
          endedAt?: Date | null;
        };
      }) =>
        state.memberships.filter(
          (m) =>
            m.companyId === where.companyId &&
            (where.employeeId === undefined || m.employeeId === where.employeeId) &&
            (where.departmentId === undefined || where.departmentId.in.includes(m.departmentId)) &&
            (where.endedAt === undefined || m.endedAt === where.endedAt),
        ),
    },
    operationCatalogueEntry: {
      findMany: async (
        args: {
          where?: {
            sensitive?: boolean;
            OR?: { domain?: { in: string[] }; key?: string }[];
          };
        } = {},
      ) => {
        const where = args.where;
        return state.catalogue.filter((c) => {
          if (where?.sensitive !== undefined && c.sensitive !== where.sensitive) return false;
          if (where?.OR !== undefined) {
            const anyMatch = where.OR.some((cond) => {
              if (cond.domain !== undefined) return cond.domain.in.includes(c.domain);
              if (cond.key !== undefined) return c.key === cond.key;
              return false;
            });
            if (!anyMatch) return false;
          }
          return true;
        });
      },
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
          operationKey?: string;
          status?: string;
          department?: {
            companyId?: string;
            status?: string;
            OR?: { projectId?: { in: string[] }; siteId?: { in: string[] } }[];
          };
          operation?: {
            sensitive?: boolean;
            leadershipInheritable?: boolean;
            OR?: { domain?: { in: string[] }; key?: string }[];
          };
        };
      }) =>
        state.deptOps
          .filter((d) => {
            if (d.companyId !== where.companyId) return false;
            if (where.operationKey !== undefined && d.operationKey !== where.operationKey)
              return false;
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
              if (
                where.operation.leadershipInheritable !== undefined &&
                (cat?.leadershipInheritable ?? false) !== where.operation.leadershipInheritable
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
            department: {
              scopeType: state.depts.find((x) => x.id === d.departmentId)?.scopeType ?? 'COMPANY',
            },
            operation: state.catalogue.find((c) => c.key === d.operationKey) ?? {
              key: d.operationKey,
              domain: 'OPERATIONS',
              name: d.operationKey,
              description: '',
              sensitive: false,
              appliesTo: [...ALL_SCOPES],
              leadershipInheritable: false,
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
      findMany: async ({
        where,
      }: {
        where: { companyId: string; employeeId?: string | { in: string[] } };
      }) =>
        state.empOps
          .filter(
            (e) =>
              e.companyId === where.companyId &&
              (where.employeeId === undefined ||
                (typeof where.employeeId === 'string'
                  ? e.employeeId === where.employeeId
                  : where.employeeId.in.includes(e.employeeId))),
          )
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
  it('rejects a direct grant when no ACTIVE member department enables the op', async () => {
    const { state, prisma } = makeFakePrisma();
    // SALARY_PAYMENT_APPROVE is enabled only on d-site, where e1's membership
    // has ended — no ACTIVE member department carries it.
    await expect(
      svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e1', 'SALARY_PAYMENT_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
    expect(state.empOps).toHaveLength(0);
  });
  it('rejects a direct grant when the employee has no active memberships at all', async () => {
    const { state, prisma } = makeFakePrisma();
    state.memberships.length = 0;
    await expect(
      svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e1', 'PETTY_CASH_REQUEST_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
    expect(state.empOps).toHaveLength(0);
  });
  it('rejects a direct grant when the op is disabled on every member department', async () => {
    const { state, prisma } = makeFakePrisma();
    const [dOp] = state.deptOps;
    if (dOp !== undefined) dOp.status = 'INACTIVE';
    await expect(
      svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e1', 'PETTY_CASH_REQUEST_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });
  it('rejects a direct grant when the member department itself is inactive', async () => {
    const { state, prisma } = makeFakePrisma();
    const dept = state.depts.find((d) => d.id === 'd-fin');
    if (dept !== undefined) dept.status = 'INACTIVE';
    await expect(
      svc(prisma).assignEmployeeOperation(OWNER, 'c1', 'e1', 'PETTY_CASH_REQUEST_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });
  it('rejects enabling a COMPANY-scope op on a SITE-scoped department', async () => {
    const { state, prisma } = makeFakePrisma();
    const dept = state.depts.find((d) => d.id === 'd-fin');
    if (dept !== undefined) dept.scopeType = 'SITE';
    await expect(
      svc(prisma).enableDeptOperation(OWNER, 'c1', 'd-fin', 'SALARY_PAYMENT_APPROVE'),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });
  it('a direct grant stays effective only while dept-backed', async () => {
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
    // SALARY_PAYMENT_APPROVE is enabled only on d-site (membership ended) →
    // the direct grant alone grants nothing.
    const effective = await svc(prisma).getEffectiveOperations('c1', 'e1');
    expect(effective).toEqual(['PETTY_CASH_REQUEST_APPROVE']);
  });
  it('effective access disappears when the membership ends or the dept op/dept is disabled', async () => {
    const { state, prisma } = makeFakePrisma();
    state.empOps.push({
      id: 'g1',
      companyId: 'c1',
      employeeId: 'e1',
      operationKey: 'PETTY_CASH_REQUEST_APPROVE',
      status: 'ACTIVE',
    });
    expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).toContain(
      'PETTY_CASH_REQUEST_APPROVE',
    );
    // Membership ends → access gone on the next check, direct grant or not.
    const [m] = state.memberships;
    if (m !== undefined) m.endedAt = new Date();
    expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).toEqual([]);
    // Restore membership, then disable the department operation.
    if (m !== undefined) m.endedAt = null;
    expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).toContain(
      'PETTY_CASH_REQUEST_APPROVE',
    );
    const [dOp] = state.deptOps;
    if (dOp !== undefined) dOp.status = 'INACTIVE';
    expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).toEqual([]);
    // Re-enable op, then deactivate the department itself.
    if (dOp !== undefined) dOp.status = 'ACTIVE';
    const dept = state.depts.find((d) => d.id === 'd-fin');
    if (dept !== undefined) dept.status = 'INACTIVE';
    expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).toEqual([]);
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

    // Toggling ON a direct grant without dept backing is rejected —
    // same eligibility rule as assignEmployeeOperation.
    await expect(
      svc(prisma).toggleEmployeeOperationStatus(
        OWNER,
        'c1',
        'e1',
        'SALARY_PAYMENT_APPROVE',
        'ACTIVE',
      ),
    ).rejects.toBeInstanceOf(OrgValidationError);
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
          scopeType: 'PROJECT',
          code: 'PA',
          name: 'Proj A Dept',
          projectId: 'proj-a',
          siteId: null,
        },
        {
          id: 'd-site-1',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'SITE',
          code: 'S1',
          name: 'Site 1 Dept',
          projectId: null,
          siteId: 's1',
        },
        {
          id: 'd-proj-b',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'PROJECT',
          code: 'PB',
          name: 'Proj B Dept',
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
        appliesTo: [...ALL_SCOPES],
        leadershipInheritable: true,
      });
      state.deptOps.push({
        id: 'do-wps',
        companyId: 'c1',
        departmentId: 'd-site-1',
        operationKey: 'WORK_PROGRESS_SUBMIT',
        status: 'ACTIVE',
      });
      const keys = await svc(prisma).getLeadershipScopedOperationKeys('c1', 'e1');
      // Non-sensitive, inheritable proj-a + site-1 ops;
      // SALARY_PAYMENT_APPROVE is sensitive → excluded.
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
          appliesTo: [...ALL_SCOPES],
          leadershipInheritable: true,
        },
        {
          key: 'HO_ONLY_OP',
          domain: 'OPERATIONS',
          name: 'HO Only',
          description: '',
          sensitive: false,
          appliesTo: [...ALL_SCOPES],
          leadershipInheritable: true,
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
        appliesTo: [...ALL_SCOPES],
        leadershipInheritable: true,
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

    it('covers all non-sensitive finance-domain ops with no dept enablement', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      state.catalogue.push({
        key: 'CLIENT_INVOICE_ISSUE',
        domain: 'BILLING',
        name: 'Client Invoice Issue',
        description: '',
        sensitive: false,
        appliesTo: ['COMPANY', 'HEAD_OFFICE'],
        leadershipInheritable: false,
      });
      // No DepartmentOperation rows at all — coverage is catalogue-driven.
      state.deptOps.length = 0;
      const keys = await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1');
      expect(keys).toContain('CLIENT_INVOICE_ISSUE');
      expect(keys).toContain('PETTY_CASH_REQUEST_APPROVE');
    });

    it('excludes sensitive and non-finance-domain ops', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      state.catalogue.push({
        key: 'WORK_PROGRESS_SUBMIT',
        domain: 'OPERATIONS',
        name: 'Work Progress Submit',
        description: '',
        sensitive: false,
        appliesTo: [...ALL_SCOPES],
        leadershipInheritable: false,
      });
      const keys = await svc(prisma).getFinanceScopedOperationKeys('c1', 'e1');
      expect(keys).not.toContain('WORK_PROGRESS_SUBMIT');
      expect(keys).not.toContain('SALARY_PAYMENT_APPROVE'); // sensitive PAYROLL
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
        appliesTo: [...ALL_SCOPES],
        leadershipInheritable: false,
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
        appliesTo: ['COMPANY', 'HEAD_OFFICE'],
        leadershipInheritable: false,
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

    it('admin disable/enable per employee reflects live in coverage', async () => {
      const { state, prisma } = makeFakePrisma();
      withFinanceRole(state);
      // Admin disables a covered op for this employee.
      const override = {
        id: 'eo-toggle',
        companyId: 'c1',
        employeeId: 'e1',
        operationKey: 'PETTY_CASH_REQUEST_APPROVE',
        status: 'INACTIVE',
      };
      state.empOps.push(override);
      expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).not.toContain(
        'PETTY_CASH_REQUEST_APPROVE',
      );
      const ops = await svc(prisma).listEmployeeOperations(OWNER, 'c1', 'e1');
      const row = ops.find((o) => o.operationKey === 'PETTY_CASH_REQUEST_APPROVE');
      expect(row?.status).toBe('INACTIVE');
      // Admin re-enables → restored as ACTIVE.
      override.status = 'ACTIVE';
      expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).toContain(
        'PETTY_CASH_REQUEST_APPROVE',
      );
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

  describe('leadership coverage boundaries', () => {
    function seedProjects(state: ReturnType<typeof makeFakePrisma>['state']) {
      state.projects.push(
        { id: 'proj-a', companyId: 'c1' },
        { id: 'proj-b', companyId: 'c1' },
        { id: 'proj-c', companyId: 'c1' },
      );
      state.sites.push(
        { id: 's1', companyId: 'c1', projectId: 'proj-a' },
        { id: 's2', companyId: 'c1', projectId: 'proj-b' },
      );
      state.depts.push(
        {
          id: 'd-proj-a',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'PROJECT',
          code: 'PA',
          name: 'Proj A Dept',
          projectId: 'proj-a',
          siteId: null,
        },
        {
          id: 'd-site-1',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'SITE',
          code: 'S1',
          name: 'Site 1 Dept',
          projectId: null,
          siteId: 's1',
        },
        {
          id: 'd-proj-b',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'PROJECT',
          code: 'PB',
          name: 'Proj B Dept',
          projectId: 'proj-b',
          siteId: null,
        },
        {
          id: 'd-proj-c',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'PROJECT',
          code: 'PC',
          name: 'Proj C Dept',
          projectId: 'proj-c',
          siteId: null,
        },
      );
      state.catalogue.push(
        {
          key: 'WORK_PROGRESS_SUBMIT',
          domain: 'WORK_EXECUTION',
          name: 'Work Progress Submit',
          description: '',
          sensitive: false,
          appliesTo: [...ALL_SCOPES],
          leadershipInheritable: true,
        },
        {
          key: 'DAILY_SITE_REPORT_SUBMIT',
          domain: 'PROJECT_REPORTS',
          name: 'Daily Site Report',
          description: '',
          sensitive: false,
          appliesTo: [...ALL_SCOPES],
          leadershipInheritable: true,
        },
        {
          key: 'PROJECT_BUDGET_APPROVE',
          domain: 'PROJECT_FINANCE',
          name: 'Budget Approve',
          description: '',
          sensitive: false,
          appliesTo: ['COMPANY', 'HEAD_OFFICE'],
          leadershipInheritable: false,
        },
        {
          key: 'NEW_UNREVIEWED_OP',
          domain: 'OPERATIONS',
          name: 'New Op',
          description: '',
          sensitive: false,
          appliesTo: [...ALL_SCOPES],
          leadershipInheritable: false,
        },
      );
      state.deptOps.push(
        {
          id: 'do-a1',
          companyId: 'c1',
          departmentId: 'd-proj-a',
          operationKey: 'WORK_PROGRESS_SUBMIT',
          status: 'ACTIVE',
        },
        {
          id: 'do-a2',
          companyId: 'c1',
          departmentId: 'd-proj-a',
          operationKey: 'PROJECT_BUDGET_APPROVE',
          status: 'ACTIVE',
        },
        {
          id: 'do-a3',
          companyId: 'c1',
          departmentId: 'd-proj-a',
          operationKey: 'NEW_UNREVIEWED_OP',
          status: 'ACTIVE',
        },
        {
          id: 'do-s1',
          companyId: 'c1',
          departmentId: 'd-site-1',
          operationKey: 'DAILY_SITE_REPORT_SUBMIT',
          status: 'ACTIVE',
        },
        {
          id: 'do-b1',
          companyId: 'c1',
          departmentId: 'd-proj-b',
          operationKey: 'DAILY_SITE_REPORT_SUBMIT',
          status: 'ACTIVE',
        },
        {
          id: 'do-c1',
          companyId: 'c1',
          departmentId: 'd-proj-c',
          operationKey: 'WORK_PROGRESS_SUBMIT',
          status: 'ACTIVE',
        },
      );
    }

    function assignLeadership(
      state: ReturnType<typeof makeFakePrisma>['state'],
      principalId: string,
      roleKey: string,
      projectId: string,
      roleId?: string,
    ) {
      state.roleAssignments.push({
        companyId: 'c1',
        principalId,
        roleId: roleId ?? `r-${projectId}`,
        scopeType: 'PROJECT',
        projectId,
        revokedAt: null,
        effectiveFrom: null,
        effectiveTo: null,
        roleKey,
      });
    }

    it('a PD on multiple projects gets each assigned project’s eligible ops — never a third project’s', async () => {
      const { state, prisma } = makeFakePrisma();
      seedProjects(state);
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      assignLeadership(state, 'p1', 'PROJECT_DIRECTOR', 'proj-a');
      assignLeadership(state, 'p1', 'PROJECT_DIRECTOR', 'proj-b', 'r-b');
      const keys = await svc(prisma).getLeadershipScopedOperationKeys('c1', 'e1');
      // proj-a (WORK_PROGRESS_SUBMIT + site report via s1) + proj-b (site report).
      expect(keys).toContain('WORK_PROGRESS_SUBMIT');
      expect(keys).toContain('DAILY_SITE_REPORT_SUBMIT');
      // High-impact + unreviewed ops are never inherited.
      expect(keys).not.toContain('PROJECT_BUDGET_APPROVE');
      expect(keys).not.toContain('NEW_UNREVIEWED_OP');
      expect(keys).not.toContain('SALARY_PAYMENT_APPROVE');
    });

    it('a PD on one project never inherits ops unique to a sibling project', async () => {
      const { state, prisma } = makeFakePrisma();
      seedProjects(state);
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      state.deptOps.push({
        id: 'do-c2',
        companyId: 'c1',
        departmentId: 'd-proj-c',
        operationKey: 'DAILY_SITE_REPORT_SUBMIT',
        status: 'ACTIVE',
      });
      // Remove proj-b coverage so DAILY_SITE_REPORT_SUBMIT only exists on proj-c.
      state.deptOps = state.deptOps.filter((d) => d.id !== 'do-b1' && d.id !== 'do-s1');
      assignLeadership(state, 'p1', 'PROJECT_DIRECTOR', 'proj-a');
      const keys = await svc(prisma).getLeadershipScopedOperationKeys('c1', 'e1');
      expect(keys).toContain('WORK_PROGRESS_SUBMIT');
      expect(keys).not.toContain('DAILY_SITE_REPORT_SUBMIT');
    });

    it('a PI project assignment covers child sites but not sibling projects', async () => {
      const { state, prisma } = makeFakePrisma();
      seedProjects(state);
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      state.deptOps = state.deptOps.filter((d) => d.id !== 'do-a1'); // proj-a only via site
      assignLeadership(state, 'p1', 'PROJECT_INCHARGE', 'proj-a');
      const keys = await svc(prisma).getLeadershipScopedOperationKeys('c1', 'e1');
      expect(keys).toContain('DAILY_SITE_REPORT_SUBMIT'); // site s1 under proj-a
      expect(keys).not.toContain('WORK_PROGRESS_SUBMIT'); // only proj-c enables it
    });

    it('revoking the role removes inherited ops on the next check', async () => {
      const { state, prisma } = makeFakePrisma();
      seedProjects(state);
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      assignLeadership(state, 'p1', 'PROJECT_INCHARGE', 'proj-a');
      expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).toContain(
        'WORK_PROGRESS_SUBMIT',
      );
      const [a] = state.roleAssignments;
      if (a !== undefined) a.revokedAt = new Date();
      expect(await svc(prisma).getEffectiveOperations('c1', 'e1')).not.toContain(
        'WORK_PROGRESS_SUBMIT',
      );
    });
  });

  describe('listEffectiveOperationsForScope', () => {
    function seedScope(state: ReturnType<typeof makeFakePrisma>['state']) {
      state.projects.push({ id: 'proj-a', companyId: 'c1' });
      state.sites.push({ id: 's1', companyId: 'c1', projectId: 'proj-a' });
      state.depts.push(
        {
          id: 'd-proj-a',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'PROJECT',
          code: 'PA',
          name: 'Proj A Dept',
          projectId: 'proj-a',
          siteId: null,
        },
        {
          id: 'd-site-1',
          companyId: 'c1',
          status: 'ACTIVE',
          scopeType: 'SITE',
          code: 'S1',
          name: 'Site 1 Dept',
          projectId: null,
          siteId: 's1',
        },
      );
      state.catalogue.push(
        {
          key: 'WORK_PROGRESS_SUBMIT',
          domain: 'WORK_EXECUTION',
          name: 'Work Progress Submit',
          description: '',
          sensitive: false,
          appliesTo: [...ALL_SCOPES],
          leadershipInheritable: true,
        },
        {
          key: 'DAILY_SITE_REPORT_SUBMIT',
          domain: 'PROJECT_REPORTS',
          name: 'Daily Site Report',
          description: '',
          sensitive: false,
          appliesTo: [...ALL_SCOPES],
          leadershipInheritable: true,
        },
      );
      state.deptOps.push(
        {
          id: 'do-a1',
          companyId: 'c1',
          departmentId: 'd-proj-a',
          operationKey: 'WORK_PROGRESS_SUBMIT',
          status: 'ACTIVE',
        },
        {
          id: 'do-s1',
          companyId: 'c1',
          departmentId: 'd-site-1',
          operationKey: 'DAILY_SITE_REPORT_SUBMIT',
          status: 'ACTIVE',
        },
      );
      // e1 is a member of the project dept; give them a PD role on proj-a.
      const [e1] = state.employees;
      if (e1 !== undefined) e1.principalId = 'p1';
      state.memberships.push({
        companyId: 'c1',
        employeeId: 'e1',
        departmentId: 'd-proj-a',
        endedAt: null,
      });
      state.roleAssignments.push({
        companyId: 'c1',
        principalId: 'p1',
        roleId: 'r-pd-a',
        scopeType: 'PROJECT',
        projectId: 'proj-a',
        revokedAt: null,
        effectiveFrom: null,
        effectiveTo: null,
        roleKey: 'PROJECT_DIRECTOR',
      });
      // A second employee, member of the site dept only.
      state.employees.push({
        id: 'e3',
        companyId: 'c1',
        status: 'ACTIVE',
        principalId: 'p3',
        employeeCode: 'EMP-3',
        displayName: 'Emp Three',
      });
      state.memberships.push({
        companyId: 'c1',
        employeeId: 'e3',
        departmentId: 'd-site-1',
        endedAt: null,
      });
    }

    it('reports dept-inherited, direct, and leadership ops with attribution', async () => {
      const { state, prisma } = makeFakePrisma();
      seedScope(state);
      const res = await svc(prisma).listEffectiveOperationsForScope(
        OWNER,
        'c1',
        { scopeType: 'PROJECT', scopeId: 'proj-a' },
        {},
      );
      const byEmpKey = new Map(res.items.map((i) => [`${i.employeeId}|${i.operationKey}`, i]));

      // e1: dept member → DEPARTMENT source for dept-enabled op; ROLE for site op.
      const deptRow = byEmpKey.get('e1|WORK_PROGRESS_SUBMIT');
      expect(deptRow).toMatchObject({
        source: 'DEPARTMENT',
        inherited: true,
        employeeCode: 'EMP-1',
        department: { id: 'd-proj-a', scopeType: 'PROJECT' },
      });
      const roleRow = byEmpKey.get('e1|DAILY_SITE_REPORT_SUBMIT');
      expect(roleRow).toMatchObject({
        source: 'ROLE',
        inherited: true,
        roleAssignment: { roleKey: 'PROJECT_DIRECTOR', scopeType: 'PROJECT' },
      });
      // e3: site-dept member → DEPARTMENT source for the site op only.
      const siteRow = byEmpKey.get('e3|DAILY_SITE_REPORT_SUBMIT');
      expect(siteRow).toMatchObject({ source: 'DEPARTMENT', department: { id: 'd-site-1' } });
      expect(byEmpKey.has('e3|WORK_PROGRESS_SUBMIT')).toBe(false);

      // An explicit ACTIVE EmployeeOperation is attributed DIRECT.
      state.empOps.push({
        id: 'eo-1',
        companyId: 'c1',
        employeeId: 'e3',
        operationKey: 'DAILY_SITE_REPORT_SUBMIT',
        status: 'ACTIVE',
      });
      const res2 = await svc(prisma).listEffectiveOperationsForScope(
        OWNER,
        'c1',
        { scopeType: 'PROJECT', scopeId: 'proj-a' },
        {},
      );
      const direct = res2.items.find(
        (i) => i.employeeId === 'e3' && i.operationKey === 'DAILY_SITE_REPORT_SUBMIT',
      );
      expect(direct).toMatchObject({ source: 'DIRECT', inherited: false });
    });

    it('site scope lists site depts plus leadership coverage from the parent project', async () => {
      const { state, prisma } = makeFakePrisma();
      seedScope(state);
      const res = await svc(prisma).listEffectiveOperationsForScope(
        OWNER,
        'c1',
        { scopeType: 'SITE', scopeId: 's1' },
        {},
      );
      const keys = new Set(res.items.map((i) => `${i.employeeId}|${i.operationKey}`));
      expect(keys.has('e3|DAILY_SITE_REPORT_SUBMIT')).toBe(true);
      // PD coverage: DAILY_SITE_REPORT_SUBMIT is inheritable + enabled on the site dept.
      expect(keys.has('e1|DAILY_SITE_REPORT_SUBMIT')).toBe(true);
      // Project-dept-only ops are not in a site listing (site = site-scoped depts).
      expect(keys.has('e3|WORK_PROGRESS_SUBMIT')).toBe(false);
    });

    it('fails closed for cross-company scope references', async () => {
      const { state, prisma } = makeFakePrisma();
      seedScope(state);
      await expect(
        svc(prisma).listEffectiveOperationsForScope(
          OWNER,
          'other-company',
          { scopeType: 'PROJECT', scopeId: 'proj-a' },
          {},
        ),
      ).rejects.toBeInstanceOf(OrgEntityNotFoundError);
      await expect(
        svc(prisma).listEffectiveOperationsForScope(
          OWNER,
          'c1',
          { scopeType: 'SITE', scopeId: 's-other' },
          {},
        ),
      ).rejects.toBeInstanceOf(OrgEntityNotFoundError);
    });

    it('paginates with a keyset cursor over (employeeId, operationKey)', async () => {
      const { state, prisma } = makeFakePrisma();
      seedScope(state);
      const first = await svc(prisma).listEffectiveOperationsForScope(
        OWNER,
        'c1',
        { scopeType: 'PROJECT', scopeId: 'proj-a' },
        { limit: 1 },
      );
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await svc(prisma).listEffectiveOperationsForScope(
        OWNER,
        'c1',
        { scopeType: 'PROJECT', scopeId: 'proj-a' },
        { cursor: first.nextCursor ?? undefined, limit: 200 },
      );
      const firstKey = `${first.items[0]?.employeeId}|${first.items[0]?.operationKey}`;
      const secondKeys = second.items.map((i) => `${i.employeeId}|${i.operationKey}`);
      expect(secondKeys).not.toContain(firstKey);
      // Every returned key sorts after the cursor.
      const cursor = first.nextCursor;
      expect(cursor).not.toBeNull();
      for (const k of secondKeys) {
        expect(k > (cursor ?? '')).toBe(true);
      }
    });
  });
});

describe('role-template operation grants', () => {
  it('non-COMPANY scope templates carry no company-scope-only operation permissions', () => {
    // OPERATION_CONFIGURE / OPERATION_EMPLOYEE_ASSIGN routes authorize at
    // COMPANY scope — grants on narrower-scope templates can never work and
    // must not exist. OPERATION_READ stays: it is also enforced at the
    // department's own scope for operation-definition reads.
    for (const t of TENANT_ROLE_TEMPLATES) {
      if (t.scopeShape === 'COMPANY') continue;
      expect(t.permissions, t.key).not.toContain('OPERATION_CONFIGURE');
      expect(t.permissions, t.key).not.toContain('OPERATION_EMPLOYEE_ASSIGN');
    }
    expect(HO_ADMIN_PERMISSIONS).not.toContain('OPERATION_CONFIGURE');
    expect(HO_ADMIN_PERMISSIONS).not.toContain('OPERATION_EMPLOYEE_ASSIGN');
  });
  it('company-scoped templates keep operation assignment authority', () => {
    const deptHead = TENANT_ROLE_TEMPLATES.find((t) => t.key === 'DEPT_HEAD');
    expect(deptHead?.scopeShape).toBe('COMPANY');
    expect(deptHead?.permissions).toContain('OPERATION_EMPLOYEE_ASSIGN');
  });
});
