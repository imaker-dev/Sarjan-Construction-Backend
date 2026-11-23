import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import type {
  AuditLogDto,
  AuditActorSummary,
  ListAuditLogsQuery,
  ListAuditLogsResponse,
  ListScopedActivityResponse,
  ScopedActivityItem,
  ScopedActivityQuery,
  StoreCompanyLogInput,
} from './types.js';
import { resolveEventScopes, type ScopeRef } from './scope-resolver.js';
import { DomainValidationError, NotFoundError } from '../../common/errors/app-error.js';

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
      changedFields: row.changedFields as Record<
        string,
        { before: unknown; after: unknown }
      > | null,
      metadata: row.metadata as Record<string, unknown> | null,
    };
  }

  /**
   * Project/site-scoped activity feed.
   *
   * Includes only events whose scope is proven from server-side entity data
   * (see scope-resolver.ts); caller-supplied metadata never establishes scope.
   * Unresolvable or security-sensitive entity types are excluded — fail closed.
   * A project feed covers the project and its child sites; a site feed is
   * restricted to that site. Keyset-paginated on (occurredAt, id), descending.
   */
  async listScopedActivity(
    actor: ActorContext,
    companyId: string,
    target: { scopeType: 'PROJECT' | 'SITE'; scopeId: string },
    query: ScopedActivityQuery,
  ): Promise<ListScopedActivityResponse> {
    await this.authorizer.assertPermission(
      actor.actorId,
      target.scopeType === 'PROJECT' ? 'ORG_PROJECT_READ' : 'ORG_SITE_READ',
      { companyId, scopeType: target.scopeType, scopeId: target.scopeId },
    );

    const exists =
      target.scopeType === 'PROJECT'
        ? await this.prisma.project.findFirst({
            where: { id: target.scopeId, companyId },
            select: { id: true },
          })
        : await this.prisma.site.findFirst({
            where: { id: target.scopeId, companyId },
            select: { id: true },
          });
    if (!exists) throw new NotFoundError(`${target.scopeType.toLowerCase()} not found`);

    const from = parseInstant(query.from, 'from');
    const to = parseInstant(query.to, 'to');
    if (from !== null && to !== null && from > to) {
      throw new DomainValidationError('INVALID_DATE_RANGE', 'from must not be after to');
    }
    const after = query.cursor !== undefined ? decodeActivityCursor(query.cursor) : null;

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const items: ScopedActivityItem[] = [];
    let scanned = 0;
    let exhausted = false;
    let lastSeen: { occurredAt: Date; id: string } | null = after;

    while (items.length < limit && !exhausted && scanned < MAX_ACTIVITY_SCAN) {
      const take = Math.min(ACTIVITY_SCAN_CHUNK, MAX_ACTIVITY_SCAN - scanned);
      const rows = await this.prisma.auditLog.findMany({
        where: {
          companyId,
          ...(query.entityType ? { entityType: query.entityType } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(from !== null || to !== null
            ? {
                occurredAt: {
                  ...(from !== null ? { gte: from } : {}),
                  ...(to !== null ? { lte: to } : {}),
                },
              }
            : {}),
          ...(lastSeen !== null
            ? {
                OR: [
                  { occurredAt: { lt: lastSeen.occurredAt } },
                  { occurredAt: lastSeen.occurredAt, id: { lt: lastSeen.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take,
      });
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      scanned += rows.length;

      const batchScopes = await resolveEventScopes(this.prisma, companyId, rows);
      let stoppedEarly = false;
      for (const row of rows) {
        lastSeen = { occurredAt: row.occurredAt, id: row.id };
        const scope = batchScopes.get(row.id);
        if (scope === undefined) continue;
        const inScope =
          target.scopeType === 'PROJECT'
            ? scope.projectId === target.scopeId
            : scope.siteId === target.scopeId;
        if (!inScope) continue;
        items.push(toActivityItem(row, scope));
        if (items.length >= limit) {
          stoppedEarly = true;
          break;
        }
      }
      // A short batch only proves exhaustion when every row was scanned.
      if (!stoppedEarly && rows.length < take) exhausted = true;
    }

    const nextCursor = !exhausted && lastSeen !== null ? encodeActivityCursor(lastSeen) : null;

    const actorMap = await this.resolveActors(companyId, [...new Set(items.map((i) => i.actorId))]);
    for (const item of items) {
      const a = actorMap.get(item.actorId);
      item.actor = {
        id: item.actorId,
        type: item.actorType,
        displayName: a?.displayName ?? (item.actorId === SYSTEM_ACTOR_ID ? 'System' : null),
        employeeCode: a?.employeeCode ?? null,
      };
    }

    return { items, nextCursor };
  }

  private async resolveActors(
    companyId: string,
    actorIds: string[],
  ): Promise<Map<string, AuditActorSummary>> {
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
        displayName:
          emp?.displayName ?? (p.id === '00000000-0000-4000-8000-000000000001' ? 'System' : null),
        loginId: p.loginId,
        employeeCode: emp?.employeeCode ?? null,
      });
    }

    return map;
  }
}

// ---------------------------------------------------------------------------
// Scoped activity feed helpers
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

// Scan bounds: each request resolves scopes for at most MAX_ACTIVITY_SCAN
// candidate rows in ACTIVITY_SCAN_CHUNK-sized batches. Sparse feeds may return
// fewer than `limit` items with a nextCursor — callers must follow it.
const ACTIVITY_SCAN_CHUNK = 200;
const MAX_ACTIVITY_SCAN = 1000;

const ACTIVITY_CURSOR_SEP = '~';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeActivityCursor(key: { occurredAt: Date; id: string }): string {
  return `${key.occurredAt.toISOString()}${ACTIVITY_CURSOR_SEP}${key.id}`;
}

function decodeActivityCursor(raw: string): { occurredAt: Date; id: string } {
  const sep = raw.lastIndexOf(ACTIVITY_CURSOR_SEP);
  const iso = sep === -1 ? raw : raw.slice(0, sep);
  const id = sep === -1 ? '' : raw.slice(sep + 1);
  const occurredAt = new Date(iso);
  if (Number.isNaN(occurredAt.getTime()) || !UUID_RE.test(id)) {
    throw new DomainValidationError('INVALID_CURSOR', 'cursor is malformed');
  }
  return { occurredAt, id };
}

function parseInstant(raw: string | undefined, field: string): Date | null {
  if (raw === undefined) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new DomainValidationError('INVALID_DATE_RANGE', `${field} is not a valid date-time`);
  }
  return d;
}

/**
 * Keys whose before/after values must never be exposed through a scoped feed —
 * credentials, secrets, financial and government-identifier fields.
 */
// Scoped-feed changedFields projection: fail CLOSED. A field's before/after
// values are returned only when its normalized name is allowlisted as a
// clearly non-sensitive structural field; every other key is shown as
// [REDACTED]. The sensitive-pattern check runs first as defence-in-depth so a
// deceptive name like 'bank_id' can never slip through the *_id suffix rule.
const SENSITIVE_FIELD_RE =
  /(password|passwd|secret|token|otp|credential|api_?key|private_?key|account|iban|ifsc|swift|aadhaar|aadhar|ssn|passport|cvv|salary|wage|payroll|ctc|bank|(^|[^a-z0-9])pan([^a-z0-9]|$))/i;

const SAFE_CHANGE_KEYS = new Set([
  'id',
  'name',
  'code',
  'display_name',
  'status',
  'category',
  'type',
  'scope_type',
  'description',
  'title',
  'label',
  'kind',
  'version',
  'priority',
  'is_primary',
  'employee_code',
  'role_key',
  'timezone',
  'state',
  'stage_key',
  'reason',
  'unit',
  'currency',
  'quantity',
  // W4 lifecycle — structured enum/date values; free text (end_note,
  // note) is deliberately absent and stays redacted.
  'end_reason',
  'suspend_until',
]);
// Structural suffixes — identifier references, timestamps, and enum markers.
const SAFE_CHANGE_SUFFIX_RE = /(_ids?|_at|_date|_on|_status|_code|_type)$/;

function isSafeChangeKey(normalized: string): boolean {
  return SAFE_CHANGE_KEYS.has(normalized) || SAFE_CHANGE_SUFFIX_RE.test(normalized);
}

function redactChangedFields(
  input: unknown,
): Record<string, { before: unknown; after: unknown }> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const reveal = !SENSITIVE_FIELD_RE.test(normalized) && isSafeChangeKey(normalized);
    if (!reveal) {
      out[key] = { before: '[REDACTED]', after: '[REDACTED]' };
      continue;
    }
    out[key] =
      value !== null && typeof value === 'object' && 'before' in value && 'after' in value
        ? value
        : { before: null, after: value };
  }
  return out;
}

function toActivityItem(
  row: {
    id: string;
    eventKey: string;
    action: string;
    entityType: string;
    entityId: string;
    actorId: string;
    actorType: string;
    correlationId: string | null;
    occurredAt: Date;
    statusBefore: string | null;
    statusAfter: string | null;
    changedFields: unknown;
  },
  scope: ScopeRef,
): ScopedActivityItem {
  return {
    id: row.id,
    eventKey: row.eventKey,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorId: row.actorId,
    actorType: row.actorType,
    actor: { id: row.actorId, type: row.actorType, displayName: null, employeeCode: null },
    correlationId: row.correlationId,
    occurredAt: row.occurredAt.toISOString(),
    statusBefore: row.statusBefore,
    statusAfter: row.statusAfter,
    // metadata is never returned: it is not server-trusted for scope and may
    // carry sensitive payloads. changedFields passes through the redaction list.
    changedFields: redactChangedFields(row.changedFields),
    scope,
  };
}
