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
  legalName?: string;
  addressLine1?: string;
  addressLine2?: string;
  locality?: string;
  city?: string;
  district?: string;
  state?: string;
  pinCode?: string;
  country?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export interface UpdateHeadOfficeInput {
  name?: string;
  legalName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  locality?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  pinCode?: string | null;
  country?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  isPrimary?: boolean;
}

export interface CreateProjectInput {
  code: string;
  name: string;
  description?: string;
  projectType?: string;
  clientName?: string;
  contractRef?: string;
  locationCity?: string;
  locationDistrict?: string;
  locationState?: string;
  locationPin?: string;
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
  addressLine1?: string;
  addressLine2?: string;
  locality?: string;
  city?: string;
  district?: string;
  state?: string;
  pinCode?: string;
  country?: string;
  geoLatitude?: number;
  geoLongitude?: number;
  geoFenceRadiusM?: number;
  timezone?: string;
}

export interface UpdateSiteInput {
  name?: string;
  address?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  locality?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  pinCode?: string | null;
  country?: string | null;
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
