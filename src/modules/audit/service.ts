import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import type {
  AuditLogDto,
  AuditActorSummary,
  ListAuditLogsQuery,
  ListAuditLogsResponse,
  StoreCompanyLogInput,
} from './types.js';
import { NotFoundError } from '../../common/errors/app-error.js';

export const AUDIT_LOG_VIEW = 'AUDIT_LOG_VIEW';

interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
}

/**
 * Universal helper to record an audit log entry for a company.
 * Accepts either the root PrismaClient or a Prisma transaction client.
 */
export async function recordCompanyAuditLog(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: StoreCompanyLogInput,
): Promise<string> {
  const eventKey = randomUUID();
  const row = await prisma.auditLog.create({
    data: {
      eventKey,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      companyId: input.companyId,
      actorId: input.actor.actorId,
      actorType: input.actor.actorType,
      correlationId: input.correlationId ?? input.actor.correlationId ?? null,
      statusBefore: input.statusBefore ?? null,
      statusAfter: input.statusAfter ?? null,
      ...(input.changedFields !== undefined
        ? { changedFields: input.changedFields as Prisma.InputJsonValue }
        : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Prisma.InputJsonValue }
        : {}),
    },
  });
  return row.id;
}

export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authorizer: Authorizer,
  ) {}

  /**
   * Helper function to store an audit log for a company.
   */
  async recordCompanyLog(input: StoreCompanyLogInput): Promise<string> {
    return recordCompanyAuditLog(this.prisma, input);
  }

  /**
   * Fetch company-scoped audit logs with filtering and actor resolution.
   */
  async listCompanyLogs(
    actor: ActorContext,
    companyId: string,
    query: ListAuditLogsQuery,
  ): Promise<ListAuditLogsResponse> {
    await this.authorizer.assertPermission(actor.actorId, AUDIT_LOG_VIEW, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

    const where: Prisma.AuditLogWhereInput = {
      companyId,
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.fromDate || query.toDate
        ? {
            occurredAt: {
              ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
              ...(query.toDate ? { lte: new Date(query.toDate) } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: limit + 1,
      ...(query.cursor
        ? {
            cursor: { id: query.cursor },
            skip: 1,
          }
        : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0 ? (items[items.length - 1]?.id ?? null) : null;

    // Resolve actor display details
    const actorIds = [...new Set(items.map((r) => r.actorId))];
    const actorMap = await this.resolveActors(companyId, actorIds);

    const dtos: AuditLogDto[] = items.map((r) => ({
      id: r.id,
      eventKey: r.eventKey,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      companyId: r.companyId,
      actorId: r.actorId,
      actorType: r.actorType,
      actor: actorMap.get(r.actorId) ?? {
        id: r.actorId,
        type: r.actorType,
        displayName: r.actorId === '00000000-0000-4000-8000-000000000001' ? 'System' : null,
        loginId: null,
        employeeCode: null,
      },
      correlationId: r.correlationId,
      occurredAt: r.occurredAt.toISOString(),
      statusBefore: r.statusBefore,
      statusAfter: r.statusAfter,
      changedFields: r.changedFields as Record<string, { before: unknown; after: unknown }> | null,
      metadata: r.metadata as Record<string, unknown> | null,
    }));

    return {
      items: dtos,
      nextCursor,
    };
  }

  async getCompanyLogById(
    actor: ActorContext,
    companyId: string,
    id: string,
  ): Promise<AuditLogDto> {
    await this.authorizer.assertPermission(actor.actorId, AUDIT_LOG_VIEW, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });

    const row = await this.prisma.auditLog.findFirst({
      where: { id, companyId },
    });
    if (!row) {
      throw new NotFoundError('Audit log record not found');
    }

    const actorMap = await this.resolveActors(companyId, [row.actorId]);

    return {
      id: row.id,
      eventKey: row.eventKey,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      companyId: row.companyId,
      actorId: row.actorId,
      actorType: row.actorType,
      actor: actorMap.get(row.actorId) ?? {
        id: row.actorId,
        type: row.actorType,
        displayName: row.actorId === '00000000-0000-4000-8000-000000000001' ? 'System' : null,
        loginId: null,
        employeeCode: null,
      },
      correlationId: row.correlationId,
      occurredAt: row.occurredAt.toISOString(),
      statusBefore: row.statusBefore,
      statusAfter: row.statusAfter,
      changedFields: row.changedFields as Record<string, { before: unknown; after: unknown }> | null,
      metadata: row.metadata as Record<string, unknown> | null,
    };
  }

  private async resolveActors(companyId: string, actorIds: string[]): Promise<Map<string, AuditActorSummary>> {
    const map = new Map<string, AuditActorSummary>();
    if (actorIds.length === 0) return map;

    const principals = await this.prisma.principal.findMany({
      where: { id: { in: actorIds } },
      select: {
        id: true,
        type: true,
        loginId: true,
        employees: {
          where: { companyId },
          select: { displayName: true, employeeCode: true },
          take: 1,
        },
      },
    });

    for (const p of principals) {
      const emp = p.employees[0];
      map.set(p.id, {
        id: p.id,
        type: p.type,
        displayName: emp?.displayName ?? (p.id === '00000000-0000-4000-8000-000000000001' ? 'System' : null),
        loginId: p.loginId,
        employeeCode: emp?.employeeCode ?? null,
      });
    }

    return map;
  }
}
