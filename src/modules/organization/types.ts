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
  geoLatitude?: number;
  geoLongitude?: number;
  geoFenceRadiusM?: number;
  timezone?: string;
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
  geoLatitude?: number | null;
  geoLongitude?: number | null;
  geoFenceRadiusM?: number | null;
  timezone?: string | null;
  isPrimary?: boolean;
}

// ---- Nested inputs for the Project/Site profile milestone -----------------

// One line of the initial draft budget estimate. `amount` is a decimal string;
// the total is summed server-side — a client-supplied total is never accepted.
export interface InitialBudgetLineInput {
  category: string; // BudgetCategory
  description: string;
  amount: string;
}

// Optional nested estimate on project creation. Creates a DRAFT
// ProjectBudget + BudgetRevision + lines inside the same transaction as the
// Project row. Requires FINANCE_BUDGET_MANAGE + budget ops — never implied by
// ORG_PROJECT_CREATE.
export interface InitialBudgetInput {
  code: string;
  name: string;
  description?: string;
  currency: string;
  notes?: string;
  lines: InitialBudgetLineInput[];
}

export interface LandParcelInput {
  surveyNo?: string;
  plotNo?: string;
  area: string; // decimal string
  areaUnit: string; // AreaUnit
  boundaryDescription?: string;
  possessionDate?: Date;
  documentId?: string;
}

// Register metadata linking an existing (AVAILABLE) Document to a project or
// site. Never carries storage keys or file bytes.
export interface OrgDocumentLinkInput {
  documentId: string;
  documentType: string; // OrgDocumentType
  title: string;
  documentNumber?: string;
  discipline?: string; // DrawingDiscipline
  revision?: string;
  issueDate?: Date;
  linkStatus?: string; // OrgDocumentLinkStatus
}

// External authority approval/registration record — distinct from internal
// workflow ApprovalTask rows.
export interface ProjectApprovalInput {
  approvalType: string; // ProjectApprovalType
  customType?: string; // required when approvalType = OTHER
  issuingAuthority?: string;
  jurisdiction?: string;
  referenceNo?: string;
  status?: string; // ProjectApprovalStatus
  appliedDate?: Date;
  grantedDate?: Date;
  validUntil?: Date;
  documentId?: string;
  notes?: string;
}

// Metadata-only patch for a project/site document link. `null` clears the
// field; the linked Document identity is immutable.
export interface UpdateOrgDocumentLinkInput {
  title?: string;
  documentNumber?: string | null;
  discipline?: string | null;
  revision?: string | null;
  issueDate?: Date | null;
  linkStatus?: string;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateProjectApprovalInput {
  customType?: string | null;
  issuingAuthority?: string | null;
  jurisdiction?: string | null;
  referenceNo?: string | null;
  status?: string; // ProjectApprovalStatus
  appliedDate?: Date | null;
  grantedDate?: Date | null;
  validUntil?: Date | null;
  documentId?: string | null;
  notes?: string | null;
}

export interface CreateProjectInput {
  code: string;
  name: string;
  description?: string;
  projectType?: string;
  projectSubtype?: string;
  contractType?: string;
  clientName?: string;
  clientContactName?: string;
  clientContactPhone?: string;
  clientContactEmail?: string;
  contractRef?: string;
  workOrderRef?: string;
  tenderRef?: string;
  contractValue?: string; // decimal string
  contractCurrency?: string;
  contractDate?: Date;
  workOrderDate?: Date;
  locationAddressLine?: string;
  locationLocality?: string;
  locationCity?: string;
  locationDistrict?: string;
  locationState?: string;
  locationPin?: string;
  locationCountry?: string;
  geoLatitude?: number;
  geoLongitude?: number;
  scopeSummary?: string;
  landArea?: string; // decimal string
  landAreaUnit?: string; // AreaUnit
  builtUpArea?: string; // decimal string
  numBuildings?: number;
  numFloorsMax?: number;
  numUnits?: number;
  linearLengthKm?: string; // decimal string
  carriagewayWidthM?: string; // decimal string
  timezone: string;
  startDate?: Date;
  endDate?: Date;
  ntpDate?: Date;
  revisedEndDate?: Date;
  actualStartDate?: Date;
  actualEndDate?: Date;
  landParcels?: LandParcelInput[];
  documents?: OrgDocumentLinkInput[];
  approvals?: ProjectApprovalInput[];
  initialBudget?: InitialBudgetInput;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  projectType?: string | null;
  projectSubtype?: string | null;
  contractType?: string | null;
  clientName?: string | null;
  clientContactName?: string | null;
  clientContactPhone?: string | null;
  clientContactEmail?: string | null;
  contractRef?: string | null;
  workOrderRef?: string | null;
  tenderRef?: string | null;
  contractValue?: string | null;
  contractCurrency?: string | null;
  contractDate?: Date | null;
  workOrderDate?: Date | null;
  locationAddressLine?: string | null;
  locationLocality?: string | null;
  locationCity?: string | null;
  locationDistrict?: string | null;
  locationState?: string | null;
  locationPin?: string | null;
  locationCountry?: string | null;
  geoLatitude?: number | null;
  geoLongitude?: number | null;
  scopeSummary?: string | null;
  landArea?: string | null;
  landAreaUnit?: string | null;
  builtUpArea?: string | null;
  numBuildings?: number | null;
  numFloorsMax?: number | null;
  numUnits?: number | null;
  linearLengthKm?: string | null;
  carriagewayWidthM?: string | null;
  timezone?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  ntpDate?: Date | null;
  revisedEndDate?: Date | null;
  actualStartDate?: Date | null;
  actualEndDate?: Date | null;
}

export interface CreateSiteInput {
  // Present in the HTTP body but routed to the dedicated `projectId` service
  // parameter — kept optional here so service callers use the explicit arg.
  projectId?: string;
  code: string;
  name: string;
  description?: string;
  siteType?: string;
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
  landParcelId?: string;
  plotArea?: string; // decimal string
  areaUnit?: string; // AreaUnit
  surveyNo?: string;
  possessionDate?: Date;
  handoverDate?: Date;
  scopeSummary?: string;
  mobilizationDate?: Date;
  accessArrangements?: string;
  facilities?: Record<string, unknown>;
  siteContactName?: string;
  siteContactPhone?: string;
  siteContactEmail?: string;
  accessInstructions?: string;
  emergencyDetails?: string;
  timezone?: string;
  documents?: OrgDocumentLinkInput[];
}

export interface UpdateSiteInput {
  name?: string;
  description?: string | null;
  siteType?: string | null;
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
  landParcelId?: string | null;
  plotArea?: string | null;
  areaUnit?: string | null;
  surveyNo?: string | null;
  possessionDate?: Date | null;
  handoverDate?: Date | null;
  scopeSummary?: string | null;
  mobilizationDate?: Date | null;
  accessArrangements?: string | null;
  facilities?: Record<string, unknown> | null;
  siteContactName?: string | null;
  siteContactPhone?: string | null;
  siteContactEmail?: string | null;
  accessInstructions?: string | null;
  emergencyDetails?: string | null;
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
