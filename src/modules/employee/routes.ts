import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { EmployeeDocumentType, DocumentVerificationStatus, Prisma } from '@prisma/client';
import type { EmployeeService } from './service.js';
import type { EmployeeAccessService } from './access.js';
import type {
  EmployeeDocumentService,
  UpdateEmployeeDocumentInput,
  VerifyEmployeeDocumentInput,
} from './document-service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError, DomainValidationError } from '../../common/errors/app-error.js';
import { OrgValidationError, OrgEntityNotFoundError } from '../organization/errors.js';
import type { ActorContext } from '../organization/types.js';
import { TENANT_ROLE_TEMPLATES } from '../setup/role-templates.js';

const EngagementType = Type.Union([
  Type.Literal('DIRECT_EMPLOYEE'),
  Type.Literal('CONTRACTOR_WORKER'),
  Type.Literal('DAILY_WAGE'),
  Type.Literal('APPRENTICE'),
  Type.Literal('CONSULTANT'),
  Type.Literal('OTHER'),
]);
const CreateEmployee = Type.Object({
  employeeCode: Type.String({ minLength: 1, maxLength: 40 }),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  // Required on create; column is nullable for legacy rows.
  engagementType: EngagementType,
  designation: Type.Optional(Type.String({ maxLength: 120 })),
  tradeCategory: Type.Optional(Type.String({ maxLength: 80 })),
  joiningDate: Type.Optional(Type.String({ format: 'date' })),
  contactPhone: Type.Optional(Type.String({ maxLength: 20 })),
  contactEmail: Type.Optional(Type.String({ format: 'email' })),
  // Pair rule enforced in the service — both or neither.
  emergencyContactName: Type.Optional(Type.String({ maxLength: 120 })),
  emergencyContactPhone: Type.Optional(Type.String({ maxLength: 20 })),
});
const MembershipBody = Type.Object({
  departmentId: Type.String({ format: 'uuid' }),
  isPrimary: Type.Optional(Type.Boolean()),
  startedAt: Type.Optional(Type.String({ format: 'date-time' })),
});
const MembershipPatchBody = Type.Object({
  isPrimary: Type.Boolean(),
  expectedVersion: Type.Integer(),
});
// expectedVersion is REQUIRED on every mutation — stale writes must fail
// closed, not silently overwrite a concurrent change.
const UpdateEmployee = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  engagementType: Type.Optional(EngagementType),
  designation: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  tradeCategory: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  joiningDate: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  contactPhone: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
  contactEmail: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])),
  emergencyContactName: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  emergencyContactPhone: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
  expectedVersion: Type.Integer(),
});
const InviteBody = Type.Object({
  loginId: Type.String({ minLength: 3, maxLength: 320 }),
  loginIdType: Type.Literal('EMAIL'),
});
const AssignmentBody = Type.Object({
  roleKey: Type.String({ maxLength: 60 }),
  scopeType: Type.Union([
    Type.Literal('COMPANY'),
    Type.Literal('HEAD_OFFICE'),
    Type.Literal('PROJECT'),
    Type.Literal('SITE'),
  ]),
  scopeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
});
const StatusBody = Type.Object({
  to: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]),
  expectedVersion: Type.Integer(),
});
const EmployeeParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 60 }),
});
const AssignmentParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 60 }),
  assignmentId: Type.String({ minLength: 1, maxLength: 60 }),
});
const ListQuery = Type.Object({
  status: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const EmployeeStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('INACTIVE'),
  Type.Literal('ARCHIVED'),
]);
const TeamQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  status: Type.Optional(EmployeeStatusSchema),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const DeptMembersQuery = Type.Object({
  includeEnded: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const UuidParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const MemberParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  mid: Type.String({ format: 'uuid' }),
});
const AddMemberBody = Type.Object(
  {
    employeeId: Type.String({ format: 'uuid' }),
    isPrimary: Type.Optional(Type.Boolean()),
    startedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);
const UpdateMemberBody = Type.Object(
  {
    isPrimary: Type.Boolean(),
    expectedVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const EndMemberBody = Type.Object(
  { expectedVersion: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
// Transfers are immediate — startedAt/endedAt are server-controlled and are
// rejected as unknown fields by rejectUnknownBodyKeys.
const TransferMemberBody = Type.Object(
  {
    toDepartmentId: Type.String({ format: 'uuid' }),
    expectedVersion: Type.Integer({ minimum: 0 }),
    isPrimary: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// ------------------------------------------------------------- W4 workforce
// Site/project workforce lifecycle — scope resolves from the PATH only.
// Server-controlled fields (employee status, membership ids, endedAt,
// startedAt, isPrimary, supersededBy, suspendUntil-as-write, version,
// companyId, siteId/projectId in body, document references) are forbidden
// and rejected as unknown keys by rejectUnknownBodyKeys.
const WorkforceParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  employeeId: Type.String({ format: 'uuid' }),
});
const SuspendWorkforceBody = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: 500,
      description:
        'Audit-grade context; persisted as endNote — never appears in ' +
        'activity feeds or notifications.',
    }),
    expectedReturnDate: Type.Optional(
      Type.String({
        format: 'date',
        description:
          'ISO date; persisted as structured suspendUntil on the ended ' +
          'rows. Informational only — reinstatement is always manual.',
      }),
    ),
  },
  { additionalProperties: false },
);
const ExitWorkforceBody = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: 500,
      description: 'Audit-grade context; never in feeds or notifications.',
    }),
  },
  { additionalProperties: false },
);
const ReinstateWorkforceBody = Type.Object(
  {
    note: Type.Optional(
      Type.String({
        maxLength: 500,
        description: 'Optional audit note; never in feeds or notifications.',
      }),
    ),
  },
  { additionalProperties: false },
);
const SUSPEND_KEYS = ['reason', 'expectedReturnDate'] as const;
const EXIT_KEYS = ['reason'] as const;
const REINSTATE_KEYS = ['note'] as const;

// Membership fields are security-sensitive (endedAt is server-controlled
// only) — the app's ajv strips unknown keys instead of rejecting them, so
// reject them explicitly in preValidation (which sees the raw body).
const rejectUnknownBodyKeys = (allowed: readonly string[]) => {
  const set = new Set(allowed);
  return async (req: FastifyRequest): Promise<void> => {
    const unknown = Object.keys(req.body as Record<string, unknown>).filter((k) => !set.has(k));
    if (unknown.length > 0) {
      throw new DomainValidationError(
        'UNKNOWN_FIELD',
        `unknown membership fields: ${unknown.join(', ')}`,
      );
    }
  };
};

const EmployeeDocumentTypeSchema = Type.Union([
  Type.Literal('AADHAAR'),
  Type.Literal('PAN'),
  Type.Literal('VOTER_ID'),
  Type.Literal('PASSPORT'),
  Type.Literal('DRIVING_LICENSE'),
  Type.Literal('OPERATOR_LICENSE'),
  Type.Literal('TRADE_CERTIFICATE'),
  Type.Literal('ACADEMIC_CERTIFICATE'),
  Type.Literal('FITNESS_CERTIFICATE'),
  Type.Literal('POLICE_VERIFICATION'),
  Type.Literal('EMPLOYMENT_CONTRACT'),
  Type.Literal('BANK_DETAILS'),
  Type.Literal('PHOTO'),
  Type.Literal('OTHER'),
]);

const DocumentVerificationStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('VERIFIED'),
  Type.Literal('REJECTED'),
]);

// Scoped workforce onboarding — every field a PI/PD may manage when the
// company enables "employeeOnboard". Server-controlled fields (companyId,
// principalId, login, credentials, status, membership startedAt/endedAt,
// isPrimary, version) are absent by design and rejected as unknown keys.
// joiningDate records a historical employment fact only — it never backdates
// membership, leave, attendance, or operation access.
const OnboardDocumentBody = Type.Object(
  {
    documentId: Type.String({
      format: 'uuid',
      description: 'Id of an existing company Document with status AVAILABLE',
    }),
    documentType: EmployeeDocumentTypeSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    documentNumber: Type.Optional(Type.String({ maxLength: 100 })),
    issuingAuthority: Type.Optional(Type.String({ maxLength: 200 })),
    issueDate: Type.Optional(Type.String({ format: 'date' })),
    expiryDate: Type.Optional(Type.String({ format: 'date' })),
  },
  { additionalProperties: false },
);
const OnboardMemberBody = Type.Object(
  {
    employeeCode: Type.String({
      minLength: 1,
      maxLength: 40,
      description: 'Company-unique code; normalized to A-Z 0-9 - _',
    }),
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    engagementType: EngagementType,
    designation: Type.Optional(Type.String({ maxLength: 120 })),
    tradeCategory: Type.Optional(Type.String({ maxLength: 80 })),
    joiningDate: Type.Optional(
      Type.String({
        format: 'date',
        description: 'Historical employment fact; does not backdate membership or access',
      }),
    ),
    contactPhone: Type.Optional(Type.String({ maxLength: 20 })),
    contactEmail: Type.Optional(
      Type.String({
        format: 'email',
        description: 'Contact data only — never creates or identifies a login',
      }),
    ),
    // Pair rule — both or neither; enforced in the service.
    emergencyContactName: Type.Optional(Type.String({ maxLength: 120 })),
    emergencyContactPhone: Type.Optional(Type.String({ maxLength: 20 })),
    documents: Type.Optional(
      Type.Array(OnboardDocumentBody, {
        maxItems: 20,
        description:
          'Existing company documents to link in the same transaction; ' +
          'each documentId must belong to the company and be AVAILABLE',
      }),
    ),
  },
  { additionalProperties: false },
);
const ONBOARD_KEYS = [
  'employeeCode',
  'displayName',
  'engagementType',
  'designation',
  'tradeCategory',
  'joiningDate',
  'contactPhone',
  'contactEmail',
  'emergencyContactName',
  'emergencyContactPhone',
  'documents',
] as const;

const AttachDocumentBody = Type.Object({
  documentId: Type.Optional(Type.String({ format: 'uuid' })),
  fileBase64: Type.Optional(Type.String()),
  fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  documentType: EmployeeDocumentTypeSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  documentNumber: Type.Optional(Type.String({ maxLength: 100 })),
  issuingAuthority: Type.Optional(Type.String({ maxLength: 200 })),
  issueDate: Type.Optional(Type.String({ format: 'date' })),
  expiryDate: Type.Optional(Type.String({ format: 'date' })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const UpdateDocumentBody = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  documentNumber: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  issuingAuthority: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  issueDate: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  expiryDate: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
});

const VerifyDocumentBody = Type.Object({
  status: DocumentVerificationStatusSchema,
  rejectionReason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
});

const ListDocumentsQuery = Type.Object({
  documentType: Type.Optional(EmployeeDocumentTypeSchema),
  verificationStatus: Type.Optional(DocumentVerificationStatusSchema),
});

const ExpiringDocumentsQuery = Type.Object({
  withinDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365, default: 30 })),
});

const DocumentParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 60 }),
  docId: Type.String({ minLength: 1, maxLength: 60 }),
});

function companyIdOf(request: FastifyRequest): string {
  const c = request.headers['x-company-id'];
  if (typeof c !== 'string' || c.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return c;
}
const atCompany = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(r);
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};
// Scoped workforce-directory targets: project/site-scoped grants (PI/PD)
// cover their own scope; company grants cover via ancestors.
const atProject = (r: FastifyRequest): ScopeTarget => ({
  companyId: companyIdOf(r),
  scopeType: 'PROJECT',
  scopeId: (r.params as { id?: string }).id ?? '',
});
const atSite = (r: FastifyRequest): ScopeTarget => ({
  companyId: companyIdOf(r),
  scopeType: 'SITE',
  scopeId: (r.params as { id?: string }).id ?? '',
});
const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

export function employeeRoutes(
  service: EmployeeService,
  accessService?: EmployeeAccessService,
  documentService?: EmployeeDocumentService,
) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string, target: (r: FastifyRequest) => ScopeTarget = atCompany) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, target)],
    });
    // Authenticated + tenant-guarded only — the service applies the
    // per-department scope check (mirrors GET /departments/:id).
    const guarded = () => ({ preHandler: [app.authenticate, app.tenantCompanyGuard] });

    app.get(
      '/employees',
      { schema: { querystring: ListQuery }, ...perm('EMPLOYEE_READ') },
      async (req) =>
        service.list(
          actorOf(req),
          companyIdOf(req),
          req.query as {
            status?: string;
            cursor?: string;
            limit?: number;
          },
        ),
    );
    app.post(
      '/employees',
      { schema: { body: CreateEmployee }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => {
        const body = req.body as Record<string, unknown>;
        return service.create(actorOf(req), companyIdOf(req), {
          ...body,
          ...(body.joiningDate !== undefined && body.joiningDate !== null
            ? { joiningDate: new Date(body.joiningDate as string) }
            : {}),
        } as never);
      },
    );
    app.patch(
      '/employees/:id',
      { schema: { body: UpdateEmployee }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as {
          displayName?: string;
          engagementType?: string | null;
          designation?: string | null;
          tradeCategory?: string | null;
          joiningDate?: string | null;
          contactPhone?: string | null;
          contactEmail?: string | null;
          emergencyContactName?: string | null;
          emergencyContactPhone?: string | null;
          expectedVersion?: number;
        };
        return service.update(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          {
            ...patch,
            ...(patch.joiningDate !== undefined && patch.joiningDate !== null
              ? { joiningDate: new Date(patch.joiningDate) }
              : {}),
          } as never,
          expectedVersion,
        );
      },
    );
    app.get('/employees/:id', { ...perm('EMPLOYEE_READ') }, async (req) =>
      service.getById(actorOf(req), companyIdOf(req), (req.params as { id: string }).id),
    );
    app.post(
      '/employees/:id/status',
      { schema: { body: StatusBody }, ...perm('EMPLOYEE_MANAGE') },
      async (req) =>
        service.changeStatus(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { to: 'ACTIVE' | 'INACTIVE' }).to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        ),
    );

    // --------------------------------------------------------- Memberships
    // Organizational placement only — membership never satisfies permissions.
    app.get('/employees/:id/memberships', { ...perm('EMPLOYEE_READ') }, async (req) =>
      service.listMemberships(companyIdOf(req), (req.params as { id: string }).id),
    );
    app.post(
      '/employees/:id/memberships',
      { schema: { body: MembershipBody }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => {
        const body = req.body as {
          departmentId: string;
          isPrimary?: boolean;
          startedAt?: string;
        };
        return service.addMembership(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          {
            departmentId: body.departmentId,
            ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
            ...(body.startedAt !== undefined ? { startedAt: new Date(body.startedAt) } : {}),
          },
        );
      },
    );
    app.patch(
      '/employees/:id/memberships/:membershipId',
      { schema: { body: MembershipPatchBody }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => {
        const { membershipId } = req.params as { id: string; membershipId: string };
        const { isPrimary, expectedVersion } = req.body as {
          isPrimary: boolean;
          expectedVersion: number;
        };
        return service.updateMembership(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          membershipId,
          { isPrimary },
          expectedVersion,
        );
      },
    );
    app.post(
      '/employees/:id/memberships/:membershipId/end',
      {
        schema: { body: Type.Object({ expectedVersion: Type.Integer() }) },
        ...perm('EMPLOYEE_MANAGE'),
      },
      async (req) =>
        service.endMembership(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.params as { membershipId: string }).membershipId,
          (req.body as { expectedVersion: number }).expectedVersion,
        ),
    );

    // -------------------------------------------- Scoped workforce directory
    // Read-only. EMPLOYEE_READ evaluated at the requested project/site scope —
    // project teams include project-department AND child-site-department
    // members; site teams include that exact site's members only.
    app.get(
      '/org/projects/:id/team',
      {
        schema: { params: UuidParams, querystring: TeamQuery },
        ...perm('EMPLOYEE_READ', atProject),
      },
      async (req) =>
        service.listScopedTeam(
          actorOf(req),
          companyIdOf(req),
          { scopeType: 'PROJECT', scopeId: (req.params as { id: string }).id },
          req.query as { q?: string; status?: string; cursor?: string; limit?: number },
        ),
    );
    app.get(
      '/org/sites/:id/team',
      {
        schema: { params: UuidParams, querystring: TeamQuery },
        ...perm('EMPLOYEE_READ', atSite),
      },
      async (req) =>
        service.listScopedTeam(
          actorOf(req),
          companyIdOf(req),
          { scopeType: 'SITE', scopeId: (req.params as { id: string }).id },
          req.query as { q?: string; status?: string; cursor?: string; limit?: number },
        ),
    );
    // Department roster/history — the service asserts DEPARTMENT_READ at the
    // department's own scope, so scoped holders see only their departments.
    app.get(
      '/departments/:id/members',
      { schema: { params: UuidParams, querystring: DeptMembersQuery }, ...guarded() },
      async (req) =>
        service.listDepartmentMembers(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          req.query as { includeEnded?: boolean; cursor?: string; limit?: number },
        ),
    );
    // Scoped membership mutations — the service verifies the department is
    // inside the caller's boundary, the "placement" switch is on for scoped
    // holders, and every touched row stays in-scope. endedAt is
    // server-controlled and never accepted from the caller.
    app.post(
      '/departments/:id/members',
      {
        schema: { params: UuidParams, body: AddMemberBody },
        preValidation: [rejectUnknownBodyKeys(['employeeId', 'isPrimary', 'startedAt'])],
        ...guarded(),
      },
      async (req) => {
        const body = req.body as { employeeId: string; isPrimary?: boolean; startedAt?: string };
        return service.addScopedMember(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          {
            employeeId: body.employeeId,
            ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
            ...(body.startedAt !== undefined ? { startedAt: new Date(body.startedAt) } : {}),
          },
        );
      },
    );
    app.patch(
      '/departments/:id/members/:mid',
      {
        schema: { params: MemberParams, body: UpdateMemberBody },
        preValidation: [rejectUnknownBodyKeys(['isPrimary', 'expectedVersion'])],
        ...guarded(),
      },
      async (req) =>
        service.updateScopedMember(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string; mid: string }).id,
          (req.params as { id: string; mid: string }).mid,
          req.body as { isPrimary: boolean; expectedVersion: number },
        ),
    );
    app.post(
      '/departments/:id/members/:mid/end',
      {
        schema: { params: MemberParams, body: EndMemberBody },
        preValidation: [rejectUnknownBodyKeys(['expectedVersion'])],
        ...guarded(),
      },
      async (req) =>
        service.endScopedMember(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string; mid: string }).id,
          (req.params as { id: string; mid: string }).mid,
          req.body as { expectedVersion: number },
        ),
    );
    app.post(
      '/departments/:id/members/:mid/transfer',
      {
        schema: { params: MemberParams, body: TransferMemberBody },
        preValidation: [rejectUnknownBodyKeys(['toDepartmentId', 'expectedVersion', 'isPrimary'])],
        ...guarded(),
      },
      async (req) => {
        const body = req.body as {
          toDepartmentId: string;
          expectedVersion: number;
          isPrimary?: boolean;
        };
        return service.transferScopedMember(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string; mid: string }).id,
          (req.params as { id: string; mid: string }).mid,
          {
            toDepartmentId: body.toDepartmentId,
            expectedVersion: body.expectedVersion,
            ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
          },
        );
      },
    );
    // Scoped member detail — the read-back path for contact/emergency fields
    // written by onboarding. DEPARTMENT_READ at the department's own scope;
    // roster and team lists keep the safe projection without them.
    app.get(
      '/departments/:id/members/:mid',
      { schema: { params: MemberParams }, ...guarded() },
      async (req) =>
        service.getScopedMember(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string; mid: string }).id,
          (req.params as { id: string; mid: string }).mid,
        ),
    );
    // Delegated workforce onboarding — employee profile + initial ACTIVE
    // primary membership in one transaction. principalId stays null: no
    // login, invite, role, permission, or operation is created here.
    app.post(
      '/departments/:id/onboard',
      {
        schema: { params: UuidParams, body: OnboardMemberBody },
        preValidation: [rejectUnknownBodyKeys(ONBOARD_KEYS)],
        ...guarded(),
      },
      async (req) => {
        const body = req.body as {
          employeeCode: string;
          displayName: string;
          engagementType: string;
          designation?: string;
          tradeCategory?: string;
          joiningDate?: string;
          contactPhone?: string;
          contactEmail?: string;
          emergencyContactName?: string;
          emergencyContactPhone?: string;
          documents?: {
            documentId: string;
            documentType: EmployeeDocumentType;
            title: string;
            documentNumber?: string;
            issuingAuthority?: string;
            issueDate?: string;
            expiryDate?: string;
          }[];
        };
        return service.onboardScopedMember(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          {
            employeeCode: body.employeeCode,
            displayName: body.displayName,
            engagementType: body.engagementType,
            ...(body.designation !== undefined ? { designation: body.designation } : {}),
            ...(body.tradeCategory !== undefined ? { tradeCategory: body.tradeCategory } : {}),
            ...(body.joiningDate !== undefined ? { joiningDate: new Date(body.joiningDate) } : {}),
            ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone } : {}),
            ...(body.contactEmail !== undefined ? { contactEmail: body.contactEmail } : {}),
            ...(body.emergencyContactName !== undefined
              ? { emergencyContactName: body.emergencyContactName }
              : {}),
            ...(body.emergencyContactPhone !== undefined
              ? { emergencyContactPhone: body.emergencyContactPhone }
              : {}),
            ...(body.documents !== undefined
              ? {
                  documents: body.documents.map((d) => ({
                    documentId: d.documentId,
                    documentType: d.documentType,
                    title: d.title,
                    ...(d.documentNumber !== undefined ? { documentNumber: d.documentNumber } : {}),
                    ...(d.issuingAuthority !== undefined
                      ? { issuingAuthority: d.issuingAuthority }
                      : {}),
                    ...(d.issueDate !== undefined ? { issueDate: new Date(d.issueDate) } : {}),
                    ...(d.expiryDate !== undefined ? { expiryDate: new Date(d.expiryDate) } : {}),
                  })),
                }
              : {}),
          },
        );
      },
    );

    // ---------------------------------------------- W4 workforce lifecycle
    // Suspension, permanent exit, and reinstatement at site or project
    // scope. The target scope resolves from the path; the delegation flag
    // (memberSuspend for suspend+reinstate, memberExit for exit) and
    // EMPLOYEE_MEMBER_MANAGE at the target are enforced in the service.
    for (const scopeType of ['SITE', 'PROJECT'] as const) {
      const base = scopeType === 'SITE' ? '/org/sites' : '/org/projects';
      const scopeOf = (req: FastifyRequest) => ({
        scopeType,
        scopeId: (req.params as { id: string }).id,
      });
      app.post(
        `${base}/:id/workforce/:employeeId/suspend`,
        {
          schema: { params: WorkforceParams, body: SuspendWorkforceBody },
          preValidation: [rejectUnknownBodyKeys(SUSPEND_KEYS)],
          ...guarded(),
        },
        async (req) => {
          const body = req.body as { reason: string; expectedReturnDate?: string };
          return service.suspendWorkforce(
            actorOf(req),
            companyIdOf(req),
            scopeOf(req),
            (req.params as { employeeId: string }).employeeId,
            {
              reason: body.reason,
              ...(body.expectedReturnDate !== undefined
                ? { expectedReturnDate: new Date(body.expectedReturnDate) }
                : {}),
            },
          );
        },
      );
      app.post(
        `${base}/:id/workforce/:employeeId/exit`,
        {
          schema: { params: WorkforceParams, body: ExitWorkforceBody },
          preValidation: [rejectUnknownBodyKeys(EXIT_KEYS)],
          ...guarded(),
        },
        async (req) =>
          service.exitWorkforce(
            actorOf(req),
            companyIdOf(req),
            scopeOf(req),
            (req.params as { employeeId: string }).employeeId,
            req.body as { reason: string },
          ),
      );
      app.post(
        `${base}/:id/workforce/:employeeId/reinstate`,
        {
          schema: { params: WorkforceParams, body: ReinstateWorkforceBody },
          preValidation: [rejectUnknownBodyKeys(REINSTATE_KEYS)],
          ...guarded(),
        },
        async (req) =>
          service.reinstateWorkforce(
            actorOf(req),
            companyIdOf(req),
            scopeOf(req),
            (req.params as { employeeId: string }).employeeId,
            req.body as { note?: string },
          ),
      );
    }

    // Assignable tenant role templates — lists available roles & required scopeShape.
    app.get('/roles', { ...perm('ROLE_ASSIGNMENT_READ') }, async () => TENANT_ROLE_TEMPLATES);

    // Phase 1 — account invite + whitelisted role assignments (Company Owner).
    if (accessService !== undefined) {
      app.post(
        '/employees/:id/invite',
        { schema: { params: EmployeeParams, body: InviteBody }, ...perm('EMPLOYEE_INVITE') },
        async (req) => {
          const { loginId, loginIdType } = req.body as {
            loginId: string;
            loginIdType?: string;
          };
          const frontendUrl =
            (req.headers['x-frontend-url'] as string | undefined) ??
            (typeof req.headers.origin === 'string' && req.headers.origin !== 'null'
              ? req.headers.origin
              : undefined);
          return accessService.invite(
            actorOf(req),
            companyIdOf(req),
            (req.params as { id: string }).id,
            loginId,
            loginIdType,
            frontendUrl,
          );
        },
      );
      app.post(
        '/employees/:id/invite/resend',
        { schema: { params: EmployeeParams }, ...perm('EMPLOYEE_INVITE') },
        async (req) => {
          const frontendUrl =
            (req.headers['x-frontend-url'] as string | undefined) ??
            (typeof req.headers.origin === 'string' && req.headers.origin !== 'null'
              ? req.headers.origin
              : undefined);
          return accessService.resend(
            actorOf(req),
            companyIdOf(req),
            (req.params as { id: string }).id,
            frontendUrl,
          );
        },
      );
      app.get(
        '/employees/:id/assignments',
        { schema: { params: EmployeeParams }, ...perm('ROLE_ASSIGNMENT_READ') },
        async (req) =>
          accessService.listAssignments(companyIdOf(req), (req.params as { id: string }).id),
      );
      app.post(
        '/employees/:id/assignments',
        { schema: { params: EmployeeParams, body: AssignmentBody }, ...perm('ACCESS_ROLE_ASSIGN') },
        async (req) =>
          accessService.grant(actorOf(req), companyIdOf(req), {
            employeeId: (req.params as { id: string }).id,
            ...(req.body as { roleKey: string; scopeType: string; scopeId?: string }),
          }),
      );
      app.delete(
        '/employees/:id/assignments/:assignmentId',
        { schema: { params: AssignmentParams }, ...perm('ACCESS_ROLE_REVOKE') },
        async (req) =>
          accessService.revoke(
            actorOf(req),
            companyIdOf(req),
            (req.params as { assignmentId: string }).assignmentId,
          ),
      );
    }

    if (documentService) {
      // 1. Expiring documents (company-wide, defined before /employees/:id)
      app.get(
        '/employees/documents/expiring',
        { schema: { querystring: ExpiringDocumentsQuery }, ...perm('EMPLOYEE_READ') },
        async (req) => {
          const query = req.query as { withinDays?: number };
          return documentService.listExpiringDocuments(
            actorOf(req),
            companyIdOf(req),
            query.withinDays ?? 30,
          );
        },
      );

      // 2. Direct Multipart Upload
      app.post(
        '/employees/:id/documents/upload',
        {
          schema: { params: EmployeeParams },
          preHandler: [app.authenticate, app.tenantCompanyGuard],
        },
        async (req, reply) => {
          const employeeId = (req.params as { id: string }).id;
          if (!req.isMultipart()) {
            throw new OrgValidationError(
              'content-type',
              'multipart/form-data required for file upload',
            );
          }
          const part = await req.file();
          if (!part) {
            throw new OrgValidationError('file', 'file is required');
          }
          const buffer = await part.toBuffer();
          const fields = part.fields as Record<string, { value?: string } | undefined>;
          const documentType = (fields.documentType?.value ?? 'OTHER') as EmployeeDocumentType;
          const title = fields.title?.value ?? part.filename;
          const documentNumber = fields.documentNumber?.value;
          const issuingAuthority = fields.issuingAuthority?.value;
          const issueDate = fields.issueDate?.value;
          const expiryDate = fields.expiryDate?.value;

          const created = await documentService.uploadAndAttach(
            actorOf(req),
            companyIdOf(req),
            employeeId,
            {
              body: buffer,
              fileName: part.filename,
              declaredContentType: part.mimetype,
            },
            {
              documentType,
              title,
              ...(documentNumber ? { documentNumber } : {}),
              ...(issuingAuthority ? { issuingAuthority } : {}),
              ...(issueDate ? { issueDate } : {}),
              ...(expiryDate ? { expiryDate } : {}),
            },
          );
          reply.status(201);
          return created;
        },
      );

      // 3. Attach Existing DocumentId or Base64
      app.post(
        '/employees/:id/documents',
        {
          schema: { params: EmployeeParams, body: AttachDocumentBody },
          preHandler: [app.authenticate, app.tenantCompanyGuard],
        },
        async (req, reply) => {
          const employeeId = (req.params as { id: string }).id;
          const body = req.body as {
            documentId?: string;
            fileBase64?: string;
            fileName?: string;
            documentType: EmployeeDocumentType;
            title: string;
            documentNumber?: string;
            issuingAuthority?: string;
            issueDate?: string;
            expiryDate?: string;
            metadata?: Prisma.InputJsonValue;
          };

          if (body.fileBase64 && body.fileName) {
            const buffer = Buffer.from(body.fileBase64, 'base64');
            const created = await documentService.uploadAndAttach(
              actorOf(req),
              companyIdOf(req),
              employeeId,
              {
                body: buffer,
                fileName: body.fileName,
              },
              {
                documentType: body.documentType,
                title: body.title,
                ...(body.documentNumber ? { documentNumber: body.documentNumber } : {}),
                ...(body.issuingAuthority ? { issuingAuthority: body.issuingAuthority } : {}),
                ...(body.issueDate ? { issueDate: body.issueDate } : {}),
                ...(body.expiryDate ? { expiryDate: body.expiryDate } : {}),
                ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
              },
            );
            reply.status(201);
            return created;
          }

          if (!body.documentId) {
            throw new OrgValidationError(
              'documentId',
              'either documentId or fileBase64+fileName is required',
            );
          }

          const created = await documentService.attachExisting(
            actorOf(req),
            companyIdOf(req),
            employeeId,
            {
              documentId: body.documentId,
              documentType: body.documentType,
              title: body.title,
              ...(body.documentNumber ? { documentNumber: body.documentNumber } : {}),
              ...(body.issuingAuthority ? { issuingAuthority: body.issuingAuthority } : {}),
              ...(body.issueDate ? { issueDate: body.issueDate } : {}),
              ...(body.expiryDate ? { expiryDate: body.expiryDate } : {}),
              ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
            },
          );
          reply.status(201);
          return created;
        },
      );

      // 4. List Employee Documents
      app.get(
        '/employees/:id/documents',
        {
          schema: { params: EmployeeParams, querystring: ListDocumentsQuery },
          preHandler: [app.authenticate, app.tenantCompanyGuard],
        },
        async (req) => {
          const employeeId = (req.params as { id: string }).id;
          const query = req.query as {
            documentType?: EmployeeDocumentType;
            verificationStatus?: DocumentVerificationStatus;
          };
          return documentService.listDocuments(actorOf(req), companyIdOf(req), employeeId, query);
        },
      );

      // 5. Get Single Employee Document
      app.get(
        '/employees/:id/documents/:docId',
        {
          schema: { params: DocumentParams },
          preHandler: [app.authenticate, app.tenantCompanyGuard],
        },
        async (req) => {
          const { id: employeeId, docId } = req.params as { id: string; docId: string };
          return documentService.getDocument(actorOf(req), companyIdOf(req), employeeId, docId);
        },
      );

      // 6. Download Document Stream
      app.get(
        '/employees/:id/documents/:docId/download',
        {
          schema: { params: DocumentParams },
          preHandler: [app.authenticate, app.tenantCompanyGuard],
        },
        async (req, reply) => {
          const { id: employeeId, docId } = req.params as { id: string; docId: string };
          const download = await documentService.downloadDocument(
            actorOf(req),
            companyIdOf(req),
            employeeId,
            docId,
          );
          reply.header('content-type', download.contentType);
          reply.header('content-disposition', `inline; filename="${download.fileName}"`);
          return reply.send(download.stream);
        },
      );

      // 7. Update Employee Document Metadata
      app.patch(
        '/employees/:id/documents/:docId',
        {
          schema: { params: DocumentParams, body: UpdateDocumentBody },
          ...perm('EMPLOYEE_MANAGE'),
        },
        async (req) => {
          const { id: employeeId, docId } = req.params as { id: string; docId: string };
          const body = req.body as UpdateEmployeeDocumentInput;
          return documentService.updateDocument(
            actorOf(req),
            companyIdOf(req),
            employeeId,
            docId,
            body,
          );
        },
      );

      // 8. Verify / Reject Employee Document
      app.post(
        '/employees/:id/documents/:docId/verify',
        {
          schema: { params: DocumentParams, body: VerifyDocumentBody },
          ...perm('EMPLOYEE_MANAGE'),
        },
        async (req) => {
          const { id: employeeId, docId } = req.params as { id: string; docId: string };
          const body = req.body as VerifyEmployeeDocumentInput;
          return documentService.verifyDocument(
            actorOf(req),
            companyIdOf(req),
            employeeId,
            docId,
            body,
          );
        },
      );

      // 9. Delete Employee Document
      app.delete(
        '/employees/:id/documents/:docId',
        { schema: { params: DocumentParams }, ...perm('EMPLOYEE_MANAGE') },
        async (req, reply) => {
          const { id: employeeId, docId } = req.params as { id: string; docId: string };
          await documentService.deleteDocument(actorOf(req), companyIdOf(req), employeeId, docId);
          reply.status(204);
          return reply.send();
        },
      );

      // 10. Self-service convenience endpoints (/me/documents)
      app.get(
        '/me/documents',
        {
          schema: { querystring: ListDocumentsQuery },
          preHandler: [app.authenticate, app.tenantCompanyGuard],
        },
        async (req) => {
          const callerEmp = await documentService.getCallerEmployee(
            companyIdOf(req),
            actorOf(req).actorId,
          );
          if (!callerEmp) throw new OrgEntityNotFoundError('EMPLOYEE');
          const query = req.query as {
            documentType?: EmployeeDocumentType;
            verificationStatus?: DocumentVerificationStatus;
          };
          return documentService.listDocuments(actorOf(req), companyIdOf(req), callerEmp.id, query);
        },
      );

      app.post(
        '/me/documents/upload',
        { preHandler: [app.authenticate, app.tenantCompanyGuard] },
        async (req, reply) => {
          const callerEmp = await documentService.getCallerEmployee(
            companyIdOf(req),
            actorOf(req).actorId,
          );
          if (!callerEmp) throw new OrgEntityNotFoundError('EMPLOYEE');
          if (!req.isMultipart()) {
            throw new OrgValidationError(
              'content-type',
              'multipart/form-data required for file upload',
            );
          }
          const part = await req.file();
          if (!part) {
            throw new OrgValidationError('file', 'file is required');
          }
          const buffer = await part.toBuffer();
          const fields = part.fields as Record<string, { value?: string } | undefined>;
          const documentType = (fields.documentType?.value ?? 'OTHER') as EmployeeDocumentType;
          const title = fields.title?.value ?? part.filename;
          const documentNumber = fields.documentNumber?.value;
          const issuingAuthority = fields.issuingAuthority?.value;
          const issueDate = fields.issueDate?.value;
          const expiryDate = fields.expiryDate?.value;

          const created = await documentService.uploadAndAttach(
            actorOf(req),
            companyIdOf(req),
            callerEmp.id,
            {
              body: buffer,
              fileName: part.filename,
              declaredContentType: part.mimetype,
            },
            {
              documentType,
              title,
              ...(documentNumber ? { documentNumber } : {}),
              ...(issuingAuthority ? { issuingAuthority } : {}),
              ...(issueDate ? { issueDate } : {}),
              ...(expiryDate ? { expiryDate } : {}),
            },
          );
          reply.status(201);
          return created;
        },
      );

      app.get(
        '/me/documents/:docId/download',
        { preHandler: [app.authenticate, app.tenantCompanyGuard] },
        async (req, reply) => {
          const callerEmp = await documentService.getCallerEmployee(
            companyIdOf(req),
            actorOf(req).actorId,
          );
          if (!callerEmp) throw new OrgEntityNotFoundError('EMPLOYEE');
          const { docId } = req.params as { docId: string };
          const download = await documentService.downloadDocument(
            actorOf(req),
            companyIdOf(req),
            callerEmp.id,
            docId,
          );
          reply.header('content-type', download.contentType);
          reply.header('content-disposition', `inline; filename="${download.fileName}"`);
          return reply.send(download.stream);
        },
      );
    }
  };
}
