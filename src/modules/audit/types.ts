import type { ActorContext } from '../organization/types.js';

export interface AuditActorSummary {
  id: string;
  type: string;
  displayName: string | null;
  loginId: string | null;
  employeeCode: string | null;
}

export interface AuditLogDto {
  id: string;
  eventKey: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId: string | null;
  actorId: string;
  actorType: string;
  actor: AuditActorSummary;
  correlationId: string | null;
  occurredAt: string;
  statusBefore: string | null;
  statusAfter: string | null;
  changedFields: Record<string, { before: unknown; after: unknown }> | null;
  metadata: Record<string, unknown> | null;
}

export interface ListAuditLogsQuery {
  limit?: number | undefined;
  cursor?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  action?: string | undefined;
  actorId?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
}

export interface ListAuditLogsResponse {
  items: AuditLogDto[];
  nextCursor: string | null;
}

export interface ScopedActivityQuery {
  limit?: number | undefined;
  cursor?: string | undefined;
  entityType?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface ScopedActivityActor {
  id: string;
  type: string;
  displayName: string | null;
  employeeCode: string | null;
}

export interface ScopedActivityItem {
  id: string;
  eventKey: string;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string;
  actorType: string;
  actor: ScopedActivityActor;
  correlationId: string | null;
  occurredAt: string;
  statusBefore: string | null;
  statusAfter: string | null;
  changedFields: Record<string, { before: unknown; after: unknown }> | null;
  scope: { projectId: string | null; siteId: string | null };
}

export interface ListScopedActivityResponse {
  items: ScopedActivityItem[];
  nextCursor: string | null;
}

export interface StoreCompanyLogInput {
  companyId: string;
  actor: ActorContext;
  action: string;
  entityType: string;
  entityId: string;
  statusBefore?: string | null | undefined;
  statusAfter?: string | null | undefined;
  changedFields?: Record<string, { before: unknown; after: unknown }> | undefined;
  metadata?: Record<string, unknown> | undefined;
  correlationId?: string | null | undefined;
}
