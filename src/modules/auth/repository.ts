import type { AuthSession, Principal, PrismaClient, RefreshToken } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';

type Tx = Prisma.TransactionClient;

export interface PrincipalDetails extends Principal {
  employees?: {
    id: string;
    displayName: string;
    employeeCode: string;
    companyId: string;
    company: {
      id: string;
      code: string;
      name: string;
      isPlatform: boolean;
    };
  }[];
  roleAssignments?: {
    id: string;
    roleId: string;
    role: {
      key: string;
      name: string;
    };
    companyId: string;
    company: {
      id: string;
      code: string;
      name: string;
    };
    scopeType: string;
    headOfficeId: string | null;
    projectId: string | null;
    siteId: string | null;
  }[];
}

export interface FullPrincipalDetails extends Principal {
  employees: {
    id: string;
    companyId: string;
    employeeCode: string;
    displayName: string;
    designation: string | null;
    tradeCategory: string | null;
    joiningDate: Date | null;
    contactPhone: string | null;
    contactEmail: string | null;
    status: string;
    company: {
      id: string;
      code: string;
      name: string;
      isPlatform: boolean;
    };
    memberships: {
      id: string;
      departmentId: string;
      isPrimary: boolean;
      department: {
        id: string;
        code: string;
        name: string;
        category?: string | null;
      };
    }[];
  }[];
  roleAssignments: {
    id: string;
    roleId: string;
    companyId: string;
    scopeType: string;
    headOfficeId: string | null;
    projectId: string | null;
    siteId: string | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    role: {
      id: string;
      key: string;
      name: string;
      permissions: {
        permission: {
          id: string;
          key: string;
        };
      }[];
    };
    headOffice?: { id: string; code: string; name: string } | null;
    project?: { id: string; code: string; name: string } | null;
    site?: { id: string; code: string; name: string } | null;
  }[];
}

export interface PrincipalRepository {
  findWithDetailsByLoginId?(loginId: string): Promise<PrincipalDetails | null>;
  findFullProfile?(
    principalId: string,
    companyId?: string,
    now?: Date,
  ): Promise<FullPrincipalDetails | null>;
  findByLoginId(loginId: string): Promise<Principal | null>;
  findById(id: string): Promise<Principal | null>;
}

export interface SessionRepository {
  create(data: {
    principalId: string;
    familyId: string;
    expiresAt: Date;
    ip?: string;
    userAgent?: string;
  }): Promise<AuthSession>;
  findById(id: string): Promise<AuthSession | null>;
  revoke(id: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
}

export interface RefreshTokenRepository {
  create(data: {
    sessionId: string;
    tokenHash: string;
    expiresAt: Date;
    replacedById?: string;
  }): Promise<RefreshToken>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  /** Atomically consume an unconsumed token; returns update count. */
  consume(id: string, replacedById?: string): Promise<number>;
  revokeBySession(sessionId: string): Promise<void>;
}

export interface AuthRepos {
  principals: PrincipalRepository;
  sessions: SessionRepository;
  refreshTokens: RefreshTokenRepository;
  audit: AuditRepository;
}

export interface AuthUnitOfWork {
  run<T>(fn: (repos: AuthRepos) => Promise<T>): Promise<T>;
}

export function makeAuthRepos(tx: Tx): AuthRepos {
  return {
    principals: {
      findByLoginId: (loginId) => tx.principal.findUnique({ where: { loginId } }),
      findWithDetailsByLoginId: (loginId) =>
        tx.principal.findUnique({
          where: { loginId },
          include: {
            employees: {
              include: {
                company: true,
              },
            },
            roleAssignments: {
              where: {
                revokedAt: null,
              },
              include: {
                role: true,
                company: true,
              },
            },
          },
        }),
      findById: (id) => tx.principal.findUnique({ where: { id } }),
      findFullProfile: (principalId, companyId, now = new Date()) =>
        tx.principal.findUnique({
          where: { id: principalId },
          include: {
            employees: {
              ...(companyId ? { where: { companyId } } : {}),
              include: {
                company: true,
                memberships: {
                  where: { endedAt: null },
                  include: {
                    department: true,
                  },
                },
              },
            },
            roleAssignments: {
              where: {
                revokedAt: null,
                ...(companyId ? { companyId } : {}),
                OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
                AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
              },
              include: {
                role: {
                  include: {
                    permissions: {
                      include: {
                        permission: true,
                      },
                    },
                  },
                },
                headOffice: { select: { id: true, code: true, name: true } },
                project: { select: { id: true, code: true, name: true } },
                site: { select: { id: true, code: true, name: true } },
              },
            },
          },
        }),
    },
    sessions: {
      create: (data) => tx.authSession.create({ data }),
      findById: (id) => tx.authSession.findUnique({ where: { id } }),
      revoke: async (id) => {
        await tx.authSession.updateMany({
          where: { id, status: 'ACTIVE' },
          data: { status: 'REVOKED' },
        });
      },
      revokeFamily: async (familyId) => {
        await tx.authSession.updateMany({
          where: { familyId, status: 'ACTIVE' },
          data: { status: 'REVOKED' },
        });
      },
    },
    refreshTokens: {
      create: (data) => tx.refreshToken.create({ data }),
      findByHash: (tokenHash) => tx.refreshToken.findUnique({ where: { tokenHash } }),
      consume: async (id, replacedById) =>
        (
          await tx.refreshToken.updateMany({
            where: { id, consumedAt: null, revokedAt: null },
            data: {
              consumedAt: new Date(),
              ...(replacedById !== undefined ? { replacedById } : {}),
            },
          })
        ).count,
      revokeBySession: async (sessionId) => {
        await tx.refreshToken.updateMany({
          where: { sessionId, consumedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      },
    },
    audit: {
      record: async (entry: AuditRecord) => {
        await tx.auditLog.create({
          data: {
            eventKey: entry.eventKey,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            actorId: entry.actorId,
            actorType: entry.actorType,
            companyId: entry.companyId ?? null,
            correlationId: entry.correlationId ?? null,
            statusBefore: entry.statusBefore ?? null,
            statusAfter: entry.statusAfter ?? null,
            ...(entry.changedFields !== undefined
              ? { changedFields: entry.changedFields as Prisma.InputJsonValue }
              : {}),
            ...(entry.metadata !== undefined
              ? { metadata: entry.metadata as Prisma.InputJsonValue }
              : {}),
          },
        });
      },
    },
  };
}

export class PrismaAuthUnitOfWork implements AuthUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: AuthRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeAuthRepos(tx)));
  }
}
