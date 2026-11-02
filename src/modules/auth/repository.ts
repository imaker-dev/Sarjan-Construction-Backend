import type { AuthSession, Principal, PrismaClient, RefreshToken } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuditRepository } from '../organization/repository.js';
import type { AuditRecord } from '../organization/types.js';

type Tx = Prisma.TransactionClient;

export interface PrincipalRepository {
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
      findById: (id) => tx.principal.findUnique({ where: { id } }),
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
