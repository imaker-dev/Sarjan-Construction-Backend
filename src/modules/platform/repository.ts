import type { Company, Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors/app-error.js';
import type { AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';

type Tx = Prisma.TransactionClient;

export interface ActiveClaimInfo {
  id: string;
  principalId: string;
  expiresAt: Date;
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
    consume(tokenHash: string, now: Date): Promise<{ id: string; principalId: string } | null>;
    /** Invalidate all unconsumed tokens for a principal (reissue). */
    revokeActive(principalId: string, at: Date): Promise<number>;
    findActive(tokenHash: string, now: Date): Promise<ActiveClaimInfo | null>;
  };
  audit: AuditRepository;
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
        return tx.claimToken.findFirst({ where: { tokenHash } });
      },
      revokeActive: async (principalId, at) => {
        const res = await tx.claimToken.updateMany({
          where: { principalId, consumedAt: null },
          data: { consumedAt: at },
        });
        return res.count;
      },
      findActive: async (tokenHash, now) => {
        const token = await tx.claimToken.findFirst({
          where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
          include: {
            principal: {
              include: {
                employees: {
                  include: {
                    company: true,
                  },
                },
              },
            },
          },
        });
        if (!token) return null;
        const emp = token.principal.employees[0];
        return {
          id: token.id,
          principalId: token.principalId,
          expiresAt: token.expiresAt,
          adminLoginId: token.principal.loginId ?? '',
          adminDisplayName: emp?.displayName ?? '',
          companyId: emp?.company.id ?? '',
          companyCode: emp?.company.code ?? '',
          companyName: emp?.company.name ?? '',
        };
      },
    },
    audit: {
      record: async (entry: AuditRecord) => {
        await tx.auditLog.create({ data: entry as never });
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
