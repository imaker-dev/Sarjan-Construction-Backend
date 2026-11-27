import type { Company, Prisma, PrismaClient } from '@prisma/client';
import type { DefaultLeaveTypeTemplate } from '../setup/leave-defaults.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';

type Tx = Prisma.TransactionClient;

export interface ActiveClaimInfo {
  id: string;
  principalId: string;
  expiresAt: Date;
  /** Bound operation — null only on legacy rows that predate purpose. */
  purpose: 'COMPANY_ONBOARD' | 'EMPLOYEE_INVITE' | null;
  /** Bound employee — non-null exactly when purpose is EMPLOYEE_INVITE. */
  employeeId: string | null;
  adminLoginId: string;
  adminDisplayName: string;
  companyId: string;
  companyCode: string;
  companyName: string;
}

export interface PlatformRepos {
  companies: {
    findById(companyId: string, id: string): Promise<Company | null>;
    findPlatform(): Promise<Company | null>;
    findByCode(code: string): Promise<Company | null>;
    list(): Promise<Company[]>;
    create(data: Record<string, unknown>): Promise<Company>;
    update(id: string, data: Record<string, unknown>): Promise<Company>;
    getDetails(id: string): Promise<Record<string, unknown> | null>;
    findOwnerPrincipalId?(companyId: string): Promise<string | null>;
  };
  headOffices: {
    create(data: Record<string, unknown>): Promise<{ id: string; code: string; name: string }>;
  };
  principals: {
    create(data: Record<string, unknown>): Promise<{ id: string }>;
    update(id: string, data: Record<string, unknown>): Promise<{ id: string }>;
    /** Atomic: activate only while status is still SUSPENDED. */
    activateIfSuspended(id: string, data: Record<string, unknown>): Promise<boolean>;
    findByLoginId(loginId: string): Promise<{ id: string } | null>;
  };
  employees: {
    create(data: Record<string, unknown>): Promise<{ id: string }>;
    updateByPrincipalId(principalId: string, data: Record<string, unknown>): Promise<number>;
    /** Bound-employee lookup for EMPLOYEE_INVITE claim validation. */
    findBound(
      companyId: string,
      employeeId: string,
    ): Promise<{
      id: string;
      status: string;
      principalId: string | null;
      displayName: string;
    } | null>;
    /** At most one employee per (principal, company) — deterministic. */
    findByPrincipalCompany(
      principalId: string,
      companyId: string,
    ): Promise<{ id: string; displayName: string } | null>;
  };
  roles: { create(data: Record<string, unknown>): Promise<{ id: string }> };
  permissions: {
    upsert(key: string): Promise<{ id: string }>;
  };
  rolePermissions: { create(roleId: string, permissionId: string): Promise<unknown> };
  roleAssignments: { create(data: Record<string, unknown>): Promise<unknown> };
  claimTokens: {
    create(data: Record<string, unknown>): Promise<{ id: string }>;
    /** Atomically consume an unexpired, unconsumed token. Returns the row once. */
    consume(
      tokenHash: string,
      now: Date,
    ): Promise<{
      id: string;
      principalId: string;
      purpose: 'COMPANY_ONBOARD' | 'EMPLOYEE_INVITE' | null;
      companyId: string | null;
      employeeId: string | null;
    } | null>;
    /** Invalidate all unconsumed tokens for a principal (reissue). */
    revokeActive(principalId: string, at: Date): Promise<number>;
    findActive(tokenHash: string, now: Date): Promise<ActiveClaimInfo | null>;
  };
  operations: {
    list(): Promise<unknown[]>;
    find(key: string): Promise<Record<string, unknown> | null>;
    create(data: {
      key: string;
      domain: string;
      name: string;
      description: string;
      sensitive?: boolean;
      appliesTo?: string[];
      leadershipInheritable?: boolean;
    }): Promise<unknown>;
    delete(key: string): Promise<number>;
    isInUse(key: string): Promise<boolean>;
  };
  audit: AuditRepository;
  leaveTypeDefs?: {
    createMany(companyId: string, items: readonly DefaultLeaveTypeTemplate[]): Promise<void>;
  };
}

export interface PlatformUnitOfWork {
  run<T>(fn: (repos: PlatformRepos) => Promise<T>): Promise<T>;
}

export function makePlatformRepos(tx: Tx): PlatformRepos {
  return {
    companies: {
      findById: (companyId, id) => tx.company.findFirst({ where: { id } }),
      findPlatform: () => tx.company.findFirst({ where: { isPlatform: true } }),
      findByCode: (code) => tx.company.findFirst({ where: { code } }),
      list: () => tx.company.findMany({ where: { isPlatform: false }, orderBy: { id: 'asc' } }),
      create: (data) => tx.company.create({ data: data as never }),
      update: (id, data) => tx.company.update({ where: { id }, data: data as never }),
      getDetails: (id) =>
        tx.company.findFirst({
          where: { id, isPlatform: false },
          include: {
            headOffices: {
              where: { status: { not: 'ARCHIVED' } },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            },
            employees: {
              include: {
                principal: {
                  select: { id: true, loginId: true, status: true },
                },
              },
              orderBy: { createdAt: 'asc' },
              take: 5,
            },
            _count: {
              select: {
                projects: true,
                employees: true,
                departments: true,
              },
            },
          },
        }),
      findOwnerPrincipalId: async (companyId: string) => {
        const ownerAssignment = await tx.roleAssignment.findFirst({
          where: { companyId, role: { key: 'COMPANY_OWNER' }, revokedAt: null },
          select: { principalId: true },
        });
        if (ownerAssignment) return ownerAssignment.principalId;
        const emp = await tx.employee.findFirst({
          where: { companyId, status: 'ACTIVE', principalId: { not: null } },
          select: { principalId: true },
        });
        return emp?.principalId ?? null;
      },
    },
    headOffices: {
      create: (data) => tx.headOffice.create({ data: data as never }),
    },
    principals: {
      create: (data) => tx.principal.create({ data: data as never }),
      update: (id, data) => tx.principal.update({ where: { id }, data }),
      activateIfSuspended: async (id, data) =>
        (await tx.principal.updateMany({ where: { id, status: 'SUSPENDED' }, data })).count === 1,
      findByLoginId: (loginId) => tx.principal.findFirst({ where: { loginId } }),
    },
    employees: {
      create: (data) => tx.employee.create({ data: data as never }),
      updateByPrincipalId: async (principalId, data) =>
        (await tx.employee.updateMany({ where: { principalId }, data: data as never })).count,
      /** Bound-employee lookup for EMPLOYEE_INVITE claim validation. FOR
       *  UPDATE serializes against a concurrent deactivation: a racing
       *  UPDATE holds the row lock, we wait, then re-read the newest
       *  committed row — so "employee still ACTIVE" is true at consume
       *  time, not just at some earlier snapshot. */
      findBound: async (companyId: string, employeeId: string) => {
        const rows = await tx.$queryRaw<
          { id: string; status: string; principalId: string | null; displayName: string }[]
        >`SELECT id, status, "principalId", "displayName" FROM "Employee"
           WHERE id = ${employeeId}::uuid AND "companyId" = ${companyId}::uuid
           FOR UPDATE`;
        return rows[0] ?? null;
      },
      /** At most one employee per (principal, company) — deterministic. */
      findByPrincipalCompany: (principalId: string, companyId: string) =>
        tx.employee.findFirst({
          where: { principalId, companyId },
          select: { id: true, displayName: true },
        }),
    },
    roles: { create: (data) => tx.role.create({ data: data as never }) },
    permissions: {
      upsert: async (key) => {
        // INSERT ON CONFLICT is atomic — no aborted-tx risk under concurrent
        // inserts of the same global Permission key (unlike findUnique+insert).
        await tx.$queryRaw`INSERT INTO "Permission" (id, key) VALUES (gen_random_uuid(), ${key}) ON CONFLICT (key) DO NOTHING`;
        return tx.permission.findUniqueOrThrow({ where: { key } });
      },
    },
    rolePermissions: {
      create: (roleId, permissionId) =>
        tx.rolePermission.create({ data: { roleId, permissionId } }),
    },
    roleAssignments: {
      create: (data) => tx.roleAssignment.create({ data: data as never }),
    },
    claimTokens: {
      create: async (data) => {
        try {
          return await tx.claimToken.create({ data: data as never });
        } catch (error) {
          // Concurrent reissue: another tx already holds the active slot —
          // deliberate 409, not an unexplained 500. Retry is safe.
          if (
            typeof error === 'object' &&
            error !== null &&
            (error as { code?: string }).code === 'P2002'
          ) {
            throw new AppError(
              409,
              'CLAIM_CODE_CONFLICT',
              'a claim code was issued concurrently; retry the request',
            );
          }
          throw error;
        }
      },
      consume: async (tokenHash, now) => {
        // Atomic single-use claim — concurrent requests race on this
        // updateMany; exactly one wins (count===1).
        const updated = await tx.claimToken.updateMany({
          where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (updated.count !== 1) return null;
        return tx.claimToken.findFirst({
          where: { tokenHash },
          select: { id: true, principalId: true, purpose: true, companyId: true, employeeId: true },
        });
      },
      revokeActive: async (principalId, at) => {
        const res = await tx.claimToken.updateMany({
          where: { principalId, consumedAt: null },
          data: { consumedAt: at },
        });
        return res.count;
      },
      findActive: async (tokenHash, now) => {
        // Company context comes from the token's explicit binding — never
        // inferred from the principal's employee list (ambiguous for
        // multi-company principals and fail-closed by design).
        const token = await tx.claimToken.findFirst({
          where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
          include: {
            principal: { select: { loginId: true } },
            company: { select: { id: true, code: true, name: true } },
            employee: { select: { displayName: true } },
          },
        });
        if (token === null) return null;
        // Fail closed on an unbound live token — no company, no claim.
        if (token.company === null) return null;
        const adminEmployee =
          token.employee ??
          (await tx.employee.findFirst({
            where: { principalId: token.principalId, companyId: token.company.id },
            select: { displayName: true },
          }));
        return {
          id: token.id,
          principalId: token.principalId,
          expiresAt: token.expiresAt,
          purpose: token.purpose,
          employeeId: token.employeeId,
          adminLoginId: token.principal.loginId ?? '',
          adminDisplayName: adminEmployee?.displayName ?? '',
          companyId: token.company.id,
          companyCode: token.company.code,
          companyName: token.company.name,
        };
      },
    },
    operations: {
      list: () =>
        tx.operationCatalogueEntry.findMany({
          orderBy: [{ domain: 'asc' }, { key: 'asc' }],
        }),
      find: (key: string) => tx.operationCatalogueEntry.findUnique({ where: { key } }),
      create: (data: {
        key: string;
        domain: string;
        name: string;
        description: string;
        sensitive?: boolean;
        appliesTo?: string[];
        leadershipInheritable?: boolean;
      }) =>
        tx.operationCatalogueEntry.create({
          data: data as Prisma.OperationCatalogueEntryCreateInput,
        }),
      delete: async (key: string) => {
        const res = await tx.operationCatalogueEntry.deleteMany({ where: { key } });
        return res.count;
      },
      isInUse: async (key: string) => {
        const [deptCount, empCount] = await Promise.all([
          tx.departmentOperation.count({ where: { operationKey: key } }),
          tx.employeeOperation.count({ where: { operationKey: key } }),
        ]);
        return deptCount > 0 || empCount > 0;
      },
    },
    audit: {
      record: async (entry: AuditRecord) => {
        await tx.auditLog.create({ data: entry as never });
      },
    },
    leaveTypeDefs: {
      createMany: async (companyId, items) => {
        await tx.leaveTypeDef.createMany({
          data: items.map((item) => ({
            companyId,
            code: item.code,
            name: item.name,
            description: item.description,
            leaveType: item.leaveType,
          })),
          skipDuplicates: true,
        });
      },
    },
  };
}

export class PrismaPlatformUnitOfWork implements PlatformUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}
  run<T>(fn: (repos: PlatformRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makePlatformRepos(tx)));
  }
}
