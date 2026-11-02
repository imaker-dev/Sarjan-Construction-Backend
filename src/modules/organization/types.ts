// Explicit caller context for organization mutations. Until the identity
// milestone exists, callers must supply this; there is no implicit actor.
export type ActorType = 'USER' | 'SYSTEM' | 'SERVICE';

export interface ActorContext {
  actorId: string;
  actorType: ActorType;
  correlationId?: string;
}

export interface CreateCompanyInput {
  code: string;
  name: string;
  legalName?: string;
}

export interface UpdateCompanyInput {
  name?: string;
  legalName?: string | null;
}

export interface CreateHeadOfficeInput {
  code: string;
  name: string;
  isPrimary?: boolean;
}

export interface UpdateHeadOfficeInput {
  name?: string;
  isPrimary?: boolean;
}

export interface CreateProjectInput {
  code: string;
  name: string;
  description?: string;
  timezone: string;
  startDate?: Date;
  endDate?: Date;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  timezone?: string;
  startDate?: Date | null;
  endDate?: Date | null;
}

export interface CreateSiteInput {
  code: string;
  name: string;
  address?: string;
  geoLatitude?: number;
  geoLongitude?: number;
  geoFenceRadiusM?: number;
  timezone?: string;
}

export interface UpdateSiteInput {
  name?: string;
  address?: string | null;
  geoLatitude?: number | null;
  geoLongitude?: number | null;
  geoFenceRadiusM?: number | null;
  timezone?: string | null;
}

export interface AuditRecord {
  eventKey: string;
  action: string;
  entityType: string; // COMPANY | HEAD_OFFICE | PROJECT | SITE | PRINCIPAL | ...
  entityId: string;
  companyId?: string | undefined;
  actorId: string;
  actorType: ActorType;
  correlationId?: string | undefined;
  statusBefore?: string | undefined;
  statusAfter?: string | undefined;
  changedFields?: Record<string, { before: unknown; after: unknown }> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type OrgEntityType = 'COMPANY' | 'HEAD_OFFICE' | 'PROJECT' | 'SITE';
