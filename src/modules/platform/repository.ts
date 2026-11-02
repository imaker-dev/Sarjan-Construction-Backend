import type { Company, Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors/app-error.js';
import type { AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';

type Tx = Prisma.TransactionClient;

export interface PlatformRepos {
  companies: {
    findById(companyId: string, id: string): Promise<Company | null>;
    findPlatform(): Promise<Company | null>;
    findByCode(code: string): Promise<Company | null>;
    list(): Promise<Company[]>;
    create(data: Record<string, unknown>): Promise<Company>;
  };
  principals: {
    create(data: Record<string, unknown>): Promise<{ id: string }>;
    update(id: string, data: Record<string, unknown>): Promise<{ id: string }>;
    /** Atomic: activate only while status is still SUSPENDED. */
    activateIfSuspended(id: string, data: Record<string, unknown>): Promise<boolean>;
    findByLoginId(loginId: string): Promise<{ id: string } | null>;
  };
  employees: { create(data: Record<string, unknown>): Promise<{ id: string }> };
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
    },
    roles: { create: (data) => tx.role.create({ data: data as never }) },
    permissions: {
      upsert: (key) => tx.permission.upsert({ where: { key }, update: {}, create: { key } }),
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
