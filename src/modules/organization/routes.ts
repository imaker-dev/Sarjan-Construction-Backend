import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { OrganizationService } from './service.js';
import type { DocumentService } from '../document/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { scopedOrAnyScope } from '../../common/auth/route-guards.js';
import { AppError, UnauthorizedError } from '../../common/errors/app-error.js';
import { OrgValidationError } from './errors.js';
import type { ActorContext } from './types.js';

/** Literal union shorthand shared by the enum-bearing schemas below. */
const Lit = (values: string[]) => Type.Union(values.map((v) => Type.Literal(v)));

const ContractTypeEnum = Lit([
  'LUMPSUM',
  'ITEM_RATE',
  'EPC',
  'DESIGN_BUILD',
  'COST_PLUS',
  'LABOUR_ONLY',
  'OTHER',
]);
const SiteTypeEnum = Lit([
  'MAIN_CONSTRUCTION',
  'BATCHING_PLANT',
  'LAYDOWN_YARD',
  'LABOUR_CAMP',
  'OFFICE',
  'STORE',
  'WORKSHOP',
  'OTHER',
]);
const AreaUnitEnum = Lit(['SQM', 'SQFT', 'ACRE', 'HECTARE', 'BIGHA', 'KATHA']);
const OrgDocumentTypeEnum = Lit([
  'MASTER_PLAN',
  'LAYOUT_PLAN',
  'DRAWING',
  'BOQ',
  'CONTRACT',
  'WORK_ORDER',
  'LAND_RECORD',
  'SURVEY',
  'GEOTECH_REPORT',
  'APPROVAL_LETTER',
  'HANDOVER_RECORD',
  'SITE_PHOTO',
  'SAFETY_PLAN',
  'OTHER',
]);
const DisciplineEnum = Lit([
  'ARCHITECTURAL',
  'STRUCTURAL',
  'CIVIL',
  'MEP',
  'ELECTRICAL',
  'PLUMBING',
  'HVAC',
  'FIRE_SAFETY',
  'SURVEY',
  'GEOTECHNICAL',
  'OTHER',
]);
const LinkStatusEnum = Lit(['DRAFT', 'ISSUED', 'FOR_CONSTRUCTION', 'SUPERSEDED', 'VOID']);
const ApprovalTypeEnum = Lit([
  'RERA',
  'ENVIRONMENT_CLEARANCE',
  'FIRE_NOC',
  'LAND_CONVERSION',
  'HEIGHT_CLEARANCE',
  'HERITAGE',
  'LOCAL_BODY',
  'RAILWAY_NOC',
  'HIGHWAY_NOC',
  'FOREST_CLEARANCE',
  'OTHER',
]);
const ApprovalStatusEnum = Lit([
  'APPLIED',
  'UNDER_REVIEW',
  'GRANTED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
]);
const BudgetCategoryEnum = Lit([
  'MATERIAL',
  'LABOUR',
  'EQUIPMENT',
  'SUBCONTRACT',
  'OVERHEAD',
  'CONTINGENCY',
  'OTHER',
]);
const DecimalStr = Type.String({
  pattern: '^\\d+(\\.\\d{1,6})?$',
  description: 'Non-negative decimal string, e.g. "12500.00"',
});
const IsoCurrency = Type.String({
  pattern: '^[A-Za-z]{3}$',
  description: 'ISO 4217 currency code, e.g. "INR"',
});
const DateStr = Type.String({ format: 'date' });
const Uuid = Type.String({ format: 'uuid' });

export const AddressOpt = {
  legalName: Type.Optional(Type.String({ maxLength: 200 })),
  addressLine1: Type.Optional(Type.String({ maxLength: 120 })),
  addressLine2: Type.Optional(Type.String({ maxLength: 120 })),
  locality: Type.Optional(Type.String({ maxLength: 80 })),
  city: Type.Optional(Type.String({ maxLength: 80 })),
  district: Type.Optional(Type.String({ maxLength: 80 })),
  state: Type.Optional(Type.String({ maxLength: 80 })),
  pinCode: Type.Optional(Type.String({ maxLength: 10 })),
  country: Type.Optional(Type.String({ maxLength: 80 })),
  contactName: Type.Optional(Type.String({ maxLength: 120 })),
  contactPhone: Type.Optional(Type.String({ maxLength: 20 })),
  contactEmail: Type.Optional(Type.String({ format: 'email' })),
  geoLatitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  geoLongitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  geoFenceRadiusM: Type.Optional(Type.Integer({ minimum: 1 })),
  timezone: Type.Optional(Type.String()),
};
const CreateHeadOffice = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  isPrimary: Type.Optional(Type.Boolean()),
  ...AddressOpt,
});
const UpdateHeadOffice = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  isPrimary: Type.Optional(Type.Boolean()),
  ...Object.fromEntries(
    Object.entries(AddressOpt).map(([k, v]) => [k, Type.Optional(Type.Union([v, Type.Null()]))]),
  ),
  expectedVersion: Type.Optional(Type.Integer()),
});
const StatusBody = Type.Object({
  to: Type.Union([Type.Literal('ACTIVE'), Type.Literal('SUSPENDED'), Type.Literal('ARCHIVED')]),
  expectedVersion: Type.Optional(Type.Integer()),
});
const UpdateCompany = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  legalName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  entityType: Type.Optional(
    Type.Union(
      ['PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'LLP', 'PARTNERSHIP', 'PROPRIETORSHIP', 'OTHER'].map(
        (v) => Type.Literal(v),
      ),
    ),
  ),
  tradeName: Type.Optional(Type.String({ maxLength: 200 })),
  formedOn: Type.Optional(Type.String({ format: 'date' })),
  pan: Type.Optional(Type.String({ pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', maxLength: 10 })),
  cin: Type.Optional(Type.String({ minLength: 21, maxLength: 21 })),
  llpin: Type.Optional(Type.String({ minLength: 7, maxLength: 7 })),
  regNumber: Type.Optional(Type.String({ maxLength: 40 })),
  website: Type.Optional(Type.String({ maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  regAddressLine1: Type.Optional(Type.String({ maxLength: 200 })),
  regAddressLine2: Type.Optional(Type.String({ maxLength: 200 })),
  regLocality: Type.Optional(Type.String({ maxLength: 120 })),
  regCity: Type.Optional(Type.String({ maxLength: 80 })),
  regDistrict: Type.Optional(Type.String({ maxLength: 80 })),
  regStateUt: Type.Optional(Type.String({ maxLength: 80 })),
  regPin: Type.Optional(Type.String({ maxLength: 10 })),
  regCountry: Type.Optional(Type.String({ maxLength: 2 })),
  corrAddressLine1: Type.Optional(Type.String({ maxLength: 200 })),
  corrAddressLine2: Type.Optional(Type.String({ maxLength: 200 })),
  corrLocality: Type.Optional(Type.String({ maxLength: 120 })),
  corrCity: Type.Optional(Type.String({ maxLength: 80 })),
  corrDistrict: Type.Optional(Type.String({ maxLength: 80 })),
  corrStateUt: Type.Optional(Type.String({ maxLength: 80 })),
  corrPin: Type.Optional(Type.String({ maxLength: 10 })),
  corrCountry: Type.Optional(Type.String({ maxLength: 2 })),
  contactName: Type.Optional(Type.String({ maxLength: 120 })),
  contactDesignation: Type.Optional(Type.String({ maxLength: 120 })),
  contactEmail: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
  contactPhone: Type.Optional(Type.String({ maxLength: 20 })),
  expectedVersion: Type.Optional(Type.Integer()),
});
// Register metadata for linking an existing (AVAILABLE) Document to a project
// or site. File bytes never travel through this payload.
const DocumentLinkBody = Type.Object({
  documentId: Uuid,
  documentType: OrgDocumentTypeEnum,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  documentNumber: Type.Optional(Type.String({ maxLength: 80 })),
  discipline: Type.Optional(DisciplineEnum),
  revision: Type.Optional(Type.String({ maxLength: 20 })),
  issueDate: Type.Optional(DateStr),
  linkStatus: Type.Optional(LinkStatusEnum),
});
const UpdateDocumentLinkBody = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  documentNumber: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  discipline: Type.Optional(Type.Union([DisciplineEnum, Type.Null()])),
  revision: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
  issueDate: Type.Optional(Type.Union([DateStr, Type.Null()])),
  linkStatus: Type.Optional(LinkStatusEnum),
  metadata: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])),
  expectedVersion: Type.Optional(Type.Integer()),
});
const LandParcelBody = Type.Object({
  surveyNo: Type.Optional(Type.String({ maxLength: 80 })),
  plotNo: Type.Optional(Type.String({ maxLength: 80 })),
  area: DecimalStr,
  areaUnit: AreaUnitEnum,
  boundaryDescription: Type.Optional(Type.String({ maxLength: 500 })),
  possessionDate: Type.Optional(DateStr),
  documentId: Type.Optional(Uuid),
});
const ApprovalBody = Type.Object({
  approvalType: ApprovalTypeEnum,
  customType: Type.Optional(Type.String({ maxLength: 80 })),
  issuingAuthority: Type.Optional(Type.String({ maxLength: 200 })),
  jurisdiction: Type.Optional(Type.String({ maxLength: 120 })),
  referenceNo: Type.Optional(Type.String({ maxLength: 80 })),
  status: Type.Optional(ApprovalStatusEnum),
  appliedDate: Type.Optional(DateStr),
  grantedDate: Type.Optional(DateStr),
  validUntil: Type.Optional(DateStr),
  documentId: Type.Optional(Uuid),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
});
const UpdateApprovalBody = Type.Object({
  customType: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  issuingAuthority: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  jurisdiction: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  referenceNo: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  status: Type.Optional(ApprovalStatusEnum),
  appliedDate: Type.Optional(Type.Union([DateStr, Type.Null()])),
  grantedDate: Type.Optional(Type.Union([DateStr, Type.Null()])),
  validUntil: Type.Optional(Type.Union([DateStr, Type.Null()])),
  documentId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
  expectedVersion: Type.Optional(Type.Integer()),
});
const InitialBudgetBody = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 40 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    currency: IsoCurrency,
    notes: Type.Optional(Type.String({ maxLength: 500 })),
    lines: Type.Array(
      Type.Object({
        category: BudgetCategoryEnum,
        description: Type.String({ minLength: 1, maxLength: 200 }),
        amount: DecimalStr,
      }),
      { minItems: 1 },
    ),
  },
  {
    description:
      'Optional initial estimate — creates a DRAFT ProjectBudget + revision in the same ' +
      'transaction as the project. Requires FINANCE_BUDGET_MANAGE plus the budget ' +
      'create/revise operations; ORG_PROJECT_CREATE alone is not sufficient.',
  },
);
// Extended project profile — every field optional; applicability varies by
// project type and jurisdiction.
const ProjectProfileOpt = {
  projectSubtype: Type.Optional(Type.String({ maxLength: 80 })),
  contractType: Type.Optional(ContractTypeEnum),
  clientName: Type.Optional(Type.String({ maxLength: 200 })),
  clientContactName: Type.Optional(Type.String({ maxLength: 120 })),
  clientContactPhone: Type.Optional(Type.String({ maxLength: 20 })),
  clientContactEmail: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
  contractRef: Type.Optional(Type.String({ maxLength: 80 })),
  workOrderRef: Type.Optional(Type.String({ maxLength: 80 })),
  tenderRef: Type.Optional(Type.String({ maxLength: 80 })),
  contractValue: Type.Optional(DecimalStr),
  contractCurrency: Type.Optional(IsoCurrency),
  contractDate: Type.Optional(DateStr),
  workOrderDate: Type.Optional(DateStr),
  locationAddressLine: Type.Optional(Type.String({ maxLength: 200 })),
  locationLocality: Type.Optional(Type.String({ maxLength: 80 })),
  locationCity: Type.Optional(Type.String({ maxLength: 80 })),
  locationDistrict: Type.Optional(Type.String({ maxLength: 80 })),
  locationState: Type.Optional(Type.String({ maxLength: 80 })),
  locationPin: Type.Optional(Type.String({ maxLength: 10 })),
  locationCountry: Type.Optional(Type.String({ maxLength: 80 })),
  geoLatitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  geoLongitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  scopeSummary: Type.Optional(Type.String({ maxLength: 2000 })),
  landArea: Type.Optional(DecimalStr),
  landAreaUnit: Type.Optional(AreaUnitEnum),
  builtUpArea: Type.Optional(DecimalStr),
  numBuildings: Type.Optional(Type.Integer({ minimum: 0 })),
  numFloorsMax: Type.Optional(Type.Integer({ minimum: 0 })),
  numUnits: Type.Optional(Type.Integer({ minimum: 0 })),
  linearLengthKm: Type.Optional(DecimalStr),
  carriagewayWidthM: Type.Optional(DecimalStr),
  ntpDate: Type.Optional(DateStr),
  revisedEndDate: Type.Optional(DateStr),
  actualStartDate: Type.Optional(DateStr),
  actualEndDate: Type.Optional(DateStr),
};
const CreateProject = Type.Object({
  // headOfficeId is DERIVED server-side from the company's active primary HO —
  // never trusted from the client body.
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  timezone: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  projectType: Type.Optional(
    Type.Union([
      Type.Literal('RESIDENTIAL'),
      Type.Literal('COMMERCIAL'),
      Type.Literal('INDUSTRIAL'),
      Type.Literal('INFRASTRUCTURE'),
      Type.Literal('OTHER'),
    ]),
  ),
  startDate: Type.Optional(DateStr),
  endDate: Type.Optional(DateStr),
  ...ProjectProfileOpt,
  landParcels: Type.Optional(Type.Array(LandParcelBody, { maxItems: 50 })),
  documents: Type.Optional(Type.Array(DocumentLinkBody, { maxItems: 50 })),
  approvals: Type.Optional(Type.Array(ApprovalBody, { maxItems: 50 })),
  initialBudget: Type.Optional(InitialBudgetBody),
});
const UpdateProject = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  projectType: Type.Optional(
    Type.Union([
      Type.Literal('RESIDENTIAL'),
      Type.Literal('COMMERCIAL'),
      Type.Literal('INDUSTRIAL'),
      Type.Literal('INFRASTRUCTURE'),
      Type.Literal('OTHER'),
      Type.Null(),
    ]),
  ),
  timezone: Type.Optional(Type.String({ minLength: 1 })),
  ...Object.fromEntries(
    Object.entries(ProjectProfileOpt).map(([k, v]) => [
      k,
      Type.Optional(Type.Union([v, Type.Null()])),
    ]),
  ),
  expectedVersion: Type.Optional(Type.Integer()),
});
const ProjectStatusBody = Type.Object({
  to: Type.Union([
    Type.Literal('PLANNED'),
    Type.Literal('ACTIVE'),
    Type.Literal('ON_HOLD'),
    Type.Literal('SUSPENDED'),
    Type.Literal('ARCHIVED'),
    Type.Literal('COMPLETED'),
  ]),
  expectedVersion: Type.Optional(Type.Integer()),
});
// Extended site profile — all optional beyond identity. `accessInstructions`
// and `emergencyDetails` are accepted here but serialized only to holders of
// ORG_SITE_SENSITIVE_READ.
const SiteProfileOpt = {
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  siteType: Type.Optional(SiteTypeEnum),
  landParcelId: Type.Optional(Uuid),
  plotArea: Type.Optional(DecimalStr),
  areaUnit: Type.Optional(AreaUnitEnum),
  surveyNo: Type.Optional(Type.String({ maxLength: 80 })),
  possessionDate: Type.Optional(DateStr),
  handoverDate: Type.Optional(DateStr),
  scopeSummary: Type.Optional(Type.String({ maxLength: 2000 })),
  mobilizationDate: Type.Optional(DateStr),
  accessArrangements: Type.Optional(Type.String({ maxLength: 500 })),
  facilities: Type.Optional(Type.Record(Type.String(), Type.Any())),
  siteContactName: Type.Optional(Type.String({ maxLength: 120 })),
  siteContactPhone: Type.Optional(Type.String({ maxLength: 20 })),
  siteContactEmail: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
  accessInstructions: Type.Optional(Type.String({ maxLength: 2000 })),
  emergencyDetails: Type.Optional(Type.String({ maxLength: 2000 })),
};
const CreateSite = Type.Object({
  projectId: Uuid,
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  address: Type.Optional(Type.String()),
  addressLine1: Type.Optional(Type.String({ maxLength: 120 })),
  addressLine2: Type.Optional(Type.String({ maxLength: 120 })),
  locality: Type.Optional(Type.String({ maxLength: 80 })),
  city: Type.Optional(Type.String({ maxLength: 80 })),
  district: Type.Optional(Type.String({ maxLength: 80 })),
  state: Type.Optional(Type.String({ maxLength: 80 })),
  pinCode: Type.Optional(Type.String({ maxLength: 10 })),
  country: Type.Optional(Type.String({ maxLength: 80 })),
  geoLatitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  geoLongitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  geoFenceRadiusM: Type.Optional(Type.Integer({ minimum: 1 })),
  timezone: Type.Optional(Type.String()),
  ...SiteProfileOpt,
  documents: Type.Optional(Type.Array(DocumentLinkBody, { maxItems: 50 })),
});
const UpdateSite = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  addressLine1: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  addressLine2: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  locality: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  city: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  district: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  state: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  pinCode: Type.Optional(Type.Union([Type.String({ maxLength: 10 }), Type.Null()])),
  country: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  geoLatitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  geoLongitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  geoFenceRadiusM: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  timezone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ...Object.fromEntries(
    Object.entries(SiteProfileOpt).map(([k, v]) => [
      k,
      Type.Optional(Type.Union([v, Type.Null()])),
    ]),
  ),
  expectedVersion: Type.Optional(Type.Integer()),
});
const ListQuery = Type.Object({
  status: Type.Optional(Type.String()),
  headOfficeId: Type.Optional(Type.String({ format: 'uuid' })),
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
});

/** Company scope comes from the header + permission check, never the body. */
function companyIdOf(request: FastifyRequest): string {
  const companyId = request.headers['x-company-id'];
  if (typeof companyId !== 'string' || companyId.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return companyId;
}

const atCompany = (request: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(request);
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};
// Project/site-scoped targets: project- and site-level grants (PD/PI) cover
// their own scope; company-wide grants (owner, finance) cover via ancestors.
const atProject = (request: FastifyRequest): ScopeTarget => ({
  companyId: companyIdOf(request),
  scopeType: 'PROJECT',
  scopeId: (request.params as { id?: string }).id ?? '',
});
const atSite = (request: FastifyRequest): ScopeTarget => ({
  companyId: companyIdOf(request),
  scopeType: 'SITE',
  scopeId: (request.params as { id?: string }).id ?? '',
});
const actorOf = (request: FastifyRequest): ActorContext => ({
  actorId: (request.principal as { actorId: string }).actorId,
  actorType: 'USER',
  ...(request.principal?.correlationId !== undefined
    ? { correlationId: request.principal.correlationId }
    : {}),
});

const PROJECT_DATE_KEYS = [
  'startDate',
  'endDate',
  'contractDate',
  'workOrderDate',
  'ntpDate',
  'revisedEndDate',
  'actualStartDate',
  'actualEndDate',
] as const;
const SITE_DATE_KEYS = ['possessionDate', 'handoverDate', 'mobilizationDate'] as const;
const APPROVAL_DATE_KEYS = ['appliedDate', 'grantedDate', 'validUntil'] as const;

/** Converts date-format string fields into Date instances (null passes through). */
function mapDates<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...obj };
  for (const key of keys) {
    const v = out[key];
    if (v !== undefined && v !== null) out[key] = new Date(v as string);
  }
  return out as T;
}

/** Maps the nested arrays of a project-create body (parcels/docs/approvals). */
function mapProjectCreateDates(body: Record<string, unknown>) {
  const input = mapDates(body, PROJECT_DATE_KEYS);
  if (Array.isArray(input.landParcels)) {
    input.landParcels = input.landParcels.map((p) =>
      mapDates(p as Record<string, unknown>, ['possessionDate']),
    );
  }
  if (Array.isArray(input.documents)) {
    input.documents = input.documents.map((d) =>
      mapDates(d as Record<string, unknown>, ['issueDate']),
    );
  }
  if (Array.isArray(input.approvals)) {
    input.approvals = input.approvals.map((a) =>
      mapDates(a as Record<string, unknown>, APPROVAL_DATE_KEYS),
    );
  }
  return input;
}

export function organizationRoutes(
  service: OrganizationService,
  deps?: { documentService?: DocumentService },
) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string, scope: (r: FastifyRequest) => ScopeTarget) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, scope)],
    });
    const anyScopePerm = (key: string) => ({
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        typeof app.requireAnyScopePermission === 'function'
          ? app.requireAnyScopePermission(key, companyIdOf)
          : app.requirePermission(key, atCompany),
      ],
    });
    const param = (req: FastifyRequest, key: string): string =>
      (req.params as Record<string, string>)[key] ?? '';
    /** Multipart upload → Document row at the given scope + register link. */
    const uploadRoute =
      (owner: 'PROJECT' | 'SITE') =>
      async (req: FastifyRequest, reply: { status: (n: number) => unknown }) => {
        if (deps?.documentService === undefined) {
          throw new AppError(503, 'UPLOAD_UNAVAILABLE', 'document upload is not configured');
        }
        const ownerId = param(req, 'id');
        if (!req.isMultipart()) {
          throw new OrgValidationError(
            'content-type',
            'multipart/form-data required for file upload',
          );
        }
        const part = await req.file();
        if (!part) throw new OrgValidationError('file', 'file is required');
        const buffer = await part.toBuffer();
        const fields = part.fields as Record<string, { value?: string } | undefined>;
        const doc = await deps.documentService.upload(actorOf(req), companyIdOf(req), {
          body: buffer,
          fileName: part.filename,
          declaredContentType: part.mimetype,
          scope:
            owner === 'PROJECT'
              ? { scopeType: 'PROJECT', projectId: ownerId }
              : { scopeType: 'SITE', siteId: ownerId },
          autoApprove: true,
        });
        const link = {
          documentId: doc.id,
          documentType: fields.documentType?.value ?? 'OTHER',
          title: fields.title?.value ?? part.filename,
          ...(fields.documentNumber?.value ? { documentNumber: fields.documentNumber.value } : {}),
          ...(fields.discipline?.value ? { discipline: fields.discipline.value } : {}),
          ...(fields.revision?.value ? { revision: fields.revision.value } : {}),
          ...(fields.issueDate?.value ? { issueDate: new Date(fields.issueDate.value) } : {}),
          ...(fields.linkStatus?.value ? { linkStatus: fields.linkStatus.value } : {}),
        };
        const created =
          owner === 'PROJECT'
            ? await service.attachProjectDocument(actorOf(req), companyIdOf(req), ownerId, link)
            : await service.attachSiteDocument(actorOf(req), companyIdOf(req), ownerId, link);
        reply.status(201);
        return created;
      };

    // -------------------------------------------------------------- company
    app.get('/org/company', perm('ORG_COMPANY_READ', atCompany), async (req) =>
      service.getCompany(companyIdOf(req), companyIdOf(req)),
    );
    app.patch(
      '/org/company',
      { schema: { body: UpdateCompany }, ...perm('ORG_COMPANY_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as {
          name?: string;
          legalName?: string | null;
          expectedVersion?: number;
        };
        return service.updateCompany(actorOf(req), companyIdOf(req), patch, expectedVersion);
      },
    );

    // ---------------------------------------------------------- head offices
    app.post(
      '/org/head-offices',
      { schema: { body: CreateHeadOffice }, ...perm('ORG_HEAD_OFFICE_CREATE', atCompany) },
      async (req) => service.createHeadOffice(actorOf(req), companyIdOf(req), req.body as never),
    );
    app.get(
      '/org/head-offices',
      { schema: { querystring: ListQuery }, ...perm('ORG_HEAD_OFFICE_READ', atCompany) },
      async (req) => {
        const q = req.query as { status?: never };
        return service.listHeadOffices(companyIdOf(req), q);
      },
    );
    app.patch(
      '/org/head-offices/:id',
      { schema: { body: UpdateHeadOffice }, ...perm('ORG_HEAD_OFFICE_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as {
          name?: string;
          isPrimary?: boolean;
          expectedVersion?: number;
        };
        return service.updateHeadOffice(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          patch,
          expectedVersion,
        );
      },
    );
    app.post(
      '/org/head-offices/:id/status',
      { schema: { body: StatusBody }, ...perm('ORG_HEAD_OFFICE_STATUS', atCompany) },
      async (req) =>
        service.transitionHeadOfficeStatus(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { to: string }).to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        ),
    );

    // -------------------------------------------------------------- projects
    app.post(
      '/org/projects',
      { schema: { body: CreateProject }, ...perm('ORG_PROJECT_CREATE', atCompany) },
      async (req, reply) => {
        const created = await service.createProject(
          actorOf(req),
          companyIdOf(req),
          mapProjectCreateDates(req.body as Record<string, unknown>) as never,
        );
        reply.status(201);
        return created;
      },
    );
    app.get(
      '/org/projects',
      { schema: { querystring: ListQuery }, ...anyScopePerm('ORG_PROJECT_READ') },
      async (req) => {
        const q = req.query as { status?: never; headOfficeId?: string };
        return service.listProjects(actorOf(req), companyIdOf(req), q);
      },
    );
    app.get('/org/projects/:id', perm('ORG_PROJECT_READ', atProject), async (req) =>
      service.getProject(companyIdOf(req), param(req, 'id')),
    );
    app.patch(
      '/org/projects/:id',
      { schema: { body: UpdateProject }, ...perm('ORG_PROJECT_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as Record<string, unknown> & {
          expectedVersion?: number;
        };
        return service.updateProject(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          mapDates(patch, PROJECT_DATE_KEYS),
          expectedVersion,
        );
      },
    );
    app.post(
      '/org/projects/:id/status',
      { schema: { body: ProjectStatusBody }, ...perm('ORG_PROJECT_STATUS', atCompany) },
      async (req) => {
        const rawTo = (req.body as { to: string }).to;
        const to = rawTo === 'SUSPENDED' ? 'ON_HOLD' : rawTo;
        return service.transitionProjectStatus(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        );
      },
    );

    // ----------------------------------------------------- project parcels
    app.post(
      '/org/projects/:id/parcels',
      { schema: { body: LandParcelBody }, ...perm('ORG_PROJECT_UPDATE', atCompany) },
      async (req, reply) => {
        const created = await service.createParcel(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          mapDates(req.body as Record<string, unknown>, ['possessionDate']) as never,
        );
        reply.status(201);
        return created;
      },
    );
    app.get('/org/projects/:id/parcels', perm('ORG_PROJECT_READ', atProject), async (req) =>
      service.listParcels(companyIdOf(req), param(req, 'id')),
    );

    // ----------------------------------------------------- project documents
    app.post(
      '/org/projects/:id/documents',
      { schema: { body: DocumentLinkBody }, ...perm('DOCUMENT_LINK', atProject) },
      async (req, reply) => {
        const created = await service.attachProjectDocument(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          mapDates(req.body as Record<string, unknown>, ['issueDate']) as never,
        );
        reply.status(201);
        return created;
      },
    );
    app.post(
      '/org/projects/:id/documents/upload',
      { ...perm('DOCUMENT_UPLOAD', atProject) },
      uploadRoute('PROJECT'),
    );
    app.get('/org/projects/:id/documents', perm('DOCUMENT_READ', atProject), async (req) =>
      service.listProjectDocuments(companyIdOf(req), param(req, 'id')),
    );
    app.patch(
      '/org/projects/:id/documents/:linkId',
      { schema: { body: UpdateDocumentLinkBody }, ...perm('DOCUMENT_LINK', atProject) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as Record<string, unknown> & {
          expectedVersion?: number;
        };
        return service.updateProjectDocument(
          actorOf(req),
          companyIdOf(req),
          param(req, 'linkId'),
          mapDates(patch, ['issueDate']),
          expectedVersion,
        );
      },
    );

    // ----------------------------------------------------- project approvals
    app.post(
      '/org/projects/:id/approvals',
      { schema: { body: ApprovalBody }, ...perm('ORG_PROJECT_UPDATE', atCompany) },
      async (req, reply) => {
        const created = await service.createApproval(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          mapDates(req.body as Record<string, unknown>, APPROVAL_DATE_KEYS) as never,
        );
        reply.status(201);
        return created;
      },
    );
    app.get('/org/projects/:id/approvals', perm('ORG_PROJECT_READ', atProject), async (req) =>
      service.listApprovals(companyIdOf(req), param(req, 'id')),
    );
    app.patch(
      '/org/projects/:id/approvals/:approvalId',
      { schema: { body: UpdateApprovalBody }, ...perm('ORG_PROJECT_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as Record<string, unknown> & {
          expectedVersion?: number;
        };
        return service.updateApproval(
          actorOf(req),
          companyIdOf(req),
          param(req, 'approvalId'),
          mapDates(patch, APPROVAL_DATE_KEYS),
          expectedVersion,
        );
      },
    );

    // ----------------------------------------------------------------- sites
    // Create authorizes against the TARGET project (body.projectId): company
    // grants cover it via scope chains; delegated scoped holders additionally
    // need the company siteCreate switch — enforced in the service.
    app.post(
      '/org/sites',
      {
        schema: { body: CreateSite },
        ...perm('ORG_SITE_CREATE', (r) => ({
          companyId: companyIdOf(r),
          scopeType: 'PROJECT',
          scopeId: (r.body as { projectId?: string }).projectId ?? '',
        })),
      },
      async (req, reply) => {
        const { projectId, ...rest } = req.body as { projectId: string } & Record<string, unknown>;
        const input = mapDates(rest, SITE_DATE_KEYS);
        if (Array.isArray(input.documents)) {
          input.documents = input.documents.map((d) =>
            mapDates(d as Record<string, unknown>, ['issueDate']),
          );
        }
        const created = await service.createSite(
          actorOf(req),
          companyIdOf(req),
          projectId,
          input as never,
        );
        reply.status(201);
        return created;
      },
    );
    app.get(
      '/org/sites',
      {
        schema: { querystring: ListQuery },
        ...scopedOrAnyScope(
          app,
          'ORG_SITE_READ',
          companyIdOf,
          (r) => ({
            companyId: companyIdOf(r),
            scopeType: 'PROJECT',
            scopeId: (r.query as { projectId?: string }).projectId ?? '',
          }),
          (r) => (r.query as { projectId?: string }).projectId !== undefined,
        ),
      },
      async (req) => {
        const q = req.query as { status?: never; projectId?: string };
        return service.listSites(actorOf(req), companyIdOf(req), q);
      },
    );
    app.get('/org/sites/:id', perm('ORG_SITE_READ', atSite), async (req) =>
      service.getSite(actorOf(req), companyIdOf(req), param(req, 'id')),
    );
    // Update authorizes at the site scope — a project grant covers its own
    // sites; delegated callers additionally need company siteUpdate (service).
    app.patch(
      '/org/sites/:id',
      { schema: { body: UpdateSite }, ...perm('ORG_SITE_UPDATE', atSite) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as Record<string, unknown> & {
          expectedVersion?: number;
        };
        return service.updateSite(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          mapDates(patch, SITE_DATE_KEYS),
          expectedVersion,
        );
      },
    );
    app.post(
      '/org/sites/:id/status',
      { schema: { body: StatusBody }, ...perm('ORG_SITE_STATUS', atCompany) },
      async (req) =>
        service.transitionSiteStatus(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          (req.body as { to: string }).to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        ),
    );

    // --------------------------------------------------------- site documents
    app.post(
      '/org/sites/:id/documents',
      { schema: { body: DocumentLinkBody }, ...perm('DOCUMENT_LINK', atSite) },
      async (req, reply) => {
        const created = await service.attachSiteDocument(
          actorOf(req),
          companyIdOf(req),
          param(req, 'id'),
          mapDates(req.body as Record<string, unknown>, ['issueDate']) as never,
        );
        reply.status(201);
        return created;
      },
    );
    app.post(
      '/org/sites/:id/documents/upload',
      { ...perm('DOCUMENT_UPLOAD', atSite) },
      uploadRoute('SITE'),
    );
    app.get('/org/sites/:id/documents', perm('DOCUMENT_READ', atSite), async (req) =>
      service.listSiteDocuments(companyIdOf(req), param(req, 'id')),
    );
    app.patch(
      '/org/sites/:id/documents/:linkId',
      { schema: { body: UpdateDocumentLinkBody }, ...perm('DOCUMENT_LINK', atSite) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as Record<string, unknown> & {
          expectedVersion?: number;
        };
        return service.updateSiteDocument(
          actorOf(req),
          companyIdOf(req),
          param(req, 'linkId'),
          mapDates(patch, ['issueDate']),
          expectedVersion,
        );
      },
    );
  };
}
